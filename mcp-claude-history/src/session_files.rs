use crate::types::ErrorResponse;
use crate::utils::{SIDECHAIN_SESSION_DIRS, session_id_from_filename, session_matches_ref};
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

pub type SessionFile = (String, String, PathBuf);
const MAX_DISCOVERED_FILES: usize = 100_000;
const MAX_DIRECTORY_ENTRIES: usize = 200_000;

fn source_error(error: impl std::fmt::Display) -> ErrorResponse {
    ErrorResponse {
        error: "source_unavailable".to_string(),
        message: format!("无法安全枚举或打开历史来源: {error}"),
        available: None,
    }
}

fn read_entries(path: &Path, optional: bool, remaining: &mut usize) -> Result<Vec<fs::DirEntry>, ErrorResponse> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if optional && error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(source_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(source_error(format!("目录不是普通目录: {}", path.display())));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(source_error)? {
        crate::record_reader::check_work()?;
        if *remaining == 0 {
            return Err(source_error("目录条目超过 200000，来源未全部枚举"));
        }
        *remaining -= 1;
        entries.push(entry.map_err(source_error)?);
    }
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn append_file(
    files: &mut Vec<SessionFile>,
    project: &str,
    entry: &fs::DirEntry,
    agent: bool,
) -> Result<(), ErrorResponse> {
    if entry.path().extension().is_none_or(|extension| extension != "jsonl") {
        return Ok(());
    }
    let name = entry.file_name().to_string_lossy().to_string();
    let session = if agent {
        name.strip_prefix("agent-")
            .and_then(|name| name.strip_suffix(".jsonl"))
            .filter(|id| !id.is_empty())
            .map(|id| format!("agent-{id}"))
    } else {
        session_id_from_filename(&name)
    };
    let Some(session) = session else {
        return Ok(());
    };
    if !entry.file_type().map_err(source_error)?.is_file() {
        return Err(source_error(format!(
            "会话来源不是普通文件: {}",
            entry.path().display()
        )));
    }
    if files.len() == MAX_DISCOVERED_FILES {
        return Err(source_error("会话文件超过 100000，来源未全部枚举"));
    }
    files.push((project.to_string(), session, entry.path()));
    Ok(())
}

/// 只枚举已经支持的会话布局，Workflow journal 不属于消息来源
pub fn collect_session_files(
    projects: &[(String, PathBuf)],
    filters: &[String],
    subagents: bool,
) -> Result<Vec<SessionFile>, ErrorResponse> {
    let mut files = Vec::new();
    let mut remaining = MAX_DIRECTORY_ENTRIES;
    for (project, directory) in projects {
        if fs::symlink_metadata(directory)
            .map_err(source_error)?
            .file_type()
            .is_symlink()
        {
            return Err(source_error(format!("项目目录为链接: {}", directory.display())));
        }
        let directory = fs::canonicalize(directory).map_err(source_error)?;
        for entry in read_entries(&directory, false, &mut remaining)? {
            append_file(&mut files, project, &entry, false)?;
            if !subagents || !entry.file_type().map_err(source_error)?.is_dir() {
                continue;
            }
            for sidechain in SIDECHAIN_SESSION_DIRS {
                let sidechain_path = entry.path().join(sidechain);
                for child in read_entries(&sidechain_path, true, &mut remaining)? {
                    append_file(&mut files, project, &child, true)?;
                    if *sidechain != "subagents" || child.file_name() != "workflows" {
                        continue;
                    }
                    for run in read_entries(&child.path(), false, &mut remaining)? {
                        if !run.file_type().map_err(source_error)?.is_dir() {
                            continue;
                        }
                        for agent in read_entries(&run.path(), false, &mut remaining)? {
                            append_file(&mut files, project, &agent, true)?;
                        }
                    }
                }
            }
        }
    }
    files.retain(|(_, session, _)| {
        filters.is_empty() || filters.iter().any(|filter| session_matches_ref(session, filter))
    });
    files.sort();
    files.dedup();
    Ok(files)
}

pub fn matches_snapshot(expected: &fs::Metadata, actual: &fs::Metadata) -> bool {
    if actual.len() < expected.len() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if actual.dev() != expected.dev() || actual.ino() != expected.ino() {
            return false;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if actual.creation_time() != expected.creation_time() {
            return false;
        }
    }
    actual.len() != expected.len() || actual.modified().ok() == expected.modified().ok()
}

/// Unix 上逐级打开目录，拒绝读取目录或文件替换后的链接目标
pub fn open_session_file(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        let mut directory = File::open("/")?;
        let parts: Vec<_> = absolute
            .components()
            .filter_map(|component| match component {
                Component::RootDir => None,
                Component::Normal(name) => Some(Ok(name)),
                _ => Some(Err(io::Error::new(io::ErrorKind::InvalidInput, "来源路径含非普通组件"))),
            })
            .collect::<io::Result<_>>()?;
        if parts.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "来源路径不能为空"));
        }
        for (index, part) in parts.iter().enumerate() {
            let name = CString::new(part.as_bytes())
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "来源路径含 NUL"))?;
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if index + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    libc::O_NONBLOCK
                };
            // 当前目录由本函数持有，名称不含斜杠，成功的 fd 转交 File 管理
            let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                return Err(io::Error::last_os_error());
            }
            directory = unsafe { File::from_raw_fd(descriptor) };
        }
        if !directory.metadata()?.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "历史来源不是普通文件"));
        }
        Ok(directory)
    }
    #[cfg(not(unix))]
    {
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component.as_os_str());
            if fs::symlink_metadata(&current)?.file_type().is_symlink() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "历史来源包含链接"));
            }
        }
        let before = fs::canonicalize(path)?;
        let file = File::open(path)?;
        if !file.metadata()?.is_file() || fs::canonicalize(path)? != before {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "历史来源打开期间发生变化"));
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_layouts_share_discovery_without_expanding_parent_filters() {
        let root = std::env::temp_dir().join(format!("history-layout-{}", std::process::id()));
        fs::create_dir_all(root.join("parent/subagents/workflows/run")).unwrap();
        fs::create_dir_all(root.join("parent/remote-agents")).unwrap();
        for name in [
            "parent.jsonl",
            "parent/subagents/agent-direct.jsonl",
            "parent/remote-agents/agent-remote.jsonl",
            "parent/subagents/workflows/run/agent-nested.jsonl",
            "parent/subagents/workflows/run/journal.jsonl",
        ] {
            fs::write(root.join(name), b"{}\n").unwrap();
        }
        let projects = vec![("project".to_string(), root.clone())];
        let files = collect_session_files(&projects, &[], true).unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(
            collect_session_files(&projects, &["parent".to_string()], true)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            collect_session_files(&projects, &["agent-nested".to_string()], true)
                .unwrap()
                .len(),
            1
        );
        for (_, _, path) in &files {
            assert!(open_session_file(path).is_ok());
        }
        #[cfg(unix)]
        {
            let link = root.join("linked.jsonl");
            std::os::unix::fs::symlink(root.join("parent.jsonl"), &link).unwrap();
            assert!(open_session_file(&link).is_err());
            assert!(collect_session_files(&projects, &[], true).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}

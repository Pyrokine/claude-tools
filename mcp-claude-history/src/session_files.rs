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

fn entries(path: &Path, optional: bool) -> Result<Option<fs::ReadDir>, ErrorResponse> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if optional && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(source_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(source_error(format!("目录不是普通目录: {}", path.display())));
    }
    fs::read_dir(path).map(Some).map_err(source_error)
}

/// 来源目录与正文扫描共用布局，枚举时不积累全部路径
pub fn visit_session_files(
    projects: &[(String, PathBuf)],
    filters: &[String],
    subagents: bool,
    mut visit: impl FnMut(SessionFile) -> Result<(), ErrorResponse>,
) -> Result<(), ErrorResponse> {
    fn entry(entry: io::Result<fs::DirEntry>, remaining: &mut usize) -> Result<fs::DirEntry, ErrorResponse> {
        crate::record_reader::check_work()?;
        if *remaining == 0 {
            return Err(source_error("目录条目超过 200000，来源未全部枚举"));
        }
        *remaining -= 1;
        entry.map_err(source_error)
    }
    let mut remaining = MAX_DIRECTORY_ENTRIES;
    let mut append = |project: &str, item: &fs::DirEntry, agent: bool| -> Result<(), ErrorResponse> {
        if item.path().extension().is_none_or(|extension| extension != "jsonl") {
            return Ok(());
        }
        let name = item.file_name().to_string_lossy().to_string();
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
        if !item.file_type().map_err(source_error)?.is_file() {
            return Err(source_error(format!("会话来源不是普通文件: {}", item.path().display())));
        }
        if filters.is_empty() || filters.iter().any(|filter| session_matches_ref(&session, filter)) {
            visit((project.to_string(), session, item.path()))?;
        }
        Ok(())
    };
    for (project, path) in projects {
        let metadata = fs::symlink_metadata(path).map_err(source_error)?;
        if metadata.file_type().is_symlink() {
            return Err(source_error("项目目录为链接"));
        }
        let directory = fs::canonicalize(path).map_err(source_error)?;
        for item in entries(&directory, false)?.into_iter().flatten() {
            let item = entry(item, &mut remaining)?;
            append(project, &item, false)?;
            if !subagents || !item.file_type().map_err(source_error)?.is_dir() {
                continue;
            }
            for sidechain in SIDECHAIN_SESSION_DIRS {
                for child in entries(&item.path().join(sidechain), true)?.into_iter().flatten() {
                    let child = entry(child, &mut remaining)?;
                    append(project, &child, true)?;
                    if *sidechain != "subagents" || child.file_name() != "workflows" {
                        continue;
                    }
                    for run in entries(&child.path(), false)?.into_iter().flatten() {
                        let run = entry(run, &mut remaining)?;
                        if !run.file_type().map_err(source_error)?.is_dir() {
                            continue;
                        }
                        for agent in entries(&run.path(), false)?.into_iter().flatten() {
                            append(project, &entry(agent, &mut remaining)?, true)?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn collect_session_files(
    projects: &[(String, PathBuf)],
    filters: &[String],
    subagents: bool,
) -> Result<Vec<SessionFile>, ErrorResponse> {
    let mut files = Vec::new();
    let mut bytes = 0usize;
    visit_session_files(projects, filters, subagents, |file| {
        bytes = bytes.saturating_add(file.0.len() + file.1.len() + file.2.as_os_str().len() + 128);
        if files.len() == MAX_DISCOVERED_FILES || bytes > 32 * 1024 * 1024 {
            return Err(source_error(
                "来源清单超过 100000 条或 32 MiB，请使用 mode=sources 分组扫描",
            ));
        }
        files.push(file);
        Ok(())
    })?;
    files.sort();
    files.dedup();
    Ok(files)
}

/// 精确来源按相同布局验证，避免为每条 sources 再次枚举整个项目
pub fn resolve_exact_source(config: &crate::config::Config, source: &str) -> Result<SessionFile, ErrorResponse> {
    let path = Path::new(source);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(crate::utils::invalid_arguments("source 必须使用返回的绝对来源路径"));
    }
    let root = config.projects_dir.canonicalize().map_err(source_error)?;
    let relative = path
        .strip_prefix(&config.projects_dir)
        .or_else(|_| path.strip_prefix(&root))
        .map_err(|_| crate::utils::invalid_arguments("source 不在历史目录内"))?;
    let parts = relative
        .components()
        .map(|part| match part {
            Component::Normal(value) => value.to_str().ok_or_else(|| source_error("source 路径不是 UTF-8")),
            _ => Err(source_error("source 路径含非法组件")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let agent = match parts.as_slice() {
        [_, _] => false,
        [_, _, "subagents" | "remote-agents", _] => true,
        [_, _, "subagents", "workflows", _, _] => true,
        _ => {
            return Err(crate::record_reader::reader_error(
                "source_not_found",
                "source 不属于受支持布局",
            ));
        }
    };
    let project = config.normalize_project_id(parts[0])?;
    let name = *parts.last().expect("validated source layout");
    let session = if agent {
        name.strip_prefix("agent-")
            .and_then(|name| name.strip_suffix(".jsonl"))
            .filter(|id| !id.is_empty())
            .map(|id| format!("agent-{id}"))
    } else {
        session_id_from_filename(name)
    }
    .ok_or_else(|| crate::record_reader::reader_error("source_not_found", "source 不是受支持会话文件"))?;
    let absolute = root.join(relative);
    open_session_file(&absolute).map_err(source_error)?;
    Ok((project, session, absolute))
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
            // Windows 前缀与根分隔符组合后才是可查询的路径
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
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
    use std::io::Read;

    #[test]
    fn canonical_history_paths_are_readable_and_directories_are_rejected() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("history-canonical-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("session.jsonl");
        let expected = b"{\"type\":\"user\",\"message\":{\"content\":\"fixture\"}}\n";
        fs::write(&path, expected).unwrap();
        let canonical = fs::canonicalize(&path).unwrap();
        #[cfg(windows)]
        assert!(matches!(canonical.components().next(), Some(Component::Prefix(_))));
        for source in [&path, &canonical] {
            let mut file = open_session_file(source).unwrap();
            let mut actual = Vec::new();
            file.read_to_end(&mut actual).unwrap();
            assert_eq!(actual, expected);
        }
        assert!(open_session_file(&fs::canonicalize(&root).unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

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

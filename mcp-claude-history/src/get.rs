use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
fn set_private_permissions(path: &Path, mode: u32, target: &str) -> Result<(), ErrorResponse> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法设置{}权限: {}", target, e),
        available: None,
    })
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path, _mode: u32, _target: &str) -> Result<(), ErrorResponse> {
    Ok(())
}

/// Get 参数
pub struct GetParams {
    pub r#ref: String,
    pub range: Option<(usize, usize)>,
    pub output: Option<PathBuf>,
    pub project: Option<String>,
}

/// 获取完整内容
pub fn get(config: &Config, params: GetParams) -> Result<GetResponse, ErrorResponse> {
    // 解析 ref
    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}，应为 session前8位:行号", params.r#ref),
        available: None,
    })?;

    // 查找 session 文件
    let (_project_id, _session_id, path) = find_session_file(
        config,
        &parsed_ref.session_prefix,
        params.project.as_deref(),
    )?;

    // 读取指定行
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {}", e),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let mut target_line = None;

    for (line_num, line) in reader.lines().enumerate() {
        if line_num + 1 == parsed_ref.line {
            target_line = Some(line.map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("读取行失败: {}", e),
                available: None,
            })?);
            break;
        }
    }

    let line = target_line.ok_or_else(|| ErrorResponse {
        error: "ref_not_found".to_string(),
        message: format!("ref 不存在: {}", params.r#ref),
        available: None,
    })?;

    // 解析消息
    let record: MessageRecord = serde_json::from_str(&line).map_err(|e| ErrorResponse {
        error: "parse_error".to_string(),
        message: format!("解析消息失败: {}", e),
        available: None,
    })?;

    // 提取内容和图片
    let (effective_type, _) = classify_message(&record);
    let content = replace_images_with_placeholders(&record);
    let images = extract_images(&record);
    let image_count = images.len();
    let content_size = content.chars().count();

    // 如果指定了 output，写入文件
    if let Some(output_dir) = params.output {
        return write_output(&output_dir, &params.r#ref, &record, &content, image_count);
    }

    // 如果指定了 range，返回部分内容
    if let Some((start, end)) = params.range {
        // content_size 已是 content 的字符数，无需再次遍历
        let content_len = content_size;
        if start > end {
            return Err(ErrorResponse {
                error: "invalid_range".to_string(),
                message: format!("range start({}) 大于 end({})", start, end),
                available: None,
            });
        }
        if start >= content_len {
            return Err(ErrorResponse {
                error: "invalid_range".to_string(),
                message: format!("range start({}) 已超出内容长度({})", start, content_len),
                available: None,
            });
        }
        let end = end.min(content_len);
        let partial_content: String = content.chars().skip(start).take(end - start).collect();
        let partial_size = partial_content.chars().count();
        return Ok(GetResponse::Success {
            r#ref: params.r#ref,
            r#type: effective_type.to_string(),
            content: partial_content,
            content_size: partial_size,
            image_count,
        });
    }

    // 检查内容大小（字符数）
    const MAX_DIRECT_SIZE: usize = 100_000;
    if content_size > MAX_DIRECT_SIZE {
        return Ok(GetResponse::TooLarge {
            error: "content_too_large".to_string(),
            r#ref: params.r#ref,
            size: content_size,
            suggestion: format!(
                "使用 --output 导出到文件，或用 --range 0-{} 分块获取",
                MAX_DIRECT_SIZE
            ),
        });
    }

    Ok(GetResponse::Success {
        r#ref: params.r#ref,
        r#type: effective_type.to_string(),
        content,
        content_size,
        image_count,
    })
}

/// 查找 session 文件
pub fn find_session_file(
    config: &Config,
    session_prefix: &str,
    project_id: Option<&str>,
) -> Result<(String, String, PathBuf), ErrorResponse> {
    // 确定要搜索的项目
    let project_dirs: Vec<(String, PathBuf)> = if let Some(pid) = project_id {
        let dir = config.project_dir(pid)?;
        if !dir.exists() {
            return Err(ErrorResponse {
                error: "project_not_found".to_string(),
                message: format!("项目不存在: {}", pid),
                available: None,
            });
        }
        vec![(pid.to_string(), dir)]
    } else if let Some(pid) = config.current_project_id() {
        // 优先搜当前项目（current_project_id 返回的 id 已通过 cwd 转码,可信）
        match config.project_dir(&pid) {
            Ok(dir) => vec![(pid.clone(), dir)],
            Err(_) => config.list_project_dirs().unwrap_or_default(),
        }
    } else {
        config.list_project_dirs().unwrap_or_default()
    };

    // 在项目中查找匹配的 session
    if let Some(result) = search_session_in_dirs(&project_dirs, session_prefix) {
        return Ok(result);
    }

    // 当前项目未找到时，fallback 到搜索所有项目
    // （search 返回的 ref 可能来自其他项目，用户未必传 project 参数）
    if project_id.is_none() {
        if let Ok(all_dirs) = config.list_project_dirs() {
            // 排除已搜过的当前项目，避免重复扫描
            let remaining: Vec<_> = all_dirs
                .into_iter()
                .filter(|(id, _)| !project_dirs.iter().any(|(pid, _)| pid == id))
                .collect();
            if !remaining.is_empty() {
                if let Some(result) = search_session_in_dirs(&remaining, session_prefix) {
                    return Ok(result);
                }
            }
        }
    }

    Err(ErrorResponse {
        error: "session_not_found".to_string(),
        message: format!("找不到 session: {}", session_prefix),
        available: None,
    })
}

/// 在指定的项目目录列表中搜索匹配 session prefix 的文件
fn search_session_in_dirs(
    project_dirs: &[(String, PathBuf)],
    session_prefix: &str,
) -> Option<(String, String, PathBuf)> {
    for (project_id, dir) in project_dirs {
        // 搜索主目录的 .jsonl 文件
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    continue;
                }

                let filename = entry.file_name().to_string_lossy().to_string();
                if let Some(session_id) = session_id_from_filename(&filename) {
                    if ref_prefix(&session_id) == session_prefix {
                        return Some((project_id.clone(), session_id, path));
                    }
                }
            }
        }

        // 搜索 subagents 目录中的 agent session
        let subagents_pattern = dir.join("*/subagents");
        if let Ok(entries) = glob::glob(&subagents_pattern.to_string_lossy()) {
            for subdir in entries.flatten() {
                if let Ok(sub_entries) = fs::read_dir(&subdir) {
                    for entry in sub_entries.flatten() {
                        let path = entry.path();
                        if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                            continue;
                        }
                        let filename = entry.file_name().to_string_lossy().to_string();
                        if filename.starts_with("agent-") {
                            let session_id = filename
                                .strip_suffix(".jsonl")
                                .unwrap_or(&filename)
                                .to_string();
                            if ref_prefix(&session_id) == session_prefix {
                                return Some((project_id.clone(), session_id, path));
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// 写入输出文件
fn write_output(
    output_dir: &PathBuf,
    r#ref: &str,
    record: &MessageRecord,
    content: &str,
    image_count: usize,
) -> Result<GetResponse, ErrorResponse> {
    // 路径校验：output_dir 必须在 cwd 内（避免 chmod-anywhere）
    validate_output_dir(output_dir)?;

    // 仅当目录是新建时才 chmod 0o700，避免 chmod 用户已有目录
    let was_new = !output_dir.exists();
    fs::create_dir_all(output_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建输出目录: {}", e),
        available: None,
    })?;
    if was_new {
        set_private_permissions(output_dir, 0o700, "目录")?;
    }

    let safe_ref = r#ref.replace(':', "_");

    // 写入内容文件（mode 0o600）
    let content_path = output_dir.join(format!("{}.txt", safe_ref));
    let mut file = File::create(&content_path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建文件: {}", e),
        available: None,
    })?;
    set_private_permissions(&content_path, 0o600, "文件")?;
    file.write_all(content.as_bytes())
        .map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("写入文件失败: {}", e),
            available: None,
        })?;

    // 导出图片（失败时记录 warning，不中断）
    let mut image_paths = Vec::new();
    let mut image_warnings = Vec::new();
    let images = extract_images(record);
    for img in &images {
        if let Some((ext, data)) = extract_image_data(record, img.index) {
            let img_path = output_dir.join(format!("{}_img{}.{}", safe_ref, img.index, ext));
            match File::create(&img_path) {
                Ok(mut img_file) => {
                    if let Err(e) = img_file.write_all(&data) {
                        image_warnings.push(format!("图片 {} 写入失败: {}", img.index, e));
                    } else {
                        let _ = set_private_permissions(&img_path, 0o600, "图片文件");
                        image_paths.push(img_path);
                    }
                }
                Err(e) => {
                    image_warnings.push(format!("图片 {} 创建失败: {}", img.index, e));
                }
            }
        }
    }
    if !image_warnings.is_empty() {
        eprintln!("[get] 图片导出警告: {}", image_warnings.join("; "));
    }

    Ok(GetResponse::Output {
        r#ref: r#ref.to_string(),
        output: OutputInfo {
            content: content_path,
            images: image_paths,
        },
        content_size: content.chars().count(),
        image_count,
    })
}

/// 校验 output_dir 必须在 cwd 内（避免 chmod-anywhere/写文件到用户家目录）
fn validate_output_dir(output_dir: &Path) -> Result<(), ErrorResponse> {
    let cwd = std::env::current_dir().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法获取当前工作目录: {}", e),
        available: None,
    })?;

    // 不允许 `..` 组件（避免 ../../etc 之类的逃出）
    if output_dir
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: "输出目录路径不允许包含 `..` 组件".to_string(),
            available: None,
        });
    }

    let absolute = if output_dir.is_absolute() {
        output_dir.to_path_buf()
    } else {
        cwd.join(output_dir)
    };

    // canonicalize 解析 symlink 与 `..`，防止通过 symlink 逃出 cwd
    // 如果路径还不存在，则向上找到第一个存在的祖先 canonicalize 后再拼接剩余路径
    let canonical_cwd = fs::canonicalize(&cwd).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("canonicalize cwd 失败: {}", e),
        available: None,
    })?;

    let canonical_target = canonicalize_or_ancestor(&absolute).map_err(|e| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("canonicalize 输出路径失败: {}", e),
        available: None,
    })?;

    if !canonical_target.starts_with(&canonical_cwd) {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!(
                "输出目录必须在当前工作目录内: cwd={}, output={}",
                canonical_cwd.display(),
                canonical_target.display()
            ),
            available: None,
        });
    }

    Ok(())
}

/// 对路径做 canonicalize；若路径不存在则向上找到第一个存在的祖先 canonicalize 后再拼接剩余部分
fn canonicalize_or_ancestor(path: &Path) -> std::io::Result<PathBuf> {
    if let Ok(canonical) = fs::canonicalize(path) {
        return Ok(canonical);
    }
    // 路径不存在，向上找到第一个存在的祖先
    let mut current = path.to_path_buf();
    let mut tail = PathBuf::new();
    while let Some(parent) = current.parent() {
        if let Some(name) = current.file_name() {
            let mut new_tail = PathBuf::from(name);
            new_tail.push(&tail);
            tail = new_tail;
        }
        current = parent.to_path_buf();
        if current.exists() {
            let canonical = fs::canonicalize(&current)?;
            return Ok(canonical.join(tail));
        }
        if current.as_os_str().is_empty() {
            break;
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("无法 canonicalize 路径: {}", path.display()),
    ))
}

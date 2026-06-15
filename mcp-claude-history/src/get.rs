use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

const TMP_PATH_PREFIX: &str = "tmp:";
const CWD_PATH_PREFIX: &str = "cwd:";

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

fn open_private_file(path: &Path, target: &str) -> Result<File, ErrorResponse> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建{}: {}", target, e),
        available: None,
    })?;
    set_private_permissions(path, 0o600, target)?;
    Ok(file)
}

/// Get 参数
pub struct GetParams {
    pub r#ref: String,
    pub range: Option<(usize, usize)>,
    pub output: Option<String>,
    pub project: Option<String>,
    pub redaction: RedactionMode,
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
    let (_project_id, _session_id, path) =
        find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;

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
    let raw_content = replace_images_with_placeholders(&record);
    let images = extract_images(&record);
    let image_count = images.len();
    let original_content_size = raw_content.chars().count();

    let ranged_content = if let Some((start, end)) = params.range {
        if start > end {
            return Err(invalid_range_response(start, end, original_content_size));
        }
        if start >= original_content_size {
            return Err(invalid_range_response(start, end, original_content_size));
        }
        let end = end.min(original_content_size);
        raw_content.chars().skip(start).take(end - start).collect::<String>()
    } else {
        raw_content
    };
    let redaction = redact_text_with_mode(&ranged_content, params.redaction);
    let content = redaction.text;
    let selected_content_size = content.chars().count();

    if let Some(output_raw) = params.output {
        let resolved_output = resolve_output_files(
            &output_raw,
            &format!("{}.txt", params.r#ref.replace(':', "_")),
            "manifest.json",
        )?;
        return write_output(OutputWriteRequest {
            output: resolved_output,
            r#ref: &params.r#ref,
            record: &record,
            content: &content,
            content_size: selected_content_size,
            original_content_size,
            image_count,
            redaction_mode: params.redaction,
            redacted_count: redaction.count,
        });
    }

    const MAX_DIRECT_SIZE: usize = 100_000;
    if selected_content_size > MAX_DIRECT_SIZE {
        return Ok(GetResponse::TooLarge {
            error: "content_too_large".to_string(),
            r#ref: params.r#ref,
            size: selected_content_size,
            content_size: selected_content_size,
            valid_range: valid_range_label(original_content_size),
            suggestion: format!("使用 --output 导出到文件，或用 --range 0-{} 分块获取", MAX_DIRECT_SIZE),
            truncation_reason: format!(
                "content_size {} exceeds max direct response {}",
                selected_content_size, MAX_DIRECT_SIZE
            ),
            output_suggestion: "使用 output=tmp:export 导出到受控临时目录，或 output=cwd:export 持久化到当前工作目录"
                .to_string(),
            range_suggestion: format!("0-{}", MAX_DIRECT_SIZE.min(original_content_size)),
            parsed_range: params.range.map(|(start, end)| RangeInfo { start, end }),
            head: content.chars().take(2000).collect(),
            tail: tail_chars(&content, 2000),
        });
    }

    Ok(GetResponse::Success {
        r#ref: params.r#ref,
        r#type: effective_type.to_string(),
        content,
        content_size: selected_content_size,
        image_count,
    })
}

fn tail_chars(content: &str, max_len: usize) -> String {
    let char_count = content.chars().count();
    if char_count <= max_len {
        return content.to_string();
    }
    content.chars().skip(char_count - max_len).collect()
}

fn valid_range_example(original_content_size: usize) -> Option<String> {
    if original_content_size == 0 {
        return None;
    }
    Some(format!("0-{}", original_content_size.min(100_000)))
}

fn valid_range_label(original_content_size: usize) -> String {
    valid_range_example(original_content_size).unwrap_or_else(|| "empty content has no valid range".to_string())
}

fn invalid_range_response(start: usize, end: usize, original_content_size: usize) -> ErrorResponse {
    ErrorResponse {
        error: "invalid_range".to_string(),
        message: format!(
            "range {}-{} 无效，original_content_size={}，valid_range 示例 {}",
            start,
            end,
            original_content_size,
            valid_range_label(original_content_size)
        ),
        available: Some(serde_json::json!({
            "original_content_size": original_content_size,
            "valid_range": valid_range_example(original_content_size),
            "parsed_range": { "start": start, "end": end }
        })),
    }
}

/// 查找 session 文件
pub fn find_session_file(
    config: &Config,
    session_prefix: &str,
    project_id: Option<&str>,
) -> Result<(String, String, PathBuf), ErrorResponse> {
    // 确定要搜索的项目
    let project_dirs: Vec<(String, PathBuf)> = if let Some(pid) = project_id {
        let normalized = config.normalize_project_id(pid)?;
        let dir = config.project_dir(&normalized)?;
        if !dir.exists() {
            return Err(ErrorResponse {
                error: "project_not_found".to_string(),
                message: format!("项目不存在: {}", normalized),
                available: None,
            });
        }
        vec![(normalized, dir)]
    } else if let Some(pid) = config.current_project_id() {
        // 优先搜当前项目（current_project_id 返回的 id 已通过 cwd 转码,可信）
        match config.project_dir(&pid) {
            Ok(dir) => vec![(pid.clone(), dir)],
            Err(_) => config.list_project_dirs().unwrap_or_default(),
        }
    } else {
        config.list_project_dirs().unwrap_or_default()
    };

    let mut matches = search_sessions_in_dirs(&project_dirs, session_prefix);

    if project_id.is_none()
        && let Ok(all_dirs) = config.list_project_dirs()
    {
        let remaining: Vec<_> = all_dirs
            .into_iter()
            .filter(|(id, _)| !project_dirs.iter().any(|(pid, _)| pid == id))
            .collect();
        if !remaining.is_empty() {
            matches.extend(search_sessions_in_dirs(&remaining, session_prefix));
        }
    }

    if matches.len() == 1 {
        return Ok(matches.remove(0));
    }
    if matches.len() > 1 {
        return Err(ErrorResponse {
            error: "session_ambiguous".to_string(),
            message: format!("session prefix 不唯一: {}，请传 project 或完整 ref", session_prefix),
            available: Some(serde_json::json!({
                "candidates": matches
                    .iter()
                    .map(|(project, session, _)| format!("{}:{}", project, session))
                    .collect::<Vec<_>>()
            })),
        });
    }

    Err(ErrorResponse {
        error: "session_not_found".to_string(),
        message: format!("找不到 session: {}", session_prefix),
        available: None,
    })
}

/// 在指定的项目目录列表中搜索匹配 session prefix 的文件
fn search_sessions_in_dirs(project_dirs: &[(String, PathBuf)], session_prefix: &str) -> Vec<(String, String, PathBuf)> {
    let mut matches = Vec::new();
    for (project_id, dir) in project_dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    continue;
                }

                let filename = entry.file_name().to_string_lossy().to_string();
                if let Some(session_id) = session_id_from_filename(&filename)
                    && (ref_prefix(&session_id) == session_prefix || session_id == session_prefix)
                {
                    matches.push((project_id.clone(), session_id, path));
                }
            }
        }

        for sidechain_dir in SIDECHAIN_SESSION_DIRS {
            let pattern = dir.join("*/").join(sidechain_dir);
            if let Ok(entries) = glob::glob(&pattern.to_string_lossy()) {
                for subdir in entries.flatten() {
                    if let Ok(sub_entries) = fs::read_dir(&subdir) {
                        for entry in sub_entries.flatten() {
                            let path = entry.path();
                            if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                                continue;
                            }
                            let filename = entry.file_name().to_string_lossy().to_string();
                            if filename.starts_with("agent-") {
                                let session_id = filename.strip_suffix(".jsonl").unwrap_or(&filename).to_string();
                                if ref_prefix(&session_id) == session_prefix || session_id == session_prefix {
                                    matches.push((project_id.clone(), session_id, path));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    matches
}

pub struct ResolvedOutputFiles {
    pub directory: PathBuf,
    pub content: PathBuf,
    pub manifest: PathBuf,
}

pub fn resolve_output_files(
    raw_output: &str,
    default_file_name: &str,
    default_manifest_name: &str,
) -> Result<ResolvedOutputFiles, ErrorResponse> {
    let trimmed = raw_output.trim();
    let path_part = trimmed
        .strip_prefix(TMP_PATH_PREFIX)
        .or_else(|| trimmed.strip_prefix(CWD_PATH_PREFIX))
        .unwrap_or(trimmed);
    let requested_path = Path::new(path_part);
    if requested_path.extension().is_none() {
        let directory = resolve_output_dir(trimmed)?;
        return Ok(ResolvedOutputFiles {
            content: directory.join(default_file_name),
            manifest: directory.join(default_manifest_name),
            directory,
        });
    }

    let file_name = requested_path.file_name().ok_or_else(|| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: "output 指向文件时必须包含文件名".to_string(),
        available: Some(serde_json::json!({
            "examples": ["tmp:export.txt", "tmp:export/output.txt", "cwd:export/output.txt"]
        })),
    })?;
    let parent = requested_path.parent().unwrap_or_else(|| Path::new("."));
    let parent_output = prefixed_parent_output(trimmed, parent);
    let directory = resolve_output_dir(&parent_output)?;
    let content = directory.join(file_name);
    let manifest_name = format!(
        "{}_manifest.json",
        content.file_stem().and_then(|s| s.to_str()).unwrap_or("output")
    );
    let manifest = content.with_file_name(manifest_name);
    Ok(ResolvedOutputFiles {
        directory,
        content,
        manifest,
    })
}

fn prefixed_parent_output(trimmed: &str, parent: &Path) -> String {
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    if trimmed.starts_with(TMP_PATH_PREFIX) {
        format!("{}{}", TMP_PATH_PREFIX, parent.display())
    } else if trimmed.starts_with(CWD_PATH_PREFIX) {
        format!("{}{}", CWD_PATH_PREFIX, parent.display())
    } else {
        parent.display().to_string()
    }
}

struct OutputWriteRequest<'a> {
    output: ResolvedOutputFiles,
    r#ref: &'a str,
    record: &'a MessageRecord,
    content: &'a str,
    content_size: usize,
    original_content_size: usize,
    image_count: usize,
    redaction_mode: RedactionMode,
    redacted_count: usize,
}

/// 写入输出文件
fn write_output(request: OutputWriteRequest<'_>) -> Result<GetResponse, ErrorResponse> {
    let output_dir = request.output.directory;
    let content_path = request.output.content;
    let manifest_path = request.output.manifest;
    let safe_ref = request.r#ref.replace(':', "_");

    let was_new = !output_dir.exists();
    fs::create_dir_all(&output_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建输出目录: {}", e),
        available: None,
    })?;
    if was_new {
        set_private_permissions(&output_dir, 0o700, "目录")?;
    }

    let mut file = open_private_file(&content_path, "文件")?;
    file.write_all(request.content.as_bytes()).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("写入文件失败: {}", e),
        available: None,
    })?;

    // 导出图片（失败时记录 warning，不中断）
    let mut image_paths = Vec::new();
    let mut image_warnings = Vec::new();
    let images = extract_images(request.record);
    for img in &images {
        if let Some((ext, data)) = extract_image_data(request.record, img.index) {
            let img_path = output_dir.join(format!("{}_img{}.{}", safe_ref, img.index, ext));
            match open_private_file(&img_path, "图片文件") {
                Ok(mut img_file) => {
                    if let Err(e) = img_file.write_all(&data) {
                        image_warnings.push(format!("图片 {} 写入失败: {}", img.index, e));
                    } else {
                        image_paths.push(img_path);
                    }
                }
                Err(e) => {
                    image_warnings.push(format!("图片 {} 创建失败: {}", img.index, e.message));
                }
            }
        }
    }
    if !image_warnings.is_empty() {
        eprintln!("[get] 图片导出警告: {}", image_warnings.join("; "));
    }

    let bytes = fs::metadata(&content_path).map(|m| m.len()).unwrap_or(0);
    let lines = request.content.lines().count();
    let redaction = redaction_info(
        request.redaction_mode,
        request.redacted_count,
        request.redaction_mode == RedactionMode::Off || request.redacted_count > 0,
    );
    let manifest = serde_json::json!({
        "schema": "mcp-claude-history.get-output.v1",
        "ref": request.r#ref,
        "content_size": request.content_size,
        "original_content_size": request.original_content_size,
        "content": content_path,
        "images": &image_paths,
        "bytes": bytes,
        "lines": lines,
        "complete": true,
        "sample_kind": if request.content_size == request.original_content_size { "all" } else { "range" },
        "redaction": &redaction,
    });
    let mut manifest_file = open_private_file(&manifest_path, "manifest")?;
    manifest_file
        .write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
        .map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("写入 manifest 失败: {}", e),
            available: None,
        })?;

    Ok(GetResponse::Output {
        r#ref: request.r#ref.to_string(),
        output: OutputInfo {
            content: content_path,
            manifest: manifest_path,
            images: image_paths,
            bytes,
            lines,
            schema: "mcp-claude-history.get-output.v1".to_string(),
            complete: true,
            sample_kind: if request.content_size == request.original_content_size {
                "all"
            } else {
                "range"
            }
            .to_string(),
            redaction,
        },
        content_size: request.content_size,
        original_content_size: request.original_content_size,
        image_count: request.image_count,
    })
}

pub fn resolve_output_dir(raw_output: &str) -> Result<PathBuf, ErrorResponse> {
    let trimmed = raw_output.trim();
    if trimmed.is_empty() {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: "输出目录不能为空".to_string(),
            available: None,
        });
    }

    let cwd_root = fs::canonicalize(env::current_dir().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法获取当前工作目录: {}", e),
        available: None,
    })?)
    .map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("canonicalize cwd 失败: {}", e),
        available: None,
    })?;

    let temp_root = controlled_temp_root()?;

    if let Some(relative) = trimmed.strip_prefix(CWD_PATH_PREFIX) {
        return resolve_relative_output_dir(relative, &cwd_root, "cwd:");
    }
    if let Some(relative) = trimmed.strip_prefix(TMP_PATH_PREFIX) {
        return resolve_relative_output_dir(relative, &temp_root, "tmp:");
    }

    let raw_path = PathBuf::from(trimmed);
    if raw_path.is_absolute() {
        return resolve_absolute_output_dir(&raw_path, &cwd_root, &temp_root);
    }

    resolve_relative_output_dir(trimmed, &temp_root, TMP_PATH_PREFIX)
}

fn controlled_temp_root() -> Result<PathBuf, ErrorResponse> {
    let root = env::temp_dir().join("claude-tools").join("mcp-claude-history");
    fs::create_dir_all(&root).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建临时目录: {}", e),
        available: None,
    })?;
    set_private_permissions(&root, 0o700, "临时目录")?;
    fs::canonicalize(&root).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("canonicalize 临时目录失败: {}", e),
        available: None,
    })
}

fn resolve_relative_output_dir(relative: &str, root: &Path, prefix: &str) -> Result<PathBuf, ErrorResponse> {
    if relative.is_empty() {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{} 后面必须跟相对路径", prefix),
            available: None,
        });
    }

    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{} 只接受相对路径", prefix),
            available: None,
        });
    }
    if relative_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{} 路径不允许包含 `..` 组件", prefix),
            available: None,
        });
    }

    let candidate = root.join(relative_path);
    let canonical_target = canonicalize_or_ancestor(&candidate).map_err(|e| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("canonicalize 输出路径失败: {}", e),
        available: None,
    })?;

    assert_within_allowed_root(&canonical_target, root)?;
    Ok(candidate)
}

fn resolve_absolute_output_dir(absolute: &Path, cwd_root: &Path, temp_root: &Path) -> Result<PathBuf, ErrorResponse> {
    let canonical_target = canonicalize_or_ancestor(absolute).map_err(|e| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("canonicalize 输出路径失败: {}", e),
        available: None,
    })?;

    if is_within_root(&canonical_target, cwd_root) || is_within_root(&canonical_target, temp_root) {
        return Ok(absolute.to_path_buf());
    }

    Err(ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!(
            "输出目录超出允许范围: {}，仅允许当前工作目录或受控临时目录；临时导出请使用 tmp:relative/path，仓库内持久化请使用 cwd:relative/path",
            canonical_target.display()
        ),
        available: Some(serde_json::json!({
            "examples": ["tmp:export", "tmp:export/search-results.jsonl", "cwd:export"],
            "note": "普通相对路径默认写入受控临时目录，tmp: 和 cwd: 后面都必须是相对路径"
        })),
    })
}

fn assert_within_allowed_root(path: &Path, root: &Path) -> Result<(), ErrorResponse> {
    if is_within_root(path, root) {
        return Ok(());
    }

    Err(ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!(
            "输出目录超出允许范围: {}，允许根目录为 {}",
            path.display(),
            root.display()
        ),
        available: None,
    })
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
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

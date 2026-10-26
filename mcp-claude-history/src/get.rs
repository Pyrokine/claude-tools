use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

const TMP_PATH_PREFIX: &str = "tmp:";
const CWD_PATH_PREFIX: &str = "cwd:";

/// Get 参数
pub struct GetParams {
    pub r#ref: String,
    pub range: Option<(usize, usize)>,
    pub output: Option<String>,
    pub project: Option<String>,
    pub source: Option<String>,
    pub redaction: RedactionMode,
    pub overwrite: bool,
    pub view: Option<String>,
    pub block: Option<usize>,
}

/// 获取完整内容
pub fn get(config: &Config, params: GetParams) -> Result<GetResponse, ErrorResponse> {
    if params.overwrite && params.output.is_none() {
        return Err(invalid_arguments("overwrite=true 需要 output"));
    }
    let view = params.view.as_deref().unwrap_or("content");
    if !matches!(view, "content" | "tool_input" | "tool_result" | "record") {
        return Err(invalid_arguments(
            "view 仅支持 content、tool_input、tool_result、record",
        ));
    }
    if params.block.is_some() && !matches!(view, "tool_input" | "tool_result") {
        return Err(invalid_arguments("block 需要 view=tool_input 或 tool_result"));
    }
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
        params.source.as_deref(),
    )?;

    // 读取指定行
    let file = crate::session_files::open_session_file(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {e}"),
        available: None,
    })?;

    let snapshot_end = file.metadata().map_err(session_io_error)?.len();
    let mut lines = crate::record_reader::RecordLines::new(file.try_clone().map_err(session_io_error)?, snapshot_end);
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut remaining = u64::MAX;
    let located = loop {
        match lines.step(&mut remaining, deadline)? {
            crate::record_reader::LineStep::Record(record) if record.line == parsed_ref.line => break record,
            crate::record_reader::LineStep::Record(_) => {}
            crate::record_reader::LineStep::Yield => {
                return Err(crate::record_reader::reader_error(
                    "deadline_exceeded",
                    "定位消息超过执行时间",
                ));
            }
            crate::record_reader::LineStep::End => {
                return Err(crate::record_reader::reader_error(
                    "ref_not_found",
                    format!("ref 不存在: {}", params.r#ref),
                ));
            }
        }
    };
    if located.small.is_none() || params.view.as_deref().is_some_and(|view| view != "content") {
        let span = located.span;
        drop(located);
        return get_indexed(file, span, params);
    }
    let line = located.small.expect("bounded message line");

    // 解析消息
    let record: MessageRecord = serde_json::from_slice(&line).map_err(|e| ErrorResponse {
        error: "parse_error".to_string(),
        message: format!("解析消息失败: {e}"),
        available: None,
    })?;

    // 提取内容和图片
    let (effective_type, _) = classify_message(&record);
    let raw_content = replace_images_with_placeholders(&record);
    let images = if params.view.as_deref().is_none_or(|view| view == "content") {
        extract_images(&record)
    } else {
        Vec::new()
    };
    let image_count = images.len();
    let original_content_size = raw_content.chars().count();

    let selected_range = if let Some((start, end)) = params.range {
        if start > end || start >= original_content_size {
            return Err(invalid_range_response(start, end, original_content_size));
        }
        Some((start, end.min(original_content_size)))
    } else {
        None
    };
    let redaction = redact_text_range_with_mode(&raw_content, params.redaction, selected_range);
    let content = redaction.text;
    let selected_content_size = content.chars().count();

    if let Some(output_raw) = params.output {
        if image_count > 64 {
            return Err(ErrorResponse {
                error: "export_image_limit".to_string(),
                message: "单次导出最多包含 64 张图片".to_string(),
                available: None,
            });
        }
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
            range_selected: selected_range.is_some(),
            redaction_mode: params.redaction,
            redacted_count: redaction.count,
            overwrite: params.overwrite,
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
            suggestion: format!("使用 --output 导出到文件，或用 --range 0-{MAX_DIRECT_SIZE} 分块获取"),
            truncation_reason: format!(
                "content_size {selected_content_size} exceeds max direct response {MAX_DIRECT_SIZE}"
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

fn get_indexed(
    file: File,
    span: crate::record_reader::SourceSpan,
    params: GetParams,
) -> Result<GetResponse, ErrorResponse> {
    use crate::record_reader::{TextBytes, check_work, index_record, reader_error, render_text_range};
    let view = params.view.as_deref().unwrap_or("content");
    let indexed = index_record(file.try_clone().map_err(session_io_error)?, span, view != "record")?;
    let (effective_type, _) = indexed.classify(file.try_clone().map_err(session_io_error)?, span)?;
    if indexed.metadata.is_none() && view != "record" {
        return Err(reader_error("parse_error", "目标行不是消息记录"));
    }
    let projection = if view == "content" {
        indexed.projection(file.try_clone().map_err(session_io_error)?, span, view, params.block)?
    } else {
        indexed.structured_projection(
            file.try_clone().map_err(session_io_error)?,
            span,
            view,
            params.block,
            params.redaction,
        )?
    };
    let images = if view == "content" {
        indexed.image_sources(file.try_clone().map_err(session_io_error)?, span)?
    } else {
        Vec::new()
    };
    let image_count = images.len();
    let mut text = TextBytes::new(projection.cursor(file.try_clone().map_err(session_io_error)?, span));
    if let Some(output_raw) = params.output.as_deref() {
        if image_count > 64 {
            return Err(reader_error("export_image_limit", "单次导出最多包含 64 张图片"));
        }
        let resolved = resolve_output_files(
            output_raw,
            &format!("{}.txt", params.r#ref.replace(':', "_")),
            "manifest.json",
        )?;
        let retention = resolved.temp_output.then(|| TEMP_OUTPUT_RETENTION.to_string());
        let transaction = OutputTransaction::begin(resolved, params.overwrite)?;
        let mut output = open_private_output_file(&transaction.staging_content())?;
        let mut lines = 0;
        let mut last = None;
        let (original_content_size, content_size, redacted_count) =
            render_text_range(&mut text, params.redaction, params.range, |chunk| {
                check_work()?;
                output.write_all(chunk).map_err(session_io_error)?;
                lines += chunk.iter().filter(|byte| **byte == b'\n').count();
                last = chunk.last().copied().or(last);
                Ok(())
            })?;
        lines += usize::from(last.is_some_and(|byte| byte != b'\n'));
        output.sync_all().map_err(session_io_error)?;
        let bytes = output.metadata().map_err(session_io_error)?.len();
        let mut image_paths = Vec::new();
        for (index, projection, extension) in images {
            check_work()?;
            let name = format!("{}_img{index}.{extension}", params.r#ref.replace(':', "_"));
            let mut image = open_private_output_file(&transaction.staging_dir().join(&name))?;
            let cursor = projection.cursor(file.try_clone().map_err(session_io_error)?, span);
            let mut decoder = base64::read::DecoderReader::new(cursor, &base64::engine::general_purpose::STANDARD);
            std::io::copy(&mut decoder, &mut image).map_err(|error| {
                reader_error(
                    "image_export_failed",
                    format!("图片 {index} 解码或写入失败，导出未发布: {error}"),
                )
            })?;
            image.sync_all().map_err(session_io_error)?;
            image_paths.push(transaction.final_dir().join(name));
        }
        let redaction = redaction_info(
            params.redaction,
            redacted_count,
            params.redaction == RedactionMode::Off || redacted_count > 0,
        );
        let content_path = transaction.content();
        let manifest_path = transaction.manifest();
        let sample_kind = if params.range.is_some() { "range" } else { "all" }.to_string();
        let manifest = serde_json::json!({
            "schema": "mcp-claude-history.get-output.v2", "ref": params.r#ref, "view": view, "block": params.block,
            "content_size": content_size, "original_content_size": original_content_size, "content": content_path,
            "images": image_paths, "bytes": bytes, "lines": lines, "complete": true, "sample_kind": sample_kind, "redaction": redaction,
        });
        let mut manifest_file = open_private_output_file(&transaction.staging_manifest())?;
        manifest_file
            .write_all(
                &serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| reader_error("serialize_error", error.to_string()))?,
            )
            .map_err(session_io_error)?;
        manifest_file.sync_all().map_err(session_io_error)?;
        check_work()?;
        transaction.publish()?;
        return Ok(GetResponse::Output {
            r#ref: params.r#ref,
            output: OutputInfo {
                content: content_path,
                manifest: manifest_path,
                images: image_paths,
                bytes,
                lines,
                schema: "mcp-claude-history.get-output.v2".to_string(),
                complete: true,
                sample_kind,
                redaction,
                retention,
            },
            content_size,
            original_content_size,
            image_count,
        });
    }
    const MAX_DIRECT_SIZE: usize = 100_000;
    let mut content = String::new();
    let mut head = String::new();
    let mut tail = std::collections::VecDeque::with_capacity(2000);
    let mut collected = 0;
    let (original_size, content_size, _) = render_text_range(&mut text, params.redaction, params.range, |chunk| {
        let chunk = std::str::from_utf8(chunk).map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?;
        for character in chunk.chars() {
            if collected < MAX_DIRECT_SIZE {
                content.push(character);
            }
            if collected < 2000 {
                head.push(character);
            }
            if tail.len() == 2000 {
                tail.pop_front();
            }
            tail.push_back(character);
            collected += 1;
        }
        Ok(())
    })?;
    check_work()?;
    if content_size > MAX_DIRECT_SIZE {
        return Ok(GetResponse::TooLarge {
            error: "content_too_large".to_string(),
            r#ref: params.r#ref,
            size: content_size,
            content_size,
            valid_range: valid_range_label(original_size),
            suggestion: "使用 output 导出或 range 分块读取".to_string(),
            truncation_reason: format!("content_size {content_size} exceeds max direct response {MAX_DIRECT_SIZE}"),
            output_suggestion: "output=tmp:export 或 output=cwd:export".to_string(),
            range_suggestion: format!("0-{}", MAX_DIRECT_SIZE.min(original_size)),
            parsed_range: params.range.map(|(start, end)| RangeInfo { start, end }),
            head,
            tail: tail.into_iter().collect(),
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
    source: Option<&str>,
) -> Result<(String, String, PathBuf), ErrorResponse> {
    if let Some(source) = source {
        let file = crate::session_files::resolve_exact_source(config, source)?;
        if !session_matches_ref(&file.1, session_prefix)
            || project_id
                .map(|project| config.normalize_project_id(project))
                .transpose()?
                .is_some_and(|project| project != file.0)
        {
            return Err(crate::record_reader::reader_error(
                "source_not_found",
                "source 与 ref/project 不匹配",
            ));
        }
        return Ok(file);
    }
    let selected_project = project_id;
    // 确定要搜索的项目
    let project_dirs: Vec<(String, PathBuf)> = if let Some(pid) = selected_project {
        let normalized = config.normalize_project_id(pid)?;
        let dir = config.project_dir(&normalized)?;
        if !dir.exists() {
            return Err(ErrorResponse {
                error: "project_not_found".to_string(),
                message: format!("项目不存在: {normalized}"),
                available: None,
            });
        }
        vec![(normalized, dir)]
    } else if let Some(pid) = config.current_project_id() {
        vec![(pid.clone(), config.project_dir(&pid)?)]
    } else {
        config.list_project_dirs().map_err(session_io_error)?
    };

    let mut matches = search_sessions_in_dirs(&project_dirs, session_prefix)?;

    if selected_project.is_none() {
        let all_dirs = config.list_project_dirs().map_err(session_io_error)?;
        let remaining: Vec<_> = all_dirs
            .into_iter()
            .filter(|(id, _)| !project_dirs.iter().any(|(pid, _)| pid == id))
            .collect();
        if !remaining.is_empty() {
            matches.extend(search_sessions_in_dirs(&remaining, session_prefix)?);
        }
    }

    if matches.len() == 1 {
        return Ok(matches.remove(0));
    }
    if matches.len() > 1 {
        return Err(ErrorResponse {
            error: "session_ambiguous".to_string(),
            message: format!(
                "session prefix 不唯一: {session_prefix}，请原样传入 available.sources 中的 source 精确选择物理来源"
            ),
            available: Some(serde_json::json!({
                "candidates": matches
                    .iter()
                    .map(|(project, session, _)| format!("{project}:{session}"))
                    .collect::<Vec<_>>(),
                "sources": matches.iter().map(|(project, session, path)| serde_json::json!({"project":project,"session":session,"source":path})).collect::<Vec<_>>()
            })),
        });
    }

    Err(ErrorResponse {
        error: "session_not_found".to_string(),
        message: format!("找不到 session: {session_prefix}"),
        available: None,
    })
}

/// 在指定的项目目录列表中搜索匹配 session prefix 的文件
fn session_io_error(error: std::io::Error) -> ErrorResponse {
    ErrorResponse {
        error: "io_error".to_string(),
        message: format!("搜索会话失败: {error}"),
        available: None,
    }
}

fn search_sessions_in_dirs(
    project_dirs: &[(String, PathBuf)],
    session_prefix: &str,
) -> Result<Vec<(String, String, PathBuf)>, ErrorResponse> {
    crate::session_files::collect_session_files(project_dirs, &[session_prefix.to_string()], true)
}

#[derive(Debug)]
pub struct ResolvedOutputFiles {
    pub directory: PathBuf,
    pub content: PathBuf,
    pub manifest: PathBuf,
    pub explicit_file: bool,
    pub temp_output: bool,
}

fn is_temp_output(raw_output: &str, directory: &Path) -> Result<bool, ErrorResponse> {
    if raw_output.starts_with(CWD_PATH_PREFIX) {
        return Ok(false);
    }
    if raw_output.starts_with(TMP_PATH_PREFIX) || !Path::new(raw_output).is_absolute() {
        return Ok(true);
    }
    Ok(directory.starts_with(controlled_temp_root()?))
}

pub fn resolve_output_files(
    raw_output: &str,
    default_file_name: &str,
    default_manifest_name: &str,
) -> Result<ResolvedOutputFiles, ErrorResponse> {
    validate_output_path(raw_output)?;
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
            temp_output: is_temp_output(trimmed, &directory)?,
            directory,
            explicit_file: false,
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
        temp_output: is_temp_output(trimmed, &directory)?,
        directory,
        content,
        manifest,
        explicit_file: true,
    })
}

static EXPORT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn export_nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        EXPORT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

const PUBLISH_JOURNAL_MAX_BYTES: u64 = 2048;
static PUBLISH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static PROCESS_INSTANCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[derive(serde::Serialize, serde::Deserialize)]
struct PublishJournal {
    version: u8,
    target: String,
    backup: String,
    token: String,
    owner: String,
}

fn process_instance() -> &'static str {
    PROCESS_INSTANCE.get_or_init(export_nonce)
}

fn owner_pid(owner: &str) -> Option<u32> {
    let mut parts = owner.split('-');
    let pid = parts.next()?.parse::<u32>().ok()?;
    if pid == 0
        || !parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        || !parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        || parts.next().is_some()
    {
        return None;
    }
    Some(pid)
}

#[cfg(unix)]
pub(crate) fn process_is_gone(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    (unsafe { libc::kill(pid, 0) }) == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(windows)]
pub(crate) fn process_is_gone(pid: u32) -> bool {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    unsafe {
        let handle = OpenProcess(0x0010_0000, 0, pid); // SYNCHRONIZE
        if handle.is_null() {
            return GetLastError() == 87; // ERROR_INVALID_PARAMETER: PID does not exist
        }
        let stopped = WaitForSingleObject(handle, 0) == 0; // WAIT_OBJECT_0
        CloseHandle(handle);
        stopped
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn process_is_gone(_pid: u32) -> bool {
    false
}

fn publish_journal_path(final_dir: &Path) -> Result<PathBuf, ErrorResponse> {
    let name = final_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_arguments("output 必须有 UTF-8 目录名"))?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in name.to_ascii_lowercase().bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    Ok(final_dir
        .parent()
        .ok_or_else(|| invalid_arguments("output 必须有父目录"))?
        .join(format!(".mcp-history-publish-{hash:016x}")))
}

fn sync_publish_directory(directory: &Path) -> Result<(), ErrorResponse> {
    #[cfg(unix)]
    {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| ErrorResponse {
                error: "output_sync_failed".to_string(),
                message: format!("同步导出目录 {} 失败: {error}", directory.display()),
                available: None,
            })?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn create_publish_journal(final_dir: &Path, backup: &Path, token: &str) -> Result<PathBuf, ErrorResponse> {
    let journal_path = publish_journal_path(final_dir)?;
    let journal = PublishJournal {
        version: 1,
        target: final_dir.file_name().unwrap().to_string_lossy().into_owned(),
        backup: backup.file_name().unwrap().to_string_lossy().into_owned(),
        token: token.to_string(),
        owner: process_instance().to_string(),
    };
    let bytes = serde_json::to_vec(&journal).map_err(|error| ErrorResponse {
        error: "serialize_error".to_string(),
        message: format!("序列化导出恢复记录失败: {error}"),
        available: None,
    })?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&journal_path).map_err(|error| ErrorResponse {
        error: if error.kind() == std::io::ErrorKind::AlreadyExists {
            "output_busy"
        } else {
            "io_error"
        }
        .to_string(),
        message: format!("无法建立导出恢复记录 {}: {error}", journal_path.display()),
        available: None,
    })?;
    let result = (|| {
        set_private_permissions(&journal_path, 0o600)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("同步导出恢复记录失败: {error}"),
                available: None,
            })?;
        sync_publish_directory(final_dir.parent().unwrap())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&journal_path);
        return Err(error);
    }
    Ok(journal_path)
}

fn recover_interrupted_export(final_dir: &Path) -> Result<(), ErrorResponse> {
    let journal_path = publish_journal_path(final_dir)?;
    let metadata = match fs::symlink_metadata(&journal_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(ErrorResponse {
                error: "output_restore_failed".to_string(),
                message: format!("无法检查导出恢复记录: {error}"),
                available: None,
            });
        }
    };
    let conflict = |reason: &str| ErrorResponse {
        error: "output_restore_failed".to_string(),
        message: format!("导出恢复记录 {} 无效: {reason}", journal_path.display()),
        available: None,
    };
    if !metadata.file_type().is_file() || metadata.len() > PUBLISH_JOURNAL_MAX_BYTES {
        return Err(conflict("类型或大小不符合预期"));
    }
    let mut bytes = Vec::new();
    File::open(&journal_path)
        .map_err(|_| conflict("无法读取"))?
        .take(PUBLISH_JOURNAL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| conflict("读取失败"))?;
    if bytes.len() as u64 > PUBLISH_JOURNAL_MAX_BYTES {
        return Err(conflict("记录过大"));
    }
    let journal: PublishJournal = serde_json::from_slice(&bytes).map_err(|_| conflict("JSON 格式错误"))?;
    let target_name = final_dir.file_name().and_then(|name| name.to_str());
    let suffix = journal.backup.strip_prefix(".mcp-history-backup-");
    if journal.version != 1
        || target_name != Some(journal.target.as_str())
        || !suffix.is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit() || b == b'-'))
        || journal.token.is_empty()
        || journal.token.len() > 128
    {
        return Err(conflict("目标、备份或版本不匹配"));
    }
    let journal_pid = owner_pid(&journal.owner).ok_or_else(|| conflict("原进程标记无效"))?;
    let age = metadata
        .modified()
        .map_err(|_| conflict("无法确认创建时间"))?
        .elapsed()
        .unwrap_or_default();
    if journal.owner != process_instance() && (age < Duration::from_secs(30) || !process_is_gone(journal_pid)) {
        return Err(ErrorResponse {
            error: "output_busy".to_string(),
            message: format!(
                "导出恢复记录 {} 的原进程仍在运行或无法确认已退出",
                journal_path.display()
            ),
            available: None,
        });
    }
    let backup = final_dir.parent().unwrap().join(&journal.backup);
    let backup_exists = match fs::symlink_metadata(&backup) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() && bundle_marker_matches(&backup) => {
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => return Err(conflict("原目录备份不完整或已被修改")),
    };
    let final_exists = match fs::symlink_metadata(final_dir) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() && bundle_marker_matches(final_dir) => {
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => return Err(conflict("目标目录不完整或已被修改")),
    };
    match (backup_exists, final_exists) {
        (true, false) => fs::rename(&backup, final_dir).map_err(|error| ErrorResponse {
            error: "output_restore_failed".to_string(),
            message: format!("无法从 {} 恢复旧输出: {error}", backup.display()),
            available: None,
        })?,
        (true, true) => {
            if !published_token_matches(final_dir, &journal.token) {
                return Err(conflict("当前输出无法确认属于此次发布，旧备份保留"));
            }
            fs::remove_dir_all(&backup).map_err(|error| ErrorResponse {
                error: "output_restore_failed".to_string(),
                message: format!("无法清理旧输出备份 {}: {error}", backup.display()),
                available: None,
            })?;
        }
        (false, false) => return Err(conflict("目标与原目录备份均不存在")),
        (false, true) => {}
    }
    sync_publish_directory(final_dir.parent().unwrap())?;
    remove_publish_journal(&journal_path)
}

fn remove_publish_journal(path: &Path) -> Result<(), ErrorResponse> {
    fs::remove_file(path).map_err(|error| ErrorResponse {
        error: "output_cleanup_failed".to_string(),
        message: format!("无法清理导出恢复记录 {}: {error}", path.display()),
        available: None,
    })?;
    sync_publish_directory(path.parent().unwrap())
}

#[derive(Debug)]
pub struct OutputTransaction {
    staging: PathBuf,
    final_dir: PathBuf,
    content_name: std::ffi::OsString,
    manifest_name: std::ffi::OsString,
    overwrite: bool,
    committed: bool,
    created_parents: Vec<PathBuf>,
}

fn planned_temp_parents(parent: &Path, is_temp: bool) -> Result<Vec<PathBuf>, ErrorResponse> {
    if !is_temp {
        return Ok(Vec::new());
    }
    let root = controlled_temp_root()?;
    if !parent.starts_with(&root) {
        return Err(invalid_arguments("临时输出父目录不属于当前会话"));
    }
    let mut missing = Vec::new();
    let mut current = parent;
    while current != root {
        match fs::symlink_metadata(current) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(invalid_arguments("临时输出父路径不是普通目录")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing.push(current.to_path_buf()),
            Err(error) => return Err(invalid_arguments(format!("无法检查临时输出父目录: {error}"))),
        }
        current = current
            .parent()
            .ok_or_else(|| invalid_arguments("临时输出父目录无效"))?;
        if missing.len() > SESSION_MAX_FILES {
            return Err(invalid_arguments("临时输出父目录超过会话文件数上限"));
        }
    }
    enforce_session_quota_with_extra(&root, missing.len() + 4, missing.len() as u64 * 4096)?;
    missing.reverse();
    Ok(missing)
}

impl OutputTransaction {
    pub fn begin(output: ResolvedOutputFiles, overwrite: bool) -> Result<Self, ErrorResponse> {
        if overwrite {
            let _guard = PUBLISH_LOCK
                .lock()
                .map_err(|_| invalid_arguments("导出发布状态不可用"))?;
            recover_interrupted_export(&output.directory)?;
        }
        let nonce = export_nonce();
        let final_dir = if output.explicit_file {
            let stem = output.content.file_stem().and_then(|s| s.to_str()).unwrap_or("export");
            if overwrite && bundle_marker_matches(&output.directory) {
                output.directory.clone()
            } else if overwrite {
                output.directory.join(format!("{stem}.export"))
            } else {
                output.directory.join(format!("{stem}.export-{nonce}"))
            }
        } else if overwrite {
            output.directory.clone()
        } else {
            let resolved = fs::canonicalize(&output.directory).ok();
            let cwd = env::current_dir().ok().and_then(|path| fs::canonicalize(path).ok());
            let temp = controlled_temp_root().ok();
            if resolved
                .as_ref()
                .is_some_and(|dir| cwd.as_ref() == Some(dir) || temp.as_ref() == Some(dir))
            {
                output.directory.join(format!("export-{nonce}"))
            } else {
                let name = output
                    .directory
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("export");
                output.directory.with_file_name(format!("{name}-{nonce}"))
            }
        };
        if overwrite && final_dir != output.directory {
            let _guard = PUBLISH_LOCK
                .lock()
                .map_err(|_| invalid_arguments("导出发布状态不可用"))?;
            recover_interrupted_export(&final_dir)?;
        }
        let parent = final_dir
            .parent()
            .ok_or_else(|| invalid_arguments("output 必须有父目录"))?
            .to_path_buf();
        let planned = planned_temp_parents(&parent, output.temp_output)?;
        let staging = parent.join(format!(".mcp-history-stage-{nonce}"));
        let mut transaction = Self {
            staging,
            final_dir,
            content_name: output.content.file_name().unwrap_or_default().to_os_string(),
            manifest_name: output.manifest.file_name().unwrap_or_default().to_os_string(),
            overwrite,
            committed: false,
            created_parents: Vec::new(),
        };
        if output.temp_output {
            for directory in planned {
                match fs::create_dir(&directory) {
                    Ok(()) => {
                        transaction.created_parents.push(directory.clone());
                        set_private_permissions(&directory, 0o700)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        checked_temp_directory(&directory).map_err(invalid_arguments)?;
                    }
                    Err(error) => {
                        return Err(ErrorResponse {
                            error: "io_error".to_string(),
                            message: format!("创建输出父目录失败: {error}"),
                            available: None,
                        });
                    }
                }
            }
        } else {
            fs::create_dir_all(&parent).map_err(|error| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("创建输出父目录失败: {error}"),
                available: None,
            })?;
        }
        fs::create_dir(&transaction.staging).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("创建暂存目录失败: {e}"),
            available: None,
        })?;
        if let Err(error) = set_private_permissions(&transaction.staging, 0o700) {
            transaction.committed = false;
            return Err(error);
        }
        Ok(transaction)
    }

    pub fn staging_content(&self) -> PathBuf {
        self.staging.join(&self.content_name)
    }

    pub fn staging_manifest(&self) -> PathBuf {
        self.staging.join(&self.manifest_name)
    }

    pub fn content(&self) -> PathBuf {
        self.final_dir.join(&self.content_name)
    }

    pub fn manifest(&self) -> PathBuf {
        self.final_dir.join(&self.manifest_name)
    }

    pub fn staging_dir(&self) -> &Path {
        &self.staging
    }

    pub fn final_dir(&self) -> &Path {
        &self.final_dir
    }

    pub fn publish(mut self) -> Result<(), ErrorResponse> {
        let sync = |path: &Path| -> Result<(), ErrorResponse> {
            OpenOptions::new()
                .read(true)
                .write(cfg!(windows))
                .open(path)
                .and_then(|file| file.sync_all())
                .map_err(|error| ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("同步输出文件失败: {error}"),
                    available: None,
                })
        };
        sync(&self.staging_content())?;
        sync(&self.staging_manifest())?;
        let mut marker = open_private_output_file(&self.staging.join(".mcp-history-bundle"))?;
        marker
            .write_all(b"mcp-claude-history.bundle.v1\n")
            .map_err(|error| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入导出归属标记失败: {error}"),
                available: None,
            })?;
        marker.sync_all().map_err(|error| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("同步导出归属标记失败: {error}"),
            available: None,
        })?;

        let _guard = PUBLISH_LOCK
            .lock()
            .map_err(|_| invalid_arguments("导出发布状态不可用"))?;
        if self.overwrite {
            recover_interrupted_export(&self.final_dir)?;
        }
        let had_existing = match fs::symlink_metadata(&self.final_dir) {
            Ok(meta) => {
                if !self.overwrite
                    || !meta.file_type().is_dir()
                    || meta.file_type().is_symlink()
                    || !bundle_marker_matches(&self.final_dir)
                {
                    return Err(ErrorResponse {
                        error: "output_exists".to_string(),
                        message: format!("输出目录已存在或不可安全替换: {}", self.final_dir.display()),
                        available: None,
                    });
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("无法检查输出目录: {error}"),
                    available: None,
                });
            }
        };
        let token = export_nonce();
        if had_existing {
            let mut file = open_private_output_file(&self.staging.join(".mcp-history-publish-token"))?;
            file.write_all(token.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|error| ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("同步导出发布标记失败: {error}"),
                    available: None,
                })?;
        }
        #[cfg(unix)]
        sync(&self.staging)?;
        enforce_session_quota(&self.staging)?;

        let parent = self.final_dir.parent().expect("output parent exists");
        let backup = parent.join(format!(".mcp-history-backup-{}", export_nonce()));
        let journal = if had_existing {
            match fs::symlink_metadata(&backup) {
                Ok(_) => {
                    return Err(ErrorResponse {
                        error: "output_busy".to_string(),
                        message: format!("输出备份目录已存在: {}", backup.display()),
                        available: None,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(ErrorResponse {
                        error: "io_error".to_string(),
                        message: format!("无法检查输出备份目录: {error}"),
                        available: None,
                    });
                }
            }
            let journal = create_publish_journal(&self.final_dir, &backup, &token)?;
            if let Err(error) = enforce_session_quota(&self.staging) {
                remove_publish_journal(&journal)?;
                return Err(error);
            }
            if let Err(error) = fs::rename(&self.final_dir, &backup) {
                remove_publish_journal(&journal)?;
                return Err(ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("无法将原输出目录移到备份（权限或文件占用）: {error}"),
                    available: None,
                });
            }
            if let Err(error) = sync_publish_directory(parent) {
                self.restore_previous(&backup, &journal)?;
                return Err(error);
            }
            Some(journal)
        } else {
            None
        };
        if let Err(error) = fs::rename(&self.staging, &self.final_dir) {
            if let Some(journal) = &journal {
                self.restore_previous(&backup, journal)?;
            }
            return Err(ErrorResponse {
                error: "io_error".to_string(),
                message: format!("发布输出失败（权限或文件占用）: {error}"),
                available: None,
            });
        }
        self.committed = true;
        sync_publish_directory(parent)?;
        if let Some(journal) = journal {
            fs::remove_dir_all(&backup).map_err(|error| ErrorResponse {
                error: "output_cleanup_failed".to_string(),
                message: format!("新输出已发布，但旧输出备份 {} 无法清理: {error}", backup.display()),
                available: None,
            })?;
            sync_publish_directory(parent)?;
            remove_publish_journal(&journal)?;
        }
        Ok(())
    }

    fn restore_previous(&self, backup: &Path, journal: &Path) -> Result<(), ErrorResponse> {
        fs::rename(backup, &self.final_dir).map_err(|error| ErrorResponse {
            error: "output_restore_failed".to_string(),
            message: format!("旧目录保留在 {}，但无法恢复原位置: {error}", backup.display()),
            available: None,
        })?;
        sync_publish_directory(self.final_dir.parent().unwrap())?;
        remove_publish_journal(journal)
    }
}

fn marker_matches(path: &Path, expected: &[u8]) -> bool {
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file() && meta.len() == expected.len() as u64) {
        return false;
    }
    let mut contents = Vec::new();
    File::open(path)
        .and_then(|file| file.take(expected.len() as u64 + 1).read_to_end(&mut contents))
        .is_ok_and(|_| contents == expected)
}

fn bundle_marker_matches(directory: &Path) -> bool {
    marker_matches(
        &directory.join(".mcp-history-bundle"),
        b"mcp-claude-history.bundle.v1\n",
    )
}

fn published_token_matches(directory: &Path, token: &str) -> bool {
    marker_matches(&directory.join(".mcp-history-publish-token"), token.as_bytes())
}

const SESSION_MAX_FILES: usize = 256;
const SESSION_MAX_BYTES: u64 = 128 * 1024 * 1024;

fn enforce_session_quota(staging: &Path) -> Result<(), ErrorResponse> {
    enforce_session_quota_with_extra(staging, 0, 0)
}

fn enforce_session_quota_with_extra(
    staging: &Path,
    additional_entries: usize,
    additional_bytes: u64,
) -> Result<(), ErrorResponse> {
    let temp_root = controlled_temp_root()?;
    if !staging.starts_with(&temp_root) {
        return Ok(());
    }
    let mut retries = 0;
    loop {
        let mut disappeared = false;
        let mut io_error = |error: std::io::Error| {
            disappeared = error.kind() == std::io::ErrorKind::NotFound;
            ErrorResponse {
                error: "io_error".to_string(),
                message: format!("无法检查临时导出配额: {error}"),
                available: None,
            }
        };
        let result = (|| {
            let mut pending = vec![temp_root.clone()];
            let mut count = 0usize;
            let mut bytes = 0u64;
            while let Some(directory) = pending.pop() {
                for entry in fs::read_dir(directory).map_err(&mut io_error)? {
                    let entry = entry.map_err(&mut io_error)?;
                    let kind = entry.file_type().map_err(&mut io_error)?;
                    if kind.is_symlink() {
                        return Err(ErrorResponse {
                            error: "export_quota_unverifiable".to_string(),
                            message: "临时会话目录中存在符号链接，无法校验导出配额".to_string(),
                            available: None,
                        });
                    }
                    let meta = entry.metadata().map_err(&mut io_error)?;
                    count += 1;
                    bytes = bytes.saturating_add(meta.len());
                    if count.saturating_add(additional_entries) > SESSION_MAX_FILES
                        || bytes.saturating_add(additional_bytes) > SESSION_MAX_BYTES
                    {
                        return Err(ErrorResponse {
                            error: "export_quota_exceeded".to_string(),
                            message: format!("临时会话导出超过 {SESSION_MAX_FILES} 项或 {SESSION_MAX_BYTES} 字节"),
                            available: None,
                        });
                    }
                    if kind.is_dir() {
                        pending.push(entry.path());
                    }
                }
            }
            Ok(())
        })();
        if result.is_ok() || !disappeared || retries == 7 {
            return result;
        }
        if retries == 0 {
            eprintln!("[mcp-claude-history] 导出目录在配额扫描期间发生变化，重新计算完整配额");
        }
        std::thread::sleep(Duration::from_millis(1 << retries));
        retries += 1;
    }
}

impl Drop for OutputTransaction {
    fn drop(&mut self) {
        if !self.committed {
            if let Err(error) = fs::remove_dir_all(&self.staging)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!(
                    "[mcp-claude-history] 无法清理未发布的输出 {}: {error}",
                    self.staging.display()
                );
            }
            for directory in self.created_parents.iter().rev() {
                if let Err(error) = fs::remove_dir(directory)
                    && error.kind() != std::io::ErrorKind::NotFound
                    && error.kind() != std::io::ErrorKind::DirectoryNotEmpty
                {
                    eprintln!(
                        "[mcp-claude-history] 无法清理未使用的目录 {}: {error}",
                        directory.display()
                    );
                }
            }
        }
    }
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
    range_selected: bool,
    redaction_mode: RedactionMode,
    redacted_count: usize,
    overwrite: bool,
}

/// 写入输出文件
fn write_output(request: OutputWriteRequest<'_>) -> Result<GetResponse, ErrorResponse> {
    let retention = request.output.temp_output.then(|| TEMP_OUTPUT_RETENTION.to_string());
    let transaction = OutputTransaction::begin(request.output, request.overwrite)?;
    let output_dir = transaction.staging_dir();
    let content_path = transaction.content();
    let manifest_path = transaction.manifest();
    let safe_ref = request.r#ref.replace(':', "_");

    let mut file = open_private_output_file(&transaction.staging_content())?;
    file.write_all(request.content.as_bytes()).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("写入文件失败: {e}"),
        available: None,
    })?;

    // 图片和正文必须作为同一个完整导出发布。
    let mut image_paths = Vec::new();
    let images = extract_images(request.record);
    for img in &images {
        let (ext, data) = extract_image_data(request.record, img.index).ok_or_else(|| ErrorResponse {
            error: "image_export_failed".to_string(),
            message: format!("无法解码图片 {}，导出未发布", img.index),
            available: None,
        })?;
        let name = format!("{}_img{}.{}", safe_ref, img.index, ext);
        let mut img_file = open_private_output_file(&output_dir.join(&name))?;
        img_file.write_all(&data).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("图片写入失败: {e}"),
            available: None,
        })?;
        img_file.sync_all().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("图片同步失败: {e}"),
            available: None,
        })?;
        image_paths.push(transaction.final_dir().join(name));
    }

    file.sync_all().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("正文同步失败: {e}"),
        available: None,
    })?;
    let bytes = file
        .metadata()
        .map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法读取正文大小: {e}"),
            available: None,
        })?
        .len();
    let lines = request.content.lines().count();
    let redaction = redaction_info(
        request.redaction_mode,
        request.redacted_count,
        request.redaction_mode == RedactionMode::Off || request.redacted_count > 0,
    );
    let manifest = serde_json::json!({
        "schema": "mcp-claude-history.get-output.v2",
        "ref": request.r#ref,
        "content_size": request.content_size,
        "original_content_size": request.original_content_size,
        "content": content_path,
        "images": &image_paths,
        "bytes": bytes,
        "lines": lines,
        "complete": true,
        "sample_kind": if request.range_selected { "range" } else { "all" },
        "redaction": &redaction,
    });
    let mut manifest_file = open_private_output_file(&transaction.staging_manifest())?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| ErrorResponse {
        error: "serialize_error".to_string(),
        message: format!("无法序列化 get manifest: {e}"),
        available: None,
    })?;
    manifest_file.write_all(&manifest_bytes).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("写入 manifest 失败: {e}"),
        available: None,
    })?;
    manifest_file.sync_all().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("manifest 同步失败: {e}"),
        available: None,
    })?;
    transaction.publish()?;

    Ok(GetResponse::Output {
        r#ref: request.r#ref.to_string(),
        output: OutputInfo {
            content: content_path,
            manifest: manifest_path,
            images: image_paths,
            bytes,
            lines,
            schema: "mcp-claude-history.get-output.v2".to_string(),
            complete: true,
            sample_kind: if request.range_selected { "range" } else { "all" }.to_string(),
            redaction,
            retention,
        },
        content_size: request.content_size,
        original_content_size: request.original_content_size,
        image_count: request.image_count,
    })
}

pub fn resolve_output_dir(raw_output: &str) -> Result<PathBuf, ErrorResponse> {
    validate_output_path(raw_output)?;
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
        message: format!("无法获取当前工作目录: {e}"),
        available: None,
    })?)
    .map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("canonicalize cwd 失败: {e}"),
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

fn validate_output_path(raw: &str) -> Result<(), ErrorResponse> {
    let invalid = || ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("output 包含不安全的 Windows 路径组件: {raw}"),
        available: None,
    };
    if raw != raw.trim() {
        return Err(invalid());
    }
    let prefixed = raw.starts_with(TMP_PATH_PREFIX) || raw.starts_with(CWD_PATH_PREFIX);
    let path = raw
        .strip_prefix(TMP_PATH_PREFIX)
        .or_else(|| raw.strip_prefix(CWD_PATH_PREFIX))
        .unwrap_or(raw);
    let path = if !prefixed
        && Path::new(path).is_absolute()
        && path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && matches!(path.as_bytes()[2], b'\\' | b'/')
    {
        &path[2..]
    } else {
        path
    };
    for component in path.split(['/', '\\']).filter(|part| !part.is_empty()) {
        if component == "." || component == ".." {
            continue;
        }
        if component.ends_with([' ', '.']) || component.chars().any(|c| c <= '\u{1f}' || "<>:\"|?*".contains(c)) {
            return Err(invalid());
        }
        let base = component
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || base
                .strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT"))
                .is_some_and(|digit| {
                    matches!(
                        digit,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TempSessionMarker {
    version: u8,
    session: String,
    owner: String,
}

pub(crate) fn checked_temp_directory(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("临时目录不是普通目录: {}", path.display()));
    }
    #[cfg(unix)]
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(format!("临时目录不属于当前用户: {}", path.display()));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 {
        return Err(format!("临时目录是重解析点: {}", path.display()));
    }
    Ok(metadata)
}

fn controlled_temp_root() -> Result<PathBuf, ErrorResponse> {
    static SESSION_ROOT: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
    let path = SESSION_ROOT.get_or_init(|| {
        let parent = env::temp_dir().join("claude-tools");
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        checked_temp_directory(&parent)?;
        let root = parent.join("mcp-claude-history");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        checked_temp_directory(&root)?;
        set_private_permissions(&root, 0o700).map_err(|e| e.message)?;
        schedule_temp_cleanup(&root);
        let session_name = format!("session-{}", export_nonce());
        let session = root.join(&session_name);
        fs::create_dir(&session).map_err(|e| e.to_string())?;
        let result = (|| {
            set_private_permissions(&session, 0o700).map_err(|e| e.message)?;
            let mut file = open_private_output_file(&session.join(".mcp-history-session")).map_err(|e| e.message)?;
            let marker = TempSessionMarker {
                version: 2,
                session: session_name,
                owner: process_instance().to_string(),
            };
            file.write_all(&serde_json::to_vec(&marker).map_err(|e| e.to_string())?)
                .and_then(|()| file.sync_all())
                .map_err(|e| e.to_string())?;
            fs::canonicalize(&session).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&session);
        }
        result
    });
    path.clone().map_err(|message| ErrorResponse {
        error: if cfg!(windows) {
            "privacy_not_enforced_on_windows"
        } else {
            "io_error"
        }
        .to_string(),
        message,
        available: None,
    })
}

pub(crate) fn cleanup_expired_temp_sessions() {
    let parent = env::temp_dir().join("claude-tools");
    let root = parent.join("mcp-claude-history");
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            eprintln!("[mcp-claude-history] 无法检查受控临时目录 {}: {error}", root.display());
            return;
        }
        Ok(_) => {}
    }
    let result = (|| -> Result<(), String> {
        checked_temp_directory(&parent)?;
        checked_temp_directory(&root)?;
        set_private_permissions(&root, 0o700).map_err(|error| error.message)?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[mcp-claude-history] 无法清理受控临时目录 {}: {error}", root.display());
        return;
    }
    schedule_temp_cleanup(&root);
}

fn schedule_temp_cleanup(root: &Path) {
    static CLEANUP_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if CLEANUP_STARTED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    let root = root.to_path_buf();
    if let Err(error) = std::thread::Builder::new()
        .name("mcp-history-temp-cleanup".to_string())
        .spawn(move || cleanup_owned_temp_sessions(&root, SystemTime::now()))
    {
        eprintln!("[mcp-claude-history] 无法启动受控临时会话清理: {error}");
        CLEANUP_STARTED.store(false, std::sync::atomic::Ordering::Release);
    }
}

fn cleanup_owned_temp_sessions(root: &Path, now: SystemTime) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("[mcp-claude-history] 无法扫描受控临时目录 {}: {error}", root.display());
            return;
        }
    };
    for (index, entry) in entries.flatten().enumerate() {
        if index > 0 && index % 128 == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("session-") {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = checked_temp_directory(&path) else {
            continue;
        };
        let marker_path = path.join(".mcp-history-session");
        let Ok(marker_metadata) = fs::symlink_metadata(&marker_path) else {
            continue;
        };
        if !marker_metadata.file_type().is_file() || marker_metadata.len() > 256 {
            continue;
        }
        let Some(marker) = fs::read(&marker_path)
            .ok()
            .and_then(|data| serde_json::from_slice::<TempSessionMarker>(&data).ok())
        else {
            continue;
        };
        let Some(pid) = owner_pid(&marker.owner) else { continue };
        if marker.version != 2 || marker.session != name || !name.starts_with(&format!("session-{pid}-")) {
            continue;
        }
        if now
            .duration_since(metadata.modified().unwrap_or(now))
            .unwrap_or_default()
            <= Duration::from_secs(24 * 60 * 60)
            || !process_is_gone(pid)
        {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&path) {
            eprintln!("[mcp-claude-history] 无法清理过期临时会话 {}: {error}", path.display());
        }
    }
}

fn resolve_relative_output_dir(relative: &str, root: &Path, prefix: &str) -> Result<PathBuf, ErrorResponse> {
    if relative.is_empty() {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{prefix} 后面必须跟相对路径"),
            available: None,
        });
    }

    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{prefix} 只接受相对路径"),
            available: None,
        });
    }
    if relative_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ErrorResponse {
            error: "invalid_output_dir".to_string(),
            message: format!("{prefix} 路径不允许包含 `..` 组件"),
            available: None,
        });
    }

    let candidate = root.join(relative_path);
    let canonical_target = canonicalize_or_ancestor(&candidate).map_err(|e| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("canonicalize 输出路径失败: {e}"),
        available: None,
    })?;

    assert_within_allowed_root(&canonical_target, root)?;
    Ok(candidate)
}

fn resolve_absolute_output_dir(absolute: &Path, cwd_root: &Path, temp_root: &Path) -> Result<PathBuf, ErrorResponse> {
    let canonical_target = canonicalize_or_ancestor(absolute).map_err(|e| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: format!("canonicalize 输出路径失败: {e}"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(record: serde_json::Value) -> (PathBuf, Config, String) {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = env::temp_dir().join(format!("mcp-history-get-test-{}-{nonce}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let session_id = "session-history-test";
        let mut file = File::create(project.join(format!("{session_id}.jsonl"))).unwrap();
        writeln!(file, "{record}").unwrap();
        (
            root.clone(),
            Config { projects_dir: root },
            format!("{}:1", ref_prefix(session_id)),
        )
    }

    fn finished_pid() -> u32 {
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/C", "exit", "0"]);
            command
        } else {
            std::process::Command::new("true")
        };
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        pid
    }

    fn session_with_marker(root: &Path, pid: u32, suffix: usize) -> PathBuf {
        let name = format!("session-{pid}-123-{suffix}");
        let directory = root.join(&name);
        fs::create_dir(&directory).unwrap();
        let marker = TempSessionMarker {
            version: 2,
            session: name,
            owner: format!("{pid}-123-{suffix}"),
        };
        fs::write(
            directory.join(".mcp-history-session"),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
        directory
    }

    fn bundle_paths(root: &Path) -> ResolvedOutputFiles {
        let directory = root.join("bundle");
        ResolvedOutputFiles {
            content: directory.join("content.txt"),
            manifest: directory.join("manifest.json"),
            directory,
            explicit_file: false,
            temp_output: false,
        }
    }

    fn published_bundle(root: &Path) {
        let output = OutputTransaction::begin(bundle_paths(root), true).unwrap();
        fs::write(output.staging_content(), "old").unwrap();
        fs::write(output.staging_manifest(), "old manifest").unwrap();
        output.publish().unwrap();
    }

    fn success_content(response: GetResponse) -> String {
        match response {
            GetResponse::Success { content, .. } => content,
            _ => panic!("expected success response"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn temporary_parent_symlink_is_rejected() {
        let root = env::temp_dir().join(format!("mcp-history-temp-parent-test-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        let parent = root.join("claude-tools");
        std::os::unix::fs::symlink(&root, &parent).unwrap();
        assert!(checked_temp_directory(&parent).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_only_removes_expired_owned_sessions_with_exited_processes() {
        let root = env::temp_dir().join(format!("mcp-history-session-cleanup-test-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        let live = session_with_marker(&root, std::process::id(), 1);
        let finished_pid = finished_pid();
        let expired = session_with_marker(&root, finished_pid, 2);
        let previous_version = root.join("session-old");
        fs::create_dir(&previous_version).unwrap();
        fs::write(
            previous_version.join(".mcp-history-session"),
            b"mcp-claude-history.session.v1\n",
        )
        .unwrap();
        let unrelated = root.join("session-unmarked");
        fs::create_dir(&unrelated).unwrap();

        cleanup_owned_temp_sessions(&root, SystemTime::now());
        assert!(expired.exists());
        cleanup_owned_temp_sessions(&root, SystemTime::now() + Duration::from_secs(25 * 60 * 60));
        assert!(!expired.exists());
        assert!(live.exists());
        assert!(previous_version.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_reaches_expired_session_after_many_unmarked_directories() {
        let root = env::temp_dir().join(format!("mcp-history-cleanup-scan-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        for index in 0..130 {
            fs::create_dir(root.join(format!("session-legacy-{index}"))).unwrap();
        }
        let expired = session_with_marker(&root, finished_pid(), 7);
        cleanup_owned_temp_sessions(&root, SystemTime::now() + Duration::from_secs(25 * 60 * 60));
        assert!(!expired.exists());
        assert!(root.join("session-legacy-0").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tmp_export_rejects_deep_parent_without_creating_directories() {
        let session = controlled_temp_root().unwrap();
        let prefix = format!("quota-parent-{}", export_nonce());
        let mut parent = session.join(&prefix);
        for _ in 0..260 {
            parent.push("dir");
        }
        let directory = parent.join("bundle");
        let error = OutputTransaction::begin(
            ResolvedOutputFiles {
                content: directory.join("content.txt"),
                manifest: directory.join("manifest.json"),
                directory,
                explicit_file: false,
                temp_output: true,
            },
            false,
        )
        .unwrap_err();
        assert_eq!(error.error, "invalid_arguments");
        assert!(!session.join(prefix).exists());
    }

    #[test]
    fn get_requires_output_for_overwrite_before_resolving_ref() {
        let error = get(
            &Config {
                projects_dir: env::temp_dir(),
            },
            GetParams {
                r#ref: "invalid".to_string(),
                range: None,
                output: None,
                project: None,
                source: None,
                redaction: RedactionMode::Auto,
                overwrite: true,
                view: None,
                block: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.error, "invalid_arguments");
    }

    #[test]
    fn large_record_range_uses_complete_sensitive_spans() {
        let secret = "x".repeat(MAX_JSONL_LINE_BYTES + 1024);
        let content = format!("前缀😀 password=\"{secret}\" 后缀");
        let selected = (content.chars().count() - 1030, content.chars().count() - 5);
        let expected = redact_text_range_with_mode(&content, RedactionMode::Strict, Some(selected));
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "large-range", "type": "user", "timestamp": "2026-10-12T00:00:00Z", "message": {"content": content}
        }));
        let response = get(
            &config,
            GetParams {
                r#ref: reference,
                range: Some(selected),
                output: None,
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Strict,
                overwrite: false,
                view: None,
                block: None,
            },
        )
        .unwrap();
        assert_eq!(success_content(response), expected.text);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn get_structured_view_selects_original_block_and_normalizes_json() {
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "views", "type": "assistant", "timestamp": "2026-10-12T00:00:00Z",
            "message": {"content": [{"type":"text", "text":"before"}, {"type":"tool_use", "name":"Bash", "id":"call", "input":{"z":1,"a":"中文😀"}}]}
        }));
        let response = get(
            &config,
            GetParams {
                r#ref: reference,
                range: None,
                output: None,
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Off,
                overwrite: false,
                view: Some("tool_input".to_string()),
                block: Some(1),
            },
        )
        .unwrap();
        assert_eq!(success_content(response), "{\"a\":\"中文😀\",\"z\":1}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn get_npm_tokens_are_redacted_in_all_views_ranges_and_exports() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let command = format!("前缀😀 printf '%s\\n' '{secret}' --visible");
        for (kind, block, structured_view) in [
            (
                "assistant",
                serde_json::json!({"type":"tool_use","id":"npm-call","name":"Bash","input":{"command":command,"note":"visible"}}),
                "tool_input",
            ),
            (
                "user",
                serde_json::json!({"type":"tool_result","tool_use_id":"npm-call","content":[{"type":"text","text":command}],"is_error":false}),
                "tool_result",
            ),
        ] {
            let record = serde_json::json!({"uuid":"npm-fixture","type":kind,"timestamp":"2026-10-01T00:00:00Z","message":{"content":[block]}});
            let (root, config, reference) = fixture(record);
            for view in ["content", structured_view, "record"] {
                let params = || GetParams {
                    r#ref: reference.clone(),
                    range: None,
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Off,
                    overwrite: false,
                    view: Some(view.to_string()),
                    block: if view == structured_view { Some(0) } else { None },
                };
                let original = success_content(get(&config, params()).unwrap());
                assert!(original.contains(&secret));
                let start = original[..original.find(&secret).unwrap()].chars().count();
                for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                    let expected = if mode.enabled() {
                        original.replace(&secret, "[redacted]")
                    } else {
                        original.clone()
                    };
                    let content = success_content(
                        get(
                            &config,
                            GetParams {
                                redaction: mode,
                                ..params()
                            },
                        )
                        .unwrap(),
                    );
                    assert_eq!(content, expected, "kind={kind} view={view} mode={mode:?}");
                    if view != "content" {
                        serde_json::from_str::<serde_json::Value>(&content).unwrap();
                    }
                    let ranged = success_content(
                        get(
                            &config,
                            GetParams {
                                range: Some((start + 4, start + 10)),
                                redaction: mode,
                                ..params()
                            },
                        )
                        .unwrap(),
                    );
                    assert_eq!(ranged, if mode.enabled() { "[redacted]" } else { &secret[4..10] });
                    let response = get(
                        &config,
                        GetParams {
                            range: Some((start + 4, start + 10)),
                            output: Some(format!(
                                "tmp:npm-get-{}-{}/message.txt",
                                std::process::id(),
                                export_nonce()
                            )),
                            redaction: mode,
                            ..params()
                        },
                    )
                    .unwrap();
                    let GetResponse::Output { output, .. } = response else {
                        panic!("expected output response")
                    };
                    assert_eq!(fs::read_to_string(&output.content).unwrap(), ranged);
                    let manifest: serde_json::Value =
                        serde_json::from_slice(&fs::read(&output.manifest).unwrap()).unwrap();
                    assert_eq!(manifest["redaction"]["mode"], mode.as_str());
                    assert_eq!(manifest["redaction"]["redacted_count"], usize::from(mode.enabled()));
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        assert_eq!(
                            fs::metadata(&output.content).unwrap().permissions().mode() & 0o777,
                            0o600
                        );
                    }
                    fs::remove_dir_all(output.content.parent().unwrap()).unwrap();
                }
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn get_record_view_preserves_internal_objects_and_redacts_nested_values() {
        for record in [
            serde_json::json!({
                "uuid":"progress-fixture", "type":"progress", "timestamp":"2026-10-01T00:00:00Z",
                "parentUuid":"parent-fixture",
                "data":{"text":"中文😀 RECORD-NEEDLE", "password":{"nested":["fixture-secret"]}}
            }),
            serde_json::json!({
                "type":"file-history-snapshot",
                "snapshot":{"text":"中文😀 RECORD-NEEDLE", "password":{"nested":["fixture-secret"]}}
            }),
            serde_json::json!({
                "uuid":"internal-fixture", "type":"system",
                "payload":{"text":"中文😀 RECORD-NEEDLE", "password":{"nested":["fixture-secret"]}}
            }),
        ] {
            let original = record.to_string();
            let (root, config, reference) = fixture(record.clone());
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let content = success_content(
                    get(
                        &config,
                        GetParams {
                            r#ref: reference.clone(),
                            range: None,
                            output: None,
                            project: Some("project".to_string()),
                            source: None,
                            redaction: mode,
                            overwrite: false,
                            view: Some("record".to_string()),
                            block: None,
                        },
                    )
                    .unwrap(),
                );
                let mut expected = record.clone();
                let payload = ["data", "snapshot", "payload"]
                    .into_iter()
                    .find(|key| expected.get(key).is_some())
                    .unwrap();
                if mode.enabled() {
                    expected[payload]["password"] = serde_json::json!("[redacted]");
                }
                assert_eq!(serde_json::from_str::<serde_json::Value>(&content).unwrap(), expected);
                assert_eq!(content.contains("fixture-secret"), mode == RedactionMode::Off);
                let start = original[..original.find("中文😀 RECORD-NEEDLE").unwrap()]
                    .chars()
                    .count();
                let range = (start + 2, start + 2 + "😀 RECORD-NEEDLE".chars().count());
                let content = success_content(
                    get(
                        &config,
                        GetParams {
                            r#ref: reference.clone(),
                            range: Some(range),
                            output: None,
                            project: Some("project".to_string()),
                            source: None,
                            redaction: mode,
                            overwrite: false,
                            view: Some("record".to_string()),
                            block: None,
                        },
                    )
                    .unwrap(),
                );
                assert_eq!(content, "😀 RECORD-NEEDLE");
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn get_record_view_ranges_large_payload_and_rejects_tool_blocks() {
        let secret = "x".repeat(MAX_JSONL_LINE_BYTES + 1024);
        let record = serde_json::json!({"type":"progress", "data":{"password":secret, "text":"中文😀 RECORD-NEEDLE"}});
        let original = record.to_string();
        let start = original[..original.find(&secret).unwrap()].chars().count() + secret.chars().count() - 10;
        let (root, config, reference) = fixture(record);
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            let content = success_content(
                get(
                    &config,
                    GetParams {
                        r#ref: reference.clone(),
                        range: Some((start, start + 5)),
                        output: None,
                        project: Some("project".to_string()),
                        source: None,
                        redaction: mode,
                        overwrite: false,
                        view: Some("record".to_string()),
                        block: None,
                    },
                )
                .unwrap(),
            );
            assert_eq!(content, if mode.enabled() { "\"[redacted]\"" } else { "xxxxx" });
        }
        for (view, block) in [("record", Some(0)), ("content", Some(0)), ("unknown", None)] {
            let error = get(
                &config,
                GetParams {
                    r#ref: reference.clone(),
                    range: None,
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Strict,
                    overwrite: false,
                    view: Some(view.to_string()),
                    block,
                },
            )
            .unwrap_err();
            assert_eq!(error.error, "invalid_arguments");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_image_fails_without_publishing_an_export() {
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "image-fixture", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "not-base64!"}}]}
        }));
        let error = get(
            &config,
            GetParams {
                r#ref: reference,
                range: None,
                output: Some(format!("tmp:image-failure-{}", export_nonce())),
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Auto,
                overwrite: false,
                view: None,
                block: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.error, "image_export_failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn range_redaction_never_exposes_a_partial_secret() {
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "user-1",
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": "password=fixture_secret"}
        }));

        for range in [(9, 23), (11, 23), (9, 20)] {
            let response = get(
                &config,
                GetParams {
                    r#ref: reference.clone(),
                    range: Some(range),
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Auto,
                    overwrite: false,
                    view: None,
                    block: None,
                },
            )
            .unwrap();
            assert_eq!(success_content(response), "[redacted]");
        }

        let output_name = format!(
            "tmp:mcp-history-get-range-output-{}-{}/message.txt",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let response = get(
            &config,
            GetParams {
                r#ref: reference.clone(),
                range: Some((11, 20)),
                output: Some(output_name),
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Strict,
                overwrite: false,
                view: None,
                block: None,
            },
        )
        .unwrap();
        let GetResponse::Output { output, .. } = response else {
            panic!("expected output response");
        };
        assert_eq!(fs::read_to_string(&output.content).unwrap(), "[redacted]");
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(&output.manifest).unwrap()).unwrap();
        assert_eq!(manifest["sample_kind"], "range");
        assert_eq!(manifest["redaction"]["redacted_count"], 1);

        fs::remove_dir_all(output.content.parent().unwrap()).ok();
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn full_range_export_reports_range_sample_kind_consistently() {
        let content = "visible content";
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "user-full-range",
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": content}
        }));
        let output_name = format!(
            "tmp:mcp-history-get-full-range-output-{}-{}/message.txt",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let response = get(
            &config,
            GetParams {
                r#ref: reference,
                range: Some((0, content.chars().count())),
                output: Some(output_name),
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Auto,
                overwrite: false,
                view: None,
                block: None,
            },
        )
        .unwrap();
        let GetResponse::Output { output, .. } = response else {
            panic!("expected output response");
        };
        assert_eq!(output.sample_kind, "range");
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(&output.manifest).unwrap()).unwrap();
        assert_eq!(manifest["sample_kind"], "range");

        fs::remove_dir_all(output.content.parent().unwrap()).ok();
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn get_redacts_json_embedded_in_serialized_tool_input() {
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "assistant-escaped-json",
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{
                "type": "tool_use",
                "id": "call-escaped-json",
                "name": "Bash",
                "input": {"command": r#"Output: {"password":"fixture_secret"}"#}
            }]}
        }));

        let redacted = success_content(
            get(
                &config,
                GetParams {
                    r#ref: reference.clone(),
                    range: None,
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Auto,
                    overwrite: false,
                    view: None,
                    block: None,
                },
            )
            .unwrap(),
        );
        assert!(!redacted.contains("fixture_secret"));
        assert!(redacted.contains("[redacted]"));

        let raw = success_content(
            get(
                &config,
                GetParams {
                    r#ref: reference,
                    range: None,
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Off,
                    overwrite: false,
                    view: None,
                    block: None,
                },
            )
            .unwrap(),
        );
        assert!(raw.contains("fixture_secret"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn get_preserves_complete_tool_input_and_honors_redaction_mode() {
        let command = format!("{} FAR_NEEDLE password=fixture_secret", "x".repeat(300));
        let (root, config, reference) = fixture(serde_json::json!({
            "uuid": "assistant-1",
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{
                "type": "tool_use",
                "id": "call-1",
                "name": "Bash",
                "input": {"command": command}
            }]}
        }));

        let raw = success_content(
            get(
                &config,
                GetParams {
                    r#ref: reference.clone(),
                    range: None,
                    output: None,
                    project: Some("project".to_string()),
                    source: None,
                    redaction: RedactionMode::Off,
                    overwrite: false,
                    view: None,
                    block: None,
                },
            )
            .unwrap(),
        );
        assert!(raw.contains("FAR_NEEDLE"));
        assert!(raw.contains("fixture_secret"));
        assert!(raw.chars().count() > 300);

        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            let content = success_content(
                get(
                    &config,
                    GetParams {
                        r#ref: reference.clone(),
                        range: None,
                        output: None,
                        project: Some("project".to_string()),
                        source: None,
                        redaction: mode,
                        overwrite: false,
                        view: None,
                        block: None,
                    },
                )
                .unwrap(),
            );
            assert!(content.contains("FAR_NEEDLE"));
            assert!(!content.contains("fixture_secret"));
            assert!(content.contains("password=[redacted]"));
        }

        let output_name = format!(
            "tmp:mcp-history-get-raw-output-{}-{}/message.txt",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let response = get(
            &config,
            GetParams {
                r#ref: reference,
                range: None,
                output: Some(output_name),
                project: Some("project".to_string()),
                source: None,
                redaction: RedactionMode::Off,
                overwrite: false,
                view: None,
                block: None,
            },
        )
        .unwrap();
        let GetResponse::Output { output, .. } = response else {
            panic!("expected output response");
        };
        assert_eq!(fs::read_to_string(&output.content).unwrap(), raw);
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(&output.manifest).unwrap()).unwrap();
        assert_eq!(manifest["sample_kind"], "all");
        assert_eq!(manifest["redaction"]["mode"], "off");

        fs::remove_dir_all(output.content.parent().unwrap()).ok();
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_windows_special_paths_before_resolving_output() {
        for name in [
            "tmp:report.txt:payload",
            "tmp:C:secret",
            "tmp:CON",
            "tmp:COM¹.txt",
            "tmp:CONOUT$.txt",
            "cwd:folder/LPT1.txt",
            "tmp:folder/aux.json",
            "tmp:folder. ",
            "tmp:folder.",
            "tmp:file<name>.txt",
            "tmp:foo|bar",
            "tmp:foo\u{1f}bar",
            "tmp:foo?bar",
            "tmp:foo*bar",
            "tmp:foo\"bar",
        ] {
            assert_eq!(
                resolve_output_files(name, "result.txt", "manifest.json")
                    .unwrap_err()
                    .error,
                "invalid_output_dir",
                "{name}"
            );
        }
    }

    #[test]
    fn interrupted_overwrite_restores_old_bundle_before_replacing_it() {
        let root = env::temp_dir().join(format!("mcp-history-recover-old-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let backup = root.join(format!(".mcp-history-backup-{}", export_nonce()));
        let journal = create_publish_journal(&target, &backup, &export_nonce()).unwrap();
        fs::rename(&target, &backup).unwrap();

        let replacement = OutputTransaction::begin(bundle_paths(&root), true).unwrap();
        assert_eq!(fs::read_to_string(replacement.content()).unwrap(), "old");
        assert!(!backup.exists());
        assert!(!journal.exists());
        fs::write(replacement.staging_content(), "new").unwrap();
        fs::write(replacement.staging_manifest(), "new manifest").unwrap();
        replacement.publish().unwrap();
        assert_eq!(fs::read_to_string(target.join("content.txt")).unwrap(), "new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_overwrite_cleans_only_a_confirmed_published_bundle() {
        let root = env::temp_dir().join(format!("mcp-history-recover-new-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let backup = root.join(format!(".mcp-history-backup-{}", export_nonce()));
        let token = export_nonce();
        let journal = create_publish_journal(&target, &backup, &token).unwrap();
        fs::rename(&target, &backup).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join(".mcp-history-bundle"), b"mcp-claude-history.bundle.v1\n").unwrap();
        fs::write(target.join(".mcp-history-publish-token"), &token).unwrap();
        fs::write(target.join("content.txt"), "new").unwrap();

        let replacement = OutputTransaction::begin(bundle_paths(&root), true).unwrap();
        assert_eq!(fs::read_to_string(replacement.content()).unwrap(), "new");
        assert!(!backup.exists());
        assert!(!journal.exists());
        drop(replacement);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_overwrite_preserves_unrecognized_output_and_backup() {
        let root = env::temp_dir().join(format!("mcp-history-recover-conflict-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let backup = root.join(format!(".mcp-history-backup-{}", export_nonce()));
        let journal = create_publish_journal(&target, &backup, &export_nonce()).unwrap();
        fs::rename(&target, &backup).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join(".mcp-history-bundle"), b"mcp-claude-history.bundle.v1\n").unwrap();
        fs::write(target.join("content.txt"), "unrelated").unwrap();

        let error = OutputTransaction::begin(bundle_paths(&root), true).unwrap_err();
        assert_eq!(error.error, "output_restore_failed");
        assert_eq!(fs::read_to_string(backup.join("content.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(target.join("content.txt")).unwrap(), "unrelated");
        assert!(journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recent_journal_from_another_process_is_not_recovered() {
        let root = env::temp_dir().join(format!("mcp-history-recover-busy-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let backup = root.join(format!(".mcp-history-backup-{}", export_nonce()));
        let journal = create_publish_journal(&target, &backup, &export_nonce()).unwrap();
        let mut data: PublishJournal = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
        let finished_pid = finished_pid();
        data.owner = format!("{finished_pid}-123-0");
        fs::write(&journal, serde_json::to_vec(&data).unwrap()).unwrap();
        let error = OutputTransaction::begin(bundle_paths(&root), true).unwrap_err();
        assert_eq!(error.error, "output_busy");
        assert_eq!(fs::read_to_string(target.join("content.txt")).unwrap(), "old");
        let file = OpenOptions::new().write(true).open(&journal).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(SystemTime::now() - std::time::Duration::from_secs(31)))
            .unwrap();
        drop(file);
        let replacement = OutputTransaction::begin(bundle_paths(&root), true).unwrap();
        assert!(!journal.exists());
        drop(replacement);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn aged_journal_from_a_running_process_is_not_recovered() {
        let root = env::temp_dir().join(format!("mcp-history-recover-live-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let backup = root.join(format!(".mcp-history-backup-{}", export_nonce()));
        let journal = create_publish_journal(&target, &backup, &export_nonce()).unwrap();
        let mut data: PublishJournal = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
        data.owner = format!("{}-123-0", std::process::id());
        fs::write(&journal, serde_json::to_vec(&data).unwrap()).unwrap();
        let file = OpenOptions::new().write(true).open(&journal).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(31)))
            .unwrap();
        drop(file);
        let error = OutputTransaction::begin(bundle_paths(&root), true).unwrap_err();
        assert_eq!(error.error, "output_busy");
        assert_eq!(fs::read_to_string(target.join("content.txt")).unwrap(), "old");
        assert!(journal.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_output_refuses_overwrite_and_keeps_old_bundle() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = env::temp_dir().join(format!("mcp-history-locked-output-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let target = root.join("bundle");
        let replacement = OutputTransaction::begin(bundle_paths(&root), true).unwrap();
        fs::write(replacement.staging_content(), "new").unwrap();
        fs::write(replacement.staging_manifest(), "new manifest").unwrap();

        let exclusive = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS: open a directory handle
            .open(&target)
            .unwrap();
        let failure = replacement.publish().unwrap_err();
        assert!(
            matches!(failure.error.as_str(), "io_error" | "output_exists"),
            "{failure:?}"
        );
        drop(exclusive);
        assert_eq!(fs::read_to_string(target.join("content.txt")).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(target.join("manifest.json")).unwrap(),
            "old manifest"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_sync_failure_preserves_existing_bundle_and_removes_staging() {
        let root = env::temp_dir().join(format!("mcp-history-sync-failure-{}", export_nonce()));
        fs::create_dir(&root).unwrap();
        published_bundle(&root);
        let replacement = OutputTransaction::begin(bundle_paths(&root), true).unwrap();
        let staging = replacement.staging_dir().to_path_buf();
        fs::write(replacement.staging_content(), "new").unwrap();
        assert_eq!(replacement.publish().unwrap_err().error, "io_error");
        assert!(!staging.exists());
        assert_eq!(fs::read_to_string(root.join("bundle/content.txt")).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(root.join("bundle/manifest.json")).unwrap(),
            "old manifest"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_bundle_publishes_together_and_requires_explicit_overwrite() {
        let root = env::temp_dir().join(format!(
            "mcp-history-transaction-test-{}-{}",
            std::process::id(),
            export_nonce()
        ));
        fs::create_dir_all(&root).unwrap();
        let paths = || ResolvedOutputFiles {
            directory: root.join("bundle"),
            content: root.join("bundle").join("content.txt"),
            manifest: root.join("bundle").join("manifest.json"),
            explicit_file: false,
            temp_output: false,
        };
        let missing = OutputTransaction::begin(paths(), true).unwrap();
        fs::write(missing.staging_content(), "new").unwrap();
        assert!(missing.publish().is_err());
        assert!(!root.join("bundle").exists());

        let first = OutputTransaction::begin(paths(), true).unwrap();
        fs::write(first.staging_content(), "old").unwrap();
        fs::write(first.staging_manifest(), "old manifest").unwrap();
        first.publish().unwrap();
        assert_eq!(fs::read_to_string(root.join("bundle/content.txt")).unwrap(), "old");

        let other = OutputTransaction::begin(paths(), false).unwrap();
        fs::write(other.staging_content(), "new").unwrap();
        fs::write(other.staging_manifest(), "new manifest").unwrap();
        other.publish().unwrap();
        assert_eq!(fs::read_to_string(root.join("bundle/content.txt")).unwrap(), "old");

        let overwrite = OutputTransaction::begin(paths(), true).unwrap();
        fs::write(overwrite.staging_content(), "new").unwrap();
        fs::write(overwrite.staging_manifest(), "new manifest").unwrap();
        overwrite.publish().unwrap();
        assert_eq!(fs::read_to_string(root.join("bundle/content.txt")).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(root.join("bundle/manifest.json")).unwrap(),
            "new manifest"
        );
        let explicit = || ResolvedOutputFiles {
            directory: root.clone(),
            content: root.join("message.txt"),
            manifest: root.join("message_manifest.json"),
            explicit_file: true,
            temp_output: false,
        };
        let first = OutputTransaction::begin(explicit(), false).unwrap();
        let first_path = first.content();
        fs::write(first.staging_content(), "first").unwrap();
        fs::write(first.staging_manifest(), "first manifest").unwrap();
        first.publish().unwrap();
        let second = OutputTransaction::begin(explicit(), false).unwrap();
        let second_path = second.content();
        fs::write(second.staging_content(), "second").unwrap();
        fs::write(second.staging_manifest(), "second manifest").unwrap();
        second.publish().unwrap();
        assert_ne!(first_path, second_path);
        assert_eq!(fs::read_to_string(&first_path).unwrap(), "first");
        assert_eq!(fs::read_to_string(&second_path).unwrap(), "second");

        let directory = first_path.parent().unwrap().to_path_buf();
        let replacement = OutputTransaction::begin(
            ResolvedOutputFiles {
                directory: directory.clone(),
                content: first_path.clone(),
                manifest: directory.join("message_manifest.json"),
                explicit_file: true,
                temp_output: false,
            },
            true,
        )
        .unwrap();
        assert_eq!(replacement.final_dir(), directory);
        fs::write(replacement.staging_content(), "updated").unwrap();
        fs::write(replacement.staging_manifest(), "updated manifest").unwrap();
        replacement.publish().unwrap();
        assert_eq!(fs::read_to_string(&first_path).unwrap(), "updated");
        assert_eq!(fs::read_to_string(&second_path).unwrap(), "second");

        fs::remove_dir_all(root).unwrap();
    }
}

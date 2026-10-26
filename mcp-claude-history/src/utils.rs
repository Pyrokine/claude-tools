use crate::types::{ErrorResponse, ImageInfo, MessageRecord, Range, RedactionInfo, ToolInfo};
use regex::{Regex, RegexBuilder};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
#[cfg(test)]
use std::io::BufReader;
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::OnceLock;

pub const MAX_JSONL_LINE_BYTES: usize = 8 * 1024 * 1024;

pub enum BoundedLine {
    Record(String),
    TooLarge,
}

pub struct BoundedJsonlLines<R> {
    reader: R,
    finished: bool,
}

pub fn bounded_jsonl_lines<R: BufRead>(reader: R) -> BoundedJsonlLines<R> {
    BoundedJsonlLines {
        reader,
        finished: false,
    }
}

impl<R: BufRead> Iterator for BoundedJsonlLines<R> {
    type Item = io::Result<BoundedLine>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        let mut bytes = Vec::new();
        let mut oversized = false;
        let mut read_any = false;
        loop {
            if let Err(error) = crate::record_reader::check_work() {
                self.finished = true;
                return Some(Err(io::Error::other(error.message)));
            }
            let available = match self.reader.fill_buf() {
                Ok(available) => available,
                Err(error) => {
                    self.finished = true;
                    return Some(Err(error));
                }
            };
            if available.is_empty() {
                self.finished = true;
                if !read_any {
                    return None;
                }
                break;
            }
            read_any = true;
            let consumed = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |i| i + 1);
            if !oversized && bytes.len().saturating_add(consumed) > MAX_JSONL_LINE_BYTES {
                oversized = true;
                bytes.clear();
            }
            if !oversized {
                bytes.extend_from_slice(&available[..consumed]);
            }
            let finished_line = available[consumed - 1] == b'\n';
            self.reader.consume(consumed);
            if let Err(error) = crate::record_reader::account_work(consumed) {
                self.finished = true;
                return Some(Err(io::Error::other(error.message)));
            }
            if finished_line {
                break;
            }
        }
        if oversized {
            Some(Ok(BoundedLine::TooLarge))
        } else {
            Some(
                String::from_utf8(bytes)
                    .map(BoundedLine::Record)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
            )
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum RedactionMode {
    #[default]
    Auto,
    Off,
    Strict,
}

impl RedactionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
            Self::Strict => "strict",
        }
    }

    pub fn enabled(self) -> bool {
        self != Self::Off
    }
}

pub fn parse_redaction_mode_param(value: &str) -> Result<RedactionMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => Ok(RedactionMode::Auto),
        "off" | "none" | "raw" => Ok(RedactionMode::Off),
        "strict" => Ok(RedactionMode::Strict),
        other => Err(format!("redaction 仅支持 auto、off、strict，收到 {other}")),
    }
}

pub struct ExportMessage<'a> {
    pub line_num: usize,
    pub effective_type: &'a str,
    pub subtype: &'a str,
    pub content: &'a str,
    pub redacted_count: usize,
}

pub struct MessageExportFilters<'a> {
    pub types: &'a [String],
    pub subtypes: &'a [String],
    pub content_filter: &'a ContentFilter,
}

fn export_io_error(error: std::io::Error) -> ErrorResponse {
    ErrorResponse {
        error: "io_error".to_string(),
        message: format!("写文件失败: {error}"),
        available: None,
    }
}

#[cfg(unix)]
pub fn set_private_permissions(path: &Path, mode: u32) -> Result<(), ErrorResponse> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法设置输出路径权限: {e}"),
        available: None,
    })
}

#[cfg(windows)]
pub fn set_private_permissions(path: &Path, _mode: u32) -> Result<(), ErrorResponse> {
    // Pass the path as an environment variable; it must never be interpreted as PowerShell code.
    let script = r#"
$ErrorActionPreference = 'Stop'
$p = $env:MCP_HISTORY_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'private path is a reparse point' }
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$trustedOwners = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($trustedOwners -notcontains $owner) { throw "private path owner mismatch: $owner" }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$inherit = if (Test-Path -LiteralPath $p -PathType Container) { 'ContainerInherit,ObjectInherit' } else { 'None' }
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
$actual = Get-Acl -LiteralPath $p
$entries = @($actual.Access)
if (-not $actual.AreAccessRulesProtected -or $entries.Count -ne 1 -or $entries[0].IsInherited -or
    $entries[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
    $entries[0].AccessControlType -ne 'Allow' -or
    ($entries[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'private DACL verification failed'
}
"#;
    let result = (|| -> io::Result<std::process::Output> {
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env_remove("PSModulePath")
            .env("MCP_HISTORY_PRIVATE_PATH", path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output(),
                Ok(None) if started.elapsed() < std::time::Duration::from_secs(10) => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Ok(None) => {
                    let termination = child.kill();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("Windows DACL 验证超过 10 秒；终止进程结果: {termination:?}"),
                    ));
                }
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            }
        }
    })();
    if result.as_ref().is_ok_and(|output| output.status.success()) {
        return Ok(());
    }
    Err(ErrorResponse {
        error: "privacy_not_enforced_on_windows".to_string(),
        message: format!(
            "无法设置并验证私有 DACL: {}",
            result.map_or_else(
                |e| e.to_string(),
                |out| String::from_utf8_lossy(&out.stderr).into_owned()
            )
        ),
        available: None,
    })
}

#[cfg(not(any(unix, windows)))]
pub fn set_private_permissions(_path: &Path, _mode: u32) -> Result<(), ErrorResponse> {
    Ok(())
}

fn reject_final_symlink(path: &Path) -> Result<(), ErrorResponse> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err(ErrorResponse {
            error: "invalid_output_file".to_string(),
            message: format!("输出文件不能是符号链接: {}", path.display()),
            available: None,
        });
    }
    Ok(())
}

pub fn open_private_output_file(path: &Path) -> Result<File, ErrorResponse> {
    reject_final_symlink(path)?;
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建输出文件: {e}"),
        available: None,
    })?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法设置输出文件权限: {e}"),
            available: None,
        })?;
    #[cfg(not(unix))]
    set_private_permissions(path, 0o600)?;
    Ok(file)
}

pub fn parse_message_record(line: &str) -> Result<Option<MessageRecord>, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(line)?;
    let Some(object) = value.as_object() else {
        return serde_json::from_value(value).map(Some);
    };
    if is_internal_record(
        object.get("type").and_then(serde_json::Value::as_str),
        object.contains_key("uuid"),
        object.contains_key("message"),
    ) {
        return Ok(None);
    }
    serde_json::from_value(value).map(Some)
}

pub(crate) fn is_internal_record(record_type: Option<&str>, has_uuid: bool, has_message: bool) -> bool {
    !has_uuid && (!has_message || record_type == Some("api-request-blob"))
}

pub fn jsonl_read_warnings(read_errors: usize, parse_errors: usize) -> Vec<String> {
    let mut warnings = Vec::new();
    if read_errors > 0 {
        warnings.push(format!("读取 JSONL 时跳过 {read_errors} 行或文件"));
    }
    if parse_errors > 0 {
        warnings.push(format!("解析 JSONL 时跳过 {parse_errors} 行"));
    }
    warnings
}

pub const MESSAGE_TYPES: &[&str] = &["assistant", "user", "summary", "system", "other"];
pub const MESSAGE_SUBTYPES: &[&str] = &[
    "human",
    "tool_result",
    "meta",
    "text",
    "tool_use",
    "thinking",
    "empty",
    "summary",
    "system",
    "other",
];

#[derive(Debug, Clone)]
pub struct MessageFilters {
    pub types: Vec<String>,
    pub subtypes: Vec<String>,
    pub warnings: Vec<String>,
}

fn push_unique(values: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn inferred_type_for_subtype(subtype: &str) -> Option<&'static str> {
    match subtype {
        "tool_use" | "text" | "thinking" | "empty" => Some("assistant"),
        "tool_result" | "human" | "meta" => Some("user"),
        "summary" => Some("summary"),
        "system" => Some("system"),
        "other" => Some("other"),
        _ => None,
    }
}

pub fn normalize_message_filters(
    requested_types: &[String],
    requested_subtypes: &[String],
    default_types: Option<&[&str]>,
) -> Result<MessageFilters, ErrorResponse> {
    let mut types = Vec::new();
    let mut subtypes = Vec::new();
    let mut warnings = Vec::new();

    for value in requested_types {
        if MESSAGE_TYPES.contains(&value.as_str()) {
            push_unique(&mut types, value.clone());
        } else if MESSAGE_SUBTYPES.contains(&value.as_str()) {
            push_unique(&mut subtypes, value.clone());
            if let Some(inferred_type) = inferred_type_for_subtype(value) {
                push_unique(&mut types, inferred_type);
            }
            warnings.push(format!("types={value} 是 subtype，已自动转入 subtypes"));
        } else {
            return Err(invalid_arguments(format!(
                "未知 type 过滤值: {value}，仅支持 {}",
                MESSAGE_TYPES.join("、")
            )));
        }
    }

    for value in requested_subtypes {
        if MESSAGE_SUBTYPES.contains(&value.as_str()) {
            push_unique(&mut subtypes, value.clone());
            if requested_types.is_empty()
                && let Some(inferred_type) = inferred_type_for_subtype(value)
            {
                push_unique(&mut types, inferred_type);
            }
        } else if MESSAGE_TYPES.contains(&value.as_str()) {
            push_unique(&mut types, value.clone());
            warnings.push(format!("subtypes={value} 是 type，已自动转入 types"));
        } else {
            return Err(invalid_arguments(format!(
                "未知 subtype 过滤值: {value}，仅支持 {}",
                MESSAGE_SUBTYPES.join("、")
            )));
        }
    }

    if types.is_empty()
        && let Some(default_types) = default_types
    {
        types.extend(default_types.iter().map(|value| (*value).to_string()));
    }

    Ok(MessageFilters {
        types,
        subtypes,
        warnings,
    })
}

pub fn validate_effective_message_type(value: &str, name: &str) -> Result<(), ErrorResponse> {
    if MESSAGE_TYPES.contains(&value) {
        return Ok(());
    }
    Err(invalid_arguments(format!(
        "{name} 仅支持 {}，收到 {value}",
        MESSAGE_TYPES.join("、")
    )))
}

pub fn parse_context_direction(value: &str) -> Result<String, ErrorResponse> {
    match value.trim().to_ascii_lowercase().as_str() {
        "forward" => Ok("forward".to_string()),
        "backward" => Ok("backward".to_string()),
        other => Err(invalid_arguments(format!(
            "direction 仅支持 forward 或 backward，收到 {other}"
        ))),
    }
}

pub fn validate_context_range_selectors(
    before: Option<usize>,
    after: Option<usize>,
    until_type: Option<&str>,
    until_ref: Option<&str>,
) -> Result<(), ErrorResponse> {
    if until_type.is_some() && until_ref.is_some() {
        return Err(invalid_arguments("until_type 和 until_ref 不能同时传入"));
    }
    if (until_type.is_some() || until_ref.is_some()) && (before.is_some() || after.is_some()) {
        return Err(invalid_arguments(
            "until_type 或 until_ref 不能和 before/after 同时传入",
        ));
    }
    if let Some(until_type) = until_type {
        validate_effective_message_type(until_type, "until_type")?;
    }
    Ok(())
}

pub fn message_type_matches(effective_type: &str, types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|t| t == effective_type)
}

pub fn message_subtype_matches(subtype: &str, subtypes: &[String]) -> bool {
    subtypes.is_empty() || subtypes.iter().any(|t| t == subtype)
}

pub fn message_content_matches(
    content: &str,
    compiled: &Option<Regex>,
    plain: &Option<String>,
    case_sensitive: bool,
) -> bool {
    if let Some(re) = compiled {
        return re.is_match(content);
    }
    if let Some(p) = plain {
        if case_sensitive {
            return content.contains(p.as_str());
        }
        return content.to_lowercase().contains(p.as_str());
    }
    true
}

pub struct ContentFilter {
    compiled_regex: Option<Regex>,
    plain_pattern: Option<String>,
    case_sensitive: bool,
}

impl ContentFilter {
    pub fn has_filter(&self) -> bool {
        self.compiled_regex.is_some() || self.plain_pattern.is_some()
    }

    pub fn matches(&self, content: &str) -> bool {
        message_content_matches(content, &self.compiled_regex, &self.plain_pattern, self.case_sensitive)
    }
}

pub fn build_content_filter(
    pattern: &Option<String>,
    use_regex: bool,
    case_sensitive: bool,
) -> Result<ContentFilter, ErrorResponse> {
    let compiled_regex = if let Some(pat) = pattern {
        if use_regex {
            Some(
                RegexBuilder::new(pat)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|e| ErrorResponse {
                        error: "invalid_regex".to_string(),
                        message: format!("无效的正则表达式: {e}"),
                        available: None,
                    })?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let plain_pattern = if pattern.is_some() && !use_regex {
        if case_sensitive {
            pattern.clone()
        } else {
            pattern.as_ref().map(|p| p.to_lowercase())
        }
    } else {
        None
    };
    Ok(ContentFilter {
        compiled_regex,
        plain_pattern,
        case_sensitive,
    })
}

pub const MAX_SESSION_WINDOW: usize = 2_000;
pub const MAX_SESSION_WINDOW_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOOL_BLOCKS: usize = 2048;
pub const MAX_TOOL_PENDING_BYTES: usize = 8 * 1024 * 1024;

pub fn tool_block_count(record: &MessageRecord) -> usize {
    record
        .message
        .as_ref()
        .and_then(|message| message.get("content"))
        .and_then(serde_json::Value::as_array)
        .map_or(0, |blocks| {
            blocks
                .iter()
                .filter(|block| {
                    matches!(
                        block.get("type").and_then(serde_json::Value::as_str),
                        Some("tool_use" | "tool_result")
                    )
                })
                .count()
        })
}

pub struct IndexedMessage {
    pub span: crate::record_reader::SourceSpan,
    pub line_num: usize,
    pub effective_type: &'static str,
    pub subtype: &'static str,
    pub matches_pattern: bool,
}

pub enum SessionRange<'a> {
    Counts { before: usize, after: Option<usize> },
    UntilType { effective_type: &'a str, backward: bool },
    UntilRef { line: usize },
}

pub struct SessionIndex {
    file: File,
    snapshot: fs::Metadata,
    pub messages: Vec<IndexedMessage>,
    pub anchor_idx: usize,
    pub warnings: Vec<String>,
    pub incomplete_reasons: Vec<String>,
}

pub struct WindowRecord {
    pub line_num: usize,
    pub result_previews: std::collections::BTreeMap<usize, (String, usize)>,
    pub record: MessageRecord,
    pub effective_type: &'static str,
    pub subtype: &'static str,
    pub content: String,
    pub redacted_count: usize,
}

pub fn index_session_messages(
    path: &Path,
    anchor_line: usize,
    filter: &ContentFilter,
    redaction: RedactionMode,
    types: &[String],
    subtypes: &[String],
    range: SessionRange<'_>,
) -> Result<SessionIndex, ErrorResponse> {
    let file = crate::session_files::open_session_file(path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法读取会话文件: {e}"),
        available: None,
    })?;
    let window_limit = || ErrorResponse {
        error: "session_window_limit".to_string(),
        message: format!("上下文范围超过 {MAX_SESSION_WINDOW} 条，使用 before/after 或 until_ref 缩小范围"),
        available: None,
    };
    let missing_until = || ErrorResponse {
        error: "ref_not_found".to_string(),
        message: "until_ref 行不存在或无法读取".to_string(),
        available: None,
    };
    let matches = |message: &IndexedMessage| {
        message_type_matches(message.effective_type, types)
            && message_subtype_matches(message.subtype, subtypes)
            && message.matches_pattern
    };
    let mut messages = VecDeque::new();
    let mut message_pos = 0;
    let mut anchor_pos = None;
    let mut boundary_pos = None;
    let mut evicted_match = false;
    let mut start = 0;
    let mut end = 0;
    let mut after_matches = 0;
    let mut parse_errors = 0;
    let snapshot = file
        .metadata()
        .map_err(|error| crate::record_reader::reader_error("io_error", error.to_string()))?;
    let reader = crate::session_files::open_session_file(path)
        .map_err(|error| crate::record_reader::reader_error("io_error", error.to_string()))?;
    if !crate::session_files::matches_snapshot(
        &snapshot,
        &reader
            .metadata()
            .map_err(|error| crate::record_reader::reader_error("io_error", error.to_string()))?,
    ) {
        return Err(crate::record_reader::reader_error(
            "source_changed",
            "会话在建立窗口索引时发生变化",
        ));
    }
    let mut lines = crate::record_reader::RecordLines::new(reader, snapshot.len());
    loop {
        let mut remaining = u64::MAX;
        let located = match lines.step(
            &mut remaining,
            std::time::Instant::now() + std::time::Duration::from_secs(120),
        )? {
            crate::record_reader::LineStep::Record(record) => record,
            crate::record_reader::LineStep::Yield => continue,
            crate::record_reader::LineStep::End => break,
        };
        let line_num = located.line;
        if line_num > anchor_line && anchor_pos.is_none() {
            break;
        }
        if let SessionRange::UntilRef { line } = range
            && line_num > line.max(anchor_line)
        {
            break;
        }
        let (effective_type, subtype, matches_pattern) = if let Some(line) = located.small {
            let record = match std::str::from_utf8(&line)
                .ok()
                .and_then(|line| parse_message_record(line).ok())
            {
                Some(Some(record)) => record,
                Some(None) => continue,
                None => {
                    parse_errors += 1;
                    continue;
                }
            };
            let (effective_type, subtype) = classify_message(&record);
            (
                effective_type,
                subtype,
                !filter.has_filter()
                    || filter
                        .matches(&redact_text_with_mode(&replace_images_with_placeholders(&record), redaction).text),
            )
        } else {
            let indexed = match crate::record_reader::index_record(
                file.try_clone()
                    .map_err(|error| crate::record_reader::reader_error("io_error", error.to_string()))?,
                located.span,
                true,
            ) {
                Ok(indexed) => indexed,
                Err(error) if error.error == "parse_error" => {
                    parse_errors += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if indexed.metadata.is_none() {
                continue;
            }
            let (effective_type, subtype) = indexed.classify(
                file.try_clone()
                    .map_err(|error| crate::record_reader::reader_error("io_error", error.to_string()))?,
                located.span,
            )?;
            let matches_pattern = if filter.has_filter() {
                let (content, _) = render_window_content(&indexed, &file, located.span, redaction)?;
                filter.matches(&content)
            } else {
                true
            };
            (effective_type, subtype, matches_pattern)
        };
        crate::record_reader::check_work()?;
        let pos = message_pos;
        message_pos += 1;
        let item = IndexedMessage {
            span: located.span,
            line_num,
            effective_type,
            subtype,
            matches_pattern,
        };
        let matched = matches(&item);
        if let SessionRange::UntilRef { line } = range
            && line_num == line
        {
            boundary_pos = Some(pos);
        }
        if line_num < anchor_line {
            if let SessionRange::UntilType {
                effective_type,
                backward: true,
            } = range
                && item.effective_type == effective_type
            {
                boundary_pos = Some(pos);
            }
            if messages.len() == MAX_SESSION_WINDOW {
                evicted_match |= messages.pop_front().as_ref().is_some_and(matches);
            }
            messages.push_back(item);
            continue;
        }
        if line_num == anchor_line {
            anchor_pos = Some(pos);
            start = match range {
                SessionRange::Counts { before, .. } => {
                    let mut selected = pos;
                    let mut count = 0;
                    if before > 0 {
                        for (offset, message) in messages.iter().enumerate().rev() {
                            if matches(message) {
                                count += 1;
                                selected = pos - messages.len() + offset;
                                if count == before {
                                    break;
                                }
                            }
                        }
                        if count < before && evicted_match {
                            return Err(window_limit());
                        }
                    }
                    selected
                }
                SessionRange::UntilType { backward: true, .. } => boundary_pos.unwrap_or(pos),
                SessionRange::UntilRef { line } if line < anchor_line => boundary_pos.ok_or_else(missing_until)?,
                _ => pos,
            };
            end = pos + 1;
            if end - start > MAX_SESSION_WINDOW {
                return Err(window_limit());
            }
            messages.drain(..start - (pos - messages.len()));
            messages.push_back(item);
            if matches!(
                range,
                SessionRange::Counts { after: Some(0), .. } | SessionRange::UntilType { backward: true, .. }
            ) || matches!(range, SessionRange::UntilRef { line } if line <= anchor_line)
            {
                break;
            }
            continue;
        }
        if messages.len() < MAX_SESSION_WINDOW {
            messages.push_back(item);
        }
        let finished = match range {
            SessionRange::Counts { after: Some(after), .. } => {
                if matched {
                    after_matches += 1;
                    end = pos + 1;
                }
                after_matches == after
            }
            SessionRange::Counts { after: None, .. } => {
                end = pos + 1;
                false
            }
            SessionRange::UntilType {
                effective_type: until_type,
                ..
            } => {
                if effective_type == until_type {
                    end = pos + 1;
                    true
                } else {
                    false
                }
            }
            SessionRange::UntilRef { line } => {
                if line_num == line {
                    end = pos + 1;
                    true
                } else {
                    false
                }
            }
        };
        if end - start > MAX_SESSION_WINDOW {
            return Err(window_limit());
        }
        if finished {
            break;
        }
    }
    let anchor_pos = anchor_pos.ok_or_else(|| ErrorResponse {
        error: "ref_not_found".to_string(),
        message: format!("ref 行不存在或不是有效消息记录: {anchor_line}"),
        available: None,
    })?;
    if matches!(range, SessionRange::UntilRef { .. }) && boundary_pos.is_none() {
        return Err(missing_until());
    }
    messages.truncate(end - start);
    let warnings = jsonl_read_warnings(0, parse_errors);
    let mut incomplete_reasons = Vec::new();
    if parse_errors > 0 {
        incomplete_reasons.push(format!("parse_errors={parse_errors}"));
    }
    Ok(SessionIndex {
        file,
        snapshot,
        messages: messages.into(),
        anchor_idx: anchor_pos - start,
        warnings,
        incomplete_reasons,
    })
}

fn render_window_content(
    indexed: &crate::record_reader::IndexedRecord,
    file: &File,
    span: crate::record_reader::SourceSpan,
    redaction: RedactionMode,
) -> Result<(String, usize), ErrorResponse> {
    use crate::record_reader::{TextBytes, reader_error, render_text_range};
    let clone = || {
        file.try_clone()
            .map_err(|error| reader_error("io_error", error.to_string()))
    };
    let projection = indexed.projection(clone()?, span, "content", None)?;
    let mut text = TextBytes::new(projection.cursor(clone()?, span));
    let mut content = String::new();
    let (_, _, count) = render_text_range(&mut text, redaction, None, |chunk| {
        if content.len() + chunk.len() > MAX_SESSION_WINDOW_BYTES {
            return Err(reader_error(
                "session_window_memory_limit",
                "逻辑正文超过 32 MiB，请用 history_get range/output 读取目标记录",
            ));
        }
        content.push_str(std::str::from_utf8(chunk).map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?);
        Ok(())
    })?;
    Ok((content, count))
}

pub fn load_session_window(
    path: &Path,
    index: &SessionIndex,
    redaction: RedactionMode,
) -> Result<Vec<WindowRecord>, ErrorResponse> {
    use crate::record_reader::{check_work, index_record, reader_error};
    let io_error = |error: io::Error| reader_error("io_error", error.to_string());
    let selected = &index.messages;
    if selected.len() > MAX_SESSION_WINDOW {
        return Err(reader_error(
            "session_window_limit",
            format!("上下文范围超过 {MAX_SESSION_WINDOW} 条，使用 before/after 或 until_ref 缩小范围"),
        ));
    }
    let current = crate::session_files::open_session_file(path).map_err(io_error)?;
    if !crate::session_files::matches_snapshot(&index.snapshot, &current.metadata().map_err(io_error)?) {
        return Err(reader_error("source_changed", "会话在索引和读取之间发生变化"));
    }
    let mut file = index.file.try_clone().map_err(io_error)?;
    let mut records = Vec::with_capacity(selected.len());
    let mut bytes = 0u64;
    let mut rendered_bytes = 0usize;
    for expected in selected {
        check_work()?;
        let length = expected.span.end - expected.span.start;
        bytes = bytes.saturating_add(length);
        if bytes > MAX_SESSION_WINDOW_BYTES as u64 {
            return Err(ErrorResponse {
                error: "session_window_memory_limit".to_string(),
                message: format!(
                    "选定范围超过 {MAX_SESSION_WINDOW_BYTES} 字节，请缩小范围或用 history_get range/output 读取单条记录"
                ),
                available: Some(
                    serde_json::json!({"source":path, "ref":format!("{}:{}",path.file_stem().and_then(|name| name.to_str()).unwrap_or_default(),expected.line_num), "get":{"source":path, "ref":format!("{}:{}",path.file_stem().and_then(|name| name.to_str()).unwrap_or_default(),expected.line_num), "range":"0-100000", "redaction":redaction.as_str()}}),
                ),
            });
        }
        let mut result_previews = std::collections::BTreeMap::new();
        let (record, effective_type, subtype, content, redacted_count) = if length <= MAX_JSONL_LINE_BYTES as u64 {
            file.seek(SeekFrom::Start(expected.span.start)).map_err(io_error)?;
            let mut line = vec![0; length as usize];
            file.read_exact(&mut line).map_err(io_error)?;
            let record = std::str::from_utf8(&line)
                .ok()
                .and_then(|line| parse_message_record(line).ok().flatten())
                .ok_or_else(|| reader_error("source_changed", "会话目标记录在读取期间发生变化"))?;
            let (effective_type, subtype) = classify_message(&record);
            let rendered = redact_text_with_mode(&replace_images_with_placeholders(&record), redaction);
            (record, effective_type, subtype, rendered.text, rendered.count)
        } else {
            let indexed = index_record(file.try_clone().map_err(io_error)?, expected.span, true)?;
            let record = indexed.association_record(file.try_clone().map_err(io_error)?, expected.span, false)?;
            let (effective_type, subtype) = indexed.classify(file.try_clone().map_err(io_error)?, expected.span)?;
            let (content, count) = render_window_content(&indexed, &file, expected.span, redaction)?;
            if let Some(blocks) = record
                .message
                .as_ref()
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_array)
            {
                for (block_index, _) in blocks
                    .iter()
                    .enumerate()
                    .filter(|(_, block)| block["type"] == "tool_result")
                {
                    result_previews.insert(
                        block_index,
                        indexed.tool_result_preview(
                            file.try_clone().map_err(io_error)?,
                            expected.span,
                            block_index,
                            redaction,
                            500,
                        )?,
                    );
                }
            }
            (record, effective_type, subtype, content, count)
        };
        if effective_type != expected.effective_type || subtype != expected.subtype {
            return Err(reader_error("source_changed", "会话消息类型在读取期间发生变化"));
        }
        rendered_bytes = rendered_bytes.saturating_add(content.len());
        if rendered_bytes > MAX_SESSION_WINDOW_BYTES {
            return Err(reader_error(
                "session_window_memory_limit",
                "选定逻辑正文超过 32 MiB，请缩小范围或使用 history_get range/output",
            ));
        }
        records.push(WindowRecord {
            line_num: expected.line_num,
            result_previews,
            record,
            effective_type,
            subtype,
            content,
            redacted_count,
        });
    }
    if !crate::session_files::matches_snapshot(&index.snapshot, &current.metadata().map_err(io_error)?) {
        return Err(reader_error("source_changed", "会话在读取窗口时发生变化"));
    }
    check_work()?;
    Ok(records)
}

pub fn write_filtered_message_export<'a, W, I>(
    writer: &mut W,
    prefix: &str,
    items: I,
    anchor_idx: usize,
    filters: MessageExportFilters<'_>,
) -> Result<(usize, usize), ErrorResponse>
where
    W: Write,
    I: IntoIterator<Item = (usize, ExportMessage<'a>)>,
{
    let mut written_messages = 0usize;
    let mut redacted_count = 0usize;
    let has_pattern_filter = filters.content_filter.has_filter();

    for (idx, item) in items {
        let is_anchor = idx == anchor_idx;
        if !is_anchor
            && (!message_type_matches(item.effective_type, filters.types)
                || !message_subtype_matches(item.subtype, filters.subtypes))
        {
            continue;
        }
        if !is_anchor && has_pattern_filter && !filters.content_filter.matches(item.content) {
            continue;
        }
        let anchor_mark = if is_anchor { " [anchor]" } else { "" };
        writeln!(
            writer,
            "=== {}:{} {} {}{} ===",
            prefix, item.line_num, item.effective_type, item.subtype, anchor_mark
        )
        .map_err(export_io_error)?;
        writeln!(writer, "{}", item.content).map_err(export_io_error)?;
        writeln!(writer).map_err(export_io_error)?;
        written_messages += 1;
        redacted_count += item.redacted_count;
    }

    Ok((written_messages, redacted_count))
}

/// 消息分类：(effective_type, subtype)
///
/// effective_type：修正后的类型（isCompactSummary 的 user → summary）
/// subtype：细粒度分类
///   user   → human / tool_result / meta
///   assistant → text / tool_use / thinking / empty
///   summary → summary
///   system → system
pub fn classify_message(record: &MessageRecord) -> (&'static str, &'static str) {
    match record.msg_type.as_str() {
        "user" => {
            if record.is_compact_summary {
                return ("summary", "summary");
            }
            if record.is_meta {
                return ("user", "meta");
            }
            if let Some(message) = &record.message
                && let Some(content) = message.get("content")
            {
                if content.is_string() {
                    return ("user", "human");
                }
                if let Some(arr) = content.as_array()
                    && arr
                        .iter()
                        .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                {
                    return ("user", "tool_result");
                }
            }
            ("user", "human")
        }
        "assistant" => {
            if let Some(message) = &record.message
                && let Some(content) = message.get("content")
            {
                // content 为字符串：纯文本回复
                if let Some(s) = content.as_str() {
                    return if s.is_empty() {
                        ("assistant", "empty")
                    } else {
                        ("assistant", "text")
                    };
                }
                // content 为数组：优先级 text > tool_use > thinking > empty
                if let Some(arr) = content.as_array() {
                    let has_text = arr.iter().any(|item| {
                        item.get("type").and_then(|t| t.as_str()) == Some("text")
                            && item.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.is_empty())
                    });
                    if has_text {
                        return ("assistant", "text");
                    }
                    if arr
                        .iter()
                        .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                    {
                        return ("assistant", "tool_use");
                    }
                    if arr
                        .iter()
                        .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                    {
                        return ("assistant", "thinking");
                    }
                }
            }
            ("assistant", "empty")
        }
        "system" => ("system", "system"),
        // progress, file-history-snapshot 等内部类型，搜索时会被 types 过滤掉
        _ => ("other", "other"),
    }
}

/// 从消息记录中提取图片信息
pub fn extract_images(record: &MessageRecord) -> Vec<ImageInfo> {
    let Some(message) = &record.message else {
        return Vec::new();
    };

    let Some(content) = message.get("content") else {
        return Vec::new();
    };

    let Some(arr) = content.as_array() else {
        return Vec::new();
    };

    let mut images = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        if item.get("type").and_then(|t| t.as_str()) == Some("image")
            && let Some(source) = item.get("source")
            && let Some(data) = source.get("data").and_then(|d| d.as_str())
        {
            images.push(ImageInfo {
                index: idx,
                size: data.len(),
            });
        }
    }

    images
}

/// 从消息记录中提取图片的 base64 数据
pub fn extract_image_data(record: &MessageRecord, index: usize) -> Option<(String, Vec<u8>)> {
    let message = record.message.as_ref()?;
    let content = message.get("content")?;
    let arr = content.as_array()?;

    let item = arr.get(index)?;
    if item.get("type").and_then(|t| t.as_str()) != Some("image") {
        return None;
    }

    let source = item.get("source")?;
    let data = source.get("data").and_then(|d| d.as_str())?;
    let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");

    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?;

    // 从 media_type 推断扩展名
    let ext = match media_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };

    Some((ext.to_string(), decoded))
}

/// 从 tool_result 内容字段中提取文本字符串
fn extract_tool_result_texts(item: &serde_json::Value) -> Vec<String> {
    let mut texts = Vec::new();
    if let Some(content) = item.get("content") {
        if let Some(s) = content.as_str() {
            texts.push(s.to_string());
        } else if let Some(sub_arr) = content.as_array() {
            for sub in sub_arr {
                if let Some(text) = sub.get("text").and_then(|t| t.as_str()) {
                    texts.push(text.to_string());
                }
            }
        }
    }
    texts
}

/// 将内容中的图片替换为占位符，保留完整工具输入
pub fn replace_images_with_placeholders(record: &MessageRecord) -> String {
    extract_and_replace_images(record).0
}

/// 一次遍历同时提取图片列表和带占位符的完整文本
pub fn extract_and_replace_images(record: &MessageRecord) -> (String, Vec<ImageInfo>) {
    let Some(message) = &record.message else {
        return (String::new(), Vec::new());
    };
    let Some(content) = message.get("content") else {
        return (String::new(), Vec::new());
    };
    if let Some(s) = content.as_str() {
        return (s.to_string(), Vec::new());
    }
    let Some(arr) = content.as_array() else {
        return (String::new(), Vec::new());
    };

    let mut text_parts = Vec::new();
    let mut images = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match item_type {
            "image" => {
                if let Some(source) = item.get("source") {
                    let size = source
                        .get("data")
                        .and_then(|d| d.as_str())
                        .map(|d| d.len())
                        .unwrap_or(0);
                    let size_mb = size as f64 / 1024.0 / 1024.0;
                    text_parts.push(format!("[IMAGE:{idx} size={size_mb:.1}MB]"));
                    images.push(ImageInfo { index: idx, size });
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                let input = item.get("input").map(serde_json::Value::to_string).unwrap_or_default();
                text_parts.push(format!("[TOOL_USE:{name}({input})]"));
            }
            "tool_result" => text_parts.extend(extract_tool_result_texts(item)),
            _ => {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
        }
    }

    (text_parts.join("\n"), images)
}

/// 返回字符串中第 n 个字符的 byte 偏移；越界则返回字符串总长度
fn nth_byte_or_end(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map(|(b, _)| b).unwrap_or(s.len())
}

pub fn parse_time_param(s: &str, name: &str) -> Result<chrono::DateTime<chrono::Utc>, String> {
    if s == "today" {
        return date_bound(chrono::Utc::now().date_naive(), name);
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return date_bound(date, name);
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|time| time.with_timezone(&chrono::Utc))
        .map_err(|_| format!("{name} 必须是带时区的 RFC3339、UTC 日期 YYYY-MM-DD 或 today"))
}

fn date_bound(date: chrono::NaiveDate, name: &str) -> Result<chrono::DateTime<chrono::Utc>, String> {
    let start = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    let time = if name == "until" {
        date.succ_opt()
            .and_then(|next| next.and_hms_opt(0, 0, 0))
            .ok_or_else(|| "until 日期超出支持范围".to_string())?
    } else {
        start
    };
    Ok(chrono::DateTime::from_naive_utc_and_offset(time, chrono::Utc))
}

pub fn parse_range_param(s: &str) -> Result<(usize, usize), String> {
    let Some((start, end)) = parse_range(s) else {
        return Err("range 必须是 start-end 格式，例如 0-100000".to_string());
    };
    if start > end {
        return Err(format!("range start({start}) 大于 end({end})"));
    }
    Ok((start, end))
}

#[derive(Debug, Clone)]
pub struct MessageSlice {
    pub raw: String,
    pub start: Option<isize>,
    pub end: Option<isize>,
}

impl MessageSlice {
    pub fn needs_full_scan(&self) -> bool {
        self.start.is_some_and(|v| v < 0) || self.end.is_none_or(|v| v < 0)
    }
}

pub fn parse_message_slice_param(s: &str) -> Result<MessageSlice, String> {
    let raw = s.trim();
    let body = raw
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(raw)
        .trim();

    if body.is_empty() || body.matches(':').count() != 1 {
        return Err("slice 必须是 [start:end] 格式，例如 [-10:] 或 [-10:-1]，不支持 step".to_string());
    }

    let (start_raw, end_raw) = body.split_once(':').expect("slice colon count checked");
    let parse_bound = |part: &str, name: &str| -> Result<Option<isize>, String> {
        let value = part.trim();
        if value.is_empty() {
            return Ok(None);
        }
        value
            .parse::<isize>()
            .map(Some)
            .map_err(|_| format!("slice {name} 不是有效整数: {value}"))
    };

    Ok(MessageSlice {
        raw: raw.to_string(),
        start: parse_bound(start_raw, "start")?,
        end: parse_bound(end_raw, "end")?,
    })
}

pub fn normalize_message_slice(slice: &MessageSlice, len: usize) -> (usize, usize) {
    fn normalize(bound: Option<isize>, default: usize, len: usize) -> usize {
        let raw = bound.unwrap_or(default as isize);
        let value = if raw < 0 { len as isize + raw } else { raw };
        value.clamp(0, len as isize) as usize
    }

    let start = normalize(slice.start, 0, len);
    let end = normalize(slice.end, len, len);
    if end < start { (start, start) } else { (start, end) }
}

pub fn parse_line_ranges_param(s: &str) -> Result<Vec<Range>, String> {
    let mut ranges = Vec::new();
    for part in s.split(',') {
        let raw = part.trim();
        if raw.is_empty() {
            continue;
        }
        let exclude = raw.starts_with('!');
        let value = if exclude { &raw[1..] } else { raw };
        if value.is_empty() {
            return Err(format!("无效的 lines 片段: {raw}"));
        }
        if value.contains('-') {
            let pieces: Vec<&str> = value.splitn(2, '-').collect();
            let start = if pieces[0].is_empty() {
                None
            } else {
                Some(
                    pieces[0]
                        .parse::<usize>()
                        .map_err(|_| format!("无效的 lines 起点: {raw}"))?,
                )
            };
            let end = if pieces.len() < 2 || pieces[1].is_empty() {
                None
            } else {
                Some(
                    pieces[1]
                        .parse::<usize>()
                        .map_err(|_| format!("无效的 lines 终点: {raw}"))?,
                )
            };
            if let (Some(start), Some(end)) = (start, end)
                && start > end
            {
                return Err(format!("lines 起点大于终点: {raw}"));
            }
            ranges.push(Range { start, end, exclude });
        } else {
            let line = value
                .parse::<usize>()
                .map_err(|_| format!("无效的 lines 行号: {raw}"))?;
            ranges.push(Range {
                start: Some(line),
                end: Some(line),
                exclude,
            });
        }
    }
    Ok(ranges)
}

pub fn format_line_ranges(ranges: &[Range]) -> String {
    ranges
        .iter()
        .map(|range| {
            let prefix = if range.exclude { "!" } else { "" };
            match (range.start, range.end) {
                (Some(start), Some(end)) if start == end => format!("{prefix}{start}"),
                (Some(start), Some(end)) => format!("{prefix}{start}-{end}"),
                (Some(start), None) => format!("{prefix}{start}-"),
                (None, Some(end)) => format!("{prefix}-{end}"),
                (None, None) => format!("{prefix}-"),
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub fn invalid_arguments(message: impl Into<String>) -> ErrorResponse {
    ErrorResponse {
        error: "invalid_arguments".to_string(),
        message: message.into(),
        available: None,
    }
}

pub fn split_csv_param(value: Option<&str>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_optional_time_param(
    value: Option<&str>,
    name: &str,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, ErrorResponse> {
    value
        .map(|s| parse_time_param(s, name).map_err(invalid_arguments))
        .transpose()
}

#[derive(Debug, Clone, Copy)]
pub struct UntilBound {
    pub instant: chrono::DateTime<chrono::Utc>,
    pub exclusive: bool,
}

impl UntilBound {
    pub fn query_value(self) -> String {
        if self.exclusive {
            self.instant
                .date_naive()
                .pred_opt()
                .expect("exclusive date has a predecessor")
                .format("%Y-%m-%d")
                .to_string()
        } else {
            self.instant.to_rfc3339()
        }
    }
}

pub fn parse_time_bounds(
    since: Option<&str>,
    until: Option<&str>,
) -> Result<(Option<chrono::DateTime<chrono::Utc>>, Option<UntilBound>), ErrorResponse> {
    let today = chrono::Utc::now().date_naive();
    let parse = |value: Option<&str>, name: &str| {
        if value == Some("today") {
            date_bound(today, name).map(Some).map_err(invalid_arguments)
        } else {
            parse_optional_time_param(value, name)
        }
    };
    Ok((
        parse(since, "since")?,
        parse(until, "until")?.map(|instant| UntilBound {
            instant,
            exclusive: until
                .is_some_and(|value| value == "today" || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()),
        }),
    ))
}

pub fn parse_optional_range_param(value: Option<&str>) -> Result<Option<(usize, usize)>, ErrorResponse> {
    value.map(parse_range_param).transpose().map_err(invalid_arguments)
}

pub fn parse_optional_message_slice_param(value: Option<&str>) -> Result<Option<MessageSlice>, ErrorResponse> {
    value
        .map(parse_message_slice_param)
        .transpose()
        .map_err(invalid_arguments)
}

pub fn parse_optional_line_ranges_param(value: Option<&str>) -> Result<Vec<Range>, ErrorResponse> {
    value
        .map(parse_line_ranges_param)
        .transpose()
        .map_err(invalid_arguments)
        .map(|v| v.unwrap_or_default())
}

pub fn parse_optional_redaction_mode_param(value: Option<&str>) -> Result<RedactionMode, ErrorResponse> {
    value
        .map(parse_redaction_mode_param)
        .transpose()
        .map_err(invalid_arguments)
        .map(|v| v.unwrap_or_default())
}

/// 截断内容到指定长度
pub fn truncate_content(content: &str, max_len: usize) -> (String, bool) {
    if content.chars().count() <= max_len {
        return (content.to_string(), false);
    }
    let byte_idx = nth_byte_or_end(content, max_len);
    (content[..byte_idx].to_string(), true)
}

/// 围绕匹配位置截断内容（grep -C 风格）
///
/// 匹配位置居中展示，前后各保留 max_len/2 的上下文
/// 无匹配位置信息时退化为从头截断
pub fn preview_bounds(char_count: usize, match_pos: Option<usize>, max_len: usize) -> (usize, usize, bool, bool) {
    if char_count <= max_len {
        return (0, char_count, false, false);
    }
    if max_len == 0 {
        return (0, 0, false, false);
    }
    let Some(pos) = match_pos else {
        return (0, max_len, false, false);
    };
    let pos = pos.min(char_count);
    let centered_window = |content_len: usize| {
        let mut start = pos.saturating_sub(content_len / 2);
        let end = (start + content_len).min(char_count);
        if end == char_count {
            start = char_count.saturating_sub(content_len);
        }
        (start, end)
    };
    let mut prefix_ellipsis = false;
    let mut suffix_ellipsis = false;

    for _ in 0..3 {
        let ellipsis_len = 3 * usize::from(prefix_ellipsis) + 3 * usize::from(suffix_ellipsis);
        if ellipsis_len >= max_len {
            prefix_ellipsis = false;
            suffix_ellipsis = false;
            break;
        }
        let (start, end) = centered_window(max_len - ellipsis_len);
        let next_prefix_ellipsis = start > 0;
        let next_suffix_ellipsis = end < char_count;
        if next_prefix_ellipsis == prefix_ellipsis && next_suffix_ellipsis == suffix_ellipsis {
            break;
        }
        prefix_ellipsis = next_prefix_ellipsis;
        suffix_ellipsis = next_suffix_ellipsis;
    }

    let ellipsis_len = 3 * usize::from(prefix_ellipsis) + 3 * usize::from(suffix_ellipsis);
    let (start, end) = centered_window(max_len - ellipsis_len);

    (start, end, prefix_ellipsis, suffix_ellipsis)
}

pub fn truncate_around_match(content: &str, match_pos: Option<usize>, max_len: usize) -> (String, bool) {
    // 用 chars().count() 单次扫描算字符数，避免预分配 Vec<usize>
    // （预分配在 100KB+ 内容上会消耗 ~800KB+ 临时内存）
    let char_count = content.chars().count();
    if char_count <= max_len {
        return (content.to_string(), false);
    }
    let (start, end, prefix_ellipsis, suffix_ellipsis) = preview_bounds(char_count, match_pos, max_len);
    // 二次扫描定位 start/end 的 byte 偏移（O(N)、无内存分配）
    let start_byte = nth_byte_or_end(content, start);
    let end_byte = nth_byte_or_end(content, end);
    let mut result = String::with_capacity(max_len);
    if prefix_ellipsis {
        result.push_str("...");
    }
    result.push_str(&content[start_byte..end_byte]);
    if suffix_ellipsis {
        result.push_str("...");
    }

    (result, true)
}

/// 搜索词解析结果
#[derive(Debug)]
pub struct SearchPattern {
    pub must_have: Vec<String>,   // AND 条件
    pub any_of: Vec<Vec<String>>, // OR 条件组
    pub must_not: Vec<String>,    // NOT 条件
}

/// 解析搜索词
/// 语法：
/// - 空格分隔 = AND
/// - | 分隔 = OR
/// - ! 前缀 = NOT
pub fn parse_search_pattern(pattern: &str, case_sensitive: bool) -> SearchPattern {
    let mut must_have = Vec::new();
    let mut any_of = Vec::new();
    let mut must_not = Vec::new();

    let normalize = |s: &str| {
        if case_sensitive {
            s.to_string()
        } else {
            s.to_lowercase()
        }
    };

    for word in pattern.split_whitespace() {
        if let Some(word) = word.strip_prefix('!') {
            if !word.is_empty() {
                must_not.push(normalize(word));
            }
        } else if word.contains('|') {
            let or_words: Vec<String> = word.split('|').filter(|w| !w.is_empty()).map(normalize).collect();
            if !or_words.is_empty() {
                any_of.push(or_words);
            }
        } else {
            must_have.push(normalize(word));
        }
    }

    SearchPattern {
        must_have,
        any_of,
        must_not,
    }
}

/// 检查内容是否匹配搜索模式
pub fn matches_pattern(content: &str, pattern: &SearchPattern, case_sensitive: bool) -> (bool, Option<usize>) {
    if case_sensitive {
        // must_have（AND）
        for word in &pattern.must_have {
            if !content.contains(word) {
                return (false, None);
            }
        }

        // must_not（NOT）
        for word in &pattern.must_not {
            if content.contains(word) {
                return (false, None);
            }
        }

        // any_of（OR 组）
        let mut match_pos = pattern
            .must_have
            .first()
            .and_then(|w| content.find(w))
            .map(|byte_pos| content[..byte_pos].chars().count());

        for or_group in &pattern.any_of {
            let mut group_pos: Option<usize> = None;
            for word in or_group {
                if let Some(byte_pos) = content.find(word.as_str()) {
                    group_pos = Some(content[..byte_pos].chars().count());
                    break;
                }
            }
            if group_pos.is_none() {
                return (false, None);
            }
            if match_pos.is_none() {
                match_pos = group_pos;
            }
        }

        return (true, match_pos);
    }

    // case-insensitive：构造小写内容 + 小写字符索引到原文字符索引的映射
    // 预分配 capacity（按字节上界），避免热路径多次 Vec/String grow 抖动
    let mut lower = String::with_capacity(content.len());
    let mut map: Vec<usize> = Vec::with_capacity(content.len());
    for (orig_idx, ch) in content.chars().enumerate() {
        for lc in ch.to_lowercase() {
            lower.push(lc);
            map.push(orig_idx);
        }
    }

    let find_pos = |word: &str| -> Option<usize> {
        let byte_pos = lower.find(word)?;
        let lower_char_pos = lower[..byte_pos].chars().count();
        map.get(lower_char_pos).copied()
    };

    // must_have（AND）：单次 find，既判断存在又获取位置
    let mut first_must_pos: Option<usize> = None;
    for word in &pattern.must_have {
        match find_pos(word) {
            None => return (false, None),
            Some(pos) => {
                if first_must_pos.is_none() {
                    first_must_pos = Some(pos);
                }
            }
        }
    }

    // must_not（NOT）
    for word in &pattern.must_not {
        if lower.contains(word) {
            return (false, None);
        }
    }

    // any_of（OR 组）：单次 find，既判断存在又获取位置
    let mut match_pos = first_must_pos;

    for or_group in &pattern.any_of {
        let mut group_pos: Option<usize> = None;
        for word in or_group {
            if let Some(pos) = find_pos(word) {
                group_pos = Some(pos);
                break;
            }
        }
        if group_pos.is_none() {
            return (false, None);
        }
        if match_pos.is_none() {
            match_pos = group_pos;
        }
    }

    (true, match_pos)
}

/// 解析时间字符串
pub fn parse_time(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    // 支持多种格式
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&chrono::Utc));
    }

    // 尝试解析日期
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let dt = date.and_hms_opt(0, 0, 0)?;
        return Some(chrono::DateTime::from_naive_utc_and_offset(dt, chrono::Utc));
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeRangeMatch {
    Matches,
    OutsideRange,
    UnparseableTimestamp,
}

/// 比较时间。未启用时间过滤时保留无法解析时间的记录；启用后无法解析的记录不匹配
pub fn time_in_range(
    timestamp: &str,
    since: Option<&chrono::DateTime<chrono::Utc>>,
    until: Option<&UntilBound>,
) -> TimeRangeMatch {
    if since.is_none() && until.is_none() {
        return TimeRangeMatch::Matches;
    }

    let Some(ts) = parse_time(timestamp) else {
        return TimeRangeMatch::UnparseableTimestamp;
    };

    if let Some(since) = since
        && ts < *since
    {
        return TimeRangeMatch::OutsideRange;
    }

    if let Some(until) = until
        && (ts > until.instant || (until.exclusive && ts == until.instant))
    {
        return TimeRangeMatch::OutsideRange;
    }

    TimeRangeMatch::Matches
}

pub const SIDECHAIN_SESSION_DIRS: &[&str] = &["subagents", "remote-agents"];

/// 从 session 文件名中提取 session ID
pub fn session_id_from_filename(filename: &str) -> Option<String> {
    let name = filename.strip_suffix(".jsonl")?;
    // 排除 agent- 前缀的文件
    if name.starts_with("agent-") {
        return None;
    }
    Some(name.to_string())
}

/// 获取 ref_prefix（session ID 前 8 位）
pub fn ref_prefix(session_id: &str) -> String {
    // agent 子会话文件名为 "agent-<id>.jsonl"，前缀固定会导致 ref_prefix 冲突率过高
    let normalized = session_id.strip_prefix("agent-").unwrap_or(session_id);
    normalized.chars().take(8).collect()
}

pub fn session_matches_ref(session_id: &str, requested: &str) -> bool {
    session_id == requested || ref_prefix(session_id) == requested
}

/// 解析 "start-end" 格式的范围字符串
pub fn parse_range(s: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 2 {
        let start = parts[0].parse().ok()?;
        let end = parts[1].parse().ok()?;
        Some((start, end))
    } else {
        None
    }
}

pub fn parse_mcp_tool_name(name: &str) -> ToolInfo {
    let mut parts = name.splitn(3, "__");
    let first = parts.next();
    let second = parts.next();
    let third = parts.next();
    if let (Some(prefix), Some(server), Some(tool)) = (first, second, third)
        && prefix == "mcp"
    {
        return ToolInfo {
            server: Some(server.to_string()),
            tool: Some(tool.to_string()),
        };
    }
    ToolInfo {
        server: None,
        tool: Some(name.to_string()),
    }
}

pub struct TextRedaction {
    pub text: String,
    pub count: usize,
}

#[derive(Debug)]
struct RedactionEdit {
    start: usize,
    end: usize,
    replacement: &'static str,
}

pub fn redact_text_with_mode(text: &str, mode: RedactionMode) -> TextRedaction {
    redact_text_range_with_mode(text, mode, None)
}

pub fn redact_text_range_with_mode(text: &str, mode: RedactionMode, range: Option<(usize, usize)>) -> TextRedaction {
    let char_count = text.chars().count();
    let (start_char, end_char) = range.unwrap_or((0, char_count));
    if start_char >= end_char {
        return TextRedaction {
            text: String::new(),
            count: 0,
        };
    }
    let start = nth_byte_or_end(text, start_char.min(char_count));
    let end = nth_byte_or_end(text, end_char.min(char_count));
    if mode == RedactionMode::Off {
        return TextRedaction {
            text: text[start..end].to_string(),
            count: 0,
        };
    }

    let edits = collect_redaction_edits(text, mode);
    let mut output = String::new();
    let mut cursor = start;
    let mut count = 0;
    for edit in edits {
        if edit.end <= start || edit.start >= end {
            continue;
        }
        let visible_start = edit.start.max(start);
        if cursor < visible_start {
            output.push_str(&text[cursor..visible_start]);
        }
        output.push_str(edit.replacement);
        cursor = cursor.max(edit.end.min(end));
        count += 1;
    }
    if cursor < end {
        output.push_str(&text[cursor..end]);
    }
    TextRedaction { text: output, count }
}

pub(crate) fn npm_token_regex() -> &'static Regex {
    static NPM_TOKEN: OnceLock<Regex> = OnceLock::new();
    NPM_TOKEN.get_or_init(|| Regex::new(r"\bnpm_[A-Za-z0-9]{36}\b").expect("valid regex"))
}

pub(crate) fn token_uuid_statement_regex() -> &'static Regex {
    static TOKEN_UUID: OnceLock<Regex> = OnceLock::new();
    TOKEN_UUID.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:\btoken\b|令牌)[^\\\n\r"{}\[\]]{0,256}?(?:返回(?:了)?[ \t]{0,16}(?:新[ \t]{0,16})?|return(?:ed|s)?[ \t]{1,16}(?:a[ \t]{1,16})?(?:new[ \t]{1,16})?)UUID[ \t:：]{0,16}`?(?P<value>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b"#,
        )
        .expect("valid regex")
    })
}

fn collect_redaction_edits(text: &str, mode: RedactionMode) -> Vec<RedactionEdit> {
    static AUTH_HEADER_RE: OnceLock<Regex> = OnceLock::new();
    static COOKIE_HEADER_RE: OnceLock<Regex> = OnceLock::new();
    static PRIVATE_KEY_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static PRIVATE_HOST_RE: OnceLock<Regex> = OnceLock::new();
    static INTERNAL_URL_RE: OnceLock<Regex> = OnceLock::new();

    let mut edits = collect_sensitive_field_edits(text, mode);
    push_matches(&mut edits, text, npm_token_regex(), "[redacted]");
    for captures in token_uuid_statement_regex().captures_iter(text) {
        let value = captures.name("value").expect("UUID value");
        edits.push(RedactionEdit {
            start: value.start(),
            end: value.end(),
            replacement: "[redacted]",
        });
    }
    for captures in AUTH_HEADER_RE
        .get_or_init(|| Regex::new(r"(?i)\b(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+").expect("valid regex"))
        .captures_iter(text)
    {
        let whole = captures.get(0).expect("whole match");
        let prefix = captures.get(1).expect("authorization prefix");
        edits.push(RedactionEdit {
            start: prefix.end(),
            end: whole.end(),
            replacement: "[redacted]",
        });
    }

    if mode == RedactionMode::Strict {
        for captures in COOKIE_HEADER_RE
            .get_or_init(|| Regex::new(r"(?i)\b(cookie\s*[:=]\s*)[^\n\r]+").expect("valid regex"))
            .captures_iter(text)
        {
            let whole = captures.get(0).expect("whole match");
            let prefix = captures.get(1).expect("cookie prefix");
            edits.push(RedactionEdit {
                start: prefix.end(),
                end: whole.end(),
                replacement: "[redacted]",
            });
        }
        push_matches(
            &mut edits,
            text,
            PRIVATE_KEY_BLOCK_RE.get_or_init(|| {
                Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
                    .expect("valid regex")
            }),
            "[redacted-private-key]",
        );
        push_matches(
            &mut edits,
            text,
            PRIVATE_HOST_RE.get_or_init(|| {
                Regex::new(
                    r"\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b",
                )
                .expect("valid regex")
            }),
            "[redacted-host]",
        );
        push_matches(
            &mut edits,
            text,
            INTERNAL_URL_RE.get_or_init(|| Regex::new(r#"https?://[^\s"'<>]+"#).expect("valid regex")),
            "[redacted-url]",
        );
    }

    edits.sort_by(|left, right| left.start.cmp(&right.start).then_with(|| right.end.cmp(&left.end)));
    let mut normalized: Vec<RedactionEdit> = Vec::new();
    for edit in edits {
        if let Some(previous) = normalized.last_mut()
            && edit.start < previous.end
        {
            if edit.end > previous.end {
                previous.end = edit.end;
            }
            continue;
        }
        normalized.push(edit);
    }
    normalized
}

fn push_matches(edits: &mut Vec<RedactionEdit>, text: &str, regex: &Regex, replacement: &'static str) {
    edits.extend(regex.find_iter(text).map(|matched| RedactionEdit {
        start: matched.start(),
        end: matched.end(),
        replacement,
    }));
}

fn collect_sensitive_field_edits(text: &str, mode: RedactionMode) -> Vec<RedactionEdit> {
    let bytes = text.as_bytes();
    let mut edits = Vec::new();
    let mut cursor = 0;
    let mut quoted_scopes: Vec<(usize, usize, u32)> = Vec::new();
    while cursor < bytes.len() {
        while let Some(&(content_end, end, _)) = quoted_scopes.last() {
            if cursor < content_end {
                break;
            }
            quoted_scopes.pop();
            cursor = cursor.max(end);
        }
        if cursor >= bytes.len() {
            break;
        }
        let escaped_key = escaped_quoted_token(bytes, cursor);
        let (key_start, key_end, key, quoted_content_start, quoted_content_end) =
            if let Some((end, content_start, content_end)) = escaped_key {
                (
                    cursor,
                    end,
                    &text[content_start..content_end],
                    Some(content_start),
                    content_end,
                )
            } else {
                match bytes[cursor] {
                    b'"' | b'\'' => {
                        let quote = bytes[cursor];
                        let Some(end) = quoted_value_end(bytes, cursor, quote) else {
                            cursor += 1;
                            continue;
                        };
                        (cursor, end, &text[cursor + 1..end - 1], Some(cursor + 1), end - 1)
                    }
                    value if is_key_byte(value) && (cursor == 0 || !is_key_byte(bytes[cursor.saturating_sub(1)])) => {
                        let mut end = cursor + 1;
                        while end < bytes.len() && is_key_byte(bytes[end]) {
                            end += 1;
                        }
                        (cursor, end, &text[cursor..end], None, end)
                    }
                    _ => {
                        cursor += 1;
                        continue;
                    }
                }
            };

        let password_option = quoted_content_start.is_none()
            && key.starts_with("--")
            && is_command_password_option(&key.to_ascii_lowercase());
        let encoded_whitespace = password_option && quoted_scopes.last().is_some_and(|scope| scope.2 > 0);
        let separator = skip_whitespace(bytes, key_end, encoded_whitespace);
        let double_colon_separator = quoted_content_start.is_none()
            && bytes.get(separator) == Some(&b':')
            && bytes.get(separator + 1) == Some(&b':')
            && bytes.get(separator + 2) != Some(&b':')
            && !is_sensitive_key(&key.to_ascii_lowercase(), RedactionMode::Auto);
        let assignment =
            bytes.get(separator).is_some_and(|byte| matches!(byte, b':' | b'=')) && !double_colon_separator;
        if !(assignment || password_option && separator > key_end) {
            if let Some(content_start) = quoted_content_start
                && quoted_scopes.last().is_none_or(|scope| quoted_content_end < scope.0)
            {
                if quoted_scopes.len() == 32 {
                    edits.push(RedactionEdit {
                        start: content_start,
                        end: quoted_content_end,
                        replacement: "[redacted]",
                    });
                    cursor = key_end;
                    continue;
                }
                let layers = if escaped_key.is_some() {
                    let width = content_start - key_start - 1;
                    if (width + 1).is_power_of_two() {
                        (width + 1).trailing_zeros() + 1
                    } else {
                        0
                    }
                } else {
                    u32::from(bytes[key_start] == b'"')
                };
                quoted_scopes.push((quoted_content_end, key_end, layers));
            }
            cursor = quoted_content_start.unwrap_or(key_end);
            continue;
        }
        let decoded_key = if let Some((_, content_start, _)) = escaped_key {
            let delimiter_width = content_start - key_start - 1;
            if (delimiter_width + 1).is_power_of_two() {
                (0..=(delimiter_width + 1).trailing_zeros())
                    .try_fold(key.to_string(), |encoded, _| {
                        serde_json::from_str::<String>(&format!("\"{encoded}\""))
                    })
                    .ok()
            } else {
                None
            }
        } else if bytes[key_start] == b'"' {
            serde_json::from_str::<String>(&text[key_start..key_end]).ok()
        } else {
            None
        };
        if !is_sensitive_key(&decoded_key.as_deref().unwrap_or(key).to_ascii_lowercase(), mode) {
            cursor = key_end.max(cursor + 1);
            continue;
        }

        let value_start = skip_whitespace(bytes, separator + usize::from(assignment), encoded_whitespace);
        let value_end = if password_option {
            let scope = quoted_scopes
                .last()
                .map_or((bytes.len(), 0), |scope| (scope.0, scope.2));
            json_like_value_end(bytes, value_start, Some(scope))
        } else if quoted_content_start.is_none() && bytes[separator] == b'=' {
            let scope_end = quoted_scopes.last().map_or(bytes.len(), |scope| scope.0);
            let (end, preserve) = code_rhs_span(&bytes[..scope_end], value_start);
            if preserve {
                // Inspect nested assignments even when the enclosing expression is preserved.
                cursor = value_start;
                continue;
            }
            end
        } else {
            escaped_quoted_token(bytes, value_start)
                .map(|(end, _, _)| end)
                .unwrap_or_else(|| json_like_value_end(bytes, value_start, None))
        };
        if value_end > value_start {
            edits.push(RedactionEdit {
                start: value_start,
                end: value_end,
                replacement: "[redacted]",
            });
            cursor = value_end;
        } else {
            cursor = key_end.max(key_start + 1);
        }
    }
    edits
}

fn code_rhs_span(bytes: &[u8], start: usize) -> (usize, bool) {
    // Frames track delimiters and method-call argument positions, not an AST.
    let mut frames: Vec<(u8, bool, usize)> = Vec::new();
    let mut cursor = start;
    let mut end = start;
    let mut safe = true;
    let mut code = false;
    let mut needs_value = true;
    let mut property = false;
    let mut identifier = false;
    let mut method = false;
    let mut lambda_params = false;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if byte.is_ascii_whitespace() {
            if frames.is_empty() && matches!(byte, b'\n' | b'\r') {
                break;
            }
            cursor += 1;
            continue;
        }
        if frames.is_empty() && !lambda_params {
            if matches!(byte, b',' | b';' | b')' | b']' | b'}')
                || (byte == b'&' && !code && !needs_value && cursor == end)
                || (byte == b'#' && code && !needs_value && cursor > end)
                || (byte == b'`' && code && !needs_value && cursor == end)
            {
                break;
            }
            if !needs_value
                && ((code && cursor == end && matches!(byte, b'"' | b'\'')) || bytes[cursor..].starts_with(b"\\n"))
            {
                break;
            }
            // Whitespace following a complete expression belongs to surrounding prose.
            if safe
                && !needs_value
                && !property
                && cursor > end
                && ((!code && byte.is_ascii_alphabetic()) || byte >= 128)
            {
                break;
            }
        }
        let quoted = escaped_quoted_token(bytes, cursor).or_else(|| {
            if matches!(byte, b'"' | b'\'' | b'`') {
                quoted_value_end(bytes, cursor, byte).map(|end| (end, cursor + 1, end - 1))
            } else {
                None
            }
        });
        if let Some((quoted_end, content_start, content_end)) = quoted {
            let content = &bytes[content_start..content_end];
            let field_name = frames.last().is_some_and(|(open, _, args)| *open == b'[' && *args == 0)
                && content.first().is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
                && content.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
                && bytes[quoted_end..].iter().find(|c| !c.is_ascii_whitespace()) == Some(&b']');
            let delimiter = frames
                .last()
                .is_some_and(|(open, method, args)| *open == b'(' && *method && *args == 0)
                && !content.is_empty()
                && content
                    .iter()
                    .all(|c| c.is_ascii_punctuation() && !matches!(c, b'\\' | b'"' | b'\''))
                && split_limit_suffix(bytes, quoted_end);
            safe &= needs_value && (field_name || delimiter);
            needs_value = false;
            identifier = false;
            method = false;
            cursor = quoted_end;
        } else if matches!(byte, b'"' | b'\'' | b'`') {
            return (bytes.len(), false);
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            let word_start = cursor;
            cursor += 1;
            while cursor < bytes.len() && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_') {
                cursor += 1;
            }
            if &bytes[word_start..cursor] == b"lambda" && needs_value && !property {
                lambda_params = true;
                identifier = false;
                code = true;
            } else if lambda_params {
                safe &= !identifier;
                identifier = true;
            } else {
                safe &= needs_value;
                method = property;
                property = false;
                needs_value = false;
                identifier = true;
            }
        } else {
            match byte {
                b'0'..=b'9' => {
                    safe &= needs_value && !property && !lambda_params;
                    cursor += 1;
                    while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                        cursor += 1;
                    }
                    needs_value = false;
                    identifier = false;
                    method = false;
                    end = cursor;
                    continue;
                }
                b'.' => {
                    safe &= !needs_value && !lambda_params;
                    code = true;
                    property = true;
                    needs_value = true;
                }
                b'(' | b'[' | b'{' => {
                    if frames.len() == 32 {
                        return (bytes.len(), false);
                    }
                    let postfix = !needs_value;
                    safe &= !property && !lambda_params && byte != b'{' && (byte != b'[' || postfix);
                    code |= postfix;
                    frames.push((byte, method && postfix, 0));
                    lambda_params = false;
                    needs_value = true;
                    identifier = false;
                    method = false;
                }
                b')' | b']' | b'}' => {
                    let opening = match byte {
                        b')' => b'(',
                        b']' => b'[',
                        _ => b'{',
                    };
                    let Some((open, _, args)) = frames.pop() else {
                        return (end, false);
                    };
                    if open != opening {
                        return (bytes.len(), false);
                    }
                    safe &= !property && !lambda_params && (!needs_value || (open == b'(' && args == 0));
                    lambda_params = false;
                    needs_value = false;
                    identifier = false;
                    method = false;
                }
                b',' if lambda_params => {
                    identifier = false;
                }
                b',' => {
                    safe &= !needs_value && !property;
                    if let Some(frame) = frames.last_mut() {
                        frame.2 += 1;
                    }
                    needs_value = true;
                    identifier = false;
                    method = false;
                }
                b':' if lambda_params => {
                    lambda_params = false;
                    needs_value = true;
                    identifier = false;
                }
                b'=' => {
                    safe &= identifier && frames.last().is_some_and(|frame| frame.0 == b'(');
                    needs_value = true;
                    identifier = false;
                }
                _ => {
                    safe = false;
                    needs_value = true;
                    identifier = false;
                }
            }
            cursor += 1;
        }
        end = cursor;
    }
    if !frames.is_empty() {
        return (bytes.len(), false);
    }
    (end, safe && code && !needs_value && !property && !lambda_params)
}

fn split_limit_suffix(bytes: &[u8], mut cursor: usize) -> bool {
    // A punctuation delimiter is allowed only in a method's (delimiter, limit)[index] shape.
    for expected in [b',', b'0', b')', b'['] {
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if expected == b'0' {
            let start = cursor;
            while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            if cursor == start {
                return false;
            }
        } else if bytes.get(cursor) == Some(&expected) {
            cursor += 1;
        } else {
            return false;
        }
    }
    true
}

fn escaped_quoted_token(bytes: &[u8], start: usize) -> Option<(usize, usize, usize)> {
    if bytes.get(start) != Some(&b'\\') {
        return None;
    }

    let mut opening_quote = start;
    while bytes.get(opening_quote) == Some(&b'\\') {
        opening_quote += 1;
    }
    let delimiter_width = opening_quote - start;
    if delimiter_width.is_multiple_of(2) || bytes.get(opening_quote) != Some(&b'"') {
        return None;
    }

    let content_start = opening_quote + 1;
    let mut cursor = content_start;
    while cursor < bytes.len() {
        if bytes[cursor] != b'\\' {
            cursor += 1;
            continue;
        }
        let run_start = cursor;
        while bytes.get(cursor) == Some(&b'\\') {
            cursor += 1;
        }
        if cursor - run_start == delimiter_width && bytes.get(cursor) == Some(&b'"') {
            return Some((cursor + 1, content_start, run_start));
        }
        if bytes.get(cursor) == Some(&b'"') {
            cursor += 1;
        }
    }
    None
}

fn is_key_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-')
}

fn quoted_value_end(bytes: &[u8], start: usize, quote: u8) -> Option<usize> {
    let mut cursor = start + 1;
    let mut escaped = false;
    while cursor < bytes.len() {
        let value = bytes[cursor];
        if escaped {
            escaped = false;
        } else if value == b'\\' {
            escaped = true;
        } else if value == quote {
            return Some(cursor + 1);
        }
        cursor += 1;
    }
    None
}

fn skip_whitespace(bytes: &[u8], mut cursor: usize, encoded: bool) -> usize {
    loop {
        if bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        } else if encoded && bytes.get(cursor) == Some(&b'\\') {
            let mut end = cursor;
            while bytes.get(end) == Some(&b'\\') {
                end += 1;
            }
            if !(end - cursor).is_power_of_two()
                || !bytes.get(end).is_some_and(|byte| matches!(byte, b't' | b'n' | b'r'))
            {
                break;
            }
            cursor = end + 1;
        } else {
            break;
        }
    }
    cursor
}

fn json_like_value_end(bytes: &[u8], start: usize, command_scope: Option<(usize, u32)>) -> usize {
    if let Some((end, layers)) = command_scope {
        return crate::record_reader::value_end(
            &mut crate::record_reader::SliceBytes(bytes),
            start,
            Some((end, layers)),
        )
        .unwrap_or_else(|_| {
            eprintln!("命令行密码参数无法解析，已遮蔽至当前字符串末尾");
            end
        });
    }
    if start >= bytes.len() {
        return start;
    }
    if matches!(bytes[start], b'"' | b'\'') {
        return quoted_value_end(bytes, start, bytes[start]).unwrap_or(bytes.len());
    }
    if matches!(bytes[start], b'{' | b'[') {
        let mut stack = vec![bytes[start]];
        let mut cursor = start + 1;
        while cursor < bytes.len() {
            match bytes[cursor] {
                quote @ (b'"' | b'\'') => {
                    cursor = quoted_value_end(bytes, cursor, quote).unwrap_or(bytes.len());
                    continue;
                }
                b'{' | b'[' => stack.push(bytes[cursor]),
                b'}' if stack.last() == Some(&b'{') => {
                    stack.pop();
                    if stack.is_empty() {
                        return cursor + 1;
                    }
                }
                b']' if stack.last() == Some(&b'[') => {
                    stack.pop();
                    if stack.is_empty() {
                        return cursor + 1;
                    }
                }
                _ => {}
            }
            cursor += 1;
        }
        return bytes.len();
    }

    let mut cursor = start;
    while cursor < bytes.len()
        && !bytes[cursor].is_ascii_whitespace()
        && !matches!(bytes[cursor], b';' | b'&' | b'"' | b'\'' | b',' | b'}' | b']')
    {
        cursor += 1;
    }
    cursor
}

pub fn redaction_info(mode: RedactionMode, redacted_count: usize, raw_available: bool) -> RedactionInfo {
    RedactionInfo {
        mode: mode.as_str().to_string(),
        enabled: mode.enabled(),
        rules: redaction_rules(mode),
        redacted_count,
        raw_available,
    }
}

fn redaction_rules(mode: RedactionMode) -> Vec<String> {
    match mode {
        RedactionMode::Off => Vec::new(),
        RedactionMode::Auto => vec![
            "password".to_string(),
            "secret".to_string(),
            "token".to_string(),
            "cookie".to_string(),
            "authorization".to_string(),
            "key".to_string(),
            "privatekey".to_string(),
            "keypath".to_string(),
        ],
        RedactionMode::Strict => vec![
            "password".to_string(),
            "secret".to_string(),
            "token".to_string(),
            "cookie".to_string(),
            "authorization".to_string(),
            "key".to_string(),
            "privatekey".to_string(),
            "keypath".to_string(),
            "private_host".to_string(),
            "url".to_string(),
        ],
    }
}

fn redact_value_with_count(value: &serde_json::Value, mode: RedactionMode) -> (serde_json::Value, usize) {
    if mode == RedactionMode::Off {
        return (value.clone(), 0);
    }

    match value {
        serde_json::Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            let mut count = 0;
            for (key, item) in map {
                let lower = key.to_lowercase();
                if is_sensitive_key(&lower, mode) {
                    redacted.insert(key.clone(), serde_json::Value::String("[redacted]".to_string()));
                    count += 1;
                } else {
                    let (item, item_count) = redact_value_with_count(item, mode);
                    redacted.insert(key.clone(), item);
                    count += item_count;
                }
            }
            (serde_json::Value::Object(redacted), count)
        }
        serde_json::Value::Array(items) => {
            let mut count = 0;
            let items = items
                .iter()
                .map(|item| {
                    let (item, item_count) = redact_value_with_count(item, mode);
                    count += item_count;
                    item
                })
                .collect();
            (serde_json::Value::Array(items), count)
        }
        serde_json::Value::String(text) => {
            let redaction = redact_text_with_mode(text, mode);
            (serde_json::Value::String(redaction.text), redaction.count)
        }
        _ => (value.clone(), 0),
    }
}

pub(crate) fn is_command_password_option(lower_key: &str) -> bool {
    matches!(
        lower_key,
        "--password" | "--http-password" | "--ftp-password" | "--proxy-password"
    )
}

pub(crate) fn is_sensitive_key(lower_key: &str, mode: RedactionMode) -> bool {
    lower_key.contains("password")
        || lower_key.contains("passwd")
        || lower_key == "sshpass"
        || lower_key == "pwd"
        || lower_key.contains("secret")
        || lower_key.contains("token")
        || lower_key.contains("cookie")
        || lower_key.contains("authorization")
        || lower_key == "key"
        || lower_key.ends_with("key")
        || lower_key.contains("privatekey")
        || lower_key.contains("keypath")
        || lower_key.contains("key_path")
        || (mode == RedactionMode::Strict
            && (lower_key.contains("host")
                || lower_key.contains("url")
                || lower_key.contains("endpoint")
                || lower_key.contains("domain")))
}

fn json_payload_has_error(value: &serde_json::Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    if map.get("success").and_then(|v| v.as_bool()) == Some(false) {
        return true;
    }
    if map.get("isError").and_then(|v| v.as_bool()) == Some(true)
        || map.get("is_error").and_then(|v| v.as_bool()) == Some(true)
    {
        return true;
    }
    map.get("error").is_some_and(|error| match error {
        serde_json::Value::Null => false,
        serde_json::Value::String(text) => !text.trim().is_empty(),
        _ => true,
    })
}

fn parse_json_payload_text(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str(text.trim()).ok()
}

fn tool_result_has_error_payload(item: &serde_json::Value) -> bool {
    let Some(content) = item.get("content") else {
        return false;
    };
    if let Some(text) = content.as_str() {
        return parse_json_payload_text(text)
            .as_ref()
            .is_some_and(json_payload_has_error);
    }
    let Some(items) = content.as_array() else {
        return json_payload_has_error(content);
    };
    items.iter().any(|content_item| {
        content_item
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(parse_json_payload_text)
            .as_ref()
            .is_some_and(json_payload_has_error)
            || json_payload_has_error(content_item)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolBlockKind {
    Use,
    Result,
}

#[derive(Debug, Clone)]
pub struct AssociatedToolBlock {
    pub kind: ToolBlockKind,
    pub block_index: usize,
    pub call_key: Option<usize>,
    pub info: ToolInfo,
    pub input: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub result_is_error: Option<bool>,
    pub result_has_error_payload: Option<bool>,
    pub metadata_incomplete_reason: Option<String>,
    pub match_method: Option<&'static str>,
    pub association_issue: Option<&'static str>,
    pub pending_count: usize,
    pub tool_use_id: Option<String>,
}

pub struct RenderedToolBlock {
    pub input: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub raw_available: bool,
    pub redacted: bool,
    pub redacted_count: usize,
}

pub fn render_tool_block(block: &AssociatedToolBlock, mode: RedactionMode) -> RenderedToolBlock {
    let (input, input_count) = block.input.as_ref().map_or((None, 0), |input| {
        let (value, count) = redact_value_with_count(input, mode);
        (Some(value), count)
    });
    let (result, result_count) = block.result.as_ref().map_or((None, 0), |result| {
        let (value, count) = redact_value_with_count(result, mode);
        (Some(value), count)
    });
    let raw_available = input.is_some() || result.is_some();
    RenderedToolBlock {
        input,
        result,
        raw_available,
        redacted: mode.enabled() && raw_available,
        redacted_count: input_count.saturating_add(result_count),
    }
}

#[derive(Debug)]
struct PendingToolUse {
    key: usize,
    id: Option<String>,
    assistant_uuid: String,
    info: ToolInfo,
}

impl PendingToolUse {
    fn stored_bytes(&self) -> usize {
        self.id.as_ref().map_or(0, String::len)
            + self.assistant_uuid.len()
            + self.info.server.as_ref().map_or(0, String::len)
            + self.info.tool.as_ref().map_or(0, String::len)
    }
}

#[derive(Default)]
pub struct ToolAssociationTracker {
    pending: Vec<PendingToolUse>,
    pending_bytes: usize,
    next_key: usize,
}

impl ToolAssociationTracker {
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    pub fn observe_record(&mut self, record: &MessageRecord, detect_error_payload: bool) -> Vec<AssociatedToolBlock> {
        let Some(content) = record
            .message
            .as_ref()
            .and_then(|message| message.get("content"))
            .and_then(serde_json::Value::as_array)
        else {
            return Vec::new();
        };

        let mut blocks = Vec::new();
        for (index, item) in content.iter().enumerate() {
            let mut block = match item.get("type").and_then(serde_json::Value::as_str) {
                Some("tool_use") => self.observe_use(record, item),
                Some("tool_result") => self.observe_result(record, item, detect_error_payload),
                _ => continue,
            };
            block.block_index = index;
            blocks.push(block);
        }
        blocks
    }

    fn observe_use(&mut self, record: &MessageRecord, item: &serde_json::Value) -> AssociatedToolBlock {
        let info = item
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(parse_mcp_tool_name)
            .unwrap_or_else(empty_tool_info);
        let id = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        let input = item.get("input").cloned();
        let key = self.next_key;
        self.next_key = self.next_key.saturating_add(1);
        let pending = PendingToolUse {
            key,
            id: id.clone(),
            assistant_uuid: record.uuid.clone(),
            info: info.clone(),
        };
        self.pending_bytes = self.pending_bytes.saturating_add(pending.stored_bytes());
        self.pending.push(pending);
        AssociatedToolBlock {
            kind: ToolBlockKind::Use,
            block_index: 0,
            call_key: Some(key),
            info,
            input,
            result: None,
            result_is_error: None,
            result_has_error_payload: None,
            metadata_incomplete_reason: None,
            match_method: None,
            association_issue: None,
            pending_count: self.pending.len(),
            tool_use_id: id,
        }
    }

    fn observe_result(
        &mut self,
        record: &MessageRecord,
        item: &serde_json::Value,
        detect_error_payload: bool,
    ) -> AssociatedToolBlock {
        let id = item
            .get("tool_use_id")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string);
        let association = self.associate_result(record, id.as_deref());
        AssociatedToolBlock {
            kind: ToolBlockKind::Result,
            block_index: 0,
            call_key: association.call_key,
            info: association.info,
            input: None,
            result: Some(item.clone()),
            result_is_error: item.get("is_error").and_then(serde_json::Value::as_bool),
            result_has_error_payload: detect_error_payload.then(|| tool_result_has_error_payload(item)),
            metadata_incomplete_reason: association.metadata_incomplete_reason,
            match_method: association.match_method,
            association_issue: association.issue,
            pending_count: self.pending.len(),
            tool_use_id: id,
        }
    }

    fn associate_result(&mut self, record: &MessageRecord, result_id: Option<&str>) -> ToolAssociationMatch {
        if let Some(result_id) = result_id {
            return self
                .pending
                .iter()
                .position(|pending| pending.id.as_deref() == Some(result_id))
                .map_or_else(
                    || ToolAssociationMatch::unmatched("unknown_id"),
                    |position| self.take_pending(position, "tool_use_id"),
                );
        }

        let mut saw_ambiguous_parent = false;
        for parent in [
            record.source_tool_assistant_uuid.as_deref(),
            record.parent_uuid.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let matches = self
                .pending
                .iter()
                .enumerate()
                .filter(|(_, pending)| pending.assistant_uuid == parent)
                .map(|(position, _)| position)
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                return self.take_pending(matches[0], "parent");
            }
            saw_ambiguous_parent |= matches.len() > 1;
        }

        if self.pending.len() == 1 {
            return self.take_pending(0, "legacy_single_pending");
        }
        if self.pending.len() > 1 {
            return ToolAssociationMatch::ambiguous(if saw_ambiguous_parent {
                "ambiguous_parent"
            } else {
                "missing_id"
            });
        }
        ToolAssociationMatch::unmatched("missing_id")
    }

    fn take_pending(&mut self, position: usize, match_method: &'static str) -> ToolAssociationMatch {
        let pending = self.pending.remove(position);
        self.pending_bytes = self.pending_bytes.saturating_sub(pending.stored_bytes());
        ToolAssociationMatch {
            call_key: Some(pending.key),
            info: pending.info,
            metadata_incomplete_reason: None,
            match_method: Some(match_method),
            issue: None,
        }
    }
}

struct ToolAssociationMatch {
    call_key: Option<usize>,
    info: ToolInfo,
    metadata_incomplete_reason: Option<String>,
    match_method: Option<&'static str>,
    issue: Option<&'static str>,
}

impl ToolAssociationMatch {
    fn unmatched(reason: &str) -> Self {
        Self {
            call_key: None,
            info: empty_tool_info(),
            metadata_incomplete_reason: Some(reason.to_string()),
            match_method: None,
            issue: Some("unmatched"),
        }
    }

    fn ambiguous(reason: &str) -> Self {
        Self {
            call_key: None,
            info: empty_tool_info(),
            metadata_incomplete_reason: Some(reason.to_string()),
            match_method: None,
            issue: Some("ambiguous"),
        }
    }
}

fn empty_tool_info() -> ToolInfo {
    ToolInfo {
        server: None,
        tool: None,
    }
}

/// 将项目 ID 还原为可读路径（仅用于展示）
/// Linux:   -home-alice-projects-app → /home/alice/projects/app
/// Windows: D--Work-project → D:/Work/project
pub fn project_id_to_display_path(id: &str) -> String {
    // Windows 格式启发式检测：以大写字母开头 + "--"（原始为 "盘符:-"，: 和 / 都变成了 -）
    // 注意：这是 best-effort 启发式，含 "--" 前缀的非常规 Linux 路径可能误判，影响仅限展示
    if id.len() >= 3 && id.as_bytes()[0].is_ascii_alphabetic() && id[1..].starts_with("--") {
        let drive = &id[..1];
        let rest = &id[3..]; // 跳过 "X--"
        return format!("{}:/{}", drive, rest.replace('-', "/"));
    }
    // Linux/Mac 格式：以 "-" 开头
    // 例如 "-home-alice-projects-app" → "/home/alice/projects/app"
    id.replace('-', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window_fixture(name: &str, lines: impl IntoIterator<Item = String>) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("mcp-history-window-{name}-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("session.jsonl");
        let mut file = io::BufWriter::new(File::create(&path).unwrap());
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        file.flush().unwrap();
        path
    }

    #[test]
    fn session_window_counts_preserve_sparse_spans_and_evicted_matches() {
        let path = window_fixture(
            "counts",
            (1..=5005).map(|line| {
                serde_json::json!({
                    "uuid": format!("message-{line}"), "timestamp": "2026-01-01T00:00:00Z",
                    "type": if [1, 3000, 3002, 5003].contains(&line) { "user" } else { "assistant" },
                    "message": {"content": "marker password=fixture_secret"}
                })
                .to_string()
            }),
        );
        let filter = build_content_filter(&Some("marker".to_string()), false, true).unwrap();
        for (anchor, before, after, expected) in [
            (3003, 1, Some(0), Some((3002, 3003))),
            (3003, 2, Some(0), Some((3000, 3003))),
            (3003, 3, Some(0), None),
            (3002, 2, Some(0), None),
            (3003, 0, Some(1), None),
            (3004, 0, Some(1), Some((3004, 5003))),
            (3003, 0, Some(0), Some((3003, 3003))),
            (5004, 1, Some(1), Some((5003, 5004))),
            (5004, 2, Some(0), None),
            (4999, 0, Some(usize::MAX), Some((4999, 5003))),
            (2, usize::MAX, Some(0), Some((1, 2))),
            (3006, 0, None, Some((3006, 5005))),
            (3005, 0, None, None),
        ] {
            let result = index_session_messages(
                &path,
                anchor,
                &filter,
                RedactionMode::Auto,
                &["user".to_string()],
                &["human".to_string()],
                SessionRange::Counts { before, after },
            );
            match expected {
                Some((start, end)) => {
                    let index = result.unwrap();
                    assert_eq!(
                        index.messages.iter().map(|item| item.line_num).collect::<Vec<_>>(),
                        (start..=end).collect::<Vec<_>>()
                    );
                    assert_eq!(index.anchor_idx, anchor - start);
                    assert!(index.messages.len() <= MAX_SESSION_WINDOW);
                }
                None => assert_eq!(result.err().unwrap().error, "session_window_limit"),
            }
        }
        let secret = build_content_filter(&Some("fixture_secret".to_string()), false, true).unwrap();
        let index = index_session_messages(
            &path,
            3003,
            &secret,
            RedactionMode::Auto,
            &[],
            &[],
            SessionRange::Counts {
                before: usize::MAX,
                after: Some(usize::MAX),
            },
        )
        .unwrap();
        assert_eq!(index.messages.len(), 1);
        assert_eq!(index.messages[0].line_num, 3003);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn session_window_boundaries_ignore_display_filters_and_distinguish_missing_refs() {
        let path = window_fixture(
            "boundaries",
            (1..=5005).map(|line| {
                serde_json::json!({
                    "uuid": format!("message-{line}"), "timestamp": "2026-01-01T00:00:00Z",
                    "type": if [1, 3000, 3002, 5003].contains(&line) { "user" } else { "assistant" },
                    "message": {"content": "fixture"}
                })
                .to_string()
            }),
        );
        let filter = build_content_filter(&Some("absent".to_string()), false, true).unwrap();
        for (anchor, backward, expected) in [
            (1, true, Some((1, 1))),
            (3000, true, None),
            (3002, true, Some((3000, 3002))),
            (3003, true, Some((3002, 3003))),
            (3000, false, Some((3000, 3002))),
            (3003, false, None),
            (3004, false, Some((3004, 5003))),
            (5003, false, Some((5003, 5003))),
        ] {
            let result = index_session_messages(
                &path,
                anchor,
                &filter,
                RedactionMode::Auto,
                &["assistant".to_string()],
                &[],
                SessionRange::UntilType {
                    effective_type: "user",
                    backward,
                },
            );
            match expected {
                Some((start, end)) => {
                    let index = result.unwrap();
                    assert_eq!(index.messages.len(), end - start + 1);
                    assert_eq!(index.messages[0].line_num, start);
                    assert_eq!(index.messages.last().unwrap().line_num, end);
                    assert_eq!(index.anchor_idx, anchor - start);
                }
                None => assert_eq!(result.err().unwrap().error, "session_window_limit"),
            }
        }
        for backward in [false, true] {
            let index = index_session_messages(
                &path,
                3000,
                &filter,
                RedactionMode::Auto,
                &[],
                &[],
                SessionRange::UntilType {
                    effective_type: "system",
                    backward,
                },
            )
            .unwrap();
            assert_eq!(index.messages.len(), 1);
            assert_eq!(index.messages[0].line_num, 3000);
        }
        for (anchor, line, expected_error) in [
            (3000, 3000, None),
            (3000, 4999, None),
            (4999, 3000, None),
            (3000, 5000, Some("session_window_limit")),
            (5000, 3000, Some("session_window_limit")),
            (1, 6000, Some("ref_not_found")),
            (6000, 1, Some("ref_not_found")),
        ] {
            let result = index_session_messages(
                &path,
                anchor,
                &filter,
                RedactionMode::Auto,
                &[],
                &[],
                SessionRange::UntilRef { line },
            );
            if let Some(error) = expected_error {
                assert_eq!(result.err().unwrap().error, error);
            } else {
                let index = result.unwrap();
                assert_eq!(index.messages.len(), anchor.abs_diff(line) + 1);
                assert_eq!(index.anchor_idx, anchor - anchor.min(line));
            }
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn session_window_diagnostics_cover_only_scanned_lines_and_detect_changed_records() {
        let record = serde_json::json!({"uuid": "message", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": "fixture"}})
        .to_string();
        let path = window_fixture(
            "diagnostics",
            ["{".to_string(), "x".repeat(MAX_JSONL_LINE_BYTES + 1)]
                .into_iter()
                .chain(std::iter::repeat_n(record.clone(), MAX_SESSION_WINDOW + 5))
                .chain(["{".to_string(), "x".repeat(MAX_JSONL_LINE_BYTES + 1)]),
        );
        let filter = build_content_filter(&None, false, false).unwrap();
        let anchor = MAX_SESSION_WINDOW + 7;
        let index = index_session_messages(
            &path,
            anchor,
            &filter,
            RedactionMode::Auto,
            &[],
            &[],
            SessionRange::Counts {
                before: 0,
                after: Some(0),
            },
        )
        .unwrap();
        assert_eq!(index.messages.len(), 1);
        assert_eq!(index.incomplete_reasons, ["parse_errors=2"]);
        assert_eq!(
            load_session_window(&path, &index, RedactionMode::Auto).unwrap().len(),
            1
        );
        let full = index_session_messages(
            &path,
            anchor,
            &filter,
            RedactionMode::Auto,
            &[],
            &[],
            SessionRange::Counts { before: 0, after: None },
        )
        .unwrap();
        assert_eq!(full.incomplete_reasons, ["parse_errors=4"]);
        for line in [1, 2, anchor + 1, anchor + 2] {
            let error = index_session_messages(
                &path,
                anchor,
                &filter,
                RedactionMode::Auto,
                &[],
                &[],
                SessionRange::UntilRef { line },
            )
            .err()
            .unwrap();
            assert_eq!(error.error, "ref_not_found");
        }
        for replacement in [
            "".to_string(),
            "{".to_string(),
            record.replace("\"user\"", "\"assistant\""),
        ] {
            let mut lines = std::iter::repeat_n(record.clone(), anchor - 1).collect::<Vec<_>>();
            lines.push(replacement);
            fs::write(&path, lines.join("\n")).unwrap();
            assert_eq!(
                load_session_window(&path, &index, RedactionMode::Auto)
                    .err()
                    .unwrap()
                    .error,
                "source_changed"
            );
        }
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn session_window_body_budget_accepts_exact_limit_and_rejects_one_extra_byte() {
        let base = serde_json::json!({"uuid": "message", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": ""}})
        .to_string();
        let line_bytes = MAX_SESSION_WINDOW_BYTES / 8;
        let record = base.replace(
            "\"content\":\"\"",
            &format!("\"content\":\"{}\"", "x".repeat(line_bytes - base.len() - 1)),
        );
        assert_eq!(record.len() + 1, line_bytes);
        let path = window_fixture("bytes", std::iter::repeat_n(record.clone(), 8));
        let filter = build_content_filter(&None, false, false).unwrap();
        let index = index_session_messages(
            &path,
            1,
            &filter,
            RedactionMode::Off,
            &[],
            &[],
            SessionRange::UntilRef { line: 8 },
        )
        .unwrap();
        assert_eq!(load_session_window(&path, &index, RedactionMode::Off).unwrap().len(), 8);
        let mut content = fs::read_to_string(&path).unwrap();
        content.insert(content.len() - 1, ' ');
        fs::write(&path, content).unwrap();
        let index = index_session_messages(
            &path,
            1,
            &filter,
            RedactionMode::Off,
            &[],
            &[],
            SessionRange::UntilRef { line: 8 },
        )
        .unwrap();
        assert_eq!(
            load_session_window(&path, &index, RedactionMode::Off)
                .err()
                .unwrap()
                .error,
            "session_window_memory_limit"
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn centered_truncation_includes_ellipsis_within_the_limit() {
        let content = "0123456789abcdefghijklmnopqrstuvwxyz";
        for max_len in 0..=20 {
            for match_pos in [0, 4, 18, content.len()] {
                let (truncated, was_truncated) = truncate_around_match(content, Some(match_pos), max_len);
                assert!(was_truncated);
                assert!(truncated.chars().count() <= max_len);
            }
        }

        let (centered, _) = truncate_around_match(content, Some(18), 12);
        assert!(centered.starts_with("..."));
        assert!(centered.ends_with("..."));
        assert_eq!(centered.chars().count(), 12);

        let (unicode, _) = truncate_around_match("甲乙丙丁戊己庚辛壬癸", Some(5), 7);
        assert_eq!(unicode.chars().count(), 7);
    }

    #[test]
    fn parse_message_slice_accepts_python_bounds() {
        let cases = [
            ("[-10:-1]", Some(-10), Some(-1), (90, 99)),
            ("[-10:]", Some(-10), None, (90, 100)),
            ("[-1:]", Some(-1), None, (99, 100)),
            ("[:10]", None, Some(10), (0, 10)),
            ("[10:20]", Some(10), Some(20), (10, 20)),
            ("[0:0]", Some(0), Some(0), (0, 0)),
        ];
        for (raw, start, end, normalized) in cases {
            let parsed = parse_message_slice_param(raw).unwrap();
            assert_eq!(parsed.start, start);
            assert_eq!(parsed.end, end);
            assert_eq!(normalize_message_slice(&parsed, 100), normalized);
        }
    }

    #[test]
    fn parse_message_slice_rejects_step() {
        let err = parse_message_slice_param("[::-1]").unwrap_err();
        assert!(err.contains("不支持 step"));
    }

    #[test]
    fn message_filter_normalization_rejects_unknown_values_and_keeps_compatibility() {
        let filters =
            normalize_message_filters(&["human".to_string()], &[], Some(&["assistant", "user", "summary"])).unwrap();
        assert_eq!(filters.types, ["user"]);
        assert_eq!(filters.subtypes, ["human"]);
        assert_eq!(filters.warnings, ["types=human 是 subtype，已自动转入 subtypes"]);

        let subtype_only =
            normalize_message_filters(&[], &["system".to_string()], Some(&["assistant", "user"])).unwrap();
        assert_eq!(subtype_only.types, ["system"]);

        let error = normalize_message_filters(&["visitor".to_string()], &[], None).unwrap_err();
        assert_eq!(error.error, "invalid_arguments");
        assert!(error.message.contains("未知 type 过滤值"));
    }

    #[test]
    fn context_selector_validation_rejects_ambiguous_combinations() {
        assert!(validate_context_range_selectors(None, None, Some("user"), None).is_ok());
        assert!(validate_context_range_selectors(Some(0), None, Some("user"), None).is_err());
        assert!(validate_context_range_selectors(None, None, Some("user"), Some("session:1")).is_err());
        assert!(validate_context_range_selectors(None, None, Some("human"), None).is_err());
        assert!(parse_context_direction("backward").is_ok());
        assert!(parse_context_direction("sideways").is_err());
    }

    #[test]
    fn time_filter_excludes_unparseable_timestamps_only_when_enabled() {
        assert_eq!(time_in_range("not-a-time", None, None), TimeRangeMatch::Matches);
        let since = parse_time("2026-01-01").unwrap();
        assert_eq!(
            time_in_range("not-a-time", Some(&since), None),
            TimeRangeMatch::UnparseableTimestamp
        );
    }

    #[test]
    fn utc_date_until_includes_full_day_and_today_uses_utc_calendar() {
        let (_, until) = parse_time_bounds(None, Some("2026-01-02")).unwrap();
        let until = until.unwrap();
        assert!(until.exclusive);
        assert_eq!(until.query_value(), "2026-01-02");
        assert_eq!(
            time_in_range("2026-01-02T23:59:59.999999999Z", None, Some(&until)),
            TimeRangeMatch::Matches
        );
        assert_eq!(
            time_in_range("2026-01-03T00:00:00Z", None, Some(&until)),
            TimeRangeMatch::OutsideRange
        );
        let since = parse_optional_time_param(Some("2026-01-02"), "since").unwrap().unwrap();
        assert_eq!(
            time_in_range("2026-01-01T23:59:59-01:00", Some(&since), None),
            TimeRangeMatch::Matches
        );
        let before = chrono::Utc::now().date_naive();
        let (since, until) = parse_time_bounds(Some("today"), Some("today")).unwrap();
        let after = chrono::Utc::now().date_naive();
        let date = since.unwrap().date_naive();
        assert!(date == before || date == after);
        assert_eq!(date.succ_opt(), Some(until.unwrap().instant.date_naive()));
        let (_, leap_day) = parse_time_bounds(None, Some("2016-12-31")).unwrap();
        assert_eq!(
            time_in_range("2016-12-31T23:59:60Z", None, leap_day.as_ref()),
            TimeRangeMatch::Matches
        );
        let (_, exact_midnight) = parse_time_bounds(None, Some("2017-01-01T00:00:00Z")).unwrap();
        assert_eq!(
            time_in_range("2017-01-01T00:00:00Z", None, exact_midnight.as_ref()),
            TimeRangeMatch::Matches
        );
        assert!(parse_time_param("2026-01-01T00:00:00", "since").is_err());
    }

    #[test]
    fn bounded_jsonl_lines_reports_persistent_read_error_once() {
        struct BrokenReader;
        impl io::Read for BrokenReader {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("read failed"))
            }
        }
        impl BufRead for BrokenReader {
            fn fill_buf(&mut self) -> io::Result<&[u8]> {
                Err(io::Error::other("read failed"))
            }
            fn consume(&mut self, _: usize) {}
        }
        let mut lines = bounded_jsonl_lines(BrokenReader);
        assert!(lines.next().unwrap().is_err());
        assert!(lines.next().is_none());
    }

    #[test]
    fn bounded_jsonl_lines_discard_large_line_and_resume_on_next_line() {
        let text = format!("{}\n{{\"ok\":true}}\n", "x".repeat(MAX_JSONL_LINE_BYTES + 2));
        let mut lines = bounded_jsonl_lines(BufReader::new(text.as_bytes()));
        assert!(matches!(lines.next().unwrap().unwrap(), BoundedLine::TooLarge));
        assert!(matches!(lines.next().unwrap().unwrap(), BoundedLine::Record(line) if line == "{\"ok\":true}\n"));
        assert!(lines.next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_output_requires_verified_dacl() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mcp-history-acl-test-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        set_private_permissions(&root, 0o700).unwrap();
        let path = root.join("private.txt");
        let mut file = open_private_output_file(&path).unwrap();
        file.write_all(b"fixture").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"fixture");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_acl_is_applied_and_verified_on_directory_and_file() {
        let root = std::env::temp_dir().join(format!("mcp-history-acl-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        set_private_permissions(&root, 0o700).unwrap();
        let file_path = root.join("private file.txt");
        let mut file = open_private_output_file(&file_path).unwrap();
        file.write_all(b"fixture").unwrap();
        set_private_permissions(&file_path, 0o600).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_acl_checks_trusted_owners_without_transferring_ownership() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mcp-history-owner-test-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let run = |script: &str, path: &Path, owner: &str| -> serde_json::Value {
            let output = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env_remove("PSModulePath")
                .env("MCP_HISTORY_PRIVATE_PATH", path)
                .env("MCP_HISTORY_TEST_OWNER", owner)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "owner={owner}, path={}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice(&output.stdout).unwrap()
        };
        let query = r#"
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $env:MCP_HISTORY_PRIVATE_PATH
$entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$private = $acl.AreAccessRulesProtected -and $entries.Count -eq 1
if ($private) {
    $entry = $entries[0]
    $private = -not $entry.IsInherited -and $entry.IdentityReference.Value -eq $sid.Value -and
        $entry.AccessControlType -eq 'Allow' -and
        ($entry.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
}
[pscustomobject]@{
    user = $sid.Value
    owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    private = $private
    sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)
} | ConvertTo-Json -Compress
"#;
        let initial = run(query, &root, "");
        eprintln!("Windows private-output fixture initial owner: {}", initial["owner"]);
        let user = initial["user"].as_str().unwrap();
        set_private_permissions(&root, 0o700).unwrap();
        let assign = format!(
            r#"
$ErrorActionPreference = 'Stop'
$p = $env:MCP_HISTORY_PRIVATE_PATH
$acl = Get-Acl -LiteralPath $p
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
Set-Acl -LiteralPath $p -AclObject $acl
& "$env:SystemRoot\System32\icacls.exe" $p /setowner "*$env:MCP_HISTORY_TEST_OWNER" /Q | Out-Null
if ($LASTEXITCODE -ne 0) {{ throw "owner fixture failed: exit $LASTEXITCODE" }}
{query}
"#
        );
        for (name, owner, trusted) in [
            ("user", user, true),
            ("system", "S-1-5-18", true),
            ("administrators", "S-1-5-32-544", true),
            ("users", "S-1-5-32-545", false),
        ] {
            for (kind, directory) in [("directory", true), ("file", false)] {
                let path = root.join(format!("{name}-{kind}"));
                let content = if directory {
                    fs::create_dir(&path).unwrap();
                    path.join("sentinel.txt")
                } else {
                    path.clone()
                };
                fs::write(&content, b"owner fixture content").unwrap();
                let before = run(&assign, &path, owner);
                assert_eq!(before["owner"], owner, "{name}-{kind}");
                assert_eq!(before["private"], false, "{name}-{kind}");
                let result = set_private_permissions(&path, if directory { 0o700 } else { 0o600 });
                if trusted {
                    result.unwrap();
                } else {
                    let error = result.unwrap_err();
                    assert_eq!(error.error, "privacy_not_enforced_on_windows");
                    assert!(error.message.contains(owner));
                }
                let after = run(query, &path, owner);
                assert_eq!(after["owner"], owner, "{name}-{kind}");
                assert_eq!(after["private"], trusted, "{name}-{kind}");
                if !trusted {
                    assert_eq!(after["sddl"], before["sddl"], "{name}-{kind}");
                }
                assert_eq!(fs::read(&content).unwrap(), b"owner fixture content", "{name}-{kind}");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_acl_removes_explicit_everyone_access() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mcp-history-acl-negative-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        set_private_permissions(&root, 0o700).unwrap();
        let path = root.join("empty fixture.txt");
        fs::write(&path, b"").unwrap();
        set_private_permissions(&path, 0o600).unwrap();

        let inject = r#"
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:MCP_HISTORY_PRIVATE_PATH
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadData', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:MCP_HISTORY_PRIVATE_PATH -AclObject $acl
$actual = Get-Acl -LiteralPath $env:MCP_HISTORY_PRIVATE_PATH
if (@($actual.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $everyone.Value }).Count -ne 1) { throw 'Everyone rule was not applied' }
"#;
        let injected = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", inject])
            .env_remove("PSModulePath")
            .env("MCP_HISTORY_PRIVATE_PATH", &path)
            .output()
            .unwrap();
        assert!(
            injected.status.success(),
            "{}",
            String::from_utf8_lossy(&injected.stderr)
        );

        set_private_permissions(&path, 0o600).unwrap();
        let verify = r#"
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:MCP_HISTORY_PRIVATE_PATH
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $acl.AreAccessRulesProtected -or $entries.Count -ne 1 -or $entries[0].IdentityReference.Value -ne $owner) { throw 'ACL still grants another identity access' }
"#;
        let verified = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", verify])
            .env_remove("PSModulePath")
            .env("MCP_HISTORY_PRIVATE_PATH", &path)
            .output()
            .unwrap();
        assert!(
            verified.status.success(),
            "{}",
            String::from_utf8_lossy(&verified.stderr)
        );
        assert_eq!(
            set_private_permissions(&root.join("missing.txt"), 0o600)
                .unwrap_err()
                .error,
            "privacy_not_enforced_on_windows"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sshpass_redaction_covers_text_structured_values_and_original_ranges() {
        let secret = "fixture_sshpass_NOT_A_REAL_CREDENTIAL";
        let input = serde_json::json!({
            "env": {"SSHPASS": secret, "LANG": "C", "SSHPASS_FD": 3, "SSHPASS_FILE": "fixture-path"}
        });
        let encoded = format!(
            r#"{{"env":{{"S{}u0053HPASS":"{secret}"}},"plain":"文字😀"}}"#,
            char::from(92)
        );
        let texts = [
            format!("前缀😀 SSHPASS={secret} 后缀"),
            format!("export SSHPASS='{secret}'"),
            input.to_string(),
            encoded.clone(),
            serde_json::to_string(&encoded).unwrap(),
        ];
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            let (redacted, count) = redact_value_with_count(&input, mode);
            assert_eq!(redacted["env"]["SSHPASS"], "[redacted]");
            assert_eq!(redacted["env"]["LANG"], "C");
            assert_eq!(redacted["env"]["SSHPASS_FD"], 3);
            assert_eq!(redacted["env"]["SSHPASS_FILE"], "fixture-path");
            assert_eq!(count, 1);
            for text in &texts {
                let result = redact_text_with_mode(text, mode);
                assert!(!result.text.contains(secret), "mode={mode:?}");
                assert_eq!(result.count, 1);
                let start = text[..text.find(secret).unwrap()].chars().count();
                assert_eq!(
                    redact_text_range_with_mode(text, mode, Some((start + 3, start + 8))).text,
                    "[redacted]"
                );
            }
        }
        assert_eq!(redact_value_with_count(&input, RedactionMode::Off), (input, 0));
        for text in texts {
            assert_eq!(redact_text_with_mode(&text, RedactionMode::Off).text, text);
        }
    }

    #[test]
    fn command_password_options_redact_values_without_hiding_other_arguments() {
        let secret = "fixture.password,NOT_A_REAL_CREDENTIAL]tail}";
        for option in ["--password", "--http-password", "--ftp-password", "--proxy-password"] {
            for (separator, value) in [
                (" ", secret.to_string()),
                ("=", secret.to_string()),
                (" ", format!("'{secret} with spaces'")),
                ("\t", format!("\"{secret} with spaces\"")),
                (" ", format!("'{secret}'suffix")),
                (" ", format!("prefix'{secret}'")),
                (" ", format!("{secret}\\ with\\ spaces")),
                (" ", format!("\"{secret}\"suffix")),
                (" ", format!("prefix\"{secret} with spaces\"suffix")),
                (" ", format!("'{secret}\\ with spaces'suffix")),
                (" ", format!("{secret}\\\"suffix")),
                ("\n", secret.to_string()),
                ("\r", secret.to_string()),
            ] {
                let argument = format!("{option}{separator}{value}");
                let command = format!("前缀😀 wget --user fixture-user {argument} --preserve-permissions");
                let value = serde_json::json!({"command": command, "env":{"LANG":"C"}, "note":"visible"});
                let encoded = value.to_string();
                let nested = serde_json::to_string(&encoded).unwrap();
                for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                    let expected_command =
                        format!("前缀😀 wget --user fixture-user {option}{separator}[redacted] --preserve-permissions");
                    let expected_value =
                        serde_json::json!({"command":expected_command, "env":{"LANG":"C"}, "note":"visible"});
                    let (redacted, count) = redact_value_with_count(&value, mode);
                    assert_eq!(redacted, expected_value);
                    assert_eq!(count, 1);
                    for (text, expected) in [
                        (&command, expected_command),
                        (&encoded, expected_value.to_string()),
                        (&nested, serde_json::to_string(&expected_value.to_string()).unwrap()),
                    ] {
                        let redacted = redact_text_with_mode(text, mode);
                        assert_eq!(redacted.text, expected, "mode={mode:?} argument={argument:?}");
                        assert_eq!(redacted.count, 1);
                        let start = text[..text.find(secret).unwrap()].chars().count();
                        assert_eq!(
                            redact_text_range_with_mode(text, mode, Some((start + 3, start + 8))).text,
                            "[redacted]"
                        );
                    }
                }
                assert_eq!(redact_value_with_count(&value, RedactionMode::Off), (value, 0));
                for text in [&command, &encoded, &nested] {
                    assert_eq!(redact_text_with_mode(text, RedactionMode::Off).text, *text);
                }
            }
        }
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            for command in ["wget --password ", "wget --password=", "wget --password"] {
                let empty = serde_json::json!({"command":command, "note":"visible"}).to_string();
                for text in [empty.clone(), serde_json::to_string(&empty).unwrap()] {
                    let redacted = redact_text_with_mode(&text, mode);
                    assert_eq!(redacted.text, text);
                    assert_eq!(redacted.count, 0);
                }
            }
            for text in [
                "wget --ask-password --quiet",
                "wget --password-file fixture-path --quiet",
                "wget --password\\tfixture-path --quiet",
                "plain password explanation remains visible",
            ] {
                let redacted = redact_text_with_mode(text, mode);
                assert_eq!(redacted.text, text);
                assert_eq!(redacted.count, 0);
            }
        }
    }

    #[test]
    fn npm_tokens_redact_without_sensitive_field_names() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let cases = [
            (secret.clone(), "[redacted]".to_string(), 1),
            (
                format!("前缀😀 [{secret}] 后缀"),
                "前缀😀 [[redacted]] 后缀".to_string(),
                1,
            ),
            (
                format!("printf '%s\\n' '{secret}' --visible"),
                "printf '%s\\n' '[redacted]' --visible".to_string(),
                1,
            ),
            (
                format!("'{secret}' '{secret}'"),
                "'[redacted]' '[redacted]'".to_string(),
                2,
            ),
        ];
        for (text, expected, expected_count) in cases {
            let start = text[..text.find(&secret).unwrap()].chars().count();
            for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                let redacted = redact_text_with_mode(&text, mode);
                assert_eq!(redacted.text, expected);
                assert_eq!(redacted.count, expected_count);
                let ranged = redact_text_range_with_mode(&text, mode, Some((start + 4, start + 10)));
                assert_eq!(ranged.text, "[redacted]");
                assert_eq!(ranged.count, 1);
            }
            let raw = redact_text_with_mode(&text, RedactionMode::Off);
            assert_eq!(raw.text, text);
            assert_eq!(raw.count, 0);
            assert_eq!(
                redact_text_range_with_mode(&text, RedactionMode::Off, Some((start + 4, start + 10))).text,
                secret[4..10]
            );
        }
        let input = serde_json::json!({"plain":secret,"array":[secret,{"text":secret}],"note":"visible"});
        let expected =
            serde_json::json!({"plain":"[redacted]","array":["[redacted]",{"text":"[redacted]"}],"note":"visible"});
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            assert_eq!(redact_value_with_count(&input, mode), (expected.clone(), 3));
            for (text, expected_text) in [
                (input.to_string(), expected.to_string()),
                (
                    serde_json::to_string(&input.to_string()).unwrap(),
                    serde_json::to_string(&expected.to_string()).unwrap(),
                ),
            ] {
                let redacted = redact_text_with_mode(&text, mode);
                assert_eq!(redacted.text, expected_text);
                assert_eq!(redacted.count, 3);
            }
            let command = format!("printf '//registry.npmjs.org/:_authToken=%s\\n' '{secret}'");
            let (redacted, count) =
                redact_value_with_count(&serde_json::json!({"command":command,"note":"visible"}), mode);
            assert!(!redacted.to_string().contains(&secret));
            assert_eq!(redacted["note"], "visible");
            assert!(count >= 1);
        }
        assert_eq!(redact_value_with_count(&input, RedactionMode::Off), (input, 0));
    }

    #[test]
    fn npm_token_boundaries_and_overlapping_rules_preserve_existing_behavior() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let negatives = [
            "npm_placeholder".to_string(),
            format!("npm_{}", "A".repeat(35)),
            format!("npm_{}", "A".repeat(37)),
            format!("NPM_{}", "Aa0".repeat(12)),
            format!("npm_{}-{}", "A".repeat(18), "A".repeat(18)),
            format!("prefix{secret}"),
            format!("{secret}suffix"),
            format!("_{secret}"),
            format!("{secret}_"),
            format!("字{secret}"),
            format!("{secret}字"),
            format!("{secret}\u{0301}"),
            "token = text(node, 1)".to_string(),
        ];
        for text in negatives {
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let redacted = redact_text_with_mode(&text, mode);
                assert_eq!(redacted.text, text);
                assert_eq!(redacted.count, 0);
            }
        }
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            for (text, expected) in [
                (format!("NPM_TOKEN='{secret}'"), "NPM_TOKEN=[redacted]".to_string()),
                (
                    format!("Authorization: Bearer {secret}"),
                    "Authorization: [redacted]".to_string(),
                ),
            ] {
                let redacted = redact_text_with_mode(&text, mode);
                assert_eq!(redacted.text, expected);
                assert_eq!(redacted.count, 1);
            }
        }
        let url = format!("https://example.com/{secret}");
        let strict = redact_text_with_mode(&url, RedactionMode::Strict);
        assert_eq!(strict.text, "[redacted-url]");
        assert_eq!(strict.count, 1);
        let auto = redact_text_with_mode(&url, RedactionMode::Auto);
        assert_eq!(auto.text, "https://example.com/[redacted]");
        assert_eq!(auto.count, 1);
    }

    #[test]
    fn token_uuid_statements_redact_values_without_hiding_identifiers() {
        let secret = "11111111-1111-4111-8111-111111111111";
        let identifier = "22222222-2222-4222-8222-222222222222";
        for statement in [
            format!("2. **用已有 token 创建新模块 token**: 成功,返回新 UUID `{secret}`"),
            format!("token created successfully, returned a new UUID `{secret}`"),
            format!("令牌创建成功，返回 UUID：{secret}"),
            format!("创建令牌成功，返回新 UUID `{secret}`"),
            format!("token {}返回新 UUID `{secret}`", "说明".repeat(120)),
        ] {
            let text = format!("前缀😀 {statement}\nsession UUID `{identifier}` remains visible");
            let expected = text.replace(secret, "[redacted]");
            let value = serde_json::json!({"text":text, "session":identifier, "ref":"fixture:12"});
            let expected_value = serde_json::json!({"text":expected, "session":identifier, "ref":"fixture:12"});
            for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                assert_eq!(redact_value_with_count(&value, mode), (expected_value.clone(), 1));
                for (original, expected) in [
                    (text.clone(), expected.clone()),
                    (value.to_string(), expected_value.to_string()),
                    (
                        serde_json::to_string(&value.to_string()).unwrap(),
                        serde_json::to_string(&expected_value.to_string()).unwrap(),
                    ),
                ] {
                    let redacted = redact_text_with_mode(&original, mode);
                    assert_eq!(redacted.text, expected);
                    assert_eq!(redacted.count, 1);
                    let start = original[..original.find(secret).unwrap()].chars().count();
                    assert_eq!(
                        redact_text_range_with_mode(&original, mode, Some((start + 3, start + 8))).text,
                        "[redacted]"
                    );
                }
            }
            assert_eq!(redact_value_with_count(&value, RedactionMode::Off), (value, 0));
            assert_eq!(redact_text_with_mode(&text, RedactionMode::Off).text, text);
        }
        for text in [
            format!("session UUID `{identifier}`"),
            format!("token 统计 30，本会话 UUID `{identifier}`"),
            format!("token 创建成功\n操作返回新 UUID `{identifier}`"),
            format!("token 创建成功\\n操作返回新 UUID `{identifier}`"),
            format!("token 创建成功，返回会话 UUID `{identifier}`"),
            serde_json::json!({"aaa":"token","note":format!("返回新 UUID `{identifier}`")}).to_string(),
            format!("operation_id={identifier} ref=fixture:12"),
        ] {
            for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                let redacted = redact_text_with_mode(&text, mode);
                assert_eq!(redacted.text, text);
                assert_eq!(redacted.count, 0);
            }
        }
    }

    #[test]
    fn range_redaction_uses_full_text_context_and_raw_unicode_offsets() {
        let text = "前缀 password=fixture_secret 后缀";
        let secret_start = text.find("fixture_secret").unwrap();
        let secret_start = text[..secret_start].chars().count();
        let secret_end = secret_start + "fixture_secret".chars().count();

        for range in [
            (secret_start, secret_end),
            (secret_start + 2, secret_end),
            (secret_start, secret_end - 2),
        ] {
            let redaction = redact_text_range_with_mode(text, RedactionMode::Auto, Some(range));
            assert_eq!(redaction.text, "[redacted]");
            assert_eq!(redaction.count, 1);
        }

        let with_prefix = redact_text_range_with_mode(
            text,
            RedactionMode::Strict,
            Some((secret_start.saturating_sub(1), secret_start + 2)),
        );
        assert_eq!(with_prefix.text, "=[redacted]");
        assert!(!with_prefix.text.contains("fi"));

        let raw = redact_text_range_with_mode(text, RedactionMode::Off, Some((0, secret_end)));
        assert_eq!(raw.text, text.chars().take(secret_end).collect::<String>());
    }

    #[test]
    fn code_rhs_preserves_complete_expressions_in_text_and_tool_input() {
        for code in [
            "token = text(node, 1)",
            "sorted(values, key=lambda x: x['durationNs'])",
            "process_key = path.name.rsplit('.', 1)[0]",
            "ghost_appearance :: description",
            "host::method()",
            "url::parse()",
            "endpoint::status",
            "domain::lookup",
        ] {
            for text in [
                code.to_string(),
                format!("```python\n{code}\n```"),
                serde_json::to_string(code).unwrap(),
                format!("[TOOL_USE:Bash({})]", serde_json::json!({"command": code})),
                format!("中文前缀 {code} 中文后缀"),
            ] {
                for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                    assert_eq!(redact_text_with_mode(&text, mode).text, text);
                    let (value, count) = redact_value_with_count(&serde_json::json!({"command": text}), mode);
                    assert_eq!(value["command"], text);
                    assert_eq!(count, 0);
                }
            }
        }
    }

    #[test]
    fn code_rhs_redacts_literal_and_unclassified_tails_with_original_ranges() {
        let secret = "fixture_secret_NOT_A_REAL_CREDENTIAL";
        let cases = [
            format!("token=\"{secret}\""),
            format!("token={secret}"),
            format!("token=build(\"{secret}\")"),
            format!("key=lambda x: \"{secret}\""),
            format!("token=prefix + \"{secret}\""),
            format!("token=\"prefix\" + \"{secret}\""),
            format!("token=\"prefix\" \"{secret}\""),
            format!("token=`{secret}`"),
            format!("token=prefix#{secret}"),
            format!("token=read(node) & \"{secret}\""),
            format!("token=build(password=\"{secret}\")"),
            format!("token=build({{\"password\":\"{secret}\"}})"),
            format!("token=build(node, \"{secret}\""),
            format!("token=\"prefix,{secret}"),
            format!("token='prefix\n{secret}"),
            format!("token=`prefix;{secret}"),
            format!("token={}node, \"{secret}\"{}", "build(".repeat(33), ")".repeat(33)),
            format!("token=build(node] + \"{secret}\")"),
            format!("token=build(node) + \"{secret}\""),
            format!("token=path.name.rsplit(\"{secret}\", 1)[0]"),
        ];
        for case in cases {
            for text in [case.clone(), serde_json::to_string(&case).unwrap()] {
                let text = format!("中文前缀 {text}");
                let secret_start = text[..text.find(secret).unwrap()].chars().count();
                let range = (secret_start + 3, secret_start + 8);
                for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                    let redacted = redact_text_with_mode(&text, mode);
                    assert!(!redacted.text.contains(secret), "{text}: {}", redacted.text);
                    assert_eq!(redacted.count, 1, "{text}");
                    assert_eq!(redact_text_range_with_mode(&text, mode, Some(range)).text, "[redacted]");
                }
                assert_eq!(redact_text_with_mode(&text, RedactionMode::Off).text, text);
                assert_eq!(
                    redact_text_range_with_mode(&text, RedactionMode::Off, Some(range)).text,
                    text.chars().skip(range.0).take(range.1 - range.0).collect::<String>()
                );
            }
        }
    }

    #[test]
    fn code_rhs_keeps_inner_sensitive_scanning_and_json_policy() {
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            let text = "token=build(password=fixture_secret, value=node.attr)";
            let redacted = redact_text_with_mode(text, mode).text;
            assert!(!redacted.contains("fixture_secret"), "{redacted}");
            assert_eq!(redacted, "token=build(password=[redacted], value=node.attr)");
            for text in [r#"{"token":"text(node, 1)"}"#, r#"{"token":text(node, 1)}"#] {
                assert!(redact_text_with_mode(text, mode).text.contains("[redacted]"));
            }
            let (redacted, _) = redact_value_with_count(&serde_json::json!({"token": "text(node, 1)"}), mode);
            assert_eq!(redacted["token"], "[redacted]");
            let at_limit = format!("token={}node{}", "call(".repeat(32), ")".repeat(32));
            assert_eq!(redact_text_with_mode(&at_limit, mode).text, at_limit);
            assert_eq!(
                redact_text_with_mode("token=build(\".\")", mode).text,
                "token=[redacted]"
            );
        }
    }

    #[test]
    fn double_colon_locations_keep_sensitive_field_protection() {
        for (text, expected) in [
            ("host: fixture-machine", "host: [redacted]"),
            ("password::fixture-secret", "password:[redacted]"),
            ("host:::1", "host:[redacted]"),
            (r#""host":"::fixture-machine""#, r#""host":[redacted]"#),
            (r#""host"::fixture-machine"#, r#""host":[redacted]"#),
            ("host::192.168.1.2", "host::[redacted-host]"),
            ("url::https://example.com", "url::[redacted-url]"),
            ("host::call(password=fixture-secret)", "host::call(password=[redacted])"),
        ] {
            assert_eq!(redact_text_with_mode(text, RedactionMode::Strict).text, expected);
            assert_eq!(redact_text_with_mode(text, RedactionMode::Off).text, text);
        }
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            assert_eq!(
                redact_text_with_mode("password::fixture-secret", mode).text,
                "password:[redacted]"
            );
        }
        let text = "中文😀 host::method() 后缀";
        let start = text[..text.find("::").unwrap()].chars().count();
        assert_eq!(
            redact_text_range_with_mode(text, RedactionMode::Strict, Some((start, start + 2))).text,
            "::"
        );
    }

    #[test]
    fn prefixed_and_fenced_json_fields_are_redacted() {
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            for text in [
                r#"Output: {"password":"fixture_secret"}"#,
                "```json\n{\"password\":\"fixture_secret\"}\n```",
                r#"result = {'api_key':'fixture_secret'}"#,
                r#"[TOOL_USE:Bash({"command":"Output: {\"password\":\"fixture_secret\"}"})]"#,
            ] {
                let redaction = redact_text_with_mode(text, mode);
                assert!(!redaction.text.contains("fixture_secret"));
                assert!(redaction.text.contains("[redacted]"));
            }
        }

        let raw = redact_text_with_mode(r#"Output: {"password":"fixture_secret"}"#, RedactionMode::Off);
        assert_eq!(raw.text, r#"Output: {"password":"fixture_secret"}"#);
    }

    #[test]
    fn unicode_escaped_json_keys_preserve_raw_ranges_and_redact_values() {
        let body = format!(
            "{{\"pass{}u0077ord\":\"fixture_secret\",\"plain\":\"文字\"}}",
            char::from(92)
        );
        assert!(body.contains(&format!("pass{}u0077ord", char::from(92))));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["password"],
            "fixture_secret"
        );
        let mut embedded = body.clone();
        for depth in 0..4 {
            let text = format!("前缀 ```json\n{embedded}\n``` 后缀");
            let secret_byte = text.find("fixture_secret").unwrap();
            let secret_start = text[..secret_byte].chars().count();
            for mode in [RedactionMode::Auto, RedactionMode::Strict] {
                let redaction = redact_text_with_mode(&text, mode);
                assert!(
                    !redaction.text.contains("fixture_secret"),
                    "depth={depth}: {}",
                    redaction.text
                );
                assert_eq!(redaction.count, 1);
                assert!(redaction.text.starts_with("前缀 ```json\n"));
                assert!(redaction.text.ends_with("\n``` 后缀"));
                for range in [(secret_start, secret_start + 14), (secret_start + 3, secret_start + 8)] {
                    let partial = redact_text_range_with_mode(&text, mode, Some(range));
                    assert_eq!(partial.text, "[redacted]");
                    assert_eq!(partial.count, 1);
                    assert_eq!(
                        redact_text_range_with_mode(&text, RedactionMode::Off, Some(range)).text,
                        text.chars().skip(range.0).take(range.1 - range.0).collect::<String>()
                    );
                }
            }
            assert_eq!(redact_text_with_mode(&text, RedactionMode::Off).text, text);
            embedded = serde_json::to_string(&embedded).unwrap();
        }
        let nested = format!("{{\"outer\": {body}, \"untouched\": [1, 2]}}");
        assert_eq!(
            redact_text_with_mode(&nested, RedactionMode::Auto).text,
            nested.replace("\"fixture_secret\"", "[redacted]")
        );
    }

    #[test]
    fn literal_backslashes_in_json_keys_are_not_recursively_decoded() {
        let body = format!("{{\"pass{}u0077ord\":\"fixture_secret\"}}", "\\".repeat(2));
        let decoded: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(body.contains(r"pass\\u0077ord"));
        assert_eq!(
            decoded.as_object().unwrap().keys().next().unwrap(),
            &format!("pass{}u0077ord", char::from(92))
        );
        assert!(decoded.get("password").is_none());
        let mut embedded = body;
        for _ in 0..4 {
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let redaction = redact_text_with_mode(&embedded, mode);
                assert_eq!(redaction.text, embedded);
                assert_eq!(redaction.count, 0);
            }
            embedded = serde_json::to_string(&embedded).unwrap();
        }
    }

    #[test]
    fn json_like_keys_and_tool_result_text_keep_existing_redaction_rules() {
        let body = format!("{{\"pass{}u0077ord\":\"fixture_secret\"}}", char::from(92));
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            for text in ["{'password':'fixture_secret'}", "password=fixture_secret"] {
                assert!(!redact_text_with_mode(text, mode).text.contains("fixture_secret"));
            }
            let value = serde_json::json!({"content": [{"type": "text", "text": body}]});
            let (redacted, count) = redact_value_with_count(&value, mode);
            assert_eq!(count, 1);
            assert!(!redacted.to_string().contains("fixture_secret"));
        }
    }

    #[test]
    fn canonical_extraction_keeps_complete_tool_input() {
        let tail = "FAR_NEEDLE";
        let record: MessageRecord = serde_json::from_value(serde_json::json!({
            "uuid": "assistant-1",
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{
                "type": "tool_use",
                "id": "call-1",
                "name": "Bash",
                "input": {"command": format!("{}{}", "x".repeat(300), tail)}
            }]}
        }))
        .unwrap();

        let content = replace_images_with_placeholders(&record);
        assert!(content.contains(tail));
        assert!(content.chars().count() > 300);
    }

    #[test]
    fn line_ranges_and_agent_refs_have_canonical_forms() {
        let ranges = parse_line_ranges_param("5-7,!6,10-,-3").unwrap();
        assert_eq!(format_line_ranges(&ranges), "5-7,!6,10-,-3");
        assert!(session_matches_ref("agent-12345678abcdef", "12345678"));
        assert!(session_matches_ref("agent-12345678abcdef", "agent-12345678abcdef"));
        assert!(!session_matches_ref("agent-12345678abcdef", "agent-12"));
    }
}

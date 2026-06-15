use crate::config::Config;
use crate::get::{find_session_file, resolve_output_files};
use crate::types::*;
use crate::utils::*;
use regex::{Regex, RegexBuilder};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

#[cfg(unix)]
fn set_private_permissions(path: &Path, mode: u32) -> Result<(), ErrorResponse> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法设置输出权限: {}", e),
        available: None,
    })
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path, _mode: u32) -> Result<(), ErrorResponse> {
    Ok(())
}

pub struct TraceParams {
    pub r#ref: String,
    pub before: usize,
    pub after: usize,
    pub project: Option<String>,
    pub max_content: usize,
    pub max_total: usize,
    // 消息类型过滤（空表示不过滤）
    pub types: Vec<String>,
    pub subtypes: Vec<String>,
    // 内容过滤（before/after 只计数匹配的）
    pub pattern: Option<String>,
    pub regex: bool,
    pub case_sensitive: bool,
    // tool_calls 过滤
    pub servers: Vec<String>,
    pub tools: Vec<String>,
    // 范围扩展（同 context）
    pub until_type: Option<String>,
    pub until_ref: Option<String>,
    pub direction: String,
    // 导出到文件，支持 tmp:/cwd: 前缀
    pub output: Option<String>,
    pub redaction: RedactionMode,
}

struct TraceRecord {
    line_num: usize,
    record: MessageRecord,
    effective_type: &'static str,
    subtype: &'static str,
    content: String,
    redacted_count: usize,
}

struct ToolUseRef {
    id: Option<String>,
    server: Option<String>,
    tool: Option<String>,
}

struct ToolResultRef {
    id: Option<String>,
    preview: String,
}

fn matches_types(effective_type: &str, types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|t| t == effective_type)
}

fn matches_subtypes(subtype: &str, subtypes: &[String]) -> bool {
    subtypes.is_empty() || subtypes.iter().any(|t| t == subtype)
}

fn matches_pattern(content: &str, compiled: &Option<Regex>, plain: &Option<String>, case_sensitive: bool) -> bool {
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

pub fn trace(config: &Config, params: TraceParams) -> Result<TraceResponse, ErrorResponse> {
    // 编译 pattern
    let compiled_regex: Option<Regex> = if let Some(ref pat) = params.pattern {
        if params.regex {
            match RegexBuilder::new(pat).case_insensitive(!params.case_sensitive).build() {
                Ok(r) => Some(r),
                Err(e) => {
                    return Err(ErrorResponse {
                        error: "invalid_regex".to_string(),
                        message: format!("无效的正则表达式: {}", e),
                        available: None,
                    });
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let plain_pattern: Option<String> = if params.pattern.is_some() && !params.regex {
        if params.case_sensitive {
            params.pattern.clone()
        } else {
            params.pattern.as_ref().map(|p| p.to_lowercase())
        }
    } else {
        None
    };

    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    let (project_id, session_id, path) =
        find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {}", e),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut anchor_idx = None;

    for (line_num, line) in reader.lines().enumerate() {
        let line_num = line_num + 1;
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let record: MessageRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (effective_type, subtype) = classify_message(&record);
        let redaction = redact_text_with_mode(
            &replace_images_with_placeholders_with_mode(&record, params.redaction),
            params.redaction,
        );
        records.push(TraceRecord {
            line_num,
            record,
            effective_type,
            subtype,
            content: redaction.text,
            redacted_count: redaction.count,
        });
        if line_num == parsed_ref.line {
            anchor_idx = Some(records.len() - 1);
        }
    }

    let anchor_idx = anchor_idx.ok_or_else(|| ErrorResponse {
        error: "ref_not_found".to_string(),
        message: format!("ref 不存在: {}", params.r#ref),
        available: None,
    })?;

    // 确定范围（逻辑与 context 一致）
    let (start, end) = if let Some(ref until_type) = params.until_type {
        if params.direction == "backward" {
            let mut start = anchor_idx;
            for i in (0..anchor_idx).rev() {
                if records[i].effective_type == until_type.as_str() {
                    start = i;
                    break;
                }
            }
            (start, anchor_idx + 1)
        } else {
            let mut end = anchor_idx + 1;
            for (i, msg) in records.iter().enumerate().skip(anchor_idx + 1) {
                if msg.effective_type == until_type.as_str() {
                    end = i + 1;
                    break;
                }
            }
            (anchor_idx, end)
        }
    } else if let Some(ref end_ref_str) = params.until_ref {
        let end_parsed = ParsedRef::parse(end_ref_str).ok_or_else(|| ErrorResponse {
            error: "ref_invalid".to_string(),
            message: format!("until_ref 格式无效: {}", end_ref_str),
            available: None,
        })?;
        if !session_id.starts_with(&end_parsed.session_prefix) {
            return Err(ErrorResponse {
                error: "ref_invalid".to_string(),
                message: format!("until_ref 不属于当前 session: {}", end_ref_str),
                available: Some(serde_json::json!({ "session": session_id })),
            });
        }
        let end_line = end_parsed.line;
        let end_pos = records
            .iter()
            .position(|m| m.line_num == end_line)
            .ok_or_else(|| ErrorResponse {
                error: "ref_not_found".to_string(),
                message: format!("until_ref 不存在: {}", end_ref_str),
                available: None,
            })?;
        if end_pos <= anchor_idx {
            (end_pos, anchor_idx + 1)
        } else {
            (anchor_idx, end_pos + 1)
        }
    } else {
        // before/after 计数模式
        let mut start = anchor_idx;
        if params.before > 0 {
            let mut count = 0usize;
            for i in (0..anchor_idx).rev() {
                let type_ok = matches_types(records[i].effective_type, &params.types)
                    && matches_subtypes(records[i].subtype, &params.subtypes);
                let pat_ok = matches_pattern(
                    &records[i].content,
                    &compiled_regex,
                    &plain_pattern,
                    params.case_sensitive,
                );
                if type_ok && pat_ok {
                    count += 1;
                    start = i;
                    if count >= params.before {
                        break;
                    }
                }
            }
        }
        let mut end = anchor_idx + 1;
        if params.after > 0 {
            let mut count = 0usize;
            for (i, msg) in records.iter().enumerate().skip(anchor_idx + 1) {
                let type_ok =
                    matches_types(msg.effective_type, &params.types) && matches_subtypes(msg.subtype, &params.subtypes);
                let pat_ok = matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive);
                if type_ok && pat_ok {
                    count += 1;
                    end = i + 1;
                    if count >= params.after {
                        break;
                    }
                }
            }
        }
        (start, end)
    };

    let prefix = ref_prefix(&session_id);
    let mut messages = Vec::new();
    let mut total_chars = 0;
    let mut truncated = false;

    for (idx, item) in records.iter().enumerate().take(end).skip(start) {
        let is_anchor = idx == anchor_idx;
        if !is_anchor
            && (!matches_types(item.effective_type, &params.types) || !matches_subtypes(item.subtype, &params.subtypes))
        {
            continue;
        }
        let has_pattern_filter = compiled_regex.is_some() || plain_pattern.is_some();
        if !is_anchor
            && has_pattern_filter
            && !matches_pattern(&item.content, &compiled_regex, &plain_pattern, params.case_sensitive)
        {
            continue;
        }
        let (content, was_truncated) = truncate_content(&item.content, params.max_content);
        let content_size = content.chars().count();
        if total_chars + content_size > params.max_total && !messages.is_empty() {
            truncated = true;
            break;
        }
        total_chars += content_size;
        messages.push(TraceMessage {
            r#ref: format!("{}:{}", prefix, item.line_num),
            r#type: item.effective_type.to_string(),
            subtype: item.subtype.to_string(),
            timestamp: item.record.timestamp.clone(),
            content,
            is_anchor: is_anchor.then_some(true),
        });
        if was_truncated {
            truncated = true;
        }
    }

    let mut tool_calls = build_tool_calls(&records[start..end], &prefix, params.redaction);
    // servers/tools 过滤
    if !params.servers.is_empty() || !params.tools.is_empty() {
        tool_calls.retain(|tc| {
            let server_ok = params.servers.is_empty()
                || tc
                    .server
                    .as_deref()
                    .map(|s| params.servers.iter().any(|f| f == s))
                    .unwrap_or(false);
            let tool_ok = params.tools.is_empty()
                || tc
                    .tool
                    .as_deref()
                    .map(|t| params.tools.iter().any(|f| f == t))
                    .unwrap_or(false);
            server_ok && tool_ok
        });
    }

    let response = TraceResponse {
        anchor_ref: params.r#ref.clone(),
        project: project_id,
        session: session_id,
        messages,
        tool_calls,
        truncated: truncated.then_some(true),
        output_path: None,
        output: None,
    };

    if let Some(output_dir_raw) = params.output {
        let safe_ref = params.r#ref.replace([':', '/'], "_");
        let output = resolve_output_files(
            &output_dir_raw,
            &format!("{}_trace.txt", safe_ref),
            &format!("{}_trace_manifest.json", safe_ref),
        )?;
        let output_dir = output.directory;
        let out_path = output.content;
        let manifest_path = output.manifest;
        let was_new = !output_dir.exists();
        fs::create_dir_all(&output_dir).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建输出目录: {}", e),
            available: None,
        })?;
        if was_new {
            set_private_permissions(&output_dir, 0o700)?;
        }
        let mut file = File::create(&out_path).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建输出文件: {}", e),
            available: None,
        })?;
        set_private_permissions(&out_path, 0o600)?;
        let mut written_messages = 0usize;
        let mut redacted_count = 0usize;
        for (idx, item) in records.iter().enumerate().take(end).skip(start) {
            let is_anchor = idx == anchor_idx;
            if !is_anchor
                && (!matches_types(item.effective_type, &params.types)
                    || !matches_subtypes(item.subtype, &params.subtypes))
            {
                continue;
            }
            let has_pattern_filter = compiled_regex.is_some() || plain_pattern.is_some();
            if !is_anchor
                && has_pattern_filter
                && !matches_pattern(&item.content, &compiled_regex, &plain_pattern, params.case_sensitive)
            {
                continue;
            }
            let anchor_mark = if is_anchor { " [anchor]" } else { "" };
            writeln!(
                file,
                "=== {}:{} {} {}{} ===",
                prefix, item.line_num, item.effective_type, item.subtype, anchor_mark
            )
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {}", e),
                available: None,
            })?;
            writeln!(file, "{}", item.content).map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {}", e),
                available: None,
            })?;
            writeln!(file).map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {}", e),
                available: None,
            })?;
            written_messages += 1;
            redacted_count += item.redacted_count;
        }
        if !response.tool_calls.is_empty() {
            writeln!(file, "=== tool_calls ===").map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {}", e),
                available: None,
            })?;
            for tc in &response.tool_calls {
                let server_tool = match (&tc.server, &tc.tool) {
                    (Some(s), Some(t)) => format!("{}::{}", s, t),
                    (None, Some(t)) => t.clone(),
                    _ => "(unknown)".to_string(),
                };
                writeln!(file, "[{}] {} status={}", tc.r#ref, server_tool, tc.status).map_err(|e| ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("写文件失败: {}", e),
                    available: None,
                })?;
                if let Some(ref preview) = tc.result_preview {
                    writeln!(file, "  result: {}", preview).map_err(|e| ErrorResponse {
                        error: "io_error".to_string(),
                        message: format!("写文件失败: {}", e),
                        available: None,
                    })?;
                }
            }
        }
        file.flush().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 trace 输出失败: {}", e),
            available: None,
        })?;
        let bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let redaction = redaction_info(
            params.redaction,
            redacted_count,
            params.redaction == RedactionMode::Off || redacted_count > 0,
        );
        let manifest = serde_json::json!({
            "schema": "mcp-claude-history.trace-output.v1",
            "anchor_ref": response.anchor_ref,
            "project": response.project,
            "session": response.session,
            "content": &out_path,
            "bytes": bytes,
            "lines": written_messages,
            "complete": true,
            "sample_kind": "selected_range",
            "redaction": &redaction,
        });
        let mut manifest_file = File::create(&manifest_path).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建 trace manifest: {}", e),
            available: None,
        })?;
        set_private_permissions(&manifest_path, 0o600)?;
        manifest_file
            .write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入 trace manifest 失败: {}", e),
                available: None,
            })?;
        return Ok(TraceResponse {
            anchor_ref: response.anchor_ref,
            project: response.project,
            session: response.session,
            messages: response.messages,
            tool_calls: response.tool_calls,
            truncated: response.truncated,
            output_path: Some(out_path.clone()),
            output: Some(OutputInfo {
                content: out_path,
                manifest: manifest_path,
                images: Vec::new(),
                bytes,
                lines: written_messages,
                schema: "mcp-claude-history.trace-output.v1".to_string(),
                complete: true,
                sample_kind: "selected_range".to_string(),
                redaction,
            }),
        });
    }

    Ok(response)
}

fn build_tool_calls(records: &[TraceRecord], prefix: &str, redaction: RedactionMode) -> Vec<TraceToolCall> {
    let mut calls = Vec::new();
    let mut pending = Vec::new();

    for record in records {
        let result_refs = extract_tool_results(&record.record, redaction);
        for result in result_refs {
            if let Some(pos) = pending_tool_call_position(&calls, &pending, result.id.as_deref()) {
                let (call_idx, _) = pending.remove(pos);
                calls[call_idx].status = "completed".to_string();
                calls[call_idx].result_ref = Some(format!("{}:{}", prefix, record.line_num));
                calls[call_idx].result_preview = Some(result.preview);
            }
        }

        for tool_use in extract_tool_uses(&record.record) {
            let call_idx = calls.len();
            calls.push(TraceToolCall {
                r#ref: format!("{}:{}", prefix, record.line_num),
                server: tool_use.server,
                tool: tool_use.tool,
                status: "pending".to_string(),
                result_ref: None,
                result_preview: None,
            });
            pending.push((call_idx, tool_use.id));
        }
    }

    calls
}

fn pending_tool_call_position(
    calls: &[TraceToolCall],
    pending: &[(usize, Option<String>)],
    result_id: Option<&str>,
) -> Option<usize> {
    if let Some(result_id) = result_id
        && let Some(pos) = pending.iter().position(|(_, id)| id.as_deref() == Some(result_id))
    {
        return Some(pos);
    }
    pending.iter().position(|(idx, _)| calls[*idx].result_ref.is_none())
}

fn extract_tool_uses(record: &MessageRecord) -> Vec<ToolUseRef> {
    let Some(content) = record
        .message
        .as_ref()
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
        let id = item.get("id").and_then(|id| id.as_str()).map(ToString::to_string);
        let (server, tool) = split_tool_name(name);
        result.push(ToolUseRef { id, server, tool });
    }
    result
}

fn extract_tool_results(record: &MessageRecord, redaction: RedactionMode) -> Vec<ToolResultRef> {
    let Some(content) = record
        .message
        .as_ref()
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let id = item
            .get("tool_use_id")
            .and_then(|id| id.as_str())
            .map(ToString::to_string);
        let preview_source = item
            .get("content")
            .and_then(|content| content.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                item.get("content")
                    .map(|content| content.to_string())
                    .unwrap_or_default()
            });
        let (preview, _) = truncate_content(&redact_text_with_mode(&preview_source, redaction).text, 500);
        results.push(ToolResultRef { id, preview });
    }
    results
}

fn split_tool_name(name: &str) -> (Option<String>, Option<String>) {
    let mut parts = name.splitn(3, "__");
    let first = parts.next();
    let second = parts.next();
    let third = parts.next();
    if let (Some("mcp"), Some(server), Some(tool)) = (first, second, third) {
        return (Some(server.to_string()), Some(tool.to_string()));
    }
    (None, Some(name.to_string()))
}

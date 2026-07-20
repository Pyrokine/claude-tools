use crate::config::Config;
use crate::get::{find_session_file, resolve_output_files};
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};

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
    assistant_uuid: String,
    server: Option<String>,
    tool: Option<String>,
}

struct ToolResultRef {
    id: Option<String>,
    source_tool_assistant_uuid: Option<String>,
    parent_uuid: Option<String>,
    preview: String,
    redacted_count: usize,
}

pub fn trace(config: &Config, params: TraceParams) -> Result<TraceResponse, ErrorResponse> {
    let content_filter = build_content_filter(&params.pattern, params.regex, params.case_sensitive)?;

    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    let (project_id, session_id, path) =
        find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {e}"),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut anchor_idx = None;
    let mut read_errors = 0usize;
    let mut parse_errors = 0usize;

    for (line_num, line) in reader.lines().enumerate() {
        let line_num = line_num + 1;
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                read_errors += 1;
                continue;
            }
        };
        let record = match parse_message_record(&line) {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(_) => {
                parse_errors += 1;
                continue;
            }
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
            message: format!("until_ref 格式无效: {end_ref_str}"),
            available: None,
        })?;
        if !session_id.starts_with(&end_parsed.session_prefix) {
            return Err(ErrorResponse {
                error: "ref_invalid".to_string(),
                message: format!("until_ref 不属于当前 session: {end_ref_str}"),
                available: Some(serde_json::json!({ "session": session_id })),
            });
        }
        let end_line = end_parsed.line;
        let end_pos = records
            .iter()
            .position(|m| m.line_num == end_line)
            .ok_or_else(|| ErrorResponse {
                error: "ref_not_found".to_string(),
                message: format!("until_ref 不存在: {end_ref_str}"),
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
                let type_ok = message_type_matches(records[i].effective_type, &params.types)
                    && message_subtype_matches(records[i].subtype, &params.subtypes);
                let pat_ok = content_filter.matches(&records[i].content);
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
                let type_ok = message_type_matches(msg.effective_type, &params.types)
                    && message_subtype_matches(msg.subtype, &params.subtypes);
                let pat_ok = content_filter.matches(&msg.content);
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
            && (!message_type_matches(item.effective_type, &params.types)
                || !message_subtype_matches(item.subtype, &params.subtypes))
        {
            continue;
        }
        if !is_anchor && content_filter.has_filter() && !content_filter.matches(&item.content) {
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

    let (mut tool_calls, association_issues, tool_call_redacted_count) =
        build_tool_calls(&records[start..end], &prefix, params.redaction);
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

    let warnings = jsonl_read_warnings(read_errors, parse_errors);
    let response = TraceResponse {
        anchor_ref: params.r#ref.clone(),
        project: project_id,
        session: session_id,
        messages,
        tool_calls,
        association_issues,
        truncated: truncated.then_some(true),
        warnings,
        output_path: None,
        output: None,
    };

    if let Some(output_dir_raw) = params.output {
        let safe_ref = params.r#ref.replace([':', '/'], "_");
        let output = resolve_output_files(
            &output_dir_raw,
            &format!("{safe_ref}_trace.txt"),
            &format!("{safe_ref}_trace_manifest.json"),
        )?;
        let output_dir = output.directory;
        let out_path = output.content;
        let manifest_path = output.manifest;
        let was_new = !output_dir.exists();
        fs::create_dir_all(&output_dir).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建输出目录: {e}"),
            available: None,
        })?;
        if was_new {
            set_private_permissions(&output_dir, 0o700)?;
        }
        let mut file = open_private_output_file(&out_path)?;
        let (written_messages, redacted_count) = write_filtered_message_export(
            &mut file,
            &prefix,
            records.iter().enumerate().take(end).skip(start).map(|(idx, item)| {
                (
                    idx,
                    ExportMessage {
                        line_num: item.line_num,
                        effective_type: item.effective_type,
                        subtype: item.subtype,
                        content: &item.content,
                        redacted_count: item.redacted_count,
                    },
                )
            }),
            anchor_idx,
            MessageExportFilters {
                types: &params.types,
                subtypes: &params.subtypes,
                content_filter: &content_filter,
            },
        )?;
        if !response.tool_calls.is_empty() {
            writeln!(file, "=== tool_calls ===").map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {e}"),
                available: None,
            })?;
            for tc in &response.tool_calls {
                let server_tool = match (&tc.server, &tc.tool) {
                    (Some(s), Some(t)) => format!("{s}::{t}"),
                    (None, Some(t)) => t.clone(),
                    _ => "(unknown)".to_string(),
                };
                writeln!(file, "[{}] {} status={}", tc.r#ref, server_tool, tc.status).map_err(|e| ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("写文件失败: {e}"),
                    available: None,
                })?;
                if let Some(ref preview) = tc.result_preview {
                    writeln!(file, "  result: {preview}").map_err(|e| ErrorResponse {
                        error: "io_error".to_string(),
                        message: format!("写文件失败: {e}"),
                        available: None,
                    })?;
                }
            }
        }
        file.flush().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 trace 输出失败: {e}"),
            available: None,
        })?;
        let bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let redacted_count = redacted_count.saturating_add(tool_call_redacted_count);
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
        let mut manifest_file = open_private_output_file(&manifest_path)?;
        manifest_file
            .write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入 trace manifest 失败: {e}"),
                available: None,
            })?;
        return Ok(TraceResponse {
            anchor_ref: response.anchor_ref,
            project: response.project,
            session: response.session,
            messages: response.messages,
            tool_calls: response.tool_calls,
            association_issues: response.association_issues,
            truncated: response.truncated,
            warnings: response.warnings,
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

const ASSOCIATION_ISSUE_CAP: usize = 20;

type PendingToolCall = (usize, Option<String>, String);

fn build_tool_calls(
    records: &[TraceRecord],
    prefix: &str,
    redaction: RedactionMode,
) -> (Vec<TraceToolCall>, Vec<TraceAssociationIssue>, usize) {
    let mut calls: Vec<TraceToolCall> = Vec::new();
    let mut pending: Vec<PendingToolCall> = Vec::new();
    let mut issues = Vec::new();
    let mut redacted_count = 0usize;

    for record in records {
        for result in extract_tool_results(&record.record, redaction) {
            let association = pending_tool_call_position(&pending, &result);
            if let Some((pos, match_method)) = association.position.zip(association.match_method) {
                let (call_idx, _, _) = pending.remove(pos);
                calls[call_idx].status = "completed".to_string();
                calls[call_idx].match_method = match_method;
                calls[call_idx].result_ref = Some(format!("{}:{}", prefix, record.line_num));
                calls[call_idx].result_preview = Some(result.preview);
                redacted_count = redacted_count.saturating_add(result.redacted_count);
            } else if issues.len() < ASSOCIATION_ISSUE_CAP {
                issues.push(TraceAssociationIssue {
                    result_ref: format!("{}:{}", prefix, record.line_num),
                    kind: association.issue.unwrap_or_else(|| "unmatched".to_string()),
                    tool_use_id: result.id,
                    pending_count: pending.len(),
                });
            }
        }

        for tool_use in extract_tool_uses(&record.record) {
            let call_idx = calls.len();
            calls.push(TraceToolCall {
                r#ref: format!("{}:{}", prefix, record.line_num),
                server: tool_use.server,
                tool: tool_use.tool,
                status: "pending".to_string(),
                match_method: "unmatched".to_string(),
                result_ref: None,
                result_preview: None,
            });
            pending.push((call_idx, tool_use.id, tool_use.assistant_uuid));
        }
    }

    (calls, issues, redacted_count)
}

struct ToolAssociation {
    position: Option<usize>,
    match_method: Option<String>,
    issue: Option<String>,
}

fn pending_tool_call_position(pending: &[PendingToolCall], result: &ToolResultRef) -> ToolAssociation {
    if let Some(result_id) = result.id.as_deref() {
        return pending
            .iter()
            .position(|(_, id, _)| id.as_deref() == Some(result_id))
            .map_or(
                ToolAssociation {
                    position: None,
                    match_method: None,
                    issue: Some("unmatched".to_string()),
                },
                |position| ToolAssociation {
                    position: Some(position),
                    match_method: Some("tool_use_id".to_string()),
                    issue: None,
                },
            );
    }

    for parent in [
        result.source_tool_assistant_uuid.as_deref(),
        result.parent_uuid.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let matches = pending
            .iter()
            .enumerate()
            .filter(|(_, (_, _, assistant_uuid))| assistant_uuid == parent)
            .map(|(position, _)| position)
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return ToolAssociation {
                position: matches.first().copied(),
                match_method: Some("parent".to_string()),
                issue: None,
            };
        }
    }

    if pending.len() == 1 {
        return ToolAssociation {
            position: Some(0),
            match_method: Some("legacy_single_pending".to_string()),
            issue: None,
        };
    }
    ToolAssociation {
        position: None,
        match_method: None,
        issue: Some(if pending.len() > 1 { "ambiguous" } else { "unmatched" }.to_string()),
    }
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
        result.push(ToolUseRef {
            id,
            assistant_uuid: record.uuid.clone(),
            server,
            tool,
        });
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
        let redaction = redact_text_with_mode(&preview_source, redaction);
        let (preview, _) = truncate_content(&redaction.text, 500);
        results.push(ToolResultRef {
            id,
            source_tool_assistant_uuid: record.source_tool_assistant_uuid.clone(),
            parent_uuid: record.parent_uuid.clone(),
            preview,
            redacted_count: redaction.count,
        });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(line_num: usize, json: serde_json::Value) -> TraceRecord {
        let record: MessageRecord = serde_json::from_value(json).unwrap();
        TraceRecord {
            line_num,
            record,
            effective_type: "assistant",
            subtype: "tool_use",
            content: String::new(),
            redacted_count: 0,
        }
    }

    #[test]
    fn explicit_mismatched_id_does_not_consume_pending_call() {
        let records = vec![
            record(
                1,
                serde_json::json!({
                    "uuid": "assistant-1",
                    "type": "assistant",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_use", "id": "call-1", "name": "Bash"}]}
                }),
            ),
            record(
                2,
                serde_json::json!({
                    "uuid": "user-1",
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "message": {"content": [{"type": "tool_result", "tool_use_id": "outside-call", "content": "wrong"}]}
                }),
            ),
            record(
                3,
                serde_json::json!({
                    "uuid": "user-2",
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:02Z",
                    "message": {"content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "right"}]}
                }),
            ),
        ];
        let (calls, issues, _) = build_tool_calls(&records, "session", RedactionMode::Auto);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].result_ref.as_deref(), Some("session:3"));
        assert_eq!(calls[0].match_method, "tool_use_id");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, "unmatched");
    }

    #[test]
    fn missing_id_is_ambiguous_with_multiple_pending_calls() {
        let records = vec![
            record(
                1,
                serde_json::json!({
                    "uuid": "assistant-1",
                    "type": "assistant",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [
                        {"type": "tool_use", "id": "call-1", "name": "Bash"},
                        {"type": "tool_use", "id": "call-2", "name": "Read"}
                    ]}
                }),
            ),
            record(
                2,
                serde_json::json!({
                    "uuid": "user-1",
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "message": {"content": [{"type": "tool_result", "content": "unknown"}]}
                }),
            ),
        ];
        let (calls, issues, _) = build_tool_calls(&records, "session", RedactionMode::Auto);
        assert!(calls.iter().all(|call| call.status == "pending"));
        assert_eq!(issues[0].kind, "ambiguous");
    }

    #[test]
    fn missing_id_uses_parent_uuid_before_legacy_fallback() {
        let records = vec![
            record(
                1,
                serde_json::json!({
                    "uuid": "assistant-1",
                    "type": "assistant",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_use", "id": "call-1", "name": "Bash"}]}
                }),
            ),
            record(
                2,
                serde_json::json!({
                    "uuid": "user-1",
                    "type": "user",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "sourceToolAssistantUUID": "assistant-1",
                    "message": {"content": [{"type": "tool_result", "content": "ok"}]}
                }),
            ),
        ];
        let (calls, issues, _) = build_tool_calls(&records, "session", RedactionMode::Auto);
        assert!(issues.is_empty());
        assert_eq!(calls[0].match_method, "parent");
    }

    #[test]
    fn strict_redaction_covers_structured_tool_results_and_exports() {
        let tmp = std::env::temp_dir().join(format!(
            "mcp-trace-redaction-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-redaction.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-1",
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [{"type": "tool_use", "id": "call-1", "name": "Bash"}]}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-1",
                "type": "user",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {"content": [{
                    "type": "tool_result",
                    "tool_use_id": "call-1",
                    "content": [{
                        "type": "text",
                        "text": r#"{"token":"SUPERSECRET","nested":{"accessToken":"ACCESSSECRET"},"host":"192.168.x.x"}"#
                    }]
                }]}
            })
        )
        .unwrap();

        let output_name = format!(
            "tmp:mcp-trace-redaction-output-{}-{}/trace.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let response = trace(
            &Config {
                projects_dir: tmp.clone(),
            },
            TraceParams {
                r#ref: "session-:1".to_string(),
                before: 0,
                after: 1,
                project: Some("project".to_string()),
                max_content: 4000,
                max_total: 40000,
                types: Vec::new(),
                subtypes: Vec::new(),
                pattern: None,
                regex: false,
                case_sensitive: false,
                servers: Vec::new(),
                tools: Vec::new(),
                until_type: None,
                until_ref: None,
                direction: "forward".to_string(),
                output: Some(output_name),
                redaction: RedactionMode::Strict,
            },
        )
        .unwrap();

        let preview = response.tool_calls[0].result_preview.as_deref().unwrap();
        assert!(!preview.contains("SUPERSECRET"));
        assert!(!preview.contains("ACCESSSECRET"));
        assert!(!preview.contains("192.168.x.x"));
        assert!(preview.contains("[redacted]"));

        let output = response.output.as_ref().unwrap();
        let exported = fs::read_to_string(&output.content).unwrap();
        assert!(!exported.contains("SUPERSECRET"));
        assert!(!exported.contains("ACCESSSECRET"));
        assert!(!exported.contains("192.168.x.x"));
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(&output.manifest).unwrap()).unwrap();
        assert!(manifest["redaction"]["redacted_count"].as_u64().unwrap() >= 3);
        assert_eq!(manifest["redaction"]["raw_available"], true);

        fs::remove_dir_all(output.content.parent().unwrap()).ok();
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn legal_non_message_records_do_not_count_as_parse_errors() {
        let tmp = std::env::temp_dir().join(format!("mcp-trace-record-test-{}", std::process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-trace.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "custom-title", "customTitle": "fixture"})
        )
        .unwrap();
        writeln!(file, "{{").unwrap();
        writeln!(file, "{}", serde_json::json!({"uuid": "incomplete"})).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-1",
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [{"type": "text", "text": "anchor"}]}
            })
        )
        .unwrap();

        let response = trace(
            &Config {
                projects_dir: tmp.clone(),
            },
            TraceParams {
                r#ref: "session-:4".to_string(),
                before: 0,
                after: 0,
                project: Some("project".to_string()),
                max_content: 4000,
                max_total: 40000,
                types: Vec::new(),
                subtypes: Vec::new(),
                pattern: None,
                regex: false,
                case_sensitive: false,
                servers: Vec::new(),
                tools: Vec::new(),
                until_type: None,
                until_ref: None,
                direction: "forward".to_string(),
                output: None,
                redaction: RedactionMode::Auto,
            },
        )
        .unwrap();

        assert_eq!(response.messages.len(), 1);
        assert_eq!(response.warnings, ["解析 JSONL 时跳过 2 行"]);
        fs::remove_dir_all(&tmp).ok();
    }
}

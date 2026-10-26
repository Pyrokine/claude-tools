use crate::config::Config;
use crate::get::{OutputTransaction, find_session_file, resolve_output_files};
use crate::search::{MAX_CONTENT_LIMIT, MAX_TOTAL_LIMIT, MIN_CONTENT_LIMIT, MIN_TOTAL_LIMIT};
use crate::types::*;
use crate::utils::*;
#[cfg(test)]
use std::fs::{self, File};
use std::io::Write;

pub struct TraceParams {
    pub r#ref: String,
    pub before: Option<usize>,
    pub after: Option<usize>,
    pub project: Option<String>,
    pub source: Option<String>,
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
    pub overwrite: bool,
    pub redaction: RedactionMode,
}

pub fn trace(config: &Config, params: TraceParams) -> Result<TraceResponse, ErrorResponse> {
    let mut params = params;
    if !(MIN_CONTENT_LIMIT..=MAX_CONTENT_LIMIT).contains(&params.max_content)
        || !(MIN_TOTAL_LIMIT..=MAX_TOTAL_LIMIT).contains(&params.max_total)
    {
        return Err(invalid_arguments("max_content 或 max_total 超出支持范围"));
    }
    if params.overwrite && params.output.is_none() {
        return Err(invalid_arguments("overwrite=true 需要 output"));
    }
    let filters = normalize_message_filters(&params.types, &params.subtypes, None)?;
    let mut parameter_warnings = filters.warnings;
    params.types = filters.types;
    params.subtypes = filters.subtypes;
    params.direction = parse_context_direction(&params.direction)?;
    validate_context_range_selectors(
        params.before,
        params.after,
        params.until_type.as_deref(),
        params.until_ref.as_deref(),
    )?;
    if params.until_type.is_none() && params.direction == "backward" {
        return Err(invalid_arguments("direction=backward 仅能与 until_type 一起使用"));
    }
    let content_filter = build_content_filter(&params.pattern, params.regex, params.case_sensitive)?;

    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    let (project_id, session_id, path) = find_session_file(
        config,
        &parsed_ref.session_prefix,
        params.project.as_deref(),
        params.source.as_deref(),
    )?;
    let range = if let Some(until_type) = &params.until_type {
        SessionRange::UntilType {
            effective_type: until_type,
            backward: params.direction == "backward",
        }
    } else if let Some(end_ref_str) = &params.until_ref {
        let end_parsed = ParsedRef::parse(end_ref_str).ok_or_else(|| ErrorResponse {
            error: "ref_invalid".to_string(),
            message: format!("until_ref 格式无效: {end_ref_str}"),
            available: None,
        })?;
        if !session_matches_ref(&session_id, &end_parsed.session_prefix) {
            return Err(ErrorResponse {
                error: "ref_invalid".to_string(),
                message: format!("until_ref 不属于当前 session: {end_ref_str}"),
                available: Some(serde_json::json!({ "session": session_id })),
            });
        }
        SessionRange::UntilRef { line: end_parsed.line }
    } else {
        SessionRange::Counts {
            before: params.before.unwrap_or(20),
            after: Some(params.after.unwrap_or(20)),
        }
    };
    let index = index_session_messages(
        &path,
        parsed_ref.line,
        &content_filter,
        params.redaction,
        &params.types,
        &params.subtypes,
        range,
    )?;
    let anchor_idx = index.anchor_idx;
    let indexed = &index.messages;
    let records = load_session_window(&path, &index, params.redaction)?;
    if records
        .iter()
        .try_fold(0usize, |count, item| count.checked_add(tool_block_count(&item.record)))
        .is_none_or(|count| count > MAX_TOOL_BLOCKS)
    {
        return Err(ErrorResponse {
            error: "tool_association_limit".to_string(),
            message: format!("选定范围内的工具调用超过 {MAX_TOOL_BLOCKS} 条，请缩小范围"),
            available: None,
        });
    }
    let prefix = ref_prefix(&session_id);
    let mut messages = Vec::new();
    let mut truncated = false;

    for (idx, item) in records.iter().enumerate() {
        let is_anchor = idx == anchor_idx;
        if !is_anchor
            && (!message_type_matches(item.effective_type, &params.types)
                || !message_subtype_matches(item.subtype, &params.subtypes))
        {
            continue;
        }
        if !is_anchor && !indexed[idx].matches_pattern {
            continue;
        }
        let (content, was_truncated) = truncate_content(&item.content, params.max_content);
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

    let block_count: usize = records
        .iter()
        .map(|item| {
            item.record
                .message
                .as_ref()
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_array)
                .map_or(0, Vec::len)
        })
        .sum();
    if block_count > 4096 {
        return Err(ErrorResponse {
            error: "session_tool_block_limit".to_string(),
            message: "trace 范围的内容块超过 4096 个，请缩小范围".to_string(),
            available: None,
        });
    }
    let (mut tool_calls, association_issues) = build_tool_calls(&records, &prefix, params.redaction);
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
                || params.tools.iter().any(|filter| {
                    let requested = parse_mcp_tool_name(filter);
                    requested.tool == tc.tool && (requested.server.is_none() || requested.server == tc.server)
                });
            server_ok && tool_ok
        });
    }

    parameter_warnings.extend(index.warnings);
    let mut response = TraceResponse {
        anchor_ref: params.r#ref.clone(),
        project: project_id,
        session: session_id,
        messages,
        tool_calls,
        association_issues,
        truncated: truncated.then_some(true),
        warnings: parameter_warnings,
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
        let retention = output.temp_output.then(|| TEMP_OUTPUT_RETENTION.to_string());
        let transaction = OutputTransaction::begin(output, params.overwrite)?;
        let out_path = transaction.content();
        let manifest_path = transaction.manifest();
        let mut file = open_private_output_file(&transaction.staging_content())?;
        let (written_messages, redacted_count) = write_filtered_message_export(
            &mut file,
            &prefix,
            records.iter().enumerate().map(|(offset, item)| {
                (
                    offset,
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
        file.sync_all().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 trace 输出失败: {e}"),
            available: None,
        })?;
        let bytes = file
            .metadata()
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("无法获取 trace 导出大小: {e}"),
                available: None,
            })?
            .len();
        drop(file);
        let redacted_count = redacted_count.saturating_add(
            response
                .tool_calls
                .iter()
                .map(|call| call.redacted_count)
                .sum::<usize>(),
        );
        let redaction = redaction_info(
            params.redaction,
            redacted_count,
            params.redaction == RedactionMode::Off || redacted_count > 0,
        );
        let manifest = serde_json::json!({
            "schema": "mcp-claude-history.trace-output.v2",
            "anchor_ref": response.anchor_ref,
            "project": response.project,
            "session": response.session,
            "content": &out_path,
            "bytes": bytes,
            "lines": written_messages,
            "complete": index.incomplete_reasons.is_empty(),
            "incomplete_reasons": index.incomplete_reasons,
            "sample_kind": "selected_range",
            "redaction": &redaction,
        });
        let mut manifest_file = open_private_output_file(&transaction.staging_manifest())?;
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| ErrorResponse {
            error: "serialize_error".to_string(),
            message: format!("无法序列化 trace manifest: {e}"),
            available: None,
        })?;
        manifest_file.write_all(&manifest_bytes).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("写入 trace manifest 失败: {e}"),
            available: None,
        })?;
        manifest_file.sync_all().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法同步 trace manifest: {e}"),
            available: None,
        })?;
        drop(manifest_file);
        response.output_path = Some(out_path.clone());
        response.output = Some(OutputInfo {
            content: out_path,
            manifest: manifest_path,
            images: Vec::new(),
            bytes,
            lines: written_messages,
            schema: "mcp-claude-history.trace-output.v2".to_string(),
            complete: index.incomplete_reasons.is_empty(),
            sample_kind: "selected_range".to_string(),
            redaction,
            retention,
        });
        budget_trace_response(&mut response, params.max_total)?;
        transaction.publish()?;
        return Ok(response);
    }

    budget_trace_response(&mut response, params.max_total)?;
    Ok(response)
}

fn budget_trace_response(response: &mut TraceResponse, max_total: usize) -> Result<(), ErrorResponse> {
    loop {
        let bytes = serde_json::to_vec(response)
            .map_err(|e| invalid_arguments(format!("序列化 trace 失败: {e}")))?
            .len();
        if bytes <= max_total {
            return Ok(());
        }
        response.truncated = Some(true);
        // Keep the anchor and retain only complete tool-call summaries.
        if response.tool_calls.pop().is_some() || response.association_issues.pop().is_some() {
            continue;
        }
        if let Some(position) = response
            .messages
            .iter()
            .rposition(|message| message.is_anchor != Some(true))
        {
            response.messages.remove(position);
            continue;
        }
        return Err(ErrorResponse {
            error: "response_too_large".to_string(),
            message: format!("trace 响应超过 max_total={max_total} 字节；请增大预算或缩小范围"),
            available: Some(serde_json::json!({"serialized_bytes": bytes, "max_total_bytes": max_total})),
        });
    }
}

const ASSOCIATION_ISSUE_CAP: usize = 20;

fn build_tool_calls(
    records: &[WindowRecord],
    prefix: &str,
    redaction: RedactionMode,
) -> (Vec<TraceToolCall>, Vec<TraceAssociationIssue>) {
    let mut tracker = ToolAssociationTracker::default();
    let mut call_indices = std::collections::BTreeMap::new();
    let mut calls = Vec::new();
    let mut issues = Vec::new();

    for record in records {
        let blocks = tracker.observe_record(&record.record, false);
        for block in blocks {
            match block.kind {
                ToolBlockKind::Use => {
                    let call_idx = calls.len();
                    calls.push(TraceToolCall {
                        r#ref: format!("{}:{}", prefix, record.line_num),
                        server: block.info.server,
                        tool: block.info.tool,
                        status: "pending".to_string(),
                        match_method: "unmatched".to_string(),
                        result_ref: None,
                        result_preview: None,
                        redacted_count: 0,
                    });
                    if let Some(call_key) = block.call_key {
                        call_indices.insert(call_key, call_idx);
                    }
                }
                ToolBlockKind::Result => {
                    if let Some(call_idx) = block.call_key.and_then(|key| call_indices.get(&key).copied()) {
                        calls[call_idx].status = "completed".to_string();
                        calls[call_idx].match_method = block.match_method.unwrap_or("unmatched").to_string();
                        calls[call_idx].result_ref = Some(format!("{}:{}", prefix, record.line_num));
                        if let Some((preview, count)) = record.result_previews.get(&block.block_index) {
                            calls[call_idx].result_preview = Some(preview.clone());
                            calls[call_idx].redacted_count = *count;
                        } else {
                            let rendered = render_tool_block(&block, redaction);
                            calls[call_idx].result_preview = rendered.result.as_ref().map(tool_result_preview);
                            calls[call_idx].redacted_count = rendered.redacted_count;
                        }
                    } else if issues.len() < ASSOCIATION_ISSUE_CAP {
                        issues.push(TraceAssociationIssue {
                            result_ref: format!("{}:{}", prefix, record.line_num),
                            kind: block.association_issue.unwrap_or("unmatched").to_string(),
                            tool_use_id: block.tool_use_id,
                            pending_count: block.pending_count,
                        });
                    }
                }
            }
        }
    }

    (calls, issues)
}

fn tool_result_preview(result: &serde_json::Value) -> String {
    let content = result.get("content").unwrap_or(result);
    let source = content
        .as_str()
        .map(ToString::to_string)
        .unwrap_or_else(|| content.to_string());
    truncate_content(&source, 500).0
}

#[cfg(test)]
mod tests {
    use super::*;

    type TraceRecord = WindowRecord;

    fn record(line_num: usize, json: serde_json::Value) -> TraceRecord {
        let record: MessageRecord = serde_json::from_value(json).unwrap();
        TraceRecord {
            line_num,
            result_previews: std::collections::BTreeMap::new(),
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
        let (calls, issues) = build_tool_calls(&records, "session", RedactionMode::Auto);
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
        let (calls, issues) = build_tool_calls(&records, "session", RedactionMode::Auto);
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
        let (calls, issues) = build_tool_calls(&records, "session", RedactionMode::Auto);
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
                        "text": concat!(
                            r#"{"token":"SUPERSECRET","nested":{"accessToken":"ACCESS"#,
                            r#"SECRET"},"host":"192.168.x.x"}"#
                        )
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
                before: Some(0),
                after: Some(1),
                project: Some("project".to_string()),
                source: None,
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
                overwrite: false,
            },
        )
        .unwrap();

        let preview = response.tool_calls[0].result_preview.as_deref().unwrap();
        assert!(!preview.contains("SUPERSECRET"));
        assert!(!preview.contains(concat!("ACCESS", "SECRET")));
        assert!(!preview.contains("192.168.x.x"));
        assert!(preview.contains("[redacted]"));

        let output = response.output.as_ref().unwrap();
        let exported = fs::read_to_string(&output.content).unwrap();
        assert!(!exported.contains("SUPERSECRET"));
        assert!(!exported.contains(concat!("ACCESS", "SECRET")));
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
                before: Some(0),
                after: Some(0),
                project: Some("project".to_string()),
                source: None,
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
                overwrite: false,
            },
        )
        .unwrap();

        assert_eq!(response.messages.len(), 1);
        assert_eq!(response.warnings, ["解析 JSONL 时跳过 2 行"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn conflicting_trace_selectors_fail_before_ref_resolution() {
        let error = trace(
            &Config {
                projects_dir: std::env::temp_dir(),
            },
            TraceParams {
                r#ref: "invalid".to_string(),
                before: Some(0),
                after: None,
                project: None,
                source: None,
                max_content: 4000,
                max_total: 40000,
                types: Vec::new(),
                subtypes: Vec::new(),
                pattern: None,
                regex: false,
                case_sensitive: false,
                servers: Vec::new(),
                tools: Vec::new(),
                until_type: Some("user".to_string()),
                until_ref: None,
                direction: "forward".to_string(),
                output: None,
                redaction: RedactionMode::Auto,
                overwrite: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.error, "invalid_arguments");
        assert!(error.message.contains("不能和 before/after 同时传入"));
    }

    #[test]
    fn agent_until_ref_accepts_its_canonical_prefix() {
        let tmp = std::env::temp_dir().join(format!("mcp-trace-agent-ref-test-{}", std::process::id()));
        fs::remove_dir_all(&tmp).ok();
        let sidechain = tmp.join("project").join("main-session").join("remote-agents");
        fs::create_dir_all(&sidechain).unwrap();
        let mut file = File::create(sidechain.join("agent-12345678abcdef.jsonl")).unwrap();
        for line in 1..=2 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("user-{line}"),
                    "type": "user",
                    "timestamp": format!("2026-01-01T00:00:0{line}Z"),
                    "message": {"content": format!("message-{line}")}
                })
            )
            .unwrap();
        }

        let response = trace(
            &Config {
                projects_dir: tmp.clone(),
            },
            TraceParams {
                r#ref: "12345678:1".to_string(),
                before: None,
                after: None,
                project: Some("project".to_string()),
                source: None,
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
                until_ref: Some("12345678:2".to_string()),
                direction: "forward".to_string(),
                output: None,
                redaction: RedactionMode::Auto,
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(response.messages.len(), 2);
        assert_eq!(response.messages[1].r#ref, "12345678:2");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn trace_budget_includes_tool_calls_and_association_metadata() {
        let tmp = std::env::temp_dir().join(format!("mcp-trace-budget-test-{}", std::process::id()));
        let project = tmp.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-budget.jsonl")).unwrap();
        let uses: Vec<_> = (0..12)
            .map(|i| {
                serde_json::json!({
                    "type": "tool_use", "id": format!("call-{i}"), "name": "mcp__fixture__test"
                })
            })
            .collect();
        let results: Vec<_> = (0..12)
            .map(|i| {
                serde_json::json!({
                    "type": "tool_result", "tool_use_id": format!("call-{i}"), "content": "中\\\"".repeat(100)
                })
            })
            .collect();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-1", "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": uses}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-1", "type": "user", "timestamp": "2026-01-01T00:00:01Z",
                "message": {"content": results}
            })
        )
        .unwrap();
        let response = trace(
            &Config {
                projects_dir: tmp.clone(),
            },
            TraceParams {
                r#ref: "session-:1".to_string(),
                before: Some(0),
                after: Some(1),
                project: Some("project".to_string()),
                source: None,
                max_content: 200,
                max_total: 900,
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
                overwrite: false,
                redaction: RedactionMode::Auto,
            },
        )
        .unwrap();
        assert_eq!(response.truncated, Some(true));
        assert!(response.messages.iter().any(|msg| msg.is_anchor == Some(true)));
        assert!(serde_json::to_vec(&response).unwrap().len() <= 900);
        fs::remove_dir_all(tmp).unwrap();
    }
}

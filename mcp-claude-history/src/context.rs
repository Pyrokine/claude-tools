use crate::config::Config;
use crate::get::{OutputTransaction, find_session_file, resolve_output_files};
use crate::search::{MAX_CONTENT_LIMIT, MAX_TOTAL_LIMIT, MIN_CONTENT_LIMIT, MIN_TOTAL_LIMIT};
use crate::types::*;
use crate::utils::*;
#[cfg(test)]
use std::fs::{self, File};
use std::io::Write;

/// Context 参数
pub struct ContextParams {
    pub r#ref: String,
    pub before: Option<usize>,
    pub after: Option<usize>,
    pub until_type: Option<String>,
    /// 截止到另一个 ref（session:line），after 扩展到该 ref 的行
    pub until_ref: Option<String>,
    pub direction: String,
    pub project: Option<String>,
    pub source: Option<String>,
    pub types: Vec<String>,
    pub subtypes: Vec<String>,
    pub max_content: usize,
    pub max_total: usize,
    /// 内容过滤 pattern（before/after 只计数匹配的消息）
    pub pattern: Option<String>,
    pub regex: bool,
    pub case_sensitive: bool,
    /// 导出到文件，支持 tmp: / cwd: 前缀
    pub output: Option<String>,
    pub overwrite: bool,
    pub redaction: RedactionMode,
}

impl Default for ContextParams {
    fn default() -> Self {
        Self {
            r#ref: String::new(),
            before: None,
            after: None,
            until_type: None,
            until_ref: None,
            direction: "forward".to_string(),
            project: None,
            source: None,
            types: vec![],
            subtypes: vec![],
            max_content: 4000,
            max_total: 40000,
            pattern: None,
            regex: false,
            case_sensitive: false,
            output: None,
            overwrite: false,
            redaction: RedactionMode::Auto,
        }
    }
}

/// 获取上下文
pub fn context(config: &Config, params: ContextParams) -> Result<ContextResponse, ErrorResponse> {
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
    // 解析 ref
    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    // 查找 session 文件
    let (_project_id, session_id, path) = find_session_file(
        config,
        &parsed_ref.session_prefix,
        params.project.as_deref(),
        params.source.as_deref(),
    )?;

    let prefix = ref_prefix(&session_id);
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
            before: params.before.unwrap_or(0),
            after: params.after.or_else(|| params.before.map(|_| 0)),
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
    let window = load_session_window(&path, &index, params.redaction)?;
    // 构建结果
    let mut messages = Vec::new();
    let mut truncated_by_content = false;

    for (idx, msg) in window.iter().enumerate() {
        let is_anchor = idx == anchor_idx;
        if !is_anchor
            && (!message_type_matches(msg.effective_type, &params.types)
                || !message_subtype_matches(msg.subtype, &params.subtypes))
        {
            continue;
        }
        // pattern 过滤（anchor 消息始终保留）
        let pattern_ok = !content_filter.has_filter() || content_filter.matches(&msg.content);
        if !is_anchor && !pattern_ok {
            continue;
        }

        let (truncated_content, was_truncated) = truncate_content(&msg.content, params.max_content);
        truncated_by_content |= was_truncated;
        messages.push(ContextMessage {
            r#ref: format!("{}:{}", prefix, msg.line_num),
            r#type: msg.effective_type.to_string(),
            subtype: msg.subtype.to_string(),
            content: truncated_content,
            is_anchor: if is_anchor { Some(true) } else { None },
        });
    }

    parameter_warnings.extend(index.warnings);
    let mut response = ContextResponse {
        anchor_ref: params.r#ref.clone(),
        messages,
        truncated: truncated_by_content.then_some(true),
        warnings: parameter_warnings,
        output_path: None,
        output: None,
    };

    // output 参数：把所有消息文本导出到文件
    if let Some(output_dir_raw) = params.output {
        let safe_ref = params.r#ref.replace([':', '/'], "_");
        let output = resolve_output_files(
            &output_dir_raw,
            &format!("{safe_ref}_context.txt"),
            &format!("{safe_ref}_context_manifest.json"),
        )?;
        let retention = output.temp_output.then(|| TEMP_OUTPUT_RETENTION.to_string());
        let transaction = OutputTransaction::begin(output, params.overwrite)?;
        let out_path = transaction.content();
        let manifest_path = transaction.manifest();
        let mut file = open_private_output_file(&transaction.staging_content())?;
        let (written_messages, redacted_count) = write_filtered_message_export(
            &mut file,
            &prefix,
            window.iter().enumerate().map(|(offset, msg)| {
                (
                    offset,
                    ExportMessage {
                        line_num: msg.line_num,
                        effective_type: msg.effective_type,
                        subtype: msg.subtype,
                        content: &msg.content,
                        redacted_count: msg.redacted_count,
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
        file.sync_all().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 context 输出失败: {e}"),
            available: None,
        })?;
        let bytes = file
            .metadata()
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("无法获取 context 导出大小: {e}"),
                available: None,
            })?
            .len();
        let redaction = redaction_info(
            params.redaction,
            redacted_count,
            params.redaction == RedactionMode::Off || redacted_count > 0,
        );
        let manifest = serde_json::json!({
            "schema": "mcp-claude-history.context-output.v2",
            "anchor_ref": response.anchor_ref,
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
            message: format!("无法序列化 context manifest: {e}"),
            available: None,
        })?;
        manifest_file.write_all(&manifest_bytes).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("写入 context manifest 失败: {e}"),
            available: None,
        })?;
        manifest_file.sync_all().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法同步 context manifest: {e}"),
            available: None,
        })?;
        response.output_path = Some(out_path.clone());
        response.output = Some(OutputInfo {
            content: out_path,
            manifest: manifest_path,
            images: Vec::new(),
            bytes,
            lines: written_messages,
            schema: "mcp-claude-history.context-output.v2".to_string(),
            complete: index.incomplete_reasons.is_empty(),
            sample_kind: "selected_range".to_string(),
            redaction,
            retention,
        });
        budget_context_response(&mut response, params.max_total)?;
        transaction.publish()?;
        return Ok(response);
    }

    budget_context_response(&mut response, params.max_total)?;
    Ok(response)
}

fn budget_context_response(response: &mut ContextResponse, max_total: usize) -> Result<(), ErrorResponse> {
    loop {
        let bytes = serde_json::to_vec(response)
            .map_err(|e| invalid_arguments(format!("序列化 context 失败: {e}")))?
            .len();
        if bytes <= max_total {
            return Ok(());
        }
        if let Some(position) = response
            .messages
            .iter()
            .rposition(|message| message.is_anchor != Some(true))
        {
            response.messages.remove(position);
            response.truncated = Some(true);
        } else {
            return Err(ErrorResponse {
                error: "response_too_large".to_string(),
                message: format!("context 响应超过 max_total={max_total} 字节；请增大预算或缩小范围"),
                available: Some(serde_json::json!({"serialized_bytes": bytes, "max_total_bytes": max_total})),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::process;

    #[test]
    fn legal_non_message_records_do_not_count_as_parse_errors() {
        let tmp = env::temp_dir().join(format!("mcp-context-record-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-context.jsonl")).unwrap();
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

        let response = context(
            &Config {
                projects_dir: tmp.clone(),
            },
            ContextParams {
                r#ref: "session-:4".to_string(),
                before: Some(0),
                after: Some(0),
                project: Some("project".to_string()),
                source: None,
                ..ContextParams::default()
            },
        )
        .unwrap();

        assert_eq!(response.messages.len(), 1);
        assert_eq!(response.warnings, ["解析 JSONL 时跳过 2 行"]);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn conflicting_context_selectors_fail_before_ref_resolution() {
        let error = context(
            &Config {
                projects_dir: env::temp_dir(),
            },
            ContextParams {
                r#ref: "invalid".to_string(),
                before: Some(0),
                until_type: Some("user".to_string()),
                ..ContextParams::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.error, "invalid_arguments");
        assert!(error.message.contains("不能和 before/after 同时传入"));
    }

    #[test]
    fn per_message_truncation_is_reported() {
        let tmp = env::temp_dir().join(format!("mcp-context-truncation-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-context-truncation.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-1",
                "type": "user",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": "FIVE"}
            })
        )
        .unwrap();

        let response = context(
            &Config {
                projects_dir: tmp.clone(),
            },
            ContextParams {
                r#ref: "session-:1".to_string(),
                before: Some(0),
                after: Some(0),
                project: Some("project".to_string()),
                source: None,
                max_content: 1,
                ..ContextParams::default()
            },
        )
        .unwrap();

        assert_eq!(response.messages[0].content, "F");
        assert_eq!(response.truncated, Some(true));
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn agent_until_ref_accepts_canonical_and_full_session_ids() {
        let tmp = env::temp_dir().join(format!("mcp-context-agent-ref-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        let sidechain_dir = project_dir.join("main-session").join("subagents");
        fs::create_dir_all(&sidechain_dir).unwrap();
        let session_id = "agent-12345678abcdef";
        let mut file = File::create(sidechain_dir.join(format!("{session_id}.jsonl"))).unwrap();
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
        let config = Config {
            projects_dir: tmp.clone(),
        };

        for (anchor, until) in [
            ("12345678:1".to_string(), "12345678:2".to_string()),
            (format!("{session_id}:1"), format!("{session_id}:2")),
        ] {
            let response = context(
                &config,
                ContextParams {
                    r#ref: anchor,
                    until_ref: Some(until),
                    project: Some("project".to_string()),
                    source: None,
                    ..ContextParams::default()
                },
            )
            .unwrap();
            assert_eq!(response.messages.len(), 2);
            assert_eq!(response.messages[1].r#ref, "12345678:2");
        }

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn context_budget_counts_full_json_metadata_and_retains_anchor() {
        let tmp = env::temp_dir().join(format!("mcp-context-budget-test-{}", process::id()));
        let project = tmp.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-budget.jsonl")).unwrap();
        for i in 0..8 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("user-{i}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "中\\\"".repeat(60)}
                })
            )
            .unwrap();
        }
        let response = context(
            &Config {
                projects_dir: tmp.clone(),
            },
            ContextParams {
                r#ref: "session-:6".to_string(),
                before: Some(5),
                after: Some(2),
                project: Some("project".to_string()),
                source: None,
                max_total: 700,
                ..ContextParams::default()
            },
        )
        .unwrap();
        assert_eq!(response.truncated, Some(true));
        assert!(response.messages.iter().any(|msg| msg.is_anchor == Some(true)));
        assert!(serde_json::to_vec(&response).unwrap().len() <= 700);
        fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn wide_context_window_fails_without_caching_entire_session() {
        let tmp = env::temp_dir().join(format!("mcp-context-window-test-{}", process::id()));
        let project = tmp.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-window.jsonl")).unwrap();
        for i in 0..=MAX_SESSION_WINDOW {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("user-{i}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "fixture"}
                })
            )
            .unwrap();
        }
        let error = context(
            &Config {
                projects_dir: tmp.clone(),
            },
            ContextParams {
                r#ref: "session-:1".to_string(),
                project: Some("project".to_string()),
                source: None,
                ..ContextParams::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.error, "session_window_limit");
        fs::remove_dir_all(tmp).unwrap();
    }
}

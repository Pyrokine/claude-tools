use crate::config::Config;
use crate::get::{find_session_file, resolve_output_files};
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};

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
            types: vec![],
            subtypes: vec![],
            max_content: 4000,
            max_total: 40000,
            pattern: None,
            regex: false,
            case_sensitive: false,
            output: None,
            redaction: RedactionMode::Auto,
        }
    }
}

/// 消息 + 分类信息
struct ClassifiedMessage {
    line_num: usize,
    effective_type: &'static str,
    subtype: &'static str,
    content: String,
    redacted_count: usize,
}

/// 获取上下文
pub fn context(config: &Config, params: ContextParams) -> Result<ContextResponse, ErrorResponse> {
    let content_filter = build_content_filter(&params.pattern, params.regex, params.case_sensitive)?;
    // 解析 ref
    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    // 查找 session 文件
    let (_project_id, session_id, path) =
        find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;

    // 读取文件
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {e}"),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let prefix = ref_prefix(&session_id);

    // 收集所有消息（带分类信息）
    let mut all_messages: Vec<ClassifiedMessage> = Vec::new();
    let mut anchor_idx = None;
    let mut read_errors = 0usize;
    let mut parse_errors = 0usize;

    for (line_num, line) in reader.lines().enumerate() {
        let line_num = line_num + 1; // 1-based
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
        all_messages.push(ClassifiedMessage {
            line_num,
            effective_type,
            subtype,
            content: redaction.text,
            redacted_count: redaction.count,
        });

        if line_num == parsed_ref.line {
            anchor_idx = Some(all_messages.len() - 1);
        }
    }

    let anchor_idx = anchor_idx.ok_or_else(|| ErrorResponse {
        error: "ref_not_found".to_string(),
        message: format!("ref 不存在: {}", params.r#ref),
        available: None,
    })?;

    // 确定上下文范围
    let (start_idx, end_idx) = if let Some(until_type) = &params.until_type {
        // until_type 模式：遇到指定类型就停止
        if params.direction == "backward" {
            let mut start = anchor_idx;
            for i in (0..anchor_idx).rev() {
                if all_messages[i].effective_type == until_type.as_str() {
                    start = i;
                    break;
                }
            }
            (start, anchor_idx + 1)
        } else {
            let mut end = anchor_idx + 1;
            for (i, msg) in all_messages.iter().enumerate().skip(anchor_idx + 1) {
                if msg.effective_type == until_type.as_str() {
                    end = i + 1;
                    break;
                }
            }
            (anchor_idx, end)
        }
    } else if let Some(ref end_ref_str) = params.until_ref {
        // until_ref 模式：从 anchor 到另一个 ref 的行（含）
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
        let end_pos = all_messages
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
        // before/after 模式：按匹配类型计数，after=None 且 before=None 时扩展到末尾
        let before = params.before.unwrap_or(0);
        let after_count = params.after;

        let mut start = anchor_idx;
        if before > 0 {
            let mut count = 0;
            for i in (0..anchor_idx).rev() {
                let type_ok = message_type_matches(all_messages[i].effective_type, &params.types)
                    && message_subtype_matches(all_messages[i].subtype, &params.subtypes);
                let pattern_ok = content_filter.matches(&all_messages[i].content);
                if type_ok && pattern_ok {
                    count += 1;
                    start = i;
                    if count >= before {
                        break;
                    }
                }
            }
        }

        let mut end = anchor_idx + 1;
        if let Some(after) = after_count {
            if after > 0 {
                let mut count = 0;
                for (i, msg) in all_messages.iter().enumerate().skip(anchor_idx + 1) {
                    let type_ok = message_type_matches(msg.effective_type, &params.types)
                        && message_subtype_matches(msg.subtype, &params.subtypes);
                    let pattern_ok = content_filter.matches(&msg.content);
                    if type_ok && pattern_ok {
                        count += 1;
                        end = i + 1;
                        if count >= after {
                            break;
                        }
                    }
                }
            }
        } else if params.before.is_none() {
            // before 和 after 都未指定时扩展到末尾（direction=forward 默认行为）
            end = all_messages.len();
        }

        (start, end)
    };

    // 构建结果
    let mut messages = Vec::new();
    let mut total_chars = 0;
    let mut truncated_by_total = false;

    for (i, msg) in all_messages.iter().enumerate().take(end_idx).skip(start_idx) {
        let is_anchor = i == anchor_idx;
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

        let (truncated_content, _) = truncate_content(&msg.content, params.max_content);
        let truncated_len = truncated_content.chars().count();

        if total_chars + truncated_len > params.max_total {
            truncated_by_total = true;
            break;
        }
        total_chars += truncated_len;

        messages.push(ContextMessage {
            r#ref: format!("{}:{}", prefix, msg.line_num),
            r#type: msg.effective_type.to_string(),
            subtype: msg.subtype.to_string(),
            content: truncated_content,
            is_anchor: if is_anchor { Some(true) } else { None },
        });
    }

    let warnings = jsonl_read_warnings(read_errors, parse_errors);
    let response = ContextResponse {
        anchor_ref: params.r#ref.clone(),
        messages,
        truncated: if truncated_by_total { Some(true) } else { None },
        warnings,
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
            all_messages
                .iter()
                .enumerate()
                .take(end_idx)
                .skip(start_idx)
                .map(|(idx, msg)| {
                    (
                        idx,
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
        file.flush().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 context 输出失败: {e}"),
            available: None,
        })?;
        let bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let redaction = redaction_info(
            params.redaction,
            redacted_count,
            params.redaction == RedactionMode::Off || redacted_count > 0,
        );
        let manifest = serde_json::json!({
            "schema": "mcp-claude-history.context-output.v1",
            "anchor_ref": response.anchor_ref,
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
                message: format!("写入 context manifest 失败: {e}"),
                available: None,
            })?;
        return Ok(ContextResponse {
            anchor_ref: response.anchor_ref,
            messages: response.messages,
            truncated: response.truncated,
            warnings: response.warnings,
            output_path: Some(out_path.clone()),
            output: Some(OutputInfo {
                content: out_path,
                manifest: manifest_path,
                images: Vec::new(),
                bytes,
                lines: written_messages,
                schema: "mcp-claude-history.context-output.v1".to_string(),
                complete: true,
                sample_kind: "selected_range".to_string(),
                redaction,
            }),
        });
    }

    Ok(response)
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
                ..ContextParams::default()
            },
        )
        .unwrap();

        assert_eq!(response.messages.len(), 1);
        assert_eq!(response.warnings, ["解析 JSONL 时跳过 2 行"]);
        fs::remove_dir_all(&tmp).ok();
    }
}

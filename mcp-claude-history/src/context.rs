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

/// 检查消息类型是否匹配
fn matches_types(effective_type: &str, types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|t| t == effective_type)
}

fn matches_subtypes(subtype: &str, subtypes: &[String]) -> bool {
    subtypes.is_empty() || subtypes.iter().any(|t| t == subtype)
}

/// 检查消息内容是否匹配 pattern
fn matches_pattern(
    content: &str,
    pattern: &Option<Regex>,
    plain_pattern: &Option<String>,
    case_sensitive: bool,
) -> bool {
    if let Some(re) = pattern {
        return re.is_match(content);
    }
    if let Some(p) = plain_pattern {
        if case_sensitive {
            return content.contains(p.as_str());
        }
        // plain_pattern 在 case-insensitive 时已预先 to_lowercase，直接比较
        return content.to_lowercase().contains(p.as_str());
    }
    true // 无 pattern 时匹配所有
}

/// 获取上下文
pub fn context(config: &Config, params: ContextParams) -> Result<ContextResponse, ErrorResponse> {
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
    // case-insensitive 时预先 to_lowercase，避免每次调用 matches_pattern 时重复分配
    let plain_pattern: Option<String> = if params.pattern.is_some() && !params.regex {
        if params.case_sensitive {
            params.pattern.clone()
        } else {
            params.pattern.as_ref().map(|p| p.to_lowercase())
        }
    } else {
        None
    };
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
        message: format!("无法打开文件: {}", e),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let prefix = ref_prefix(&session_id);

    // 收集所有消息（带分类信息）
    let mut all_messages: Vec<ClassifiedMessage> = Vec::new();
    let mut anchor_idx = None;

    for (line_num, line) in reader.lines().enumerate() {
        let line_num = line_num + 1; // 1-based
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
        let end_pos = all_messages
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
        // before/after 模式：按匹配类型计数，after=None 且 before=None 时扩展到末尾
        let before = params.before.unwrap_or(0);
        let after_count = params.after;

        let mut start = anchor_idx;
        if before > 0 {
            let mut count = 0;
            for i in (0..anchor_idx).rev() {
                let type_ok = matches_types(all_messages[i].effective_type, &params.types)
                    && matches_subtypes(all_messages[i].subtype, &params.subtypes);
                let pattern_ok = matches_pattern(
                    &all_messages[i].content,
                    &compiled_regex,
                    &plain_pattern,
                    params.case_sensitive,
                );
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
                    let type_ok = matches_types(msg.effective_type, &params.types)
                        && matches_subtypes(msg.subtype, &params.subtypes);
                    let pattern_ok =
                        matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive);
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
            && (!matches_types(msg.effective_type, &params.types) || !matches_subtypes(msg.subtype, &params.subtypes))
        {
            continue;
        }
        // pattern 过滤（anchor 消息始终保留）
        let has_pattern_filter = compiled_regex.is_some() || plain_pattern.is_some();
        let pattern_ok = !has_pattern_filter
            || matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive);
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

    let response = ContextResponse {
        anchor_ref: params.r#ref.clone(),
        messages,
        truncated: if truncated_by_total { Some(true) } else { None },
        output_path: None,
        output: None,
    };

    // output 参数：把所有消息文本导出到文件
    if let Some(output_dir_raw) = params.output {
        let safe_ref = params.r#ref.replace([':', '/'], "_");
        let output = resolve_output_files(
            &output_dir_raw,
            &format!("{}_context.txt", safe_ref),
            &format!("{}_context_manifest.json", safe_ref),
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
        for (i, msg) in all_messages.iter().enumerate().take(end_idx).skip(start_idx) {
            let is_anchor = i == anchor_idx;
            if !is_anchor
                && (!matches_types(msg.effective_type, &params.types)
                    || !matches_subtypes(msg.subtype, &params.subtypes))
            {
                continue;
            }
            let has_pattern_filter = compiled_regex.is_some() || plain_pattern.is_some();
            if !is_anchor
                && has_pattern_filter
                && !matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive)
            {
                continue;
            }
            let anchor_mark = if is_anchor { " [anchor]" } else { "" };
            writeln!(
                file,
                "=== {}:{} {} {}{} ===",
                prefix, msg.line_num, msg.effective_type, msg.subtype, anchor_mark
            )
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写文件失败: {}", e),
                available: None,
            })?;
            writeln!(file, "{}", msg.content).map_err(|e| ErrorResponse {
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
            redacted_count += msg.redacted_count;
        }
        file.flush().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("刷新 context 输出失败: {}", e),
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
        let mut manifest_file = File::create(&manifest_path).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建 context manifest: {}", e),
            available: None,
        })?;
        set_private_permissions(&manifest_path, 0o600)?;
        manifest_file
            .write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入 context manifest 失败: {}", e),
                available: None,
            })?;
        return Ok(ContextResponse {
            anchor_ref: response.anchor_ref,
            messages: response.messages,
            truncated: response.truncated,
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

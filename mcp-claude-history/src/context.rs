use crate::config::Config;
use crate::get::find_session_file;
use crate::types::*;
use crate::utils::*;
use std::fs::File;
use std::io::{BufRead, BufReader};

/// Context 参数
pub struct ContextParams {
    pub r#ref: String,
    pub before: Option<usize>,
    pub after: Option<usize>,
    pub until_type: Option<String>,
    pub direction: String,
    pub project: Option<String>,
    pub types: Vec<String>,
    pub max_content: usize,
    pub max_total: usize,
}

impl Default for ContextParams {
    fn default() -> Self {
        Self {
            r#ref: String::new(),
            before: None,
            after: None,
            until_type: None,
            direction: "forward".to_string(),
            project: None,
            types: vec![],
            max_content: 4000,
            max_total: 40000,
        }
    }
}

/// 检查消息类型是否匹配
fn matches_types(msg_type: &str, types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|t| t == msg_type)
}

/// 获取上下文
pub fn context(config: &Config, params: ContextParams) -> Result<ContextResponse, ErrorResponse> {
    // 解析 ref
    let parsed_ref = ParsedRef::parse(&params.r#ref).ok_or_else(|| ErrorResponse {
        error: "ref_invalid".to_string(),
        message: format!("无效的 ref 格式: {}", params.r#ref),
        available: None,
    })?;

    // 查找 session 文件
    let (_project_id, session_id, path) = find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;

    // 读取文件
    let file = File::open(&path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法打开文件: {}", e),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let prefix = ref_prefix(&session_id);

    // 收集所有消息
    let mut all_messages: Vec<(usize, MessageRecord, String)> = Vec::new();
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

        let content = replace_images_with_placeholders(&record);
        all_messages.push((line_num, record, content));

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
            // 向前查找
            let mut start = anchor_idx;
            for i in (0..anchor_idx).rev() {
                if all_messages[i].1.msg_type == *until_type {
                    start = i;
                    break;
                }
            }
            (start, anchor_idx + 1)
        } else {
            // 向后查找
            let mut end = anchor_idx + 1;
            for i in (anchor_idx + 1)..all_messages.len() {
                if all_messages[i].1.msg_type == *until_type {
                    end = i + 1;
                    break;
                }
            }
            (anchor_idx, end)
        }
    } else {
        // before/after 模式：按匹配类型计数
        let before = params.before.unwrap_or(0);
        let after = params.after.unwrap_or(0);

        // 向前查找 before 条匹配类型的消息
        let mut start = anchor_idx;
        if before > 0 {
            let mut count = 0;
            for i in (0..anchor_idx).rev() {
                if matches_types(&all_messages[i].1.msg_type, &params.types) {
                    count += 1;
                    start = i;
                    if count >= before {
                        break;
                    }
                }
            }
        }

        // 向后查找 after 条匹配类型的消息
        let mut end = anchor_idx + 1;
        if after > 0 {
            let mut count = 0;
            for i in (anchor_idx + 1)..all_messages.len() {
                if matches_types(&all_messages[i].1.msg_type, &params.types) {
                    count += 1;
                    end = i + 1;
                    if count >= after {
                        break;
                    }
                }
            }
        }

        (start, end)
    };

    // 构建结果
    let mut messages = Vec::new();
    let mut total_chars = 0;
    let mut truncated_by_total = false;

    for i in start_idx..end_idx {
        let (line_num, record, content) = &all_messages[i];

        // 类型过滤（anchor 始终包含）
        let is_anchor = i == anchor_idx;
        if !is_anchor && !matches_types(&record.msg_type, &params.types) {
            continue;
        }

        let (truncated_content, _) = truncate_content(content, params.max_content);

        // max_total 限制
        if total_chars + truncated_content.len() > params.max_total {
            truncated_by_total = true;
            break;
        }
        total_chars += truncated_content.len();

        messages.push(ContextMessage {
            r#ref: format!("{}:{}", prefix, line_num),
            r#type: record.msg_type.clone(),
            content: truncated_content,
            is_anchor: if is_anchor { Some(true) } else { None },
        });
    }

    Ok(ContextResponse {
        anchor_ref: params.r#ref,
        messages,
        truncated: if truncated_by_total { Some(true) } else { None },
    })
}

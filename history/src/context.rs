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
    pub max_content: usize,
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
            max_content: 4000,
        }
    }
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
        // until_type 模式
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
        // before/after 模式
        let before = params.before.unwrap_or(0);
        let after = params.after.unwrap_or(0);
        let start = anchor_idx.saturating_sub(before);
        let end = (anchor_idx + after + 1).min(all_messages.len());
        (start, end)
    };

    // 构建结果
    let mut messages = Vec::new();
    for i in start_idx..end_idx {
        let (line_num, record, content) = &all_messages[i];
        let (truncated_content, _) = truncate_content(content, params.max_content);

        messages.push(ContextMessage {
            r#ref: format!("{}:{}", prefix, line_num),
            r#type: record.msg_type.clone(),
            content: truncated_content,
            is_anchor: if i == anchor_idx { Some(true) } else { None },
        });
    }

    Ok(ContextResponse {
        anchor_ref: params.r#ref,
        messages,
    })
}

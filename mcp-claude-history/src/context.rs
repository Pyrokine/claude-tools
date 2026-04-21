use crate::config::Config;
use crate::get::find_session_file;
use crate::types::*;
use crate::utils::*;
use regex::{Regex, RegexBuilder};
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
    /// 内容过滤 pattern（before/after 只计数匹配的消息）
    pub pattern: Option<String>,
    pub regex: bool,
    pub case_sensitive: bool,
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
            pattern: None,
            regex: false,
            case_sensitive: false,
        }
    }
}

/// 消息 + 分类信息
struct ClassifiedMessage {
    line_num: usize,
    effective_type: &'static str,
    subtype: &'static str,
    content: String,
}

/// 检查消息类型是否匹配
fn matches_types(effective_type: &str, types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|t| t == effective_type)
}

/// 检查消息内容是否匹配 pattern
fn matches_pattern(content: &str, pattern: &Option<Regex>, plain_pattern: &Option<String>, case_sensitive: bool) -> bool {
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
            match RegexBuilder::new(pat)
                .case_insensitive(!params.case_sensitive)
                .build()
            {
                Ok(r) => Some(r),
                Err(e) => return Err(ErrorResponse {
                    error: "invalid_regex".to_string(),
                    message: format!("无效的正则表达式: {}", e),
                    available: None,
                }),
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
    let (_project_id, session_id, path) = find_session_file(config, &parsed_ref.session_prefix, params.project.as_deref())?;

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
        let content = replace_images_with_placeholders(&record);
        all_messages.push(ClassifiedMessage {
            line_num,
            effective_type,
            subtype,
            content,
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
    } else {
        // before/after 模式：按匹配类型计数
        let before = params.before.unwrap_or(0);
        let after = params.after.unwrap_or(0);

        let mut start = anchor_idx;
        if before > 0 {
            let mut count = 0;
            for i in (0..anchor_idx).rev() {
                if matches_types(all_messages[i].effective_type, &params.types)
                    && matches_pattern(&all_messages[i].content, &compiled_regex, &plain_pattern, params.case_sensitive)
                {
                    count += 1;
                    start = i;
                    if count >= before {
                        break;
                    }
                }
            }
        }

        let mut end = anchor_idx + 1;
        if after > 0 {
            let mut count = 0;
            for (i, msg) in all_messages.iter().enumerate().skip(anchor_idx + 1) {
                if matches_types(msg.effective_type, &params.types)
                    && matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive)
                {
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

    for (i, msg) in all_messages.iter().enumerate().take(end_idx).skip(start_idx) {
        let is_anchor = i == anchor_idx;
        if !is_anchor && !matches_types(msg.effective_type, &params.types) {
            continue;
        }
        // pattern 过滤（anchor 消息始终保留）
        if !is_anchor && (compiled_regex.is_some() || plain_pattern.is_some())
            && !matches_pattern(&msg.content, &compiled_regex, &plain_pattern, params.case_sensitive)
        {
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

    Ok(ContextResponse {
        anchor_ref: params.r#ref,
        messages,
        truncated: if truncated_by_total { Some(true) } else { None },
    })
}

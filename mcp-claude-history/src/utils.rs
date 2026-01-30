use crate::types::{ImageInfo, MessageRecord};
use regex::Regex;

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
        if item.get("type").and_then(|t| t.as_str()) == Some("image") {
            if let Some(source) = item.get("source") {
                if let Some(data) = source.get("data").and_then(|d| d.as_str()) {
                    images.push(ImageInfo {
                        index: idx,
                        size: data.len(),
                    });
                }
            }
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

/// 将内容中的图片替换为占位符
pub fn replace_images_with_placeholders(record: &MessageRecord) -> String {
    let Some(message) = &record.message else {
        return String::new();
    };

    let Some(content) = message.get("content") else {
        return String::new();
    };

    if let Some(s) = content.as_str() {
        return s.to_string();
    }

    let Some(arr) = content.as_array() else {
        return String::new();
    };

    let mut result = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        if item.get("type").and_then(|t| t.as_str()) == Some("image") {
            if let Some(source) = item.get("source") {
                let size = source.get("data").and_then(|d| d.as_str()).map(|d| d.len()).unwrap_or(0);
                let size_mb = size as f64 / 1024.0 / 1024.0;
                result.push(format!("[IMAGE:{} size={:.1}MB]", idx, size_mb));
            }
        } else if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
            result.push(text.to_string());
        }
    }

    result.join("\n")
}

/// 截断内容到指定长度
pub fn truncate_content(content: &str, max_len: usize) -> (String, bool) {
    if content.len() <= max_len {
        (content.to_string(), false)
    } else {
        // 按字符边界截断
        let truncated: String = content.chars().take(max_len).collect();
        (truncated, true)
    }
}

/// 搜索词解析结果
#[derive(Debug)]
pub struct SearchPattern {
    pub must_have: Vec<String>,      // AND 条件
    pub any_of: Vec<Vec<String>>,    // OR 条件组
    pub must_not: Vec<String>,       // NOT 条件
}

/// 解析搜索词
/// 语法：
/// - 空格分隔 = AND
/// - | 分隔 = OR
/// - ! 前缀 = NOT
pub fn parse_search_pattern(pattern: &str) -> SearchPattern {
    let mut must_have = Vec::new();
    let mut any_of = Vec::new();
    let mut must_not = Vec::new();

    for word in pattern.split_whitespace() {
        if word.starts_with('!') {
            let word = &word[1..];
            if !word.is_empty() {
                must_not.push(word.to_lowercase());
            }
        } else if word.contains('|') {
            let or_words: Vec<String> = word.split('|')
                .filter(|w| !w.is_empty())
                .map(|w| w.to_lowercase())
                .collect();
            if !or_words.is_empty() {
                any_of.push(or_words);
            }
        } else {
            must_have.push(word.to_lowercase());
        }
    }

    SearchPattern { must_have, any_of, must_not }
}

/// 检查内容是否匹配搜索模式
pub fn matches_pattern(content: &str, pattern: &SearchPattern, case_sensitive: bool) -> bool {
    let content = if case_sensitive {
        content.to_string()
    } else {
        content.to_lowercase()
    };

    // 检查 must_have（AND）
    for word in &pattern.must_have {
        if !content.contains(word) {
            return false;
        }
    }

    // 检查 any_of（OR 组）
    for or_group in &pattern.any_of {
        let matched = or_group.iter().any(|word| content.contains(word));
        if !matched {
            return false;
        }
    }

    // 检查 must_not（NOT）
    for word in &pattern.must_not {
        if content.contains(word) {
            return false;
        }
    }

    true
}

/// 正则匹配
pub fn matches_regex(content: &str, regex: &Regex) -> bool {
    regex.is_match(content)
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

/// 比较时间
pub fn time_in_range(
    timestamp: &str,
    since: Option<&chrono::DateTime<chrono::Utc>>,
    until: Option<&chrono::DateTime<chrono::Utc>>,
) -> bool {
    let Some(ts) = parse_time(timestamp) else {
        return true; // 无法解析时间时不过滤
    };

    if let Some(since) = since {
        if ts < *since {
            return false;
        }
    }

    if let Some(until) = until {
        if ts > *until {
            return false;
        }
    }

    true
}

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
    session_id.chars().take(8).collect()
}

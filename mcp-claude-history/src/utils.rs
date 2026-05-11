use crate::types::{ImageInfo, MessageRecord};

/// 消息分类：(effective_type, subtype)
///
/// effective_type：修正后的类型（isCompactSummary 的 user → summary）
/// subtype：细粒度分类
///   user   → human / tool_result / meta
///   assistant → text / tool_use / thinking / empty
///   summary → summary
///   system → system
pub fn classify_message(record: &MessageRecord) -> (&'static str, &'static str) {
    match record.msg_type.as_str() {
        "user" => {
            if record.is_compact_summary {
                return ("summary", "summary");
            }
            if record.is_meta {
                return ("user", "meta");
            }
            if let Some(message) = &record.message {
                if let Some(content) = message.get("content") {
                    if content.is_string() {
                        return ("user", "human");
                    }
                    if let Some(arr) = content.as_array() {
                        if arr
                            .iter()
                            .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                        {
                            return ("user", "tool_result");
                        }
                    }
                }
            }
            ("user", "human")
        }
        "assistant" => {
            if let Some(message) = &record.message {
                if let Some(content) = message.get("content") {
                    // content 为字符串：纯文本回复
                    if let Some(s) = content.as_str() {
                        return if s.is_empty() {
                            ("assistant", "empty")
                        } else {
                            ("assistant", "text")
                        };
                    }
                    // content 为数组：优先级 text > tool_use > thinking > empty
                    if let Some(arr) = content.as_array() {
                        let has_text = arr.iter().any(|item| {
                            item.get("type").and_then(|t| t.as_str()) == Some("text")
                                && item.get("text").and_then(|t| t.as_str()).is_some_and(|s| !s.is_empty())
                        });
                        if has_text {
                            return ("assistant", "text");
                        }
                        if arr
                            .iter()
                            .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
                        {
                            return ("assistant", "tool_use");
                        }
                        if arr
                            .iter()
                            .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                        {
                            return ("assistant", "thinking");
                        }
                    }
                }
            }
            ("assistant", "empty")
        }
        "system" => ("system", "system"),
        // progress, file-history-snapshot 等内部类型，搜索时会被 types 过滤掉
        _ => ("other", "other"),
    }
}

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

/// 从 tool_result 内容字段中提取文本字符串
fn extract_tool_result_texts(item: &serde_json::Value) -> Vec<String> {
    let mut texts = Vec::new();
    if let Some(content) = item.get("content") {
        if let Some(s) = content.as_str() {
            texts.push(s.to_string());
        } else if let Some(sub_arr) = content.as_array() {
            for sub in sub_arr {
                if let Some(text) = sub.get("text").and_then(|t| t.as_str()) {
                    texts.push(text.to_string());
                }
            }
        }
    }
    texts
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
        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match item_type {
            "image" => {
                if let Some(source) = item.get("source") {
                    let size = source
                        .get("data")
                        .and_then(|d| d.as_str())
                        .map(|d| d.len())
                        .unwrap_or(0);
                    let size_mb = size as f64 / 1024.0 / 1024.0;
                    result.push(format!("[IMAGE:{} size={:.1}MB]", idx, size_mb));
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                let input = item.get("input").map(|i| i.to_string()).unwrap_or_default();
                let input_preview: String = input.chars().take(200).collect();
                result.push(format!("[TOOL_USE:{}({})]", name, input_preview));
            }
            "tool_result" => {
                result.extend(extract_tool_result_texts(item));
            }
            _ => {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    result.push(text.to_string());
                }
            }
        }
    }

    result.join("\n")
}

/// 一次遍历同时提取图片列表和带占位符的文本（避免 search.rs 中的双次遍历）
pub fn extract_and_replace_images(record: &MessageRecord) -> (String, Vec<ImageInfo>) {
    let Some(message) = &record.message else {
        return (String::new(), Vec::new());
    };
    let Some(content) = message.get("content") else {
        return (String::new(), Vec::new());
    };
    if let Some(s) = content.as_str() {
        return (s.to_string(), Vec::new());
    }
    let Some(arr) = content.as_array() else {
        return (String::new(), Vec::new());
    };

    let mut text_parts = Vec::new();
    let mut images = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match item_type {
            "image" => {
                if let Some(source) = item.get("source") {
                    let size = source
                        .get("data")
                        .and_then(|d| d.as_str())
                        .map(|d| d.len())
                        .unwrap_or(0);
                    let size_mb = size as f64 / 1024.0 / 1024.0;
                    text_parts.push(format!("[IMAGE:{} size={:.1}MB]", idx, size_mb));
                    images.push(ImageInfo { index: idx, size });
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
                let input = item.get("input").map(|i| i.to_string()).unwrap_or_default();
                let input_preview: String = input.chars().take(200).collect();
                text_parts.push(format!("[TOOL_USE:{}({})]", name, input_preview));
            }
            "tool_result" => {
                text_parts.extend(extract_tool_result_texts(item));
            }
            _ => {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text.to_string());
                }
            }
        }
    }

    (text_parts.join("\n"), images)
}

/// 返回字符串中第 n 个字符的 byte 偏移；越界则返回字符串总长度
fn nth_byte_or_end(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map(|(b, _)| b).unwrap_or(s.len())
}

/// 解析 ISO 8601 / RFC 3339 时间字符串为 UTC DateTime
pub fn parse_iso_utc(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// 截断内容到指定长度
pub fn truncate_content(content: &str, max_len: usize) -> (String, bool) {
    if content.chars().count() <= max_len {
        return (content.to_string(), false);
    }
    let byte_idx = nth_byte_or_end(content, max_len);
    (content[..byte_idx].to_string(), true)
}

/// 围绕匹配位置截断内容（grep -C 风格）
///
/// 匹配位置居中展示，前后各保留 max_len/2 的上下文
/// 无匹配位置信息时退化为从头截断
pub fn truncate_around_match(content: &str, match_pos: Option<usize>, max_len: usize) -> (String, bool) {
    // 用 chars().count() 单次扫描算字符数，避免预分配 Vec<usize>
    // （预分配在 100KB+ 内容上会消耗 ~800KB+ 临时内存）
    let char_count = content.chars().count();

    if char_count <= max_len {
        return (content.to_string(), false);
    }

    let Some(pos) = match_pos else {
        // 从头截断：用 nth 直接定位第 max_len 个字符的 byte 偏移
        return (content[..nth_byte_or_end(content, max_len)].to_string(), true);
    };

    let half = max_len / 2;
    let mut start = pos.saturating_sub(half);
    let end = (start + max_len).min(char_count);
    if end == char_count && char_count > max_len {
        start = char_count - max_len;
    }

    // 二次扫描定位 start/end 的 byte 偏移（O(N)、无内存分配）
    let start_byte = nth_byte_or_end(content, start);
    let end_byte = nth_byte_or_end(content, end);
    let mut result = content[start_byte..end_byte].to_string();

    if start > 0 {
        result = format!("...{}", result);
    }
    if end < char_count {
        result.push_str("...");
    }

    (result, true)
}

/// 搜索词解析结果
#[derive(Debug)]
pub struct SearchPattern {
    pub must_have: Vec<String>,   // AND 条件
    pub any_of: Vec<Vec<String>>, // OR 条件组
    pub must_not: Vec<String>,    // NOT 条件
}

/// 解析搜索词
/// 语法：
/// - 空格分隔 = AND
/// - | 分隔 = OR
/// - ! 前缀 = NOT
pub fn parse_search_pattern(pattern: &str, case_sensitive: bool) -> SearchPattern {
    let mut must_have = Vec::new();
    let mut any_of = Vec::new();
    let mut must_not = Vec::new();

    let normalize = |s: &str| {
        if case_sensitive {
            s.to_string()
        } else {
            s.to_lowercase()
        }
    };

    for word in pattern.split_whitespace() {
        if let Some(word) = word.strip_prefix('!') {
            if !word.is_empty() {
                must_not.push(normalize(word));
            }
        } else if word.contains('|') {
            let or_words: Vec<String> = word.split('|').filter(|w| !w.is_empty()).map(normalize).collect();
            if !or_words.is_empty() {
                any_of.push(or_words);
            }
        } else {
            must_have.push(normalize(word));
        }
    }

    SearchPattern {
        must_have,
        any_of,
        must_not,
    }
}

/// 检查内容是否匹配搜索模式
pub fn matches_pattern(content: &str, pattern: &SearchPattern, case_sensitive: bool) -> (bool, Option<usize>) {
    if case_sensitive {
        // must_have（AND）
        for word in &pattern.must_have {
            if !content.contains(word) {
                return (false, None);
            }
        }

        // must_not（NOT）
        for word in &pattern.must_not {
            if content.contains(word) {
                return (false, None);
            }
        }

        // any_of（OR 组）
        let mut match_pos = pattern
            .must_have
            .first()
            .and_then(|w| content.find(w))
            .map(|byte_pos| content[..byte_pos].chars().count());

        for or_group in &pattern.any_of {
            let mut group_pos: Option<usize> = None;
            for word in or_group {
                if let Some(byte_pos) = content.find(word.as_str()) {
                    group_pos = Some(content[..byte_pos].chars().count());
                    break;
                }
            }
            if group_pos.is_none() {
                return (false, None);
            }
            if match_pos.is_none() {
                match_pos = group_pos;
            }
        }

        return (true, match_pos);
    }

    // case-insensitive：构造小写内容 + 小写字符索引到原文字符索引的映射
    // 预分配 capacity（按字节上界），避免热路径多次 Vec/String grow 抖动
    let mut lower = String::with_capacity(content.len());
    let mut map: Vec<usize> = Vec::with_capacity(content.len());
    for (orig_idx, ch) in content.chars().enumerate() {
        for lc in ch.to_lowercase() {
            lower.push(lc);
            map.push(orig_idx);
        }
    }

    let find_pos = |word: &str| -> Option<usize> {
        let byte_pos = lower.find(word)?;
        let lower_char_pos = lower[..byte_pos].chars().count();
        map.get(lower_char_pos).copied()
    };

    // must_have（AND）：单次 find，既判断存在又获取位置
    let mut first_must_pos: Option<usize> = None;
    for word in &pattern.must_have {
        match find_pos(word) {
            None => return (false, None),
            Some(pos) => {
                if first_must_pos.is_none() {
                    first_must_pos = Some(pos);
                }
            }
        }
    }

    // must_not（NOT）
    for word in &pattern.must_not {
        if lower.contains(word) {
            return (false, None);
        }
    }

    // any_of（OR 组）：单次 find，既判断存在又获取位置
    let mut match_pos = first_must_pos;

    for or_group in &pattern.any_of {
        let mut group_pos: Option<usize> = None;
        for word in or_group {
            if let Some(pos) = find_pos(word) {
                group_pos = Some(pos);
                break;
            }
        }
        if group_pos.is_none() {
            return (false, None);
        }
        if match_pos.is_none() {
            match_pos = group_pos;
        }
    }

    (true, match_pos)
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
    // agent 子会话文件名为 "agent-<id>.jsonl"，前缀固定会导致 ref_prefix 冲突率过高
    let normalized = session_id.strip_prefix("agent-").unwrap_or(session_id);
    normalized.chars().take(8).collect()
}

/// 解析 "start-end" 格式的范围字符串
pub fn parse_range(s: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 2 {
        let start = parts[0].parse().ok()?;
        let end = parts[1].parse().ok()?;
        Some((start, end))
    } else {
        None
    }
}

/// 将项目 ID 还原为可读路径（仅用于展示）
/// Linux:   -home-py-CLion-dev → /home/py/CLion/dev
/// Windows: D--Prog-python-harvester → D:/Prog/python/harvester
pub fn project_id_to_display_path(id: &str) -> String {
    // Windows 格式启发式检测：以大写字母开头 + "--"（原始为 "盘符:-"，: 和 / 都变成了 -）
    // 注意：这是 best-effort 启发式，含 "--" 前缀的非常规 Linux 路径可能误判，影响仅限展示
    if id.len() >= 3 && id.as_bytes()[0].is_ascii_alphabetic() && id[1..].starts_with("--") {
        let drive = &id[..1];
        let rest = &id[3..]; // 跳过 "X--"
        return format!("{}:/{}", drive, rest.replace('-', "/"));
    }
    // Linux/Mac 格式：以 "-" 开头
    // 例如 "-home-py-CLion-dev" → "/home/py/CLion/dev"
    id.replace('-', "/")
}

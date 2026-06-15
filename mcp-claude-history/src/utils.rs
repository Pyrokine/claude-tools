use crate::types::{ImageInfo, MessageRecord, RedactionInfo, ToolInfo};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum RedactionMode {
    #[default]
    Auto,
    Off,
    Strict,
}

impl RedactionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
            Self::Strict => "strict",
        }
    }

    pub fn enabled(self) -> bool {
        self != Self::Off
    }
}

pub fn parse_redaction_mode_param(value: &str) -> Result<RedactionMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => Ok(RedactionMode::Auto),
        "off" | "none" | "raw" => Ok(RedactionMode::Off),
        "strict" => Ok(RedactionMode::Strict),
        other => Err(format!("redaction 仅支持 auto、off、strict，收到 {}", other)),
    }
}

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
            if let Some(message) = &record.message
                && let Some(content) = message.get("content")
            {
                if content.is_string() {
                    return ("user", "human");
                }
                if let Some(arr) = content.as_array()
                    && arr
                        .iter()
                        .any(|item| item.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                {
                    return ("user", "tool_result");
                }
            }
            ("user", "human")
        }
        "assistant" => {
            if let Some(message) = &record.message
                && let Some(content) = message.get("content")
            {
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
        if item.get("type").and_then(|t| t.as_str()) == Some("image")
            && let Some(source) = item.get("source")
            && let Some(data) = source.get("data").and_then(|d| d.as_str())
        {
            images.push(ImageInfo {
                index: idx,
                size: data.len(),
            });
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
    replace_images_with_placeholders_with_mode(record, RedactionMode::Auto)
}

pub fn replace_images_with_placeholders_with_mode(record: &MessageRecord, mode: RedactionMode) -> String {
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
                let input_preview = item
                    .get("input")
                    .map(|i| value_preview(i, 200, mode))
                    .unwrap_or_default();
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
pub fn extract_and_replace_images_with_mode(record: &MessageRecord, mode: RedactionMode) -> (String, Vec<ImageInfo>) {
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
                let input_preview = item
                    .get("input")
                    .map(|i| value_preview(i, 200, mode))
                    .unwrap_or_default();
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

pub fn parse_time_param(s: &str, name: &str) -> Result<chrono::DateTime<chrono::Utc>, String> {
    parse_time(s).ok_or_else(|| format!("{} 必须是 RFC3339 或 YYYY-MM-DD 格式", name))
}

pub fn parse_range_param(s: &str) -> Result<(usize, usize), String> {
    let Some((start, end)) = parse_range(s) else {
        return Err("range 必须是 start-end 格式，例如 0-100000".to_string());
    };
    if start > end {
        return Err(format!("range start({}) 大于 end({})", start, end));
    }
    Ok((start, end))
}

#[derive(Debug, Clone)]
pub struct MessageSlice {
    pub raw: String,
    pub start: Option<isize>,
    pub end: Option<isize>,
}

impl MessageSlice {
    pub fn needs_full_scan(&self) -> bool {
        self.start.is_some_and(|v| v < 0) || self.end.is_none_or(|v| v < 0)
    }

    pub fn positive_end(&self) -> Option<usize> {
        self.end.and_then(|v| usize::try_from(v).ok())
    }
}

pub fn parse_message_slice_param(s: &str) -> Result<MessageSlice, String> {
    let raw = s.trim();
    let body = raw
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(raw)
        .trim();

    if body.is_empty() || body.matches(':').count() != 1 {
        return Err("slice 必须是 [start:end] 格式，例如 [-10:] 或 [-10:-1]，不支持 step".to_string());
    }

    let (start_raw, end_raw) = body.split_once(':').expect("slice colon count checked");
    let parse_bound = |part: &str, name: &str| -> Result<Option<isize>, String> {
        let value = part.trim();
        if value.is_empty() {
            return Ok(None);
        }
        value
            .parse::<isize>()
            .map(Some)
            .map_err(|_| format!("slice {} 不是有效整数: {}", name, value))
    };

    Ok(MessageSlice {
        raw: raw.to_string(),
        start: parse_bound(start_raw, "start")?,
        end: parse_bound(end_raw, "end")?,
    })
}

pub fn normalize_message_slice(slice: &MessageSlice, len: usize) -> (usize, usize) {
    fn normalize(bound: Option<isize>, default: usize, len: usize) -> usize {
        let raw = bound.unwrap_or(default as isize);
        let value = if raw < 0 { len as isize + raw } else { raw };
        value.clamp(0, len as isize) as usize
    }

    let start = normalize(slice.start, 0, len);
    let end = normalize(slice.end, len, len);
    if end < start { (start, start) } else { (start, end) }
}

pub fn parse_line_ranges_param(s: &str) -> Result<Vec<crate::types::Range>, String> {
    let mut ranges = Vec::new();
    for part in s.split(',') {
        let raw = part.trim();
        if raw.is_empty() {
            continue;
        }
        let exclude = raw.starts_with('!');
        let value = if exclude { &raw[1..] } else { raw };
        if value.is_empty() {
            return Err(format!("无效的 lines 片段: {}", raw));
        }
        if value.contains('-') {
            let pieces: Vec<&str> = value.splitn(2, '-').collect();
            let start = if pieces[0].is_empty() {
                None
            } else {
                Some(
                    pieces[0]
                        .parse::<usize>()
                        .map_err(|_| format!("无效的 lines 起点: {}", raw))?,
                )
            };
            let end = if pieces.len() < 2 || pieces[1].is_empty() {
                None
            } else {
                Some(
                    pieces[1]
                        .parse::<usize>()
                        .map_err(|_| format!("无效的 lines 终点: {}", raw))?,
                )
            };
            if let (Some(start), Some(end)) = (start, end)
                && start > end
            {
                return Err(format!("lines 起点大于终点: {}", raw));
            }
            ranges.push(crate::types::Range { start, end, exclude });
        } else {
            let line = value
                .parse::<usize>()
                .map_err(|_| format!("无效的 lines 行号: {}", raw))?;
            ranges.push(crate::types::Range {
                start: Some(line),
                end: Some(line),
                exclude,
            });
        }
    }
    Ok(ranges)
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

    if let Some(since) = since
        && ts < *since
    {
        return false;
    }

    if let Some(until) = until
        && ts > *until
    {
        return false;
    }

    true
}

pub const SIDECHAIN_SESSION_DIRS: &[&str] = &["subagents", "remote-agents"];

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

pub fn parse_mcp_tool_name(name: &str) -> ToolInfo {
    let mut parts = name.splitn(3, "__");
    let first = parts.next();
    let second = parts.next();
    let third = parts.next();
    if let (Some(prefix), Some(server), Some(tool)) = (first, second, third)
        && prefix == "mcp"
    {
        return ToolInfo {
            server: Some(server.to_string()),
            tool: Some(tool.to_string()),
        };
    }
    ToolInfo {
        server: None,
        tool: Some(name.to_string()),
    }
}

fn value_preview(value: &serde_json::Value, max_chars: usize, mode: RedactionMode) -> String {
    let redacted = redact_value_with_mode(value, mode).to_string();
    redacted.chars().take(max_chars).collect()
}

pub struct TextRedaction {
    pub text: String,
    pub count: usize,
}

pub fn redact_text_with_mode(text: &str, mode: RedactionMode) -> TextRedaction {
    static AUTH_HEADER_RE: OnceLock<Regex> = OnceLock::new();
    static COOKIE_HEADER_RE: OnceLock<Regex> = OnceLock::new();
    static SECRET_FIELD_RE: OnceLock<Regex> = OnceLock::new();
    static QUERY_SECRET_RE: OnceLock<Regex> = OnceLock::new();
    static PRIVATE_KEY_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static PRIVATE_HOST_RE: OnceLock<Regex> = OnceLock::new();
    static INTERNAL_URL_RE: OnceLock<Regex> = OnceLock::new();

    if mode == RedactionMode::Off {
        return TextRedaction {
            text: text.to_string(),
            count: 0,
        };
    }

    let mut count = 0usize;
    let result = AUTH_HEADER_RE
        .get_or_init(|| Regex::new(r"(?i)\b(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+").expect("valid regex"))
        .replace_all(text, |caps: &regex::Captures<'_>| {
            count += 1;
            format!("{}[redacted]", &caps[1])
        });
    let result = SECRET_FIELD_RE
        .get_or_init(|| {
            Regex::new(
                r#"(?i)\b((?:password|passwd|pwd|token|cookie|api[_-]?key|secret|private[_-]?key|keypath|key_path)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)"#,
            )
            .expect("valid regex")
        })
        .replace_all(&result, |caps: &regex::Captures<'_>| {
            count += 1;
            format!("{}[redacted]", &caps[1])
        });
    let result = QUERY_SECRET_RE
        .get_or_init(|| {
            Regex::new(r"(?i)([?&](?:password|token|api[_-]?key|secret|key)=)[^&\s]+").expect("valid regex")
        })
        .replace_all(&result, |caps: &regex::Captures<'_>| {
            count += 1;
            format!("{}[redacted]", &caps[1])
        });

    if mode != RedactionMode::Strict {
        return TextRedaction {
            text: result.into_owned(),
            count,
        };
    }

    let result = COOKIE_HEADER_RE
        .get_or_init(|| Regex::new(r"(?i)\b(cookie\s*[:=]\s*)[^\n\r]+").expect("valid regex"))
        .replace_all(&result, |caps: &regex::Captures<'_>| {
            count += 1;
            format!("{}[redacted]", &caps[1])
        });
    let result = PRIVATE_KEY_BLOCK_RE
        .get_or_init(|| {
            Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
                .expect("valid regex")
        })
        .replace_all(&result, |_: &regex::Captures<'_>| {
            count += 1;
            "[redacted-private-key]".to_string()
        });
    let result = PRIVATE_HOST_RE
        .get_or_init(|| {
            Regex::new(
                r"\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b",
            )
            .expect("valid regex")
        })
        .replace_all(&result, |_: &regex::Captures<'_>| {
            count += 1;
            "[redacted-host]".to_string()
        });
    let text = INTERNAL_URL_RE
        .get_or_init(|| Regex::new(r#"https?://[^\s"'<>]+"#).expect("valid regex"))
        .replace_all(&result, |_: &regex::Captures<'_>| {
            count += 1;
            "[redacted-url]".to_string()
        })
        .into_owned();

    TextRedaction { text, count }
}

pub fn redaction_info(mode: RedactionMode, redacted_count: usize, raw_available: bool) -> RedactionInfo {
    RedactionInfo {
        mode: mode.as_str().to_string(),
        enabled: mode.enabled(),
        rules: redaction_rules(mode),
        redacted_count,
        raw_available,
    }
}

fn redaction_rules(mode: RedactionMode) -> Vec<String> {
    match mode {
        RedactionMode::Off => Vec::new(),
        RedactionMode::Auto => vec![
            "password".to_string(),
            "token".to_string(),
            "cookie".to_string(),
            "authorization".to_string(),
            "key".to_string(),
            "privatekey".to_string(),
            "keypath".to_string(),
        ],
        RedactionMode::Strict => vec![
            "password".to_string(),
            "token".to_string(),
            "cookie".to_string(),
            "authorization".to_string(),
            "key".to_string(),
            "privatekey".to_string(),
            "keypath".to_string(),
            "private_host".to_string(),
            "url".to_string(),
        ],
    }
}

fn redact_value_with_mode(value: &serde_json::Value, mode: RedactionMode) -> serde_json::Value {
    if mode == RedactionMode::Off {
        return value.clone();
    }

    match value {
        serde_json::Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, item) in map {
                let lower = key.to_lowercase();
                if is_sensitive_key(&lower, mode) {
                    redacted.insert(key.clone(), serde_json::Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key.clone(), redact_value_with_mode(item, mode));
                }
            }
            serde_json::Value::Object(redacted)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|item| redact_value_with_mode(item, mode)).collect())
        }
        serde_json::Value::String(text) => serde_json::Value::String(redact_text_with_mode(text, mode).text),
        _ => value.clone(),
    }
}

fn is_sensitive_key(lower_key: &str, mode: RedactionMode) -> bool {
    lower_key.contains("password")
        || lower_key.contains("token")
        || lower_key.contains("cookie")
        || lower_key.contains("authorization")
        || lower_key == "key"
        || lower_key.ends_with("key")
        || lower_key.contains("privatekey")
        || lower_key.contains("keypath")
        || lower_key.contains("key_path")
        || (mode == RedactionMode::Strict
            && (lower_key.contains("host")
                || lower_key.contains("url")
                || lower_key.contains("endpoint")
                || lower_key.contains("domain")))
}

pub struct StructuredToolData {
    pub input: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub result_is_error: Option<bool>,
    pub raw_available: bool,
    pub redacted: bool,
}

pub fn extract_structured_tool_data_with_mode(record: &MessageRecord, mode: RedactionMode) -> StructuredToolData {
    let Some(message) = &record.message else {
        return StructuredToolData {
            input: None,
            result: None,
            result_is_error: None,
            raw_available: false,
            redacted: false,
        };
    };
    let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
        return StructuredToolData {
            input: None,
            result: None,
            result_is_error: None,
            raw_available: false,
            redacted: false,
        };
    };

    let mut input = None;
    let mut result = None;
    let mut result_is_error = None;
    for item in content {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("tool_use") => {
                if let Some(raw_input) = item.get("input") {
                    input = Some(redact_value_with_mode(raw_input, mode));
                }
            }
            Some("tool_result") => {
                result = Some(redact_value_with_mode(item, mode));
                result_is_error = item.get("is_error").and_then(|v| v.as_bool());
            }
            _ => {}
        }
    }

    let raw_available = input.is_some() || result.is_some();
    StructuredToolData {
        input,
        result,
        result_is_error,
        raw_available,
        redacted: mode.enabled() && raw_available,
    }
}

pub fn extract_tool_info(record: &MessageRecord) -> ToolInfo {
    let Some(message) = &record.message else {
        return ToolInfo {
            server: None,
            tool: None,
        };
    };
    let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
        return ToolInfo {
            server: None,
            tool: None,
        };
    };

    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(name) = item.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        return parse_mcp_tool_name(name);
    }

    ToolInfo {
        server: None,
        tool: None,
    }
}

/// 将项目 ID 还原为可读路径（仅用于展示）
/// Linux:   -home-alice-projects-app → /home/alice/projects/app
/// Windows: D--Work-project → D:/Work/project
pub fn project_id_to_display_path(id: &str) -> String {
    // Windows 格式启发式检测：以大写字母开头 + "--"（原始为 "盘符:-"，: 和 / 都变成了 -）
    // 注意：这是 best-effort 启发式，含 "--" 前缀的非常规 Linux 路径可能误判，影响仅限展示
    if id.len() >= 3 && id.as_bytes()[0].is_ascii_alphabetic() && id[1..].starts_with("--") {
        let drive = &id[..1];
        let rest = &id[3..]; // 跳过 "X--"
        return format!("{}:/{}", drive, rest.replace('-', "/"));
    }
    // Linux/Mac 格式：以 "-" 开头
    // 例如 "-home-alice-projects-app" → "/home/alice/projects/app"
    id.replace('-', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_message_slice_accepts_python_bounds() {
        let cases = [
            ("[-10:-1]", Some(-10), Some(-1), (90, 99)),
            ("[-10:]", Some(-10), None, (90, 100)),
            ("[-1:]", Some(-1), None, (99, 100)),
            ("[:10]", None, Some(10), (0, 10)),
            ("[10:20]", Some(10), Some(20), (10, 20)),
            ("[0:0]", Some(0), Some(0), (0, 0)),
        ];
        for (raw, start, end, normalized) in cases {
            let parsed = parse_message_slice_param(raw).unwrap();
            assert_eq!(parsed.start, start);
            assert_eq!(parsed.end, end);
            assert_eq!(normalize_message_slice(&parsed, 100), normalized);
        }
    }

    #[test]
    fn parse_message_slice_rejects_step() {
        let err = parse_message_slice_param("[::-1]").unwrap_err();
        assert!(err.contains("不支持 step"));
    }
}

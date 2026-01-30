use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// JSONL 中的消息记录
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub uuid: String,
    #[serde(default)]
    pub parent_uuid: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub timestamp: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub message: Option<serde_json::Value>,
}

/// 搜索结果中的单条消息
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub r#ref: String,
    pub session: String,
    pub line: usize,
    pub uuid: String,
    pub r#type: String,
    pub timestamp: String,
    pub content: String,
    pub content_size: usize,
    pub truncated: bool,
    pub image_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageInfo>,
    pub project: String,
}

/// 图片信息
#[derive(Debug, Clone, Serialize)]
pub struct ImageInfo {
    pub index: usize,
    pub size: usize,
}

/// 搜索统计
#[derive(Debug, Clone, Serialize)]
pub struct SearchStats {
    pub files_scanned: usize,
    pub lines_scanned: usize,
    pub total_matches: usize,
    pub returned_count: usize,
    pub time_ms: u64,
}

/// 搜索响应
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub stats: SearchStats,
    pub results: Vec<SearchResult>,
    pub has_more: bool,
    pub next_offset: usize,
}

/// Get 响应
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum GetResponse {
    Success {
        r#ref: String,
        r#type: String,
        content: String,
        content_size: usize,
        image_count: usize,
    },
    TooLarge {
        error: String,
        r#ref: String,
        size: usize,
        suggestion: String,
    },
    Output {
        r#ref: String,
        output: OutputInfo,
        content_size: usize,
        image_count: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputInfo {
    pub content: PathBuf,
    pub images: Vec<PathBuf>,
}

/// Context 响应
#[derive(Debug, Clone, Serialize)]
pub struct ContextResponse {
    pub anchor_ref: String,
    pub messages: Vec<ContextMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextMessage {
    pub r#ref: String,
    pub r#type: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_anchor: Option<bool>,
}

/// 项目信息
#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub path: String,
    pub session_count: usize,
    pub last_activity: String,
}

/// 项目列表响应
#[derive(Debug, Clone, Serialize)]
pub struct ProjectsResponse {
    pub projects: Vec<ProjectInfo>,
}

/// 会话信息
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub ref_prefix: String,
    pub line_count: usize,
    pub start_time: String,
    pub end_time: String,
    pub size_bytes: u64,
}

/// 会话列表响应
#[derive(Debug, Clone, Serialize)]
pub struct SessionsResponse {
    pub project: String,
    pub sessions: Vec<SessionInfo>,
}

/// 错误响应
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<serde_json::Value>,
}

/// Ref 解析结果
#[derive(Debug, Clone)]
pub struct ParsedRef {
    pub session_prefix: String,
    pub line: usize,
}

impl ParsedRef {
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 2 {
            return None;
        }
        let session_prefix = parts[0].to_string();
        let line = parts[1].parse().ok()?;
        Some(Self { session_prefix, line })
    }
}

/// 范围
#[derive(Debug, Clone)]
pub struct Range {
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub exclude: bool,
}

impl Range {
    /// 判断数值是否在区间内（纯粹的区间判断，不考虑 exclude）
    pub fn in_range(&self, n: usize) -> bool {
        match (self.start, self.end) {
            (Some(s), Some(e)) => n >= s && n <= e,
            (Some(s), None) => n >= s,
            (None, Some(e)) => n <= e,
            (None, None) => true,
        }
    }

    /// 解析范围字符串
    pub fn parse_ranges(s: &str) -> Vec<Range> {
        let mut ranges = Vec::new();
        for part in s.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }

            let exclude = part.starts_with('!');
            let part = if exclude { &part[1..] } else { part };

            if part.contains('-') {
                let parts: Vec<&str> = part.splitn(2, '-').collect();
                let start = if parts[0].is_empty() { None } else { parts[0].parse().ok() };
                let end = if parts.len() < 2 || parts[1].is_empty() { None } else { parts[1].parse().ok() };
                ranges.push(Range { start, end, exclude });
            } else if let Ok(n) = part.parse::<usize>() {
                ranges.push(Range { start: Some(n), end: Some(n), exclude });
            }
        }
        ranges
    }
}

/// 检查行号是否在范围内
pub fn line_in_ranges(line: usize, ranges: &[Range]) -> bool {
    if ranges.is_empty() {
        return true;
    }

    // 分离包含范围和排除范围
    let include_ranges: Vec<_> = ranges.iter().filter(|r| !r.exclude).collect();
    let exclude_ranges: Vec<_> = ranges.iter().filter(|r| r.exclude).collect();

    // 先检查是否被排除
    for range in &exclude_ranges {
        if range.in_range(line) {
            return false;
        }
    }

    // 如果没有包含范围，默认包含所有
    if include_ranges.is_empty() {
        return true;
    }

    // 检查是否在任一包含范围内
    include_ranges.iter().any(|r| r.in_range(line))
}

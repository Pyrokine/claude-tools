use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// JSONL 中的消息记录
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub uuid: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub timestamp: String,
    #[serde(default)]
    pub message: Option<serde_json::Value>,
    /// 上下文压缩产生的摘要消息（raw type 为 user，但逻辑类型应为 summary）
    #[serde(default)]
    pub is_compact_summary: bool,
    /// CLI 命令产生的 meta 消息
    #[serde(default)]
    pub is_meta: bool,
    #[serde(default, rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    #[serde(default, rename = "sourceToolAssistantUUID", alias = "sourceToolAssistantUuid")]
    pub source_tool_assistant_uuid: Option<String>,
}

/// 搜索结果中的单条消息
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub r#ref: String,
    pub session: String,
    pub line: usize,
    pub uuid: String,
    pub r#type: String,
    pub subtype: String,
    pub timestamp: String,
    pub content: String,
    pub content_size: usize,
    pub truncated: bool,
    pub image_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageInfo>,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_incomplete_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input_redacted: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result_redacted: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result_is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result_has_error_payload: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub matched_filters: Vec<String>,
    /// 匹配位置（字符偏移），用于截断时居中显示上下文
    #[serde(skip)]
    pub match_pos: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchCoverage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    pub projects: Vec<String>,
    pub sessions: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub searched_files: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skipped_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SearchSummary {
    pub by_project: Vec<SummaryBucket>,
    pub by_session: Vec<SummaryBucket>,
    pub by_type: Vec<SummaryBucket>,
    pub by_server: Vec<SummaryBucket>,
    pub by_tool: Vec<SummaryBucket>,
    pub by_day: Vec<SummaryBucket>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchSliceInfo {
    pub raw: String,
    pub start: usize,
    pub end: usize,
    pub total_before_slice: usize,
    pub total_after_slice: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SummaryBucket {
    pub key: String,
    pub count: usize,
}

/// 图片信息
#[derive(Debug, Clone, Serialize)]
pub struct ImageInfo {
    pub index: usize,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

/// 搜索统计
#[derive(Debug, Clone, Serialize)]
pub struct SearchStats {
    pub files_scanned: usize,
    pub lines_scanned: usize,
    pub total_matches: usize,
    pub returned_count: usize,
    pub time_ms: u64,
    pub total_matches_exact: bool,
    pub incomplete: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub incomplete_reasons: Vec<String>,
    pub coverage: SearchCoverage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<SearchSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice: Option<SearchSliceInfo>,
    pub effective_filters: EffectiveFilters,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ignored_keys: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// 是否触发了全局命中硬上限截断（GLOBAL_RESULT_CAP）；
    /// 客户端看到 has_more=false + truncated_global=true 应理解为"翻完但被截，需缩小搜索"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_global: Option<bool>,
}

/// 搜索响应
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub stats: SearchStats,
    pub results: Vec<SearchResult>,
    pub has_more: bool,
    pub next_offset: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_query: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<SearchOutputInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub serialized_bytes: usize,
    pub max_total_bytes: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub limits_applied: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct EffectiveFilters {
    pub pattern: String,
    pub projects: Vec<String>,
    pub all_projects: bool,
    pub sessions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    pub types: Vec<String>,
    pub subtypes: Vec<String>,
    pub servers: Vec<String>,
    pub tools: Vec<String>,
    pub tool_payload_errors: bool,
    pub regex: bool,
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchOutputInfo {
    pub results: PathBuf,
    pub manifest: PathBuf,
    pub format: String,
    pub export_scope: String,
    pub total_matches: usize,
    pub written_count: usize,
    pub content_truncated_count: usize,
    pub complete: bool,
    pub sample_kind: String,
    pub bytes: u64,
    pub lines: usize,
    pub redacted_count: usize,
    pub cap_reasons: Vec<String>,
    pub redaction: RedactionInfo,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedactionInfo {
    pub mode: String,
    pub enabled: bool,
    pub rules: Vec<String>,
    pub redacted_count: usize,
    pub raw_available: bool,
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
        content_size: usize,
        valid_range: String,
        suggestion: String,
        truncation_reason: String,
        output_suggestion: String,
        range_suggestion: String,
        parsed_range: Option<RangeInfo>,
        head: String,
        tail: String,
    },
    Output {
        r#ref: String,
        output: OutputInfo,
        content_size: usize,
        original_content_size: usize,
        image_count: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct RangeInfo {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputInfo {
    pub content: PathBuf,
    pub manifest: PathBuf,
    pub images: Vec<PathBuf>,
    pub bytes: u64,
    pub lines: usize,
    pub schema: String,
    pub complete: bool,
    pub sample_kind: String,
    pub redaction: RedactionInfo,
}

/// Context 响应
#[derive(Debug, Clone, Serialize)]
pub struct ContextResponse {
    pub anchor_ref: String,
    pub messages: Vec<ContextMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextMessage {
    pub r#ref: String,
    pub r#type: String,
    pub subtype: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_anchor: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceResponse {
    pub anchor_ref: String,
    pub project: String,
    pub session: String,
    pub messages: Vec<TraceMessage>,
    pub tool_calls: Vec<TraceToolCall>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub association_issues: Vec<TraceAssociationIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceMessage {
    pub r#ref: String,
    pub r#type: String,
    pub subtype: String,
    pub timestamp: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_anchor: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceToolCall {
    pub r#ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub status: String,
    pub match_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceAssociationIssue {
    pub result_ref: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    pub pending_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildIdentity {
    pub package_version: String,
    pub commit: String,
    pub target: String,
    pub profile: String,
    pub build_timestamp_utc: String,
    pub dirty: bool,
    pub reproducible: bool,
}

impl BuildIdentity {
    pub fn current() -> Self {
        let commit = env!("MCP_HISTORY_BUILD_COMMIT").to_string();
        let build_timestamp_utc = env!("MCP_HISTORY_BUILD_TIMESTAMP").to_string();
        let dirty = env!("MCP_HISTORY_BUILD_DIRTY") == "true";
        Self {
            package_version: env!("CARGO_PKG_VERSION").to_string(),
            target: env!("MCP_HISTORY_BUILD_TARGET").to_string(),
            profile: env!("MCP_HISTORY_BUILD_PROFILE").to_string(),
            reproducible: commit != "unknown" && build_timestamp_utc != "unknown" && !dirty,
            commit,
            build_timestamp_utc,
            dirty,
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
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

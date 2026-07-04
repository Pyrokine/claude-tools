use crate::config::Config;
use crate::get::resolve_output_dir;
use crate::types::*;
use crate::utils::*;
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 搜索参数
pub struct SearchParams {
    pub pattern: String,
    pub projects: Vec<String>,
    pub all_projects: bool,
    pub sessions: Vec<String>,
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    pub until: Option<chrono::DateTime<chrono::Utc>>,
    pub types: Vec<String>,
    pub subtypes: Vec<String>,
    pub servers: Vec<String>,
    pub tools: Vec<String>,
    pub lines: Vec<Range>,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub offset: usize,
    pub limit: Option<usize>,
    pub slice: Option<MessageSlice>,
    pub max_content: usize,
    /// tool_result 子类型的最大内容长度（独立控制，默认 500）
    pub max_content_tool_result: usize,
    pub max_total: usize,
    pub summary: bool,
    pub aggregate: bool,
    pub failed_tool_results: bool,
    pub tool_payload_errors: bool,
    pub dry_run: bool,
    pub redaction: RedactionMode,
    pub ignored_keys: Vec<String>,
    pub warnings: Vec<String>,
    pub output: Option<String>,
    pub output_format: Option<String>,
    /// 是否包含 agent 子会话（默认 false）
    pub subagents: bool,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            projects: Vec::new(),
            all_projects: false,
            sessions: Vec::new(),
            since: None,
            until: None,
            types: vec!["assistant".to_string(), "user".to_string(), "summary".to_string()],
            subtypes: Vec::new(),
            servers: Vec::new(),
            tools: Vec::new(),
            lines: Vec::new(),
            use_regex: false,
            case_sensitive: false,
            offset: 0,
            limit: None,
            slice: None,
            max_content: 4000,
            max_content_tool_result: 500,
            max_total: 40000,
            summary: false,
            aggregate: false,
            failed_tool_results: false,
            tool_payload_errors: false,
            dry_run: false,
            redaction: RedactionMode::Auto,
            ignored_keys: Vec::new(),
            warnings: Vec::new(),
            output: None,
            output_format: None,
            subagents: false,
        }
    }
}

/// 单文件命中上限（避免单一巨型 jsonl 把内存吃满）
/// 上限 = clamp((offset + limit) * 2, 1_000, GLOBAL_RESULT_CAP)
/// 不让 offset 把单文件 cap 拉到无限，否则并行 search_file 会先 OOM 再被全局截断
fn per_file_cap(params: &SearchParams) -> usize {
    if params.output.is_some() || params.dry_run {
        return usize::MAX;
    }
    if let Some(slice) = &params.slice {
        if slice.needs_full_scan() {
            return usize::MAX;
        }
        if let Some(end) = slice.positive_end() {
            return end.saturating_mul(2).clamp(1_000, GLOBAL_RESULT_CAP);
        }
        return usize::MAX;
    }
    let target = params.offset.saturating_add(params.limit.unwrap_or(10_000));
    target.saturating_mul(2).clamp(1_000, GLOBAL_RESULT_CAP)
}

/// 全局命中硬上限（防止 OOM；超过即截断 + 在响应里标 truncated）
const GLOBAL_RESULT_CAP: usize = 50_000;
const STREAMING_UUID_DEDUPE_CAP: usize = GLOBAL_RESULT_CAP;

const TYPE_VALUES: &[&str] = &["assistant", "user", "summary", "system", "other"];
const SUBTYPE_VALUES: &[&str] = &[
    "human",
    "tool_result",
    "meta",
    "text",
    "tool_use",
    "thinking",
    "empty",
    "summary",
    "system",
    "other",
];

struct FileSearchResult {
    lines_scanned: usize,
    results: Vec<SearchResult>,
    truncated: bool,
}

fn push_unique(values: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn normalize_filters(mut params: SearchParams) -> SearchParams {
    let mut normalized_types = Vec::new();
    let mut normalized_subtypes = params.subtypes.clone();
    for value in &params.types {
        if TYPE_VALUES.contains(&value.as_str()) {
            push_unique(&mut normalized_types, value.clone());
        } else if SUBTYPE_VALUES.contains(&value.as_str()) {
            push_unique(&mut normalized_subtypes, value.clone());
            match value.as_str() {
                "tool_use" | "text" | "thinking" | "empty" => push_unique(&mut normalized_types, "assistant"),
                "tool_result" | "human" | "meta" => push_unique(&mut normalized_types, "user"),
                "summary" => push_unique(&mut normalized_types, "summary"),
                "system" => push_unique(&mut normalized_types, "system"),
                _ => {}
            }
            params
                .warnings
                .push(format!("types={} 是 subtype，已自动转入 subtypes", value));
        } else {
            params.warnings.push(format!("未知 type 过滤值: {}", value));
            push_unique(&mut normalized_types, value.clone());
        }
    }
    if normalized_types.is_empty() {
        normalized_types = vec!["assistant".to_string(), "user".to_string(), "summary".to_string()];
    }

    let mut final_subtypes = Vec::new();
    for value in normalized_subtypes {
        if SUBTYPE_VALUES.contains(&value.as_str()) {
            push_unique(&mut final_subtypes, value);
        } else if TYPE_VALUES.contains(&value.as_str()) {
            push_unique(&mut normalized_types, value.clone());
            params
                .warnings
                .push(format!("subtypes={} 是 type，已自动转入 types", value));
        } else {
            params.warnings.push(format!("未知 subtype 过滤值: {}", value));
            push_unique(&mut final_subtypes, value);
        }
    }

    let mut normalized_servers = params.servers.clone();
    let mut normalized_tools = Vec::new();
    for value in &params.tools {
        let parsed = parse_mcp_tool_name(value);
        if let Some(server) = parsed.server {
            push_unique(&mut normalized_servers, server);
            if let Some(tool) = parsed.tool {
                push_unique(&mut normalized_tools, tool);
            }
            params
                .warnings
                .push(format!("tools={} 是完整 MCP tool 名，已拆分为 server/tool", value));
        } else {
            push_unique(&mut normalized_tools, parsed.tool.unwrap_or_else(|| value.clone()));
        }
    }

    if params.failed_tool_results || params.tool_payload_errors {
        normalized_types.clear();
        final_subtypes.clear();
        push_unique(&mut normalized_types, "user");
        push_unique(&mut final_subtypes, "tool_result");
    }

    params.types = normalized_types;
    params.subtypes = final_subtypes;
    params.servers = normalized_servers;
    params.tools = normalized_tools;
    params
}

fn effective_filters(params: &SearchParams) -> EffectiveFilters {
    EffectiveFilters {
        pattern: params.pattern.clone(),
        projects: params.projects.clone(),
        all_projects: params.all_projects,
        sessions: params.sessions.clone(),
        since: params.since.map(|v| v.to_rfc3339()),
        until: params.until.map(|v| v.to_rfc3339()),
        types: params.types.clone(),
        subtypes: params.subtypes.clone(),
        servers: params.servers.clone(),
        tools: params.tools.clone(),
        tool_payload_errors: params.tool_payload_errors,
        regex: params.use_regex,
        case_sensitive: params.case_sensitive,
    }
}

fn broad_pattern_warning(params: &SearchParams) -> Option<String> {
    let pattern = params.pattern.trim();
    if ![".", ".*", "MCP", "mcp", "error", "timeout", "failed"].contains(&pattern) {
        return None;
    }
    if !params.projects.is_empty()
        || !params.sessions.is_empty()
        || params.since.is_some()
        || params.until.is_some()
        || !params.servers.is_empty()
        || !params.tools.is_empty()
        || !params.subtypes.is_empty()
    {
        return None;
    }
    Some("查询 pattern 过宽，建议增加 project、since、types/subtypes、servers 或 tools 过滤".to_string())
}

type SearchFile = (String, String, PathBuf);

struct SearchInputs {
    project_dirs: Vec<(String, PathBuf)>,
    files: Vec<SearchFile>,
    regex: Option<Regex>,
    search_pattern: Option<SearchPattern>,
}

struct SearchCollection {
    files_scanned: usize,
    lines_scanned: usize,
    results: Vec<SearchResult>,
    incomplete_reasons: Vec<String>,
    truncated_global: bool,
}

struct SearchWindow {
    selected_results: Vec<SearchResult>,
    slice_info: Option<SearchSliceInfo>,
    selected_count: usize,
}

/// 执行搜索
pub fn search(config: &Config, params: SearchParams) -> Result<SearchResponse, ErrorResponse> {
    let start = Instant::now();
    let mut params = prepare_search_params(params)?;
    if let Some(warning) = broad_pattern_warning(&params) {
        params.warnings.push(warning);
    }

    let inputs = prepare_search_inputs(config, &params)?;
    if params.dry_run {
        return Ok(build_dry_run_response(
            &params,
            &inputs.project_dirs,
            &inputs.files,
            start,
        ));
    }

    if params.output.is_some() {
        return search_to_output_streaming(
            &params,
            &inputs.files,
            inputs.regex.as_ref(),
            inputs.search_pattern.as_ref(),
            start,
        );
    }

    if params.aggregate {
        return search_aggregate_streaming(
            &params,
            &inputs.files,
            inputs.regex.as_ref(),
            inputs.search_pattern.as_ref(),
            start,
        );
    }

    let collection = collect_search_results(
        &params,
        &inputs.files,
        inputs.regex.as_ref(),
        inputs.search_pattern.as_ref(),
    );
    build_search_response(params, inputs.files, collection, start)
}

fn prepare_search_params(params: SearchParams) -> Result<SearchParams, ErrorResponse> {
    let params = normalize_filters(params);
    validate_search_params(&params)?;
    Ok(params)
}

fn validate_search_params(params: &SearchParams) -> Result<(), ErrorResponse> {
    if let Some(format) = &params.output_format
        && format != "jsonl"
    {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: format!("output_format 仅支持 jsonl，收到 {}", format),
            available: Some(serde_json::json!({ "formats": ["jsonl"] })),
        });
    }
    if params.slice.is_some() && (params.offset > 0 || params.limit.is_some()) {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: "slice 不能和 offset/limit 同时使用".to_string(),
            available: Some(serde_json::json!({ "examples": ["[-10:]", "[-10:-1]", "[:20]", "[10:20]"] })),
        });
    }
    if params.output.is_some() && params.slice.as_ref().is_some_and(MessageSlice::needs_full_scan) {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: "output 模式不支持需要缓存全量结果的负数 slice，请使用 offset/limit 或正数 slice".to_string(),
            available: Some(serde_json::json!({ "examples": ["[0:20]", "[10:20]", "offset=0,limit=20"] })),
        });
    }
    Ok(())
}

fn prepare_search_inputs(config: &Config, params: &SearchParams) -> Result<SearchInputs, ErrorResponse> {
    let project_dirs = get_project_dirs(config, params)?;
    let files = collect_jsonl_files(&project_dirs, &params.sessions, params.subagents);
    ensure_session_filters_unambiguous(&files, &params.sessions)?;
    let regex = build_search_regex(params)?;
    let search_pattern = if !params.use_regex && !params.pattern.is_empty() {
        Some(parse_search_pattern(&params.pattern, params.case_sensitive))
    } else {
        None
    };
    Ok(SearchInputs {
        project_dirs,
        files,
        regex,
        search_pattern,
    })
}

fn build_search_regex(params: &SearchParams) -> Result<Option<Regex>, ErrorResponse> {
    if !params.use_regex || params.pattern.is_empty() {
        return Ok(None);
    }
    RegexBuilder::new(&params.pattern)
        .case_insensitive(!params.case_sensitive)
        .build()
        .map(Some)
        .map_err(|e| ErrorResponse {
            error: "invalid_regex".to_string(),
            message: format!("无效的正则表达式: {}", e),
            available: None,
        })
}

fn searched_files(files: &[SearchFile]) -> Vec<String> {
    files
        .iter()
        .map(|(_, _, path)| path.display().to_string())
        .collect::<Vec<_>>()
}

fn build_dry_run_response(
    params: &SearchParams,
    project_dirs: &[(String, PathBuf)],
    files: &[SearchFile],
    start: Instant,
) -> SearchResponse {
    let coverage = SearchCoverage {
        start: None,
        end: None,
        projects: project_dirs.iter().map(|(project, _)| project.clone()).collect(),
        sessions: files.iter().map(|(_, session, _)| session.clone()).collect(),
        searched_files: searched_files(files),
        skipped_files: Vec::new(),
    };
    SearchResponse {
        stats: SearchStats {
            files_scanned: 0,
            lines_scanned: 0,
            total_matches: 0,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: true,
            incomplete: false,
            incomplete_reasons: Vec::new(),
            coverage,
            summary: None,
            slice: None,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            truncated_global: None,
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output: None,
        warning: None,
    }
}

fn collect_search_results(
    params: &SearchParams,
    files: &[SearchFile],
    regex: Option<&Regex>,
    search_pattern: Option<&SearchPattern>,
) -> SearchCollection {
    let file_cap = per_file_cap(params);
    let file_results: Vec<_> = files
        .par_iter()
        .map(|(project_id, session_id, path)| {
            search_file(project_id, session_id, path, params, regex, search_pattern, file_cap)
        })
        .collect();

    let mut results = Vec::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;
    let mut incomplete_reasons = Vec::new();

    for file_result in file_results {
        files_scanned += 1;
        lines_scanned += file_result.lines_scanned;
        if file_result.truncated {
            incomplete_reasons.push("per_file_cap".to_string());
        }
        results.extend(file_result.results);
    }

    results.sort_by(|a, b| {
        a.timestamp
         .cmp(&b.timestamp)
         .then_with(|| a.project.cmp(&b.project))
         .then_with(|| a.session.cmp(&b.session))
         .then_with(|| a.line.cmp(&b.line))
    });

    let mut seen_uuids = HashSet::new();
    results.retain(|r| r.uuid.is_empty() || seen_uuids.insert(r.uuid.clone()));

    let truncated_global = !params.aggregate && results.len() > GLOBAL_RESULT_CAP;
    if truncated_global {
        incomplete_reasons.push("global_result_cap".to_string());
        results.truncate(GLOBAL_RESULT_CAP);
    }

    SearchCollection {
        files_scanned,
        lines_scanned,
        results,
        incomplete_reasons,
        truncated_global,
    }
}

fn select_search_window(params: &SearchParams, all_results: &[SearchResult]) -> SearchWindow {
    let capped_total = all_results.len();
    if let Some(slice) = &params.slice {
        let (start_idx, end_idx) = normalize_message_slice(slice, capped_total);
        let total_after_slice = end_idx.saturating_sub(start_idx);
        let slice_info = SearchSliceInfo {
            raw: slice.raw.clone(),
            start: start_idx,
            end: end_idx,
            total_before_slice: capped_total,
            total_after_slice,
        };
        return SearchWindow {
            selected_results: all_results
                .iter()
                .skip(start_idx)
                .take(total_after_slice)
                .cloned()
                .collect(),
            slice_info: Some(slice_info),
            selected_count: total_after_slice,
        };
    }

    if params.aggregate {
        return SearchWindow {
            selected_results: Vec::new(),
            slice_info: None,
            selected_count: 0,
        };
    }

    SearchWindow {
        selected_results: all_results
            .iter()
            .skip(params.offset)
            .take(params.limit.unwrap_or(usize::MAX))
            .cloned()
            .collect(),
        slice_info: None,
        selected_count: capped_total.saturating_sub(params.offset),
    }
}

fn truncate_selected_results(params: &SearchParams, selected_results: Vec<SearchResult>) -> (Vec<SearchResult>, bool) {
    const METADATA_OVERHEAD: usize = 300;
    if params.aggregate {
        return (Vec::new(), false);
    }

    let mut final_results = Vec::new();
    let mut total_chars = 0;
    let mut max_total_hit = false;

    for mut result in selected_results {
        let effective_max = if result.subtype == "tool_result" {
            params.max_content_tool_result
        } else {
            params.max_content
        };
        let (content, truncated) = truncate_around_match(&result.content, result.match_pos, effective_max);
        result.content = content;
        result.truncated = truncated || result.truncated;

        let result_size = result.content.chars().count() + METADATA_OVERHEAD;
        if total_chars + result_size > params.max_total && !final_results.is_empty() {
            max_total_hit = true;
            break;
        }

        total_chars += result_size;
        final_results.push(result);
    }

    (final_results, max_total_hit)
}

fn build_search_response(
    params: SearchParams,
    files: Vec<SearchFile>,
    mut collection: SearchCollection,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let total_matches = collection.results.len();
    let window = select_search_window(&params, &collection.results);
    let (final_results, max_total_hit) = truncate_selected_results(&params, window.selected_results);

    if max_total_hit {
        collection.incomplete_reasons.push("max_total".to_string());
    }
    let has_more = !params.aggregate && final_results.len() < window.selected_count;
    if has_more {
        collection.incomplete_reasons.push("has_more".to_string());
    }
    collection.incomplete_reasons.sort();
    collection.incomplete_reasons.dedup();

    let next_offset = if params.slice.is_some() || params.aggregate {
        0
    } else {
        params.offset + final_results.len()
    };
    let coverage = build_coverage(&collection.results, searched_files(&files));
    let summary = (params.summary || params.aggregate).then(|| build_summary(&collection.results));
    let returned_results = if params.aggregate { Vec::new() } else { final_results };
    let returned_count = returned_results.len();
    let next_query = has_more.then(|| build_next_query(&params, next_offset));
    let total_matches_exact = !collection.incomplete_reasons.iter().any(|r| {
        matches!(
            r.as_str(),
            "per_file_cap" | "global_result_cap" | "max_total" | "has_more"
        )
    });
    let warning = build_response_warning(&collection.incomplete_reasons, &params);

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned: collection.files_scanned,
            lines_scanned: collection.lines_scanned,
            total_matches,
            returned_count,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact,
            incomplete: !collection.incomplete_reasons.is_empty(),
            incomplete_reasons: collection.incomplete_reasons,
            coverage,
            summary,
            slice: window.slice_info,
            effective_filters: effective_filters(&params),
            ignored_keys: params.ignored_keys,
            warnings: params.warnings,
            truncated_global: collection.truncated_global.then_some(true),
        },
        results: returned_results,
        has_more,
        next_offset,
        next_query,
        output: None,
        warning,
    })
}

fn build_response_warning(incomplete_reasons: &[String], params: &SearchParams) -> Option<String> {
    if incomplete_reasons.is_empty() && params.warnings.is_empty() && params.ignored_keys.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    if !incomplete_reasons.is_empty() {
        parts.push(format!("结果不完整，原因: {}", incomplete_reasons.join(",")));
    }
    if !params.warnings.is_empty() {
        parts.push(format!("查询提示: {}", params.warnings.join("; ")));
    }
    if !params.ignored_keys.is_empty() {
        parts.push(format!("存在未识别参数: {}", params.ignored_keys.join(",")));
    }
    Some(parts.join("；"))
}

fn ensure_session_filters_unambiguous(
    files: &[(String, String, PathBuf)],
    sessions: &[String],
) -> Result<(), ErrorResponse> {
    if sessions.is_empty() {
        return Ok(());
    }

    for filter in sessions {
        let mut matches = BTreeSet::new();
        for (project, session, _) in files {
            if session == filter || ref_prefix(session) == *filter {
                matches.insert(format!("{}:{}", project, session));
            }
        }
        if matches.is_empty() {
            return Err(ErrorResponse {
                error: "session_not_found".to_string(),
                message: format!("找不到 session 过滤条件: {}", filter),
                available: None,
            });
        }
        if matches.len() > 1 {
            return Err(ErrorResponse {
                error: "session_ambiguous".to_string(),
                message: format!(
                    "session 过滤条件不唯一: {}，请使用完整 session id 或指定 project",
                    filter
                ),
                available: Some(serde_json::json!({ "candidates": matches.into_iter().collect::<Vec<_>>() })),
            });
        }
    }

    Ok(())
}

fn build_next_query(params: &SearchParams, next_offset: usize) -> serde_json::Value {
    let mut query = serde_json::Map::new();
    if !params.pattern.is_empty() {
        query.insert("pattern".to_string(), serde_json::Value::String(params.pattern.clone()));
    }
    if !params.projects.is_empty() {
        query.insert(
            "project".to_string(),
            serde_json::Value::String(params.projects.join(",")),
        );
    }
    if params.all_projects {
        query.insert("all".to_string(), serde_json::Value::Bool(true));
    }
    if !params.sessions.is_empty() {
        query.insert(
            "sessions".to_string(),
            serde_json::Value::String(params.sessions.join(",")),
        );
    }
    if let Some(since) = params.since {
        query.insert("since".to_string(), serde_json::Value::String(since.to_rfc3339()));
    }
    if let Some(until) = params.until {
        query.insert("until".to_string(), serde_json::Value::String(until.to_rfc3339()));
    }
    if !params.types.is_empty() {
        query.insert("types".to_string(), serde_json::Value::String(params.types.join(",")));
    }
    if !params.subtypes.is_empty() {
        query.insert(
            "subtypes".to_string(),
            serde_json::Value::String(params.subtypes.join(",")),
        );
    }
    if !params.servers.is_empty() {
        query.insert(
            "servers".to_string(),
            serde_json::Value::String(params.servers.join(",")),
        );
    }
    if !params.tools.is_empty() {
        query.insert("tools".to_string(), serde_json::Value::String(params.tools.join(",")));
    }
    if params.use_regex {
        query.insert("regex".to_string(), serde_json::Value::Bool(true));
    }
    if params.case_sensitive {
        query.insert("case_sensitive".to_string(), serde_json::Value::Bool(true));
    }
    if params.summary {
        query.insert("summary".to_string(), serde_json::Value::Bool(true));
    }
    if params.failed_tool_results {
        query.insert("failed_tool_results".to_string(), serde_json::Value::Bool(true));
    }
    if params.tool_payload_errors {
        query.insert("tool_payload_errors".to_string(), serde_json::Value::Bool(true));
    }
    if params.subagents {
        query.insert("subagents".to_string(), serde_json::Value::Bool(true));
    }
    if params.redaction != RedactionMode::Auto {
        query.insert(
            "redaction".to_string(),
            serde_json::Value::String(params.redaction.as_str().to_string()),
        );
    }
    query.insert("offset".to_string(), serde_json::json!(next_offset));
    if let Some(limit) = params.limit {
        query.insert("limit".to_string(), serde_json::json!(limit));
    }
    serde_json::Value::Object(query)
}

fn build_coverage(results: &[SearchResult], searched_files: Vec<String>) -> SearchCoverage {
    let mut projects = BTreeSet::new();
    let mut sessions = BTreeSet::new();
    let mut start: Option<String> = None;
    let mut end: Option<String> = None;

    for result in results {
        projects.insert(result.project.clone());
        sessions.insert(result.session.clone());
        if start.as_ref().is_none_or(|s| result.timestamp < *s) {
            start = Some(result.timestamp.clone());
        }
        if end.as_ref().is_none_or(|s| result.timestamp > *s) {
            end = Some(result.timestamp.clone());
        }
    }

    SearchCoverage {
        start,
        end,
        projects: projects.into_iter().collect(),
        sessions: sessions.into_iter().collect(),
        searched_files,
        skipped_files: Vec::new(),
    }
}

fn buckets(map: BTreeMap<String, usize>) -> Vec<SummaryBucket> {
    map.into_iter()
       .map(|(key, count)| SummaryBucket { key, count })
       .collect()
}

fn build_summary(results: &[SearchResult]) -> SearchSummary {
    let mut by_project = BTreeMap::new();
    let mut by_session = BTreeMap::new();
    let mut by_type = BTreeMap::new();
    let mut by_server = BTreeMap::new();
    let mut by_tool = BTreeMap::new();
    let mut by_day = BTreeMap::new();

    for result in results {
        *by_project.entry(result.project.clone()).or_insert(0) += 1;
        *by_session.entry(result.session.clone()).or_insert(0) += 1;
        *by_type
            .entry(format!("{}:{}", result.r#type, result.subtype))
            .or_insert(0) += 1;
        if let Some(day) = result.timestamp.get(..10) {
            *by_day.entry(day.to_string()).or_insert(0) += 1;
        }
        if let Some(server) = &result.server {
            *by_server.entry(server.clone()).or_insert(0) += 1;
        }
        if let Some(tool) = &result.tool {
            *by_tool.entry(tool.clone()).or_insert(0) += 1;
        }
    }

    SearchSummary {
        by_project: buckets(by_project),
        by_session: buckets(by_session),
        by_type: buckets(by_type),
        by_server: buckets(by_server),
        by_tool: buckets(by_tool),
        by_day: buckets(by_day),
    }
}

#[cfg(unix)]
fn set_private_permissions(path: &Path, mode: u32) -> Result<(), ErrorResponse> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法设置输出文件权限: {}", e),
        available: None,
    })
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path, _mode: u32) -> Result<(), ErrorResponse> {
    Ok(())
}

fn open_private_output_file(path: &Path) -> Result<File, ErrorResponse> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建输出文件: {}", e),
        available: None,
    })?;
    set_private_permissions(path, 0o600)?;
    Ok(file)
}

fn prefixed_parent_output(raw: &str, parent: &Path) -> String {
    let parent = parent.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("tmp:") {
        return if parent.is_empty() {
            "tmp:.".to_string()
        } else {
            format!(
                "tmp:{}",
                Path::new(rest).parent().unwrap_or_else(|| Path::new(".")).display()
            )
        };
    }
    if let Some(rest) = raw.strip_prefix("cwd:") {
        return if parent.is_empty() {
            "cwd:.".to_string()
        } else {
            format!(
                "cwd:{}",
                Path::new(rest).parent().unwrap_or_else(|| Path::new(".")).display()
            )
        };
    }
    if parent.is_empty() {
        ".".to_string()
    } else {
        parent.to_string()
    }
}

fn resolve_search_output_paths(raw_output: &str) -> Result<(PathBuf, PathBuf), ErrorResponse> {
    let trimmed = raw_output.trim();
    let path_part = trimmed
        .strip_prefix("tmp:")
        .or_else(|| trimmed.strip_prefix("cwd:"))
        .unwrap_or(trimmed);
    let requested_path = Path::new(path_part);
    if requested_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        let dir = resolve_output_dir(trimmed)?;
        fs::create_dir_all(&dir).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法创建搜索输出目录: {}", e),
            available: None,
        })?;
        set_private_permissions(&dir, 0o700)?;
        return Ok((dir.join("search-results.jsonl"), dir.join("search-manifest.json")));
    }

    let file_name = requested_path.file_name().ok_or_else(|| ErrorResponse {
        error: "invalid_output_dir".to_string(),
        message: "output 指向 .jsonl 文件时必须包含文件名".to_string(),
        available: Some(serde_json::json!({
            "examples": ["tmp:search-results.jsonl", "tmp:export/search-results.jsonl", "cwd:export/search-results.jsonl"]
        })),
    })?;
    let parent = requested_path.parent().unwrap_or_else(|| Path::new("."));
    let parent_output = prefixed_parent_output(trimmed, parent);
    let dir = resolve_output_dir(&parent_output)?;
    fs::create_dir_all(&dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法创建搜索输出目录: {}", e),
        available: None,
    })?;
    set_private_permissions(&dir, 0o700)?;
    let results_path = dir.join(file_name);
    let manifest_name = format!(
        "{}_manifest.json",
        results_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("search-results")
    );
    let manifest_path = results_path.with_file_name(manifest_name);
    Ok((results_path, manifest_path))
}

#[derive(Default)]
struct SearchAggregation {
    projects: BTreeSet<String>,
    sessions: BTreeSet<String>,
    start: Option<String>,
    end: Option<String>,
    by_project: BTreeMap<String, usize>,
    by_session: BTreeMap<String, usize>,
    by_type: BTreeMap<String, usize>,
    by_server: BTreeMap<String, usize>,
    by_tool: BTreeMap<String, usize>,
    by_day: BTreeMap<String, usize>,
}

impl SearchAggregation {
    fn observe(&mut self, result: &SearchResult) {
        self.projects.insert(result.project.clone());
        self.sessions.insert(result.session.clone());
        if self.start.as_ref().is_none_or(|s| result.timestamp < *s) {
            self.start = Some(result.timestamp.clone());
        }
        if self.end.as_ref().is_none_or(|s| result.timestamp > *s) {
            self.end = Some(result.timestamp.clone());
        }
        *self.by_project.entry(result.project.clone()).or_insert(0) += 1;
        *self.by_session.entry(result.session.clone()).or_insert(0) += 1;
        *self
            .by_type
            .entry(format!("{}:{}", result.r#type, result.subtype))
            .or_insert(0) += 1;
        if let Some(day) = result.timestamp.get(..10) {
            *self.by_day.entry(day.to_string()).or_insert(0) += 1;
        }
        if let Some(server) = &result.server {
            *self.by_server.entry(server.clone()).or_insert(0) += 1;
        }
        if let Some(tool) = &result.tool {
            *self.by_tool.entry(tool.clone()).or_insert(0) += 1;
        }
    }

    fn coverage(self, searched_files: Vec<String>) -> SearchCoverage {
        SearchCoverage {
            start: self.start,
            end: self.end,
            projects: self.projects.into_iter().collect(),
            sessions: self.sessions.into_iter().collect(),
            searched_files,
            skipped_files: Vec::new(),
        }
    }

    fn summary(&self) -> SearchSummary {
        SearchSummary {
            by_project: buckets(self.by_project.clone()),
            by_session: buckets(self.by_session.clone()),
            by_type: buckets(self.by_type.clone()),
            by_server: buckets(self.by_server.clone()),
            by_tool: buckets(self.by_tool.clone()),
            by_day: buckets(self.by_day.clone()),
        }
    }
}

fn streaming_selection(params: &SearchParams) -> (usize, Option<usize>, bool) {
    if let Some(slice) = &params.slice {
        let start = slice.start.and_then(|v| usize::try_from(v).ok()).unwrap_or(0);
        let end = slice.end.and_then(|v| usize::try_from(v).ok());
        return (start, end, true);
    }
    let end = params.limit.map(|limit| params.offset.saturating_add(limit));
    (params.offset, end, params.offset > 0 || params.limit.is_some())
}

fn streaming_slice_info(params: &SearchParams, total_matches: usize) -> Option<SearchSliceInfo> {
    let slice = params.slice.as_ref()?;
    let start = slice
        .start
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(0)
        .min(total_matches);
    let end = slice
        .end
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(total_matches)
        .min(total_matches);
    Some(SearchSliceInfo {
        raw: slice.raw.clone(),
        start,
        end,
        total_before_slice: total_matches,
        total_after_slice: end.saturating_sub(start),
    })
}

fn create_search_output_file(output: &str) -> Result<(PathBuf, PathBuf, File), ErrorResponse> {
    let (results_path, manifest_path) = resolve_search_output_paths(output)?;
    let file = open_private_output_file(&results_path)?;
    Ok((results_path, manifest_path, file))
}

struct SearchManifestContext<'a> {
    results_path: &'a Path,
    manifest_path: &'a Path,
    coverage: &'a SearchCoverage,
    summary: Option<&'a SearchSummary>,
    slice: Option<&'a SearchSliceInfo>,
    total_matches: usize,
    written_count: usize,
    content_truncated_count: usize,
    redaction: RedactionMode,
    redacted_count: usize,
    complete: bool,
    explicit_range: bool,
    incomplete_reasons: &'a [String],
    bytes: u64,
}

fn write_search_manifest(ctx: SearchManifestContext<'_>) -> Result<SearchOutputInfo, ErrorResponse> {
    let export_scope = if ctx.complete {
        if ctx.explicit_range {
            "explicit_range"
        } else {
            "all_matches"
        }
    } else {
        "incomplete"
    }
        .to_string();
    let sample_kind = if ctx.explicit_range { "range" } else { "all" }.to_string();
    let redaction = redaction_info(
        ctx.redaction,
        ctx.redacted_count,
        ctx.redaction == RedactionMode::Off || ctx.redacted_count > 0,
    );
    let manifest = serde_json::json!({
        "format": "jsonl",
        "schema": "mcp-claude-history.search-results.v1",
        "results": ctx.results_path,
        "count": ctx.written_count,
        "total_matches": ctx.total_matches,
        "export_scope": export_scope,
        "sample_kind": sample_kind,
        "complete": ctx.complete,
        "content_truncated_count": ctx.content_truncated_count,
        "redacted_count": ctx.redacted_count,
        "bytes": ctx.bytes,
        "lines": ctx.written_count,
        "coverage": ctx.coverage,
        "summary": ctx.summary,
        "slice": ctx.slice,
        "incomplete_reasons": ctx.incomplete_reasons,
        "cap_reasons": ctx.incomplete_reasons,
        "redaction": &redaction,
    });
    let mut manifest_file = open_private_output_file(ctx.manifest_path)?;
    manifest_file
        .write_all(serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())
        .map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("写入搜索 manifest 失败: {}", e),
            available: None,
        })?;

    Ok(SearchOutputInfo {
        results: ctx.results_path.to_path_buf(),
        manifest: ctx.manifest_path.to_path_buf(),
        format: "jsonl".to_string(),
        export_scope,
        total_matches: ctx.total_matches,
        written_count: ctx.written_count,
        content_truncated_count: ctx.content_truncated_count,
        complete: ctx.complete,
        redacted_count: ctx.redacted_count,
        sample_kind,
        bytes: ctx.bytes,
        lines: ctx.written_count,
        cap_reasons: ctx.incomplete_reasons.to_vec(),
        redaction,
    })
}

/// 获取要搜索的项目目录
fn get_project_dirs(config: &Config, params: &SearchParams) -> Result<Vec<(String, PathBuf)>, ErrorResponse> {
    if params.all_projects && !params.projects.is_empty() {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: "all=true 不能和 project 同时使用".to_string(),
            available: Some(config.available_projects_json()),
        });
    }

    if params.all_projects {
        return config.list_project_dirs().map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法读取项目目录: {}", e),
            available: None,
        });
    }

    if !params.projects.is_empty() {
        // 搜索指定项目
        let mut dirs = Vec::new();
        for project_id in &params.projects {
            let normalized = config.normalize_project_id(project_id)?;
            let dir = config.project_dir(&normalized)?;
            if !dir.exists() {
                return Err(ErrorResponse {
                    error: "project_not_found".to_string(),
                    message: format!("项目不存在: {}", normalized),
                    available: Some(config.available_projects_json()),
                });
            }
            dirs.push((normalized, dir));
        }
        return Ok(dirs);
    }

    // 默认：当前项目
    if let Some(project_id) = config.current_project_id() {
        // current_project_id 由 cwd 转码生成,理论上合规;若失败则继续向下报 no_current_project
        if let Ok(dir) = config.project_dir(&project_id) {
            return Ok(vec![(project_id, dir)]);
        }
    }

    // 找不到当前项目，返回错误
    Err(ErrorResponse {
        error: "no_current_project".to_string(),
        message: "无法确定当前项目，请使用 --project 指定".to_string(),
        available: Some(config.available_projects_json()),
    })
}

/// 检查 session 是否匹配过滤条件
fn session_matches_filter(session_id: &str, sessions: &[String]) -> bool {
    if sessions.is_empty() {
        return true;
    }
    let prefix = ref_prefix(session_id);
    sessions.iter().any(|s| s == session_id || s == &prefix)
}

/// 收集所有 jsonl 文件
fn collect_jsonl_files(
    project_dirs: &[(String, PathBuf)],
    sessions: &[String],
    include_subagents: bool,
) -> Vec<(String, String, PathBuf)> {
    let mut files = Vec::new();

    for (project_id, dir) in project_dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false)
                    && let Some(session_id) = session_id_from_filename(&entry.file_name().to_string_lossy())
                    && session_matches_filter(&session_id, sessions)
                {
                    files.push((project_id.clone(), session_id, path));
                }
            }
        }

        if !include_subagents {
            continue;
        }

        for sidechain_dir in SIDECHAIN_SESSION_DIRS {
            let pattern = dir.join("*/").join(sidechain_dir);
            if let Ok(entries) = glob::glob(&pattern.to_string_lossy()) {
                for subdir in entries.flatten() {
                    if let Ok(sub_entries) = fs::read_dir(&subdir) {
                        for entry in sub_entries.flatten() {
                            let path = entry.path();
                            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                                let filename = entry.file_name().to_string_lossy().to_string();
                                if filename.starts_with("agent-") {
                                    let session_id = filename.strip_suffix(".jsonl").unwrap_or(&filename).to_string();
                                    if session_matches_filter(&session_id, sessions) {
                                        files.push((project_id.clone(), session_id, path));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    files
}

fn search_aggregate_streaming(
    params: &SearchParams,
    files: &[(String, String, PathBuf)],
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let searched_files = files
        .iter()
        .map(|(_, _, path)| path.display().to_string())
        .collect::<Vec<_>>();
    let mut aggregation = SearchAggregation::default();
    let mut seen_uuids = HashSet::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;
    let mut total_matches = 0;
    let mut incomplete_reasons = Vec::new();

    'files: for (project_id, session_id, path) in files {
        files_scanned += 1;
        let Ok(input) = File::open(path) else {
            continue;
        };
        let prefix = ref_prefix(session_id);
        for (line_num, line) in BufReader::new(input).lines().enumerate() {
            let line_num = line_num + 1;
            lines_scanned += 1;
            if !line_in_ranges(line_num, &params.lines) {
                continue;
            }
            let Ok(line) = line else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<MessageRecord>(&line) else {
                continue;
            };
            let ctx = RecordBuildContext {
                project_id,
                session_id,
                prefix: &prefix,
                params,
                regex,
                pattern,
            };
            let Some(result) = build_search_result(&ctx, line_num, record) else {
                continue;
            };
            if !result.uuid.is_empty() {
                if seen_uuids.contains(&result.uuid) {
                    continue;
                }
                if seen_uuids.len() >= STREAMING_UUID_DEDUPE_CAP {
                    incomplete_reasons.push("uuid_dedupe_cap".to_string());
                    break 'files;
                }
                seen_uuids.insert(result.uuid.clone());
            }
            total_matches += 1;
            aggregation.observe(&result);
        }
    }

    incomplete_reasons.sort();
    incomplete_reasons.dedup();
    let summary_value = Some(aggregation.summary());
    let coverage = aggregation.coverage(searched_files);
    let warning = build_response_warning(&incomplete_reasons, params);

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned,
            lines_scanned,
            total_matches,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: incomplete_reasons.is_empty(),
            incomplete: !incomplete_reasons.is_empty(),
            incomplete_reasons,
            coverage,
            summary: summary_value,
            slice: None,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            truncated_global: None,
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output: None,
        warning,
    })
}

fn search_to_output_streaming(
    params: &SearchParams,
    files: &[(String, String, PathBuf)],
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let output = params.output.as_ref().expect("output checked by caller");
    let (results_path, manifest_path, mut file) = create_search_output_file(output)?;
    let searched_files = files
        .iter()
        .map(|(_, _, path)| path.display().to_string())
        .collect::<Vec<_>>();
    let (selection_start, selection_end, explicit_range) = streaming_selection(params);
    let mut aggregation = SearchAggregation::default();
    let mut seen_uuids = HashSet::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;
    let mut total_matches = 0;
    let mut written_count = 0;
    let mut content_truncated_count = 0;
    let mut redacted_count = 0;
    let mut incomplete_reasons = Vec::new();

    'files: for (project_id, session_id, path) in files {
        files_scanned += 1;
        let Ok(input) = File::open(path) else {
            continue;
        };
        let prefix = ref_prefix(session_id);
        for (line_num, line) in BufReader::new(input).lines().enumerate() {
            let line_num = line_num + 1;
            lines_scanned += 1;
            if !line_in_ranges(line_num, &params.lines) {
                continue;
            }
            let Ok(line) = line else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<MessageRecord>(&line) else {
                continue;
            };
            let ctx = RecordBuildContext {
                project_id,
                session_id,
                prefix: &prefix,
                params,
                regex,
                pattern,
            };
            let Some(result) = build_search_result(&ctx, line_num, record) else {
                continue;
            };
            if !result.uuid.is_empty() {
                if seen_uuids.contains(&result.uuid) {
                    continue;
                }
                if seen_uuids.len() >= STREAMING_UUID_DEDUPE_CAP {
                    incomplete_reasons.push("uuid_dedupe_cap".to_string());
                    break 'files;
                }
                seen_uuids.insert(result.uuid.clone());
            }

            let result_index = total_matches;
            total_matches += 1;
            aggregation.observe(&result);
            if result_index < selection_start {
                continue;
            }
            if selection_end.is_some_and(|end| result_index >= end) {
                continue;
            }
            if result.truncated {
                content_truncated_count += 1;
            }
            if result.redacted == Some(true) {
                redacted_count += 1;
            }
            let line = serde_json::to_string(&result).map_err(|e| ErrorResponse {
                error: "serialize_error".to_string(),
                message: format!("序列化搜索结果失败: {}", e),
                available: None,
            })?;
            writeln!(file, "{}", line).map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入搜索结果失败: {}", e),
                available: None,
            })?;
            written_count += 1;
        }
    }

    file.flush().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("刷新搜索结果文件失败: {}", e),
        available: None,
    })?;
    let bytes = fs::metadata(&results_path).map(|m| m.len()).unwrap_or(0);
    let slice_info = streaming_slice_info(params, total_matches);
    incomplete_reasons.sort();
    incomplete_reasons.dedup();
    let summary_value = (params.summary || params.aggregate).then(|| aggregation.summary());
    let coverage = aggregation.coverage(searched_files);
    let output = Some(write_search_manifest(SearchManifestContext {
        results_path: &results_path,
        manifest_path: &manifest_path,
        coverage: &coverage,
        summary: summary_value.as_ref(),
        slice: slice_info.as_ref(),
        total_matches,
        written_count,
        content_truncated_count,
        redaction: params.redaction,
        redacted_count,
        complete: incomplete_reasons.is_empty(),
        explicit_range,
        incomplete_reasons: &incomplete_reasons,
        bytes,
    })?);
    let warning = build_response_warning(&incomplete_reasons, params);

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned,
            lines_scanned,
            total_matches,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: incomplete_reasons.is_empty(),
            incomplete: !incomplete_reasons.is_empty(),
            incomplete_reasons,
            coverage,
            summary: summary_value,
            slice: slice_info,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            truncated_global: None,
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output,
        warning,
    })
}

struct RecordBuildContext<'a> {
    project_id: &'a str,
    session_id: &'a str,
    prefix: &'a str,
    params: &'a SearchParams,
    regex: Option<&'a Regex>,
    pattern: Option<&'a SearchPattern>,
}

fn build_search_result(ctx: &RecordBuildContext<'_>, line_num: usize, record: MessageRecord) -> Option<SearchResult> {
    let (effective_type, subtype) = classify_message(&record);
    if !ctx.params.types.iter().any(|t| t == effective_type) {
        return None;
    }
    if !ctx.params.subtypes.is_empty() && !ctx.params.subtypes.iter().any(|s| s == subtype) {
        return None;
    }
    if !time_in_range(&record.timestamp, ctx.params.since.as_ref(), ctx.params.until.as_ref()) {
        return None;
    }

    let tool_info = extract_tool_info(&record);
    if !ctx.params.servers.is_empty() {
        let Some(server) = &tool_info.server else {
            return None;
        };
        if !ctx.params.servers.iter().any(|s| s == server) {
            return None;
        }
    }
    if !ctx.params.tools.is_empty() {
        let Some(tool) = &tool_info.tool else {
            return None;
        };
        if !ctx.params.tools.iter().any(|t| t == tool) {
            return None;
        }
    }

    let structured_tool_data =
        extract_structured_tool_data_with_mode(&record, ctx.params.redaction, ctx.params.tool_payload_errors);
    if ctx.params.failed_tool_results && structured_tool_data.result_is_error != Some(true) {
        return None;
    }
    if ctx.params.tool_payload_errors && structured_tool_data.result_has_error_payload != Some(true) {
        return None;
    }

    let (raw_content, images) = extract_and_replace_images_with_mode(&record, ctx.params.redaction);
    let (matches, match_pos) = if ctx.params.pattern.is_empty() {
        (true, None)
    } else if let Some(regex) = ctx.regex {
        regex.find(&raw_content).map_or((false, None), |m| {
            (true, Some(raw_content[..m.start()].chars().count()))
        })
    } else if let Some(pattern) = ctx.pattern {
        matches_pattern(&raw_content, pattern, ctx.params.case_sensitive)
    } else {
        (true, None)
    };
    if !matches {
        return None;
    }

    let text_redaction = redact_text_with_mode(&raw_content, ctx.params.redaction);
    let content_redacted = text_redaction.count > 0;
    let content = text_redaction.text;
    let content_size = raw_content.chars().count();
    let image_count = images.len();
    let mut matched_filters = vec![
        format!("project={}", ctx.project_id),
        format!("session={}", ctx.session_id),
        format!("type={}", effective_type),
        format!("subtype={}", subtype),
    ];
    if ctx.params.since.is_some() || ctx.params.until.is_some() {
        matched_filters.push("time=true".to_string());
    }
    if let Some(server) = &tool_info.server {
        matched_filters.push(format!("server={}", server));
    }
    if let Some(tool) = &tool_info.tool {
        matched_filters.push(format!("tool={}", tool));
    }
    if ctx.params.failed_tool_results {
        matched_filters.push("failed_tool_results=true".to_string());
    }
    if ctx.params.tool_payload_errors {
        matched_filters.push("tool_payload_errors=true".to_string());
    }

    Some(SearchResult {
        r#ref: format!("{}:{}", ctx.prefix, line_num),
        session: ctx.session_id.to_string(),
        line: line_num,
        uuid: record.uuid,
        r#type: effective_type.to_string(),
        subtype: subtype.to_string(),
        timestamp: record.timestamp,
        content,
        content_size,
        truncated: false,
        image_count,
        images,
        project: ctx.project_id.to_string(),
        server: tool_info.server,
        tool: tool_info.tool,
        tool_input_redacted: structured_tool_data.input,
        tool_result_redacted: structured_tool_data.result,
        tool_result_is_error: structured_tool_data.result_is_error,
        tool_result_has_error_payload: structured_tool_data.result_has_error_payload,
        raw_available: (structured_tool_data.raw_available || content_redacted).then_some(true),
        redacted: (structured_tool_data.redacted || content_redacted).then_some(true),
        matched_filters,
        match_pos: (!content_redacted).then_some(match_pos).flatten(),
    })
}

/// 搜索单个文件
fn search_file(
    project_id: &str,
    session_id: &str,
    path: &Path,
    params: &SearchParams,
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    max_per_file: usize,
) -> FileSearchResult {
    let mut results = Vec::new();
    let mut lines_scanned = 0;
    let mut truncated = false;

    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return FileSearchResult {
                lines_scanned: 0,
                results,
                truncated: false,
            };
        }
    };

    let reader = BufReader::new(file);
    let prefix = ref_prefix(session_id);

    for (line_num, line) in reader.lines().enumerate() {
        let line_num = line_num + 1; // 1-based
        lines_scanned += 1;

        // 行号过滤
        if !line_in_ranges(line_num, &params.lines) {
            continue;
        }

        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        // 解析 JSON
        let record: MessageRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let ctx = RecordBuildContext {
            project_id,
            session_id,
            prefix: &prefix,
            params,
            regex,
            pattern,
        };
        if let Some(result) = build_search_result(&ctx, line_num, record) {
            results.push(result);

            // 单文件早停（避免一个巨型 jsonl 把内存吃满）
            if results.len() >= max_per_file {
                truncated = true;
                break;
            }
        }
    }

    FileSearchResult {
        lines_scanned,
        results,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::{env, fs, process};

    fn write_jsonl(dir: &Path, name: &str, lines: usize) -> PathBuf {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        for i in 0..lines {
            // 构造最小可被 classify_message 识别为 "user" 类型的 jsonl 行
            // 时间戳带毫秒偏移以保证 sort 顺序
            writeln!(
                f,
                r#"{{"uuid":"u-{i:08}","type":"user","timestamp":"2026-04-26T10:00:{:02}.{:03}Z","message":{{"role":"user","content":"hit-{i}"}}}}"#,
                i % 60,
                i % 1000,
            )
                .unwrap();
        }
        path
    }

    #[test]
    fn test_per_file_cap_default() {
        let p = SearchParams::default();
        // limit None → unwrap_or(10000); offset 0; cap = max(20000, 1000) = 20000
        assert_eq!(per_file_cap(&p), 20_000);
    }

    #[test]
    fn test_per_file_cap_with_limit() {
        let mut p = SearchParams::default();
        p.offset = 100;
        p.limit = Some(50);
        // (100 + 50) * 2 = 300，下限 1000 → 1000
        assert_eq!(per_file_cap(&p), 1_000);

        p.offset = 0;
        p.limit = Some(5_000);
        // 5000 * 2 = 10000
        assert_eq!(per_file_cap(&p), 10_000);
    }

    #[test]
    fn test_search_file_early_stop_at_cap() {
        let tmp = env::temp_dir().join(format!("mcp-search-test-{}", process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let path = write_jsonl(&tmp, "session-aaa.jsonl", 200);

        let mut p = SearchParams::default();
        p.types = vec!["user".to_string()]; // 默认含 user，但显式收紧避免被其他默认类型干扰
        p.pattern = String::new(); // 全部命中

        let cap = 50;
        let file_result = search_file("proj", "session-aaa", &path, &p, None, None, cap);
        let lines_scanned = file_result.lines_scanned;
        let results = file_result.results;
        assert!(
            results.len() <= cap,
            "results.len()={} should be <= cap={}",
            results.len(),
            cap
        );
        assert_eq!(results.len(), cap, "should hit exactly cap");
        assert!(file_result.truncated, "should mark per-file truncation");
        // lines_scanned 在 break 前已 +1，所以 ≤ cap 行（每行命中即 push 后才检查 break）
        assert!(
            lines_scanned <= cap + 1 && lines_scanned >= cap,
            "lines_scanned={} should be near cap={}",
            lines_scanned,
            cap
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_search_file_no_break_when_under_cap() {
        let tmp = env::temp_dir().join(format!("mcp-search-test2-{}", process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let path = write_jsonl(&tmp, "session-bbb.jsonl", 30);

        let mut p = SearchParams::default();
        p.types = vec!["user".to_string()];
        p.pattern = String::new();

        let file_result = search_file("proj", "session-bbb", &path, &p, None, None, 1000);
        assert_eq!(file_result.results.len(), 30, "all 30 should be returned");
        assert_eq!(file_result.lines_scanned, 30);
        assert!(!file_result.truncated, "should not mark truncation under cap");

        fs::remove_dir_all(&tmp).ok();
    }
}

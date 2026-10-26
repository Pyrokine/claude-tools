use crate::config::Config;
use crate::get::{OutputTransaction, ResolvedOutputFiles, resolve_output_files};
use crate::record_reader::{
    ByteSource, LineStep, RecordLines, SourceSpan, TextBytes, index_record, reader_error, render_text_range,
    stream_matches_pattern,
};
use crate::types::*;
use crate::utils::*;
use regex::{Regex, RegexBuilder};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashSet};
#[cfg(test)]
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn compare_results(a: &SearchResult, b: &SearchResult) -> std::cmp::Ordering {
    a.project
        .cmp(&b.project)
        .then_with(|| a.session.cmp(&b.session))
        .then_with(|| a.line.cmp(&b.line))
        .then_with(|| a.timestamp.cmp(&b.timestamp))
}

fn utc_day(timestamp: &str) -> Option<String> {
    parse_time(timestamp).map(|time| time.date_naive().format("%Y-%m-%d").to_string())
}

/// 搜索参数
#[derive(Clone)]
pub struct SearchParams {
    pub pattern: String,
    pub projects: Vec<String>,
    pub all_projects: bool,
    pub sessions: Vec<String>,
    pub source: Option<String>,
    pub sources: Vec<String>,
    pub output_content: String,
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    pub until: Option<UntilBound>,
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
    pub overwrite: bool,
    /// 是否包含 agent 子会话（默认 false）
    pub subagents: bool,
    pub structured: Option<String>,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            projects: Vec::new(),
            all_projects: false,
            sessions: Vec::new(),
            source: None,
            sources: Vec::new(),
            output_content: "preview".to_string(),
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
            overwrite: false,
            subagents: false,
            structured: None,
        }
    }
}

/// 全局命中硬上限（防止 OOM；超过即截断 + 在响应里标 truncated）
const GLOBAL_RESULT_CAP: usize = 50_000;
const STREAMING_UUID_DEDUPE_CAP: usize = GLOBAL_RESULT_CAP;
const MAX_SEARCH_RESULTS_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXPORT_RECORDS: usize = 20_000;
const MAX_EXPORT_BYTES: u64 = 16 * 1024 * 1024;
pub const DEFAULT_MAX_CONTENT: usize = 4_000;
pub const DEFAULT_MAX_CONTENT_TOOL_RESULT: usize = 500;
pub const DEFAULT_MAX_TOTAL: usize = 40_000;
pub const MIN_CONTENT_LIMIT: usize = 1;
pub const MAX_CONTENT_LIMIT: usize = 1_000_000;
pub const MIN_TOTAL_LIMIT: usize = 512;
pub const MAX_TOTAL_LIMIT: usize = 10_000_000;

struct FileSearchResult {
    lines_scanned: usize,
    results: Vec<SearchResult>,
    truncated: bool,
    read_errors: usize,
    parse_errors: usize,
    metadata_parse_errors: usize,
    invalid_timestamps: usize,
    metadata_issues: Vec<String>,
    attribution_issues: Vec<String>,
    result_bytes: usize,
    memory_capped: bool,
    oversized_lines: usize,
}

struct FileSearchLimits {
    max_matches: usize,
    max_bytes: usize,
}

fn push_jsonl_error_reasons(
    reasons: &mut Vec<String>,
    read_errors: usize,
    parse_errors: usize,
    metadata_parse_errors: usize,
) {
    if read_errors > 0 {
        reasons.push(format!("read_errors={read_errors}"));
    }
    if parse_errors > 0 {
        reasons.push(format!("parse_errors={parse_errors}"));
    }
    if metadata_parse_errors > 0 {
        reasons.push(format!("metadata_parse_error={metadata_parse_errors}"));
    }
}

fn push_time_filter_reason(reasons: &mut Vec<String>, invalid_timestamps: usize) {
    if invalid_timestamps > 0 {
        reasons.push(format!("timestamp_unparseable_excluded={invalid_timestamps}"));
    }
}

fn push_unique(values: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn normalize_filters(mut params: SearchParams) -> Result<SearchParams, ErrorResponse> {
    let message_filters =
        normalize_message_filters(&params.types, &params.subtypes, Some(&["assistant", "user", "summary"]))?;
    let mut normalized_types = message_filters.types;
    let mut normalized_subtypes = message_filters.subtypes;
    params.warnings.extend(message_filters.warnings);

    let mut normalized_tools = Vec::new();
    for value in &params.tools {
        push_unique(&mut normalized_tools, value.clone());
    }

    if params.failed_tool_results || params.tool_payload_errors {
        normalized_types.clear();
        normalized_subtypes.clear();
        push_unique(&mut normalized_types, "user");
        push_unique(&mut normalized_subtypes, "tool_result");
    }

    params.types = normalized_types;
    params.subtypes = normalized_subtypes;
    params.tools = normalized_tools;
    Ok(params)
}

pub(crate) fn effective_filters(params: &SearchParams) -> EffectiveFilters {
    EffectiveFilters {
        pattern: params.pattern.clone(),
        projects: params.projects.clone(),
        all_projects: params.all_projects,
        sessions: params.sessions.clone(),
        source: params.source.clone(),
        sources: params.sources.clone(),
        output_content: params.output_content.clone(),
        subagents: params.subagents,
        since: params.since.map(|v| v.to_rfc3339()),
        until: params.until.map(UntilBound::query_value),
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

pub(crate) struct SearchInputs {
    project_dirs: Vec<(String, PathBuf)>,
    pub(crate) files: Vec<SearchFile>,
    regex: Option<Regex>,
    pub(crate) search_pattern: Option<SearchPattern>,
}

struct SearchCollection {
    files_scanned: usize,
    lines_scanned: usize,
    invalid_timestamps: usize,
    results: Vec<SearchResult>,
    incomplete_reasons: Vec<String>,
    attribution_issues: Vec<String>,
    truncated_global: bool,
}

struct SearchWindow {
    range: std::ops::Range<usize>,
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
    let max_total = params.max_total;
    let continuation_query = build_next_query(&params, params.offset);
    let response = if params.dry_run {
        Ok(build_dry_run_response(
            &params,
            &inputs.project_dirs,
            &inputs.files,
            start,
        ))
    } else if params.output.is_some() {
        return search_to_output_bounded(
            &params,
            &inputs.files,
            inputs.regex.as_ref(),
            inputs.search_pattern.as_ref(),
            start,
        );
    } else if params.aggregate {
        search_aggregate_streaming(
            &params,
            &inputs.files,
            inputs.regex.as_ref(),
            inputs.search_pattern.as_ref(),
            start,
        )
    } else {
        let collection = collect_search_results(
            &params,
            &inputs.files,
            inputs.regex.as_ref(),
            inputs.search_pattern.as_ref(),
        )?;
        build_search_response(params, inputs.files, collection, start)
    }?;
    apply_response_budget(response, max_total, continuation_query)
}

pub(crate) fn prepare_search_params(params: SearchParams) -> Result<SearchParams, ErrorResponse> {
    let params = normalize_filters(params)?;
    validate_search_params(&params)?;
    Ok(params)
}

fn validate_search_params(params: &SearchParams) -> Result<(), ErrorResponse> {
    if params.source.is_some() && !params.sources.is_empty() {
        return Err(invalid_arguments("source 与 sources 互斥"));
    }
    if params.sources.len() > 128 || params.sources.iter().map(String::len).sum::<usize>() > 1024 * 1024 {
        return Err(invalid_arguments("sources 每组最多 128 个路径且合计不超过 1 MiB"));
    }
    if !["preview", "full"].contains(&params.output_content.as_str())
        || (params.output_content == "full" && params.output.is_none())
    {
        return Err(invalid_arguments(
            "output_content 仅支持 preview 或 full；full 需要 output",
        ));
    }
    if params
        .structured
        .as_deref()
        .is_some_and(|mode| mode != "preview" && mode != "full")
    {
        return Err(invalid_arguments("structured 仅支持 preview 或 full"));
    }
    if params.overwrite && params.output.is_none() {
        return Err(invalid_arguments("overwrite=true 需要 output"));
    }
    if let (Some(since), Some(until)) = (params.since, params.until)
        && (since > until.instant || (until.exclusive && since == until.instant))
    {
        return Err(invalid_arguments("since 不能晚于 until"));
    }
    if let Some(format) = &params.output_format
        && format != "jsonl"
    {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: format!("output_format 仅支持 jsonl，收到 {format}"),
            available: Some(serde_json::json!({ "formats": ["jsonl"] })),
        });
    }
    for (name, value) in [
        ("max_content", params.max_content),
        ("max_content_tool_result", params.max_content_tool_result),
    ] {
        if !(MIN_CONTENT_LIMIT..=MAX_CONTENT_LIMIT).contains(&value) {
            return Err(ErrorResponse {
                error: "invalid_arguments".to_string(),
                message: format!("{name} 必须在 {MIN_CONTENT_LIMIT}..={MAX_CONTENT_LIMIT} 之间"),
                available: Some(serde_json::json!({ "min": MIN_CONTENT_LIMIT, "max": MAX_CONTENT_LIMIT })),
            });
        }
    }
    if !(MIN_TOTAL_LIMIT..=MAX_TOTAL_LIMIT).contains(&params.max_total) {
        return Err(ErrorResponse {
            error: "invalid_arguments".to_string(),
            message: format!("max_total 必须在 {MIN_TOTAL_LIMIT}..={MAX_TOTAL_LIMIT} 字节之间"),
            available: Some(serde_json::json!({ "min": MIN_TOTAL_LIMIT, "max": MAX_TOTAL_LIMIT })),
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

pub(crate) fn prepare_search_inputs(config: &Config, params: &SearchParams) -> Result<SearchInputs, ErrorResponse> {
    let (project_dirs, mut files) = if params.source.is_some() || !params.sources.is_empty() {
        let sources = params.source.iter().chain(&params.sources);
        let files = sources
            .map(|source| crate::session_files::resolve_exact_source(config, source))
            .collect::<Result<Vec<_>, _>>()?;
        let project_dirs = if params.projects.is_empty() && !params.all_projects {
            files
                .iter()
                .map(|file| Ok((file.0.clone(), config.project_dir(&file.0)?)))
                .collect::<Result<Vec<_>, ErrorResponse>>()?
        } else {
            get_project_dirs(config, params)?
        };
        let mut selected_files = Vec::new();
        for file in files {
            let (project, _, path) = &file;
            let selected_project = project_dirs.iter().any(|(selected, _)| selected == project);
            let selected_layout = params.subagents
                || path.parent()
                    == Some(
                        config
                            .project_dir(project)?
                            .canonicalize()
                            .map_err(|error| reader_error("source_unavailable", error.to_string()))?
                            .as_path(),
                    );
            if !selected_project || !selected_layout {
                if params.source.is_some() {
                    return Err(reader_error(
                        "source_not_found",
                        "source 不属于指定项目或 subagents 范围",
                    ));
                }
                continue;
            }
            selected_files.push(file);
        }
        let files = selected_files;
        (project_dirs, files)
    } else {
        let project_dirs = get_project_dirs(config, params)?;
        let files = collect_jsonl_files(&project_dirs, &params.sessions, params.subagents)?;
        (project_dirs, files)
    };
    files.retain(|(_, session, _)| {
        params.sessions.is_empty()
            || params
                .sessions
                .iter()
                .any(|filter| session_matches_ref(session, filter))
    });
    files.sort();
    files.dedup();
    if params.sources.is_empty() {
        ensure_session_filters_unambiguous(&files, &params.sessions)?;
    }
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
            message: format!("无效的正则表达式: {e}"),
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
            skipped_invalid_timestamps: 0,
            total_matches: 0,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: true,
            incomplete: false,
            incomplete_reasons: Vec::new(),
            attribution_incomplete_reasons: Vec::new(),
            coverage,
            summary: None,
            slice: None,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            metadata_dimensions: BTreeMap::new(),
            truncated_global: None,
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output: None,
        warning: None,
        serialized_bytes: 0,
        max_total_bytes: params.max_total,
        limits_applied: Vec::new(),
        complete: true,
    }
}

fn collect_search_results(
    params: &SearchParams,
    files: &[SearchFile],
    regex: Option<&Regex>,
    search_pattern: Option<&SearchPattern>,
) -> Result<SearchCollection, ErrorResponse> {
    let mut results = Vec::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;
    let mut incomplete_reasons = Vec::new();
    let mut attribution_issues = Vec::new();
    let mut read_errors = 0usize;
    let mut parse_errors = 0usize;
    let mut metadata_parse_errors = 0usize;
    let mut invalid_timestamps = 0usize;
    let mut oversized_lines = 0usize;
    let mut remaining_bytes = MAX_SEARCH_RESULTS_BYTES;

    for (project_id, session_id, path) in files {
        crate::record_reader::check_work()?;
        let file_result = search_file(
            project_id,
            session_id,
            path,
            params,
            regex,
            search_pattern,
            FileSearchLimits {
                max_matches: GLOBAL_RESULT_CAP,
                max_bytes: remaining_bytes,
            },
        )?;
        files_scanned += 1;
        lines_scanned += file_result.lines_scanned;
        if file_result.truncated {
            push_unique(&mut incomplete_reasons, "per_file_cap");
        }
        if file_result.memory_capped {
            push_unique(&mut incomplete_reasons, "result_memory_cap");
        }
        remaining_bytes = remaining_bytes.saturating_sub(file_result.result_bytes);
        oversized_lines += file_result.oversized_lines;
        read_errors += file_result.read_errors;
        parse_errors += file_result.parse_errors;
        metadata_parse_errors += file_result.metadata_parse_errors;
        invalid_timestamps += file_result.invalid_timestamps;
        for issue in file_result.metadata_issues {
            push_unique(&mut incomplete_reasons, issue);
        }
        for issue in file_result.attribution_issues {
            push_unique(&mut attribution_issues, issue);
        }
        results.extend(file_result.results);
        if remaining_bytes == 0 || file_result.memory_capped {
            push_unique(&mut incomplete_reasons, "result_memory_cap");
            break;
        }
    }
    push_jsonl_error_reasons(
        &mut incomplete_reasons,
        read_errors,
        parse_errors,
        metadata_parse_errors,
    );
    push_time_filter_reason(&mut incomplete_reasons, invalid_timestamps);
    push_attribution_filter_reason(params, &mut incomplete_reasons, &attribution_issues);
    if oversized_lines > 0 {
        incomplete_reasons.push(format!("oversized_jsonl_lines={oversized_lines}"));
    }

    let mut ordered = Vec::with_capacity(results.len());
    for result in results {
        crate::record_reader::check_work()?;
        ordered.push((parse_time(&result.timestamp), result));
    }
    ordered.sort_by(|(a_time, a), (b_time, b)| a_time.cmp(b_time).then_with(|| compare_results(a, b)));
    crate::record_reader::check_work()?;
    let mut seen_uuids = HashSet::new();
    let mut results = Vec::with_capacity(ordered.len());
    for (_, result) in ordered {
        crate::record_reader::check_work()?;
        if result.uuid.is_empty() || seen_uuids.insert(result.uuid.clone()) {
            results.push(result);
        }
    }

    let truncated_global = !params.aggregate && results.len() > GLOBAL_RESULT_CAP;
    if truncated_global {
        incomplete_reasons.push("global_result_cap".to_string());
        results.truncate(GLOBAL_RESULT_CAP);
    }

    Ok(SearchCollection {
        files_scanned,
        lines_scanned,
        invalid_timestamps,
        results,
        incomplete_reasons,
        attribution_issues,
        truncated_global,
    })
}

fn select_search_window(params: &SearchParams, capped_total: usize) -> SearchWindow {
    if let Some(slice) = &params.slice {
        let (start, end) = normalize_message_slice(slice, capped_total);
        let total_after_slice = end.saturating_sub(start);
        return SearchWindow {
            range: start..end,
            slice_info: Some(SearchSliceInfo {
                raw: slice.raw.clone(),
                start,
                end,
                total_before_slice: capped_total,
                total_after_slice,
            }),
            selected_count: total_after_slice,
        };
    }
    if params.aggregate && params.output.is_none() {
        return SearchWindow {
            range: 0..0,
            slice_info: None,
            selected_count: 0,
        };
    }
    let start = params.offset.min(capped_total);
    let selected_count = capped_total.saturating_sub(params.offset);
    let end = start + selected_count.min(params.limit.unwrap_or(usize::MAX));
    SearchWindow {
        range: start..end,
        slice_info: None,
        selected_count,
    }
}

fn truncate_selected_results(params: &SearchParams, selected_results: Vec<SearchResult>) -> Vec<SearchResult> {
    if params.aggregate && params.output.is_none() {
        return Vec::new();
    }

    selected_results
        .into_iter()
        .map(|mut result| {
            let effective_max = if result.subtype == "tool_result" {
                params.max_content_tool_result
            } else {
                params.max_content
            };
            let (content, truncated) = truncate_around_match(&result.content, result.match_pos, effective_max);
            result.content = content;
            result.truncated = truncated || result.truncated;
            result
        })
        .collect()
}

fn build_search_response(
    params: SearchParams,
    files: Vec<SearchFile>,
    mut collection: SearchCollection,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let total_matches = collection.results.len();
    let window = select_search_window(&params, total_matches);
    let coverage = build_coverage(&collection.results, &files, collection.files_scanned)?;
    let summary = (params.summary || params.aggregate)
        .then(|| build_summary(&collection.results))
        .transpose()?;
    let selected_results = collection
        .results
        .into_iter()
        .skip(window.range.start)
        .take(window.range.len())
        .collect();
    let final_results = truncate_selected_results(&params, selected_results);
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
    let returned_results = if params.aggregate { Vec::new() } else { final_results };
    let returned_count = returned_results.len();
    let next_query = has_more.then(|| build_next_query(&params, next_offset));
    let total_matches_exact = collection.incomplete_reasons.iter().all(|reason| reason == "has_more");
    let warning = build_response_warning(&collection.incomplete_reasons, &collection.attribution_issues, &params);

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned: collection.files_scanned,
            lines_scanned: collection.lines_scanned,
            skipped_invalid_timestamps: collection.invalid_timestamps,
            total_matches,
            returned_count,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact,
            incomplete: !collection.incomplete_reasons.is_empty(),
            incomplete_reasons: collection.incomplete_reasons,
            attribution_incomplete_reasons: collection.attribution_issues,
            coverage,
            summary,
            slice: window.slice_info,
            effective_filters: effective_filters(&params),
            ignored_keys: params.ignored_keys,
            warnings: params.warnings,
            metadata_dimensions: BTreeMap::new(),
            truncated_global: collection.truncated_global.then_some(true),
        },
        results: returned_results,
        has_more,
        next_offset,
        next_query,
        output: None,
        warning,
        serialized_bytes: 0,
        max_total_bytes: params.max_total,
        limits_applied: Vec::new(),
        complete: true,
    })
}

fn compact_response_size(response: &SearchResponse) -> Result<usize, ErrorResponse> {
    crate::record_reader::serialize_json(std::io::sink(), response, false)
}

fn fixed_response_size(response: &mut SearchResponse) -> Result<usize, ErrorResponse> {
    let results = std::mem::take(&mut response.results);
    let size = compact_response_size(response);
    response.results = results;
    size
}

fn update_serialized_size(response: &mut SearchResponse) -> Result<usize, ErrorResponse> {
    for _ in 0..4 {
        let size = compact_response_size(response)?;
        if response.serialized_bytes == size {
            return Ok(size);
        }
        response.serialized_bytes = size;
    }
    compact_response_size(response)
}

fn mark_budget_limit(response: &mut SearchResponse) {
    if !response.limits_applied.iter().any(|value| value == "max_total") {
        response.limits_applied.push("max_total".to_string());
    }
    if !response
        .stats
        .incomplete_reasons
        .iter()
        .any(|value| value == "max_total")
    {
        response.stats.incomplete_reasons.push("max_total".to_string());
    }
    response.stats.incomplete = true;
    response.complete = false;
}

fn trim_metadata_values<T: serde::Serialize>(
    values: &mut Vec<T>,
    dimension: &str,
    dimensions: &mut BTreeMap<String, SearchMetadataDimension>,
    estimated: &mut usize,
    max_total: usize,
) -> Result<(), ErrorResponse> {
    if *estimated <= max_total || values.is_empty() {
        return Ok(());
    }
    let total = values.len();
    let old_dimensions = if dimensions.is_empty() {
        0
    } else {
        crate::record_reader::serialize_json(std::io::sink(), dimensions, false)? + "metadata_dimensions".len() + 4
    };
    if !dimensions.contains_key(dimension) {
        let mut omitted = dimensions.clone();
        omitted.insert(
            dimension.to_string(),
            SearchMetadataDimension {
                total,
                returned: 0,
                omitted: total,
            },
        );
        let diagnostic_bytes =
            crate::record_reader::serialize_json(std::io::sink(), &omitted, false)? + "metadata_dimensions".len() + 4
                - old_dimensions;
        let field_bytes = if matches!(
            dimension,
            "coverage.searched_files" | "coverage.skipped_files" | "warnings" | "ignored_keys"
        ) {
            dimension.rsplit('.').next().expect("dimension name").len() + 4
        } else {
            0
        };
        let removable_bytes =
            crate::record_reader::serialize_json(std::io::sink(), values, false)?.saturating_sub(2) + field_bytes;
        if removable_bytes <= diagnostic_bytes {
            return Ok(());
        }
    }
    dimensions
        .entry(dimension.to_string())
        .or_insert(SearchMetadataDimension {
            total,
            returned: total,
            omitted: 0,
        });
    let inserted_dimensions =
        crate::record_reader::serialize_json(std::io::sink(), dimensions, false)? + "metadata_dimensions".len() + 4;
    *estimated += inserted_dimensions - old_dimensions;
    while *estimated > max_total {
        let Some(value) = values.pop() else {
            break;
        };
        let bytes = crate::record_reader::serialize_json(std::io::sink(), &value, false)?;
        *estimated = estimated.saturating_sub(bytes + usize::from(!values.is_empty()));
    }
    let entry = dimensions.get_mut(dimension).expect("dimension was inserted");
    entry.returned = values.len();
    entry.omitted = entry.total - entry.returned;
    let final_dimensions =
        crate::record_reader::serialize_json(std::io::sink(), dimensions, false)? + "metadata_dimensions".len() + 4;
    *estimated = estimated
        .saturating_sub(inserted_dimensions)
        .saturating_add(final_dimensions);
    Ok(())
}

fn trim_response_metadata(
    response: &mut SearchResponse,
    estimated: &mut usize,
    max_total: usize,
) -> Result<(), ErrorResponse> {
    let dimensions = &mut response.stats.metadata_dimensions;
    for (name, values) in [
        ("coverage.searched_files", &mut response.stats.coverage.searched_files),
        ("coverage.skipped_files", &mut response.stats.coverage.skipped_files),
        ("warnings", &mut response.stats.warnings),
        ("ignored_keys", &mut response.stats.ignored_keys),
    ] {
        trim_metadata_values(values, name, dimensions, estimated, max_total)?;
    }
    if let Some(summary) = response.stats.summary.as_mut() {
        for (name, values) in [
            ("summary.by_day", &mut summary.by_day),
            ("summary.by_tool", &mut summary.by_tool),
            ("summary.by_server", &mut summary.by_server),
            ("summary.by_session", &mut summary.by_session),
            ("summary.by_project", &mut summary.by_project),
            ("summary.by_type", &mut summary.by_type),
        ] {
            trim_metadata_values(values, name, dimensions, estimated, max_total)?;
        }
    }
    for (name, values) in [
        ("coverage.sessions", &mut response.stats.coverage.sessions),
        ("coverage.projects", &mut response.stats.coverage.projects),
    ] {
        trim_metadata_values(values, name, dimensions, estimated, max_total)?;
    }
    Ok(())
}

fn structured_get_query(result: &SearchResult, view: &str) -> serde_json::Value {
    serde_json::json!({
        "ref": format!("{}:{}", result.session, result.line),
        "project": result.project,
        "source": result.source,
        "view": view,
        "block": result.block,
    })
}

fn replace_structured_value_with_preview(
    value: &mut Option<serde_json::Value>,
    get: serde_json::Value,
    structured_preview: bool,
) -> Result<bool, ErrorResponse> {
    let Some(original) = value.take() else {
        return Ok(false);
    };
    if original.get("budget_preview").and_then(serde_json::Value::as_bool) == Some(true)
        && original.get("get") == Some(&get)
    {
        *value = Some(original);
        return Ok(false);
    }
    let mut serialized = Vec::new();
    crate::record_reader::serialize_json(&mut serialized, &original, false)?;
    let (preview, _) = truncate_content(std::str::from_utf8(&serialized).expect("JSON is UTF-8"), 100);
    *value = Some(serde_json::json!({
        "preview": preview,
        "truncated": true,
        "budget_preview": true,
        "original_bytes": if structured_preview { original.get("original_bytes").and_then(serde_json::Value::as_u64).unwrap_or(serialized.len() as u64) } else { serialized.len() as u64 },
        "get": get,
    }));
    Ok(true)
}

fn trim_last_result_metadata(response: &mut SearchResponse, query: &serde_json::Value) -> Result<bool, ErrorResponse> {
    let Some(result) = response.results.last_mut() else {
        return Ok(false);
    };
    if query.get("structured").and_then(serde_json::Value::as_str) != Some("full") {
        let mut result_get = structured_get_query(result, "tool_result");
        let mut input_get = structured_get_query(result, "tool_input");
        if let Some(redaction) = query.get("redaction") {
            result_get["redaction"] = redaction.clone();
            input_get["redaction"] = redaction.clone();
        }
        let structured_preview = query.get("structured").and_then(serde_json::Value::as_str) == Some("preview");
        if replace_structured_value_with_preview(&mut result.tool_result_redacted, result_get, structured_preview)?
            || replace_structured_value_with_preview(&mut result.tool_input_redacted, input_get, structured_preview)?
        {
            result.truncated = true;
            return Ok(true);
        }
    }
    if !result.images.is_empty() {
        result.images.clear();
        result.truncated = true;
        return Ok(true);
    }
    if result.matched_filters.pop().is_some() {
        result.truncated = true;
        return Ok(true);
    }
    Ok(false)
}

fn shorten_last_result(
    response: &mut SearchResponse,
    max_total: usize,
    other_bytes: usize,
) -> Result<bool, ErrorResponse> {
    let Some(result) = response.results.last_mut() else {
        return Ok(false);
    };
    let original = std::mem::take(&mut result.content);
    if original.is_empty() {
        return Ok(false);
    }
    let original_truncated = result.truncated;
    let mut low = 0usize;
    let mut high = original.chars().count();
    let mut best = None;
    while low <= high {
        crate::record_reader::check_work()?;
        let mid = low + (high - low) / 2;
        result.content = truncate_content(&original, mid).0;
        result.truncated = true;
        let size = crate::record_reader::serialize_json(std::io::sink(), result, false)?;
        if other_bytes.saturating_add(size) <= max_total {
            best = Some(result.content.clone());
            low = mid.saturating_add(1);
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    if let Some(content) = best {
        result.content = content;
        return Ok(true);
    }
    result.content = original;
    result.truncated = original_truncated;
    Ok(false)
}

fn response_too_large_error(
    response: &SearchResponse,
    max_total: usize,
    mut query: serde_json::Value,
) -> ErrorResponse {
    let redaction = query.get("redaction").cloned();
    let next_query = if response.serialized_bytes <= MAX_TOTAL_LIMIT {
        query["max_total"] = serde_json::json!(
            response
                .serialized_bytes
                .saturating_add(64)
                .clamp(MIN_TOTAL_LIMIT, MAX_TOTAL_LIMIT)
        );
        Some(query)
    } else {
        None
    };
    let get = response.results.first().map(|result| {
        let view = if result.tool_result_redacted.is_some() {
            "tool_result"
        } else if result.tool_input_redacted.is_some() {
            "tool_input"
        } else {
            "content"
        };
        let mut get = structured_get_query(result, view);
        if let Some(redaction) = &redaction {
            get["redaction"] = redaction.clone();
        }
        get
    });
    ErrorResponse {
        error: "response_too_large".to_string(),
        message: "搜索响应无法在 max_total 字节预算内返回任何结果，请使用恢复查询或 history_get 读取目标记录"
            .to_string(),
        available: Some(serde_json::json!({
            "serialized_bytes": response.serialized_bytes,
            "required_bytes": response.serialized_bytes,
            "max_total_bytes": max_total,
            "limits_applied": response.limits_applied,
            "metadata_dimensions": response.stats.metadata_dimensions,
            "next_query": next_query,
            "get": get,
            "complete": false
        })),
    }
}

fn apply_response_budget(
    mut response: SearchResponse,
    max_total: usize,
    continuation_query: serde_json::Value,
) -> Result<SearchResponse, ErrorResponse> {
    let original_result_count = response.results.len();
    let slice_bounds = response.stats.slice.as_ref().map(|slice| (slice.start, slice.end));
    let base_offset = slice_bounds
        .map(|(start, _)| start)
        .unwrap_or_else(|| response.next_offset.saturating_sub(original_result_count));
    response.max_total_bytes = max_total;
    response.complete = !response.stats.incomplete;
    if update_serialized_size(&mut response)? <= max_total {
        return Ok(response);
    }

    mark_budget_limit(&mut response);
    let original_has_more = response.has_more;
    let mut row_sizes = response
        .results
        .iter()
        .map(|result| crate::record_reader::serialize_json(std::io::sink(), result, false))
        .collect::<Result<Vec<_>, _>>()?;
    let mut row_bytes: usize = row_sizes.iter().sum();
    loop {
        crate::record_reader::check_work()?;
        response.stats.returned_count = response.results.len();
        response.next_offset = base_offset.saturating_add(response.results.len());
        let budget_removed_results = response.results.len() < original_result_count;
        response.has_more = if let Some((_, slice_end)) = slice_bounds {
            budget_removed_results && response.next_offset < slice_end
        } else {
            original_has_more || budget_removed_results
        };
        if response.has_more {
            let next_query = response
                .next_query
                .get_or_insert_with(|| continuation_query.clone())
                .as_object_mut()
                .expect("build_next_query returns an object");
            if let Some((_, slice_end)) = slice_bounds {
                next_query.remove("offset");
                next_query.remove("limit");
                next_query.insert(
                    "slice".to_string(),
                    serde_json::Value::String(format!("[{}:{slice_end}]", response.next_offset)),
                );
            } else {
                next_query.remove("slice");
                next_query.insert("offset".to_string(), serde_json::json!(response.next_offset));
            }
            next_query.insert("max_total".to_string(), serde_json::json!(max_total));
        } else {
            response.next_query = None;
        }
        let mut estimated = fixed_response_size(&mut response)?
            .saturating_add(row_bytes)
            .saturating_add(response.results.len().saturating_sub(1));
        if estimated <= max_total && update_serialized_size(&mut response)? <= max_total {
            return Ok(response);
        }
        trim_response_metadata(&mut response, &mut estimated, max_total)?;
        let fixed = fixed_response_size(&mut response)?;
        estimated = fixed
            .saturating_add(row_bytes)
            .saturating_add(response.results.len().saturating_sub(1));
        if estimated <= max_total && update_serialized_size(&mut response)? <= max_total {
            return Ok(response);
        }
        let before = response.results.len();
        while estimated > max_total && response.results.len() > 1 {
            crate::record_reader::check_work()?;
            response.results.pop();
            let removed = row_sizes.pop().expect("one size per result");
            row_bytes -= removed;
            estimated = estimated.saturating_sub(removed + 1);
        }
        if response.results.len() != before {
            continue;
        }
        let Some(last_bytes) = row_sizes.last().copied() else {
            update_serialized_size(&mut response)?;
            return Err(response_too_large_error(&response, max_total, continuation_query));
        };
        let other_bytes = fixed + row_bytes - last_bytes + response.results.len().saturating_sub(1);
        if shorten_last_result(&mut response, max_total, other_bytes)?
            || trim_last_result_metadata(&mut response, &continuation_query)?
        {
            let updated = crate::record_reader::serialize_json(
                std::io::sink(),
                response.results.last().expect("result exists"),
                false,
            )?;
            row_bytes = row_bytes - last_bytes + updated;
            *row_sizes.last_mut().expect("size exists") = updated;
            continue;
        }
        update_serialized_size(&mut response)?;
        let mut recovery = continuation_query;
        if let Some((_, end)) = slice_bounds {
            if let Some(query) = recovery.as_object_mut() {
                query.remove("offset");
                query.remove("limit");
                query.insert("slice".to_string(), serde_json::json!(format!("[{base_offset}:{end}]")));
            }
        } else {
            recovery["offset"] = serde_json::json!(base_offset);
        }
        return Err(response_too_large_error(&response, max_total, recovery));
    }
}

fn build_response_warning(
    incomplete_reasons: &[String],
    attribution_issues: &[String],
    params: &SearchParams,
) -> Option<String> {
    if incomplete_reasons.is_empty()
        && attribution_issues.is_empty()
        && params.warnings.is_empty()
        && params.ignored_keys.is_empty()
    {
        return None;
    }

    let mut parts = Vec::new();
    if !incomplete_reasons.is_empty() {
        parts.push(format!("结果不完整，原因: {}", incomplete_reasons.join(",")));
    }
    if !attribution_issues.is_empty() {
        parts.push(format!("工具归因不完整，原因: {}", attribution_issues.join(",")));
    }
    if !params.warnings.is_empty() {
        parts.push(format!("查询提示: {}", params.warnings.join("; ")));
    }
    if !params.ignored_keys.is_empty() {
        parts.push(format!("存在未识别参数: {}", params.ignored_keys.join(",")));
    }
    Some(parts.join("；"))
}

pub(crate) fn ensure_session_filters_unambiguous(
    files: &[(String, String, PathBuf)],
    sessions: &[String],
) -> Result<(), ErrorResponse> {
    if sessions.is_empty() {
        return Ok(());
    }

    for filter in sessions {
        let mut matches = BTreeSet::new();
        for (project, session, source) in files {
            crate::record_reader::check_work()?;
            if session_matches_ref(session, filter) {
                matches.insert((project, session, source));
            }
        }
        if matches.is_empty() {
            return Err(ErrorResponse {
                error: "session_not_found".to_string(),
                message: format!("找不到 session 过滤条件: {filter}"),
                available: None,
            });
        }
        if matches.len() > 1 {
            return Err(ErrorResponse {
                error: "session_ambiguous".to_string(),
                message: format!(
                    "session 过滤条件不唯一: {filter}；请原样传入 available.sources 中的 source 精确选择物理来源"
                ),
                available: Some(serde_json::json!({
                    "candidates": matches.iter().map(|(project, session, _)| format!("{project}:{session}")).collect::<Vec<_>>(),
                    "sources": matches.iter().map(|(project, session, source)| serde_json::json!({"project": project, "session": session, "source": source})).collect::<Vec<_>>()
                })),
            });
        }
    }

    Ok(())
}

pub(crate) fn build_next_query(params: &SearchParams, next_offset: usize) -> serde_json::Value {
    let mut query = serde_json::Map::new();
    if let Some(source) = &params.source {
        query.insert("source".to_string(), serde_json::json!(source));
    }
    if !params.sources.is_empty() {
        query.insert("sources".to_string(), serde_json::json!(params.sources));
    }
    query.insert("output_content".to_string(), serde_json::json!(params.output_content));
    if let Some(output) = &params.output {
        query.insert("output".to_string(), serde_json::json!(output));
    }
    if let Some(format) = &params.output_format {
        query.insert("output_format".to_string(), serde_json::json!(format));
    }
    if params.overwrite {
        query.insert("overwrite".to_string(), serde_json::json!(true));
    }
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
        query.insert("until".to_string(), serde_json::Value::String(until.query_value()));
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
    if !params.lines.is_empty() {
        query.insert(
            "lines".to_string(),
            serde_json::Value::String(format_line_ranges(&params.lines)),
        );
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
    if params.aggregate {
        query.insert("aggregate".to_string(), serde_json::Value::Bool(true));
    }
    if params.dry_run {
        query.insert("dry_run".to_string(), serde_json::Value::Bool(true));
    }
    if let Some(structured) = &params.structured {
        query.insert("structured".to_string(), serde_json::json!(structured));
    }
    if let Some(slice) = &params.slice {
        query.remove("offset");
        query.insert("slice".to_string(), serde_json::json!(slice.raw));
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
    query.insert("max_content".to_string(), serde_json::json!(params.max_content));
    query.insert(
        "max_content_tool_result".to_string(),
        serde_json::json!(params.max_content_tool_result),
    );
    query.insert("max_total".to_string(), serde_json::json!(params.max_total));
    if params.redaction != RedactionMode::Auto {
        query.insert(
            "redaction".to_string(),
            serde_json::Value::String(params.redaction.as_str().to_string()),
        );
    }
    if params.slice.is_none() {
        query.insert("offset".to_string(), serde_json::json!(next_offset));
    }
    if let Some(limit) = params.limit {
        query.insert("limit".to_string(), serde_json::json!(limit.max(1)));
    }
    serde_json::Value::Object(query)
}

fn build_coverage(
    results: &[SearchResult],
    files: &[SearchFile],
    files_scanned: usize,
) -> Result<SearchCoverage, ErrorResponse> {
    let (attempted, skipped) = files.split_at(files_scanned);
    let mut projects = BTreeSet::new();
    let mut sessions = BTreeSet::new();
    let mut start: Option<String> = None;
    let mut end: Option<String> = None;

    for result in results {
        crate::record_reader::check_work()?;
        projects.insert(result.project.clone());
        sessions.insert(result.session.clone());
        if start
            .as_ref()
            .is_none_or(|s| parse_time(&result.timestamp) < parse_time(s))
        {
            start = Some(result.timestamp.clone());
        }
        if end
            .as_ref()
            .is_none_or(|s| parse_time(&result.timestamp) > parse_time(s))
        {
            end = Some(result.timestamp.clone());
        }
    }

    crate::record_reader::check_work()?;
    Ok(SearchCoverage {
        start,
        end,
        projects: projects.into_iter().collect(),
        sessions: sessions.into_iter().collect(),
        searched_files: searched_files(attempted),
        skipped_files: searched_files(skipped),
    })
}

fn buckets(map: BTreeMap<String, usize>) -> Vec<SummaryBucket> {
    map.into_iter()
        .map(|(key, count)| SummaryBucket { key, count })
        .collect()
}

fn build_summary(results: &[SearchResult]) -> Result<SearchSummary, ErrorResponse> {
    let mut by_project = BTreeMap::new();
    let mut by_session = BTreeMap::new();
    let mut by_type = BTreeMap::new();
    let mut by_server = BTreeMap::new();
    let mut by_tool = BTreeMap::new();
    let mut by_day = BTreeMap::new();

    for result in results {
        crate::record_reader::check_work()?;
        *by_project.entry(result.project.clone()).or_insert(0) += 1;
        *by_session.entry(result.session.clone()).or_insert(0) += 1;
        *by_type
            .entry(format!("{}:{}", result.r#type, result.subtype))
            .or_insert(0) += 1;
        if let Some(day) = utc_day(&result.timestamp) {
            *by_day.entry(day).or_insert(0) += 1;
        }
        if let Some(server) = &result.server {
            *by_server.entry(server.clone()).or_insert(0) += 1;
        }
        if let Some(tool) = &result.tool {
            *by_tool.entry(tool.clone()).or_insert(0) += 1;
        }
    }

    crate::record_reader::check_work()?;
    Ok(SearchSummary {
        by_project: buckets(by_project),
        by_session: buckets(by_session),
        by_type: buckets(by_type),
        by_server: buckets(by_server),
        by_tool: buckets(by_tool),
        by_day: buckets(by_day),
    })
}

fn resolve_search_output_paths(raw_output: &str) -> Result<ResolvedOutputFiles, ErrorResponse> {
    let path = raw_output
        .strip_prefix("tmp:")
        .or_else(|| raw_output.strip_prefix("cwd:"))
        .unwrap_or(raw_output);
    let extension = Path::new(path).extension().and_then(|ext| ext.to_str());
    if extension.is_some_and(|ext| ext != "jsonl") {
        return Err(invalid_arguments("search output 文件扩展名必须是 .jsonl"));
    }
    resolve_output_files(raw_output, "search-results.jsonl", "search-manifest.json")
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
    matches: usize,
    retained_bytes: usize,
}

impl SearchAggregation {
    fn observe(&mut self, result: &SearchResult) -> Result<(), &'static str> {
        if self.matches >= GLOBAL_RESULT_CAP {
            return Err("aggregate_matches_cap");
        }
        let cost = result.uuid.len()
            + result.project.len() * 2
            + result.session.len() * 2
            + result.r#type.len()
            + result.subtype.len()
            + result.timestamp.len() * 2
            + result.server.as_ref().map_or(0, |value| value.len())
            + result.tool.as_ref().map_or(0, |value| value.len())
            + 256;
        if self.retained_bytes.saturating_add(cost) > MAX_SEARCH_RESULTS_BYTES {
            return Err("aggregate_bytes_cap");
        }
        self.matches += 1;
        self.retained_bytes += cost;
        self.projects.insert(result.project.clone());
        self.sessions.insert(result.session.clone());
        if self
            .start
            .as_ref()
            .is_none_or(|s| parse_time(&result.timestamp) < parse_time(s))
        {
            self.start = Some(result.timestamp.clone());
        }
        if self
            .end
            .as_ref()
            .is_none_or(|s| parse_time(&result.timestamp) > parse_time(s))
        {
            self.end = Some(result.timestamp.clone());
        }
        *self.by_project.entry(result.project.clone()).or_insert(0) += 1;
        *self.by_session.entry(result.session.clone()).or_insert(0) += 1;
        *self
            .by_type
            .entry(format!("{}:{}", result.r#type, result.subtype))
            .or_insert(0) += 1;
        if let Some(day) = utc_day(&result.timestamp) {
            *self.by_day.entry(day).or_insert(0) += 1;
        }
        if let Some(server) = &result.server {
            *self.by_server.entry(server.clone()).or_insert(0) += 1;
        }
        if let Some(tool) = &result.tool {
            *self.by_tool.entry(tool.clone()).or_insert(0) += 1;
        }
        Ok(())
    }

    fn coverage(self, files: &[SearchFile], files_scanned: usize) -> SearchCoverage {
        let (attempted, skipped) = files.split_at(files_scanned);
        SearchCoverage {
            start: self.start,
            end: self.end,
            projects: self.projects.into_iter().collect(),
            sessions: self.sessions.into_iter().collect(),
            searched_files: searched_files(attempted),
            skipped_files: searched_files(skipped),
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

struct SearchManifestContext<'a> {
    results_path: &'a Path,
    manifest_path: &'a Path,
    staging_manifest: &'a Path,
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
    attribution_issues: &'a [String],
    bytes: u64,
    max_content: usize,
    max_content_tool_result: usize,
    max_records: usize,
    max_bytes: u64,
    output_content: &'a str,
    selected_start: usize,
    selected_count: usize,
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
        "schema": "mcp-claude-history.search-results.v2",
        "results": ctx.results_path,
        "count": ctx.written_count,
        "total_matches": ctx.total_matches,
        "export_scope": export_scope,
        "sample_kind": sample_kind,
        "complete": ctx.complete,
        "content_truncated_count": ctx.content_truncated_count,
        "record_set_complete": ctx.complete,
        "content_complete": ctx.content_truncated_count == 0,
        "output_content": ctx.output_content,
        "unexported_range": {"start":ctx.selected_start + ctx.written_count,"end":ctx.selected_start + ctx.selected_count},
        "redacted_count": ctx.redacted_count,
        "bytes": ctx.bytes,
        "lines": ctx.written_count,
        "coverage": ctx.coverage,
        "summary": ctx.summary,
        "slice": ctx.slice,
        "incomplete_reasons": ctx.incomplete_reasons,
        "attribution_incomplete_reasons": ctx.attribution_issues,
        "cap_reasons": ctx.incomplete_reasons,
        "max_content": ctx.max_content,
        "max_content_tool_result": ctx.max_content_tool_result,
        "max_export_records": ctx.max_records,
        "max_export_bytes": ctx.max_bytes,
        "redaction": &redaction,
    });
    let mut manifest_file = open_private_output_file(ctx.staging_manifest)?;
    crate::record_reader::serialize_json(&mut manifest_file, &manifest, true)?;
    manifest_file.sync_all().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("同步搜索 manifest 失败: {e}"),
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
        retention: None,
    })
}

/// 获取要搜索的项目目录
pub(crate) fn get_project_dirs(
    config: &Config,
    params: &SearchParams,
) -> Result<Vec<(String, PathBuf)>, ErrorResponse> {
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
            message: format!("无法读取项目目录: {e}"),
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
                    message: format!("项目不存在: {normalized}"),
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

/// 收集所有 jsonl 文件
fn collect_jsonl_files(
    project_dirs: &[(String, PathBuf)],
    sessions: &[String],
    include_subagents: bool,
) -> Result<Vec<(String, String, PathBuf)>, ErrorResponse> {
    crate::session_files::collect_session_files(project_dirs, sessions, include_subagents)
}

fn search_aggregate_streaming(
    params: &SearchParams,
    files: &[(String, String, PathBuf)],
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let mut aggregation = SearchAggregation::default();
    let mut seen_uuids = HashSet::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;
    let mut total_matches = 0;
    let mut incomplete_reasons = Vec::new();
    let mut attribution_issues = Vec::new();
    let mut read_errors = 0usize;
    let mut parse_errors = 0usize;
    let mut metadata_parse_errors = 0usize;
    let mut invalid_timestamps = 0usize;
    for (project_id, session_id, path) in files {
        crate::record_reader::check_work()?;
        files_scanned += 1;
        let prefix = ref_prefix(session_id);
        let ctx = RecordBuildContext {
            project_id,
            session_id,
            source: path,
            prefix: &prefix,
            params,
            regex,
            pattern,
        };
        let mut stopped = false;
        let stats = visit_search_file(&ctx, |result| {
            if !result.uuid.is_empty() {
                if seen_uuids.contains(&result.uuid) {
                    return Ok(true);
                }
                if seen_uuids.len() >= STREAMING_UUID_DEDUPE_CAP {
                    push_unique(&mut incomplete_reasons, "uuid_dedupe_cap");
                    stopped = true;
                    return Ok(false);
                }
            }
            if let Err(reason) = aggregation.observe(&result) {
                push_unique(&mut incomplete_reasons, reason);
                stopped = true;
                return Ok(false);
            }
            if !result.uuid.is_empty() {
                seen_uuids.insert(result.uuid.clone());
            }
            total_matches += 1;
            Ok(true)
        })?;
        lines_scanned += stats.lines_scanned;
        read_errors += stats.read_errors;
        parse_errors += stats.parse_errors;
        metadata_parse_errors += stats.metadata_parse_errors;
        invalid_timestamps += stats.invalid_timestamps;
        for issue in stats.metadata_issues {
            push_unique(&mut incomplete_reasons, issue);
        }
        for issue in stats.attribution_issues {
            push_unique(&mut attribution_issues, issue);
        }
        if stopped
            || incomplete_reasons.iter().any(|reason| {
                matches!(
                    reason.as_str(),
                    "tool_blocks_cap" | "tool_pending_cap" | "tool_pending_bytes_cap"
                )
            })
        {
            break;
        }
    }

    push_jsonl_error_reasons(
        &mut incomplete_reasons,
        read_errors,
        parse_errors,
        metadata_parse_errors,
    );
    push_time_filter_reason(&mut incomplete_reasons, invalid_timestamps);
    push_attribution_filter_reason(params, &mut incomplete_reasons, &attribution_issues);
    incomplete_reasons.sort();
    incomplete_reasons.dedup();
    crate::record_reader::check_work()?;
    let summary_value = Some(aggregation.summary());
    let coverage = aggregation.coverage(files, files_scanned);
    let warning = build_response_warning(&incomplete_reasons, &attribution_issues, params);

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned,
            lines_scanned,
            skipped_invalid_timestamps: invalid_timestamps,
            total_matches,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: incomplete_reasons.is_empty(),
            incomplete: !incomplete_reasons.is_empty(),
            incomplete_reasons,
            attribution_incomplete_reasons: attribution_issues,
            coverage,
            summary: summary_value,
            slice: None,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            metadata_dimensions: BTreeMap::new(),
            truncated_global: None,
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output: None,
        warning,
        serialized_bytes: 0,
        max_total_bytes: params.max_total,
        limits_applied: Vec::new(),
        complete: true,
    })
}

fn validate_export_source(result: &SearchResult) -> Result<std::fs::File, ErrorResponse> {
    let (_, expected) = result
        .locator
        .as_ref()
        .ok_or_else(|| reader_error("source_changed", "全文导出缺少来源定位"))?;
    let path = result
        .source
        .as_deref()
        .ok_or_else(|| reader_error("source_changed", "全文导出缺少来源"))?;
    let file = crate::session_files::open_session_file(Path::new(path))
        .map_err(|error| reader_error("source_changed", format!("{path}: {error}")))?;
    let actual = file
        .metadata()
        .map_err(|error| reader_error("source_changed", error.to_string()))?;
    if actual.len() != expected.len() || !crate::session_files::matches_snapshot(expected, &actual) {
        return Err(reader_error(
            "source_changed",
            format!("{path} 在排序后发生变化，未发布全文导出"),
        ));
    }
    Ok(file)
}

fn write_full_result(
    output: &mut std::fs::File,
    result: &SearchResult,
    params: &SearchParams,
    remaining: u64,
) -> Result<(u64, usize), ErrorResponse> {
    struct CappedWriter<'a> {
        file: &'a mut std::fs::File,
        remaining: u64,
        bytes: u64,
        exceeded: bool,
    }
    impl Write for CappedWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() as u64 > self.remaining {
                self.exceeded = true;
                return Err(std::io::Error::other("export_byte_cap"));
            }
            let written = self.file.write(bytes)?;
            self.remaining -= written as u64;
            self.bytes += written as u64;
            Ok(written)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }
    let start = output
        .stream_position()
        .map_err(|error| reader_error("io_error", error.to_string()))?;
    let mut writer = CappedWriter {
        file: output,
        remaining,
        bytes: 0,
        exceeded: false,
    };
    let exported = (|| {
        let file = validate_export_source(result)?;
        let span = result.locator.as_ref().expect("validated locator").0;
        let open = || {
            file.try_clone()
                .map_err(|error| reader_error("io_error", error.to_string()))
        };
        let indexed = index_record(open()?, span, true)?;
        if indexed
            .metadata
            .as_ref()
            .is_none_or(|metadata| metadata.uuid != result.uuid || metadata.timestamp != result.timestamp)
        {
            return Err(reader_error("source_changed", "来源记录与排序定位不一致"));
        }
        let mut metadata =
            serde_json::to_value(result).map_err(|error| reader_error("serialize_error", error.to_string()))?;
        let values = metadata.as_object_mut().expect("search result object");
        values.remove("content");
        values.remove("tool_input_redacted");
        values.remove("tool_result_redacted");
        writer
            .write_all(b"{")
            .map_err(|error| reader_error("io_error", error.to_string()))?;
        for (key, value) in values {
            crate::record_reader::serialize_json(&mut writer, key, false)?;
            writer
                .write_all(b":")
                .map_err(|error| reader_error("io_error", error.to_string()))?;
            crate::record_reader::serialize_json(&mut writer, value, false)?;
            writer
                .write_all(b",")
                .map_err(|error| reader_error("io_error", error.to_string()))?;
        }
        writer
            .write_all(b"\"content\":\"")
            .map_err(|error| reader_error("io_error", error.to_string()))?;
        let projection = indexed.projection(open()?, span, "content", None)?;
        let mut text = TextBytes::new(projection.cursor(open()?, span));
        let (_, _, mut redactions) = render_text_range(&mut text, params.redaction, None, |chunk| {
            let text = std::str::from_utf8(chunk).map_err(|_| reader_error("invalid_utf8", "正文 UTF-8 无效"))?;
            let escaped =
                serde_json::to_vec(text).map_err(|error| reader_error("serialize_error", error.to_string()))?;
            writer
                .write_all(&escaped[1..escaped.len() - 1])
                .map_err(|error| reader_error("io_error", error.to_string()))
        })?;
        writer
            .write_all(b"\"")
            .map_err(|error| reader_error("io_error", error.to_string()))?;
        if let Some(block) = result.block {
            let record = indexed.association_record(open()?, span, false)?;
            let kind = record
                .message
                .as_ref()
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_array)
                .and_then(|content| content.get(block))
                .and_then(|item| item.get("type"))
                .and_then(serde_json::Value::as_str);
            let (view, field) = match kind {
                Some("tool_use") => ("tool_input", "tool_input_redacted"),
                Some("tool_result") => ("tool_result", "tool_result_redacted"),
                _ => return Err(reader_error("block_not_found", "选中的原始 content 下标不是工具块")),
            };
            writer
                .write_all(format!(",\"{field}\":").as_bytes())
                .map_err(|error| reader_error("io_error", error.to_string()))?;
            if params.structured.as_deref() == Some("preview") {
                let projection = indexed.structured_projection(open()?, span, view, Some(block), params.redaction)?;
                let mut text = TextBytes::new(projection.cursor(open()?, span));
                let maximum = if view == "tool_input" {
                    params.max_content
                } else {
                    params.max_content_tool_result
                };
                let mut preview = String::new();
                let mut characters = 0;
                let mut original_bytes = 0;
                let (_, rendered, count) = render_text_range(&mut text, params.redaction, None, |chunk| {
                    original_bytes += chunk.len();
                    for character in std::str::from_utf8(chunk)
                        .map_err(|_| reader_error("invalid_utf8", "结构 UTF-8 无效"))?
                        .chars()
                    {
                        if characters < maximum {
                            preview.push(character);
                        }
                        characters += 1;
                    }
                    Ok(())
                })?;
                redactions += count;
                let value = serde_json::json!({"preview":preview,"truncated":rendered > maximum,"original_bytes":original_bytes,
                    "get":{"ref":format!("{}:{}", result.session,result.line),"project":result.project,"source":result.source,"view":view,"block":block,"redaction":params.redaction.as_str()}});
                crate::record_reader::serialize_json(&mut writer, &value, false)?;
            } else {
                let projection = indexed.structured_projection(open()?, span, view, Some(block), params.redaction)?;
                let mut text = TextBytes::new(projection.cursor(open()?, span));
                let (_, _, count) = render_text_range(&mut text, params.redaction, None, |chunk| {
                    writer
                        .write_all(chunk)
                        .map_err(|error| reader_error("io_error", error.to_string()))
                })?;
                redactions += count;
            }
        }
        writer
            .write_all(b"}\n")
            .map_err(|error| reader_error("io_error", error.to_string()))?;
        validate_export_source(result)?;
        Ok((writer.bytes, redactions))
    })();
    if writer.exceeded {
        writer
            .file
            .set_len(start)
            .and_then(|_| writer.file.seek(SeekFrom::Start(start)))
            .map_err(|error| reader_error("io_error", format!("恢复完整 JSONL 边界失败: {error}")))?;
        return Err(reader_error(
            "export_byte_cap",
            "全文导出达到 16 MiB，保留此前完整 JSONL 条目",
        ));
    }
    exported
}

fn search_to_output_bounded(
    params: &SearchParams,
    files: &[SearchFile],
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    start: Instant,
) -> Result<SearchResponse, ErrorResponse> {
    let collection = collect_search_results(params, files, regex, pattern)?;
    let total_matches = collection.results.len();
    let window = select_search_window(params, total_matches);
    let mut incomplete_reasons = collection.incomplete_reasons;
    let attribution_issues = collection.attribution_issues;
    let coverage = build_coverage(&collection.results, files, collection.files_scanned)?;
    let summary = (params.summary || params.aggregate)
        .then(|| build_summary(&collection.results))
        .transpose()?;
    let selected_results = collection
        .results
        .into_iter()
        .skip(window.range.start)
        .take(window.range.len())
        .collect();
    let selected_results = if params.output_content == "full" {
        selected_results
    } else {
        truncate_selected_results(params, selected_results)
    };

    let resolved = resolve_search_output_paths(params.output.as_deref().expect("output checked by caller"))?;
    let temp_output = resolved.temp_output;
    let transaction = OutputTransaction::begin(resolved, params.overwrite)?;
    let results_path = transaction.content();
    let manifest_path = transaction.manifest();
    let mut file = open_private_output_file(&transaction.staging_content())?;
    let mut bytes = 0u64;
    let mut written_count = 0usize;
    let mut redacted_count = 0usize;
    let mut content_truncated_count = 0usize;
    for result in &selected_results {
        if written_count == MAX_EXPORT_RECORDS {
            push_unique(&mut incomplete_reasons, "export_record_cap");
            break;
        }
        if params.output_content == "full" {
            match write_full_result(&mut file, result, params, MAX_EXPORT_BYTES.saturating_sub(bytes)) {
                Ok((written, redactions)) => {
                    bytes += written;
                    written_count += 1;
                    redacted_count += redactions;
                    continue;
                }
                Err(error) if error.error == "export_byte_cap" => {
                    push_unique(&mut incomplete_reasons, "export_byte_cap");
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        let mut line = Vec::new();
        crate::record_reader::serialize_json(&mut line, &result, false)?;
        let next_bytes = bytes.saturating_add(line.len() as u64 + 1);
        if next_bytes > MAX_EXPORT_BYTES {
            push_unique(&mut incomplete_reasons, "export_byte_cap");
            break;
        }
        file.write_all(&line)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("写入搜索结果失败: {e}"),
                available: None,
            })?;
        bytes = next_bytes;
        written_count += 1;
        content_truncated_count += usize::from(result.truncated);
        redacted_count += usize::from(result.redacted == Some(true));
    }
    file.sync_all().map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("同步搜索结果失败: {e}"),
        available: None,
    })?;
    push_time_filter_reason(&mut incomplete_reasons, collection.invalid_timestamps);
    incomplete_reasons.sort();
    incomplete_reasons.dedup();
    let complete = incomplete_reasons.is_empty();
    let mut output_info = write_search_manifest(SearchManifestContext {
        results_path: &results_path,
        manifest_path: &manifest_path,
        staging_manifest: &transaction.staging_manifest(),
        coverage: &coverage,
        summary: summary.as_ref(),
        slice: window.slice_info.as_ref(),
        total_matches,
        written_count,
        content_truncated_count,
        redaction: params.redaction,
        redacted_count,
        complete,
        explicit_range: params.offset > 0 || params.limit.is_some() || params.slice.is_some(),
        incomplete_reasons: &incomplete_reasons,
        attribution_issues: &attribution_issues,
        bytes,
        max_content: params.max_content,
        max_content_tool_result: params.max_content_tool_result,
        max_records: MAX_EXPORT_RECORDS,
        max_bytes: MAX_EXPORT_BYTES,
        output_content: &params.output_content,
        selected_start: window.range.start,
        selected_count: window.range.len(),
    })?;
    output_info.retention = temp_output.then(|| TEMP_OUTPUT_RETENTION.to_string());
    let warning = build_response_warning(&incomplete_reasons, &attribution_issues, params);
    let response = SearchResponse {
        stats: SearchStats {
            files_scanned: collection.files_scanned,
            lines_scanned: collection.lines_scanned,
            skipped_invalid_timestamps: collection.invalid_timestamps,
            total_matches,
            returned_count: 0,
            time_ms: start.elapsed().as_millis() as u64,
            total_matches_exact: complete,
            incomplete: !complete,
            incomplete_reasons,
            attribution_incomplete_reasons: attribution_issues,
            coverage,
            summary,
            slice: window.slice_info,
            effective_filters: effective_filters(params),
            ignored_keys: params.ignored_keys.clone(),
            warnings: params.warnings.clone(),
            metadata_dimensions: BTreeMap::new(),
            truncated_global: collection.truncated_global.then_some(true),
        },
        results: Vec::new(),
        has_more: false,
        next_offset: 0,
        next_query: None,
        output: Some(output_info),
        warning,
        serialized_bytes: 0,
        max_total_bytes: params.max_total,
        limits_applied: Vec::new(),
        complete,
    };
    let response = apply_response_budget(response, params.max_total, build_next_query(params, params.offset))?;
    crate::record_reader::check_work()?;
    if params.output_content == "full" {
        for result in &selected_results {
            validate_export_source(result)?;
        }
    }
    transaction.publish()?;
    Ok(response)
}

pub(crate) struct RecordBuildContext<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub source: &'a Path,
    pub prefix: &'a str,
    pub params: &'a SearchParams,
    pub regex: Option<&'a Regex>,
    pub pattern: Option<&'a SearchPattern>,
}

pub(crate) fn tool_block_matches(block: &AssociatedToolBlock, params: &SearchParams) -> bool {
    let server_matches = params.servers.is_empty()
        || block
            .info
            .server
            .as_ref()
            .is_some_and(|server| params.servers.iter().any(|filter| filter == server));
    let tool_matches = params.tools.is_empty()
        || params.tools.iter().any(|filter| {
            let parsed = parse_mcp_tool_name(filter);
            parsed.tool == block.info.tool && (parsed.server.is_none() || parsed.server == block.info.server)
        });
    let failed_matches = !params.failed_tool_results || block.result_is_error == Some(true);
    let payload_matches = !params.tool_payload_errors || block.result_has_error_payload == Some(true);
    server_matches && tool_matches && failed_matches && payload_matches
}

pub(crate) fn has_tool_filter(params: &SearchParams) -> bool {
    !params.servers.is_empty() || !params.tools.is_empty() || params.failed_tool_results || params.tool_payload_errors
}

fn push_attribution_filter_reason(params: &SearchParams, reasons: &mut Vec<String>, attribution_issues: &[String]) {
    if (!params.servers.is_empty() || !params.tools.is_empty()) && !attribution_issues.is_empty() {
        push_unique(reasons, "tool_filter_unverifiable");
    }
}

pub(crate) fn select_tool_block<'a>(
    blocks: &'a [AssociatedToolBlock],
    params: &SearchParams,
) -> Option<&'a AssociatedToolBlock> {
    if has_tool_filter(params) {
        blocks.iter().find(|block| tool_block_matches(block, params))
    } else {
        blocks.first()
    }
}

pub(crate) fn matched_filters(
    params: &SearchParams,
    project: &str,
    session: &str,
    effective_type: &str,
    subtype: &str,
    tool_info: &ToolInfo,
) -> Vec<String> {
    let mut filters = vec![
        format!("project={project}"),
        format!("session={session}"),
        format!("type={effective_type}"),
        format!("subtype={subtype}"),
    ];
    if let Some(source) = &params.source {
        filters.push(format!("source={source}"));
    }
    if !params.sources.is_empty() {
        filters.push("sources=true".to_string());
    }
    if params.since.is_some() || params.until.is_some() {
        filters.push("time=true".to_string());
    }
    if let Some(server) = &tool_info.server {
        filters.push(format!("server={server}"));
    }
    if let Some(tool) = &tool_info.tool {
        filters.push(format!("tool={tool}"));
    }
    if params.failed_tool_results {
        filters.push("failed_tool_results=true".to_string());
    }
    if params.tool_payload_errors {
        filters.push("tool_payload_errors=true".to_string());
    }
    filters
}

pub(crate) fn build_search_result(
    ctx: &RecordBuildContext<'_>,
    line_num: usize,
    record: MessageRecord,
    tool_blocks: &[AssociatedToolBlock],
    attribution_issues: &mut Vec<String>,
) -> Result<Option<SearchResult>, ErrorResponse> {
    crate::record_reader::check_work()?;
    let (effective_type, subtype) = classify_message(&record);
    if !ctx.params.types.iter().any(|t| t == effective_type) {
        return Ok(None);
    }
    if !ctx.params.subtypes.is_empty() && !ctx.params.subtypes.iter().any(|s| s == subtype) {
        return Ok(None);
    }
    if time_in_range(&record.timestamp, ctx.params.since.as_ref(), ctx.params.until.as_ref()) != TimeRangeMatch::Matches
    {
        return Ok(None);
    }

    let (raw_content, images) = extract_and_replace_images(&record);
    crate::record_reader::check_work()?;
    let (matches, match_pos) = if ctx.params.pattern.is_empty() {
        (true, None)
    } else if let Some(regex) = ctx.regex {
        if raw_content.len() > MAX_JSONL_LINE_BYTES {
            return Err(reader_error(
                "regex_content_limit",
                "逻辑正文超过 8 MiB，regex 未完整检查该记录",
            ));
        }
        regex.find(&raw_content).map_or((false, None), |m| {
            (true, Some(raw_content[..m.start()].chars().count()))
        })
    } else if let Some(pattern) = ctx.pattern {
        matches_pattern(&raw_content, pattern, ctx.params.case_sensitive)
    } else {
        (true, None)
    };
    crate::record_reader::check_work()?;
    if !matches {
        return Ok(None);
    }

    for block in tool_blocks {
        crate::record_reader::check_work()?;
        if (!ctx.params.failed_tool_results || block.result_is_error == Some(true))
            && (!ctx.params.tool_payload_errors || block.result_has_error_payload == Some(true))
            && let Some(issue) = &block.metadata_incomplete_reason
        {
            push_unique(attribution_issues, issue.clone());
        }
    }
    let selected_tool_block = select_tool_block(tool_blocks, ctx.params);
    if has_tool_filter(ctx.params) && selected_tool_block.is_none() {
        return Ok(None);
    }
    let tool_info = selected_tool_block.map(|block| block.info.clone()).unwrap_or(ToolInfo {
        server: None,
        tool: None,
    });
    let metadata_incomplete_reason = selected_tool_block.and_then(|block| block.metadata_incomplete_reason.clone());
    let rendered_tool_block = selected_tool_block.filter(|_| !ctx.params.aggregate || ctx.params.output.is_some()).map(|block| {
        let mut rendered = render_tool_block(block, ctx.params.redaction);
        crate::record_reader::check_work()?;
        if ctx.params.structured.as_deref() == Some("preview") || ctx.params.output_content == "full" {
            for (value, view, limit) in [
                (&mut rendered.input, "tool_input", ctx.params.max_content),
                (&mut rendered.result, "tool_result", ctx.params.max_content_tool_result),
            ] {
                if let Some(full) = value.take() {
                    let mut serialized = Vec::new();
                    crate::record_reader::serialize_json(&mut serialized, &full, false)?;
                    let (preview, truncated) = truncate_content(std::str::from_utf8(&serialized).expect("JSON is UTF-8"), limit);
                    *value = Some(serde_json::json!({
                        "preview": preview, "truncated": truncated, "original_bytes": serialized.len(),
                        "get": {"ref": format!("{}:{}", ctx.session_id, line_num), "project": ctx.project_id, "source": ctx.source, "view": view, "block": block.block_index, "redaction": ctx.params.redaction.as_str()}
                    }));
                }
            }
        }
        Ok::<_, ErrorResponse>(rendered)
    }).transpose()?;
    let text_redaction = redact_text_with_mode(&raw_content, ctx.params.redaction);
    crate::record_reader::check_work()?;
    let content_redacted = text_redaction.count > 0;
    let content = text_redaction.text;
    let content_size = raw_content.chars().count();
    let image_count = images.len();
    let matched_filters = matched_filters(
        ctx.params,
        ctx.project_id,
        ctx.session_id,
        effective_type,
        subtype,
        &tool_info,
    );
    let (tool_input_redacted, tool_result_redacted, raw_available, redacted) = rendered_tool_block
        .map_or((None, None, false, false), |block| {
            (block.input, block.result, block.raw_available, block.redacted)
        });
    Ok(Some(SearchResult {
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
        source: Some(ctx.source.to_string_lossy().into_owned()),
        block: selected_tool_block.map(|block| block.block_index),
        server: tool_info.server,
        tool: tool_info.tool,
        metadata_incomplete_reason,
        tool_input_redacted,
        tool_result_redacted,
        tool_result_is_error: selected_tool_block.and_then(|block| block.result_is_error),
        tool_result_has_error_payload: selected_tool_block.and_then(|block| block.result_has_error_payload),
        raw_available: (raw_available || content_redacted).then_some(true),
        redacted: (redacted || content_redacted).then_some(true),
        matched_filters,
        match_pos: (!content_redacted).then_some(match_pos).flatten(),
        locator: None,
    }))
}

pub(crate) fn build_indexed_search_result(
    ctx: &RecordBuildContext<'_>,
    span: SourceSpan,
    line: usize,
    open: impl Fn() -> Result<std::fs::File, ErrorResponse>,
    tracker: &mut ToolAssociationTracker,
    attribution: &mut Vec<String>,
    invalid_timestamps: &mut usize,
) -> Result<Option<SearchResult>, ErrorResponse> {
    let params = ctx.params;
    let pattern = ctx.pattern;
    let indexed = index_record(open()?, span, true)?;
    let Some(metadata) = &indexed.metadata else {
        return Ok(None);
    };
    let association_record = indexed.association_record(open()?, span, params.tool_payload_errors)?;
    if tool_block_count(&association_record) > MAX_TOOL_BLOCKS {
        return Err(reader_error("tool_blocks_cap", "单条消息工具块超出 2048"));
    }
    let blocks = tracker.observe_record(&association_record, params.tool_payload_errors);
    let (effective_type, subtype) = indexed.classify(open()?, span)?;
    if !line_in_ranges(line, &params.lines)
        || !params.types.iter().any(|kind| kind == effective_type)
        || !message_subtype_matches(subtype, &params.subtypes)
    {
        return Ok(None);
    }
    match time_in_range(&metadata.timestamp, params.since.as_ref(), params.until.as_ref()) {
        TimeRangeMatch::Matches => {}
        TimeRangeMatch::UnparseableTimestamp => {
            *invalid_timestamps += 1;
            return Ok(None);
        }
        _ => return Ok(None),
    }
    let projection = indexed.projection(open()?, span, "content", None)?;
    let images = projection.images.clone();
    let original_characters = projection.characters;
    let mut text = TextBytes::new(projection.cursor(open()?, span));
    let (matches, match_position) = if let Some(regex) = ctx.regex {
        if text.len() > MAX_JSONL_LINE_BYTES {
            return Err(reader_error(
                "regex_content_limit",
                "逻辑正文超过 8 MiB，regex 未完整检查该记录",
            ));
        }
        let raw = text.range(0, text.len(), MAX_JSONL_LINE_BYTES)?;
        let raw = std::str::from_utf8(&raw).map_err(|_| reader_error("invalid_utf8", "正文 UTF-8 无效"))?;
        regex.find(raw).map_or((false, None), |found| {
            (true, Some(raw[..found.start()].chars().count()))
        })
    } else if let Some(pattern) = pattern {
        stream_matches_pattern(&mut text, pattern, params.case_sensitive)?
    } else {
        (true, None)
    };
    if !matches {
        return Ok(None);
    }
    for block in &blocks {
        if (!params.failed_tool_results || block.result_is_error == Some(true))
            && (!params.tool_payload_errors || block.result_has_error_payload == Some(true))
            && let Some(reason) = &block.metadata_incomplete_reason
        {
            push_unique(attribution, reason.clone());
        }
    }
    let selected = select_tool_block(&blocks, params);
    if has_tool_filter(params) && selected.is_none() {
        return Ok(None);
    }
    let maximum = if subtype == "tool_result" {
        params.max_content_tool_result
    } else {
        params.max_content
    };
    let (start, end, prefix, suffix) = preview_bounds(original_characters, match_position, maximum);
    let mut head = String::new();
    let mut window = String::new();
    let mut collected = 0usize;
    let (content_size, redacted_size, redacted_count) =
        render_text_range(&mut text, params.redaction, None, |chunk| {
            let chunk = std::str::from_utf8(chunk).map_err(|_| reader_error("parse_error", "正文 UTF-8 无效"))?;
            for character in chunk.chars() {
                if collected < maximum {
                    head.push(character);
                }
                if (start..end).contains(&collected) {
                    window.push(character);
                }
                collected += 1;
            }
            Ok(())
        })?;
    let content = if redacted_count > 0 {
        head
    } else {
        format!(
            "{}{window}{}",
            if prefix { "..." } else { "" },
            if suffix { "..." } else { "" }
        )
    };
    let mut input = None;
    let mut result = None;
    if let Some(block) = selected.filter(|_| !params.aggregate || params.output.is_some()) {
        let view = if block.kind == ToolBlockKind::Use {
            "tool_input"
        } else {
            "tool_result"
        };
        let projection =
            indexed.structured_projection(open()?, span, view, Some(block.block_index), params.redaction)?;
        let full = params.structured.as_deref().unwrap_or("full") == "full" && params.output_content != "full";
        let maximum = if block.kind == ToolBlockKind::Use {
            params.max_content
        } else {
            params.max_content_tool_result
        };
        let mut cursor = TextBytes::new(projection.cursor(open()?, span));
        let mut preview = String::new();
        let mut characters = 0;
        let mut original_bytes = 0usize;
        let (_, rendered_size, _) = render_text_range(&mut cursor, params.redaction, None, |chunk| {
            original_bytes = original_bytes
                .checked_add(chunk.len())
                .ok_or_else(|| reader_error("record_index_limit", "结构化文本长度溢出"))?;
            if full {
                if chunk.len() > params.max_total.saturating_sub(preview.len()) {
                    return Err(ErrorResponse { error:"structured_response_too_large".to_string(), message:"完整结构超过响应预算；使用 history_get view/range/output 读取，或释放扫描后以 structured=preview 重新查询".to_string(),
                        available:Some(json!({"get":{"ref":format!("{}:{line}", ctx.session_id), "project":ctx.project_id, "source":ctx.source.to_string_lossy(), "view":view, "block":block.block_index, "redaction":params.redaction.as_str()}})) });
                }
                preview.push_str(
                    std::str::from_utf8(chunk).map_err(|_| reader_error("parse_error", "结构化视图 UTF-8 无效"))?,
                );
            } else {
                for character in std::str::from_utf8(chunk)
                    .map_err(|_| reader_error("parse_error", "结构化视图 UTF-8 无效"))?
                    .chars()
                {
                    if characters < maximum {
                        preview.push(character);
                    }
                    characters += 1;
                }
            }
            Ok(())
        })?;
        let value = if full {
            serde_json::from_str(&preview)
                .map_err(|error| reader_error("parse_error", format!("脱敏结构化视图不是合法 JSON: {error}")))?
        } else {
            json!({"preview":preview, "truncated":rendered_size > maximum, "original_bytes":original_bytes,
                "get":{"ref":format!("{}:{line}", ctx.session_id), "project":ctx.project_id, "source":ctx.source.to_string_lossy(), "view":view, "block":block.block_index, "redaction":params.redaction.as_str()}})
        };
        if block.kind == ToolBlockKind::Use {
            input = Some(value);
        } else {
            result = Some(value);
        }
    }
    Ok(Some(SearchResult {
        r#ref: format!("{}:{line}", ctx.session_id),
        session: ctx.session_id.to_string(),
        line,
        uuid: metadata.uuid.clone(),
        r#type: effective_type.to_string(),
        subtype: subtype.to_string(),
        timestamp: metadata.timestamp.clone(),
        content,
        content_size,
        truncated: redacted_size > maximum,
        image_count: images.len(),
        images,
        project: ctx.project_id.to_string(),
        source: Some(ctx.source.to_string_lossy().to_string()),
        block: selected.map(|block| block.block_index),
        server: selected.and_then(|block| block.info.server.clone()),
        tool: selected.and_then(|block| block.info.tool.clone()),
        metadata_incomplete_reason: selected.and_then(|block| block.metadata_incomplete_reason.clone()),
        tool_input_redacted: input,
        tool_result_redacted: result,
        tool_result_is_error: selected.and_then(|block| block.result_is_error),
        tool_result_has_error_payload: selected.and_then(|block| block.result_has_error_payload),
        raw_available: (selected.is_some() || redacted_count > 0).then_some(true),
        redacted: (params.redaction.enabled() && (selected.is_some() || redacted_count > 0)).then_some(true),
        matched_filters: matched_filters(
            params,
            ctx.project_id,
            ctx.session_id,
            effective_type,
            subtype,
            &selected.map(|block| block.info.clone()).unwrap_or(ToolInfo {
                server: None,
                tool: None,
            }),
        ),
        match_pos: None,
        locator: None,
    }))
}

fn visit_search_file(
    ctx: &RecordBuildContext<'_>,
    mut consume: impl FnMut(SearchResult) -> Result<bool, ErrorResponse>,
) -> Result<FileSearchResult, ErrorResponse> {
    crate::record_reader::check_work()?;
    let mut stats = FileSearchResult {
        lines_scanned: 0,
        results: Vec::new(),
        truncated: false,
        read_errors: 0,
        parse_errors: 0,
        metadata_parse_errors: 0,
        invalid_timestamps: 0,
        metadata_issues: Vec::new(),
        attribution_issues: Vec::new(),
        result_bytes: 0,
        memory_capped: false,
        oversized_lines: 0,
    };
    let input = match crate::session_files::open_session_file(ctx.source) {
        Ok(file) => file,
        Err(_) => {
            stats.read_errors = 1;
            return Ok(stats);
        }
    };
    let metadata = std::sync::Arc::new(
        input
            .metadata()
            .map_err(|error| reader_error("io_error", error.to_string()))?,
    );
    let open = || {
        let file = crate::session_files::open_session_file(ctx.source)
            .map_err(|error| reader_error("source_changed", error.to_string()))?;
        if !crate::session_files::matches_snapshot(
            &metadata,
            &file
                .metadata()
                .map_err(|error| reader_error("io_error", error.to_string()))?,
        ) {
            return Err(reader_error(
                "source_changed",
                format!("{} 来源发生变化", ctx.source.display()),
            ));
        }
        Ok(file)
    };
    let mut lines = RecordLines::new(input, metadata.len());
    let mut tracker = ToolAssociationTracker::default();
    loop {
        let mut remaining = u64::MAX;
        let located = match lines.step(&mut remaining, Instant::now() + std::time::Duration::from_secs(120)) {
            Ok(LineStep::Record(located)) => located,
            Ok(LineStep::Yield) => continue,
            Ok(LineStep::End) => break,
            Err(error) if error.error == "io_error" => {
                stats.read_errors += 1;
                break;
            }
            Err(error) => return Err(error),
        };
        stats.lines_scanned += 1;
        let in_range = line_in_ranges(located.line, &ctx.params.lines);
        let parsed = (|| {
            if let Some(raw) = &located.small {
                let raw = std::str::from_utf8(raw).map_err(|_| reader_error("invalid_utf8", "JSONL UTF-8 无效"))?;
                let Some(record) =
                    parse_message_record(raw).map_err(|_| reader_error("parse_error", "JSONL 格式或消息字段无效"))?
                else {
                    return Ok(None);
                };
                if tool_block_count(&record) > MAX_TOOL_BLOCKS {
                    return Err(reader_error("tool_blocks_cap", "单条消息工具块超出 2048"));
                }
                let blocks = tracker.observe_record(&record, ctx.params.tool_payload_errors);
                if !in_range {
                    return Ok(None);
                }
                if time_in_range(&record.timestamp, ctx.params.since.as_ref(), ctx.params.until.as_ref())
                    == TimeRangeMatch::UnparseableTimestamp
                {
                    stats.invalid_timestamps += 1;
                    return Ok(None);
                }
                build_search_result(ctx, located.line, record, &blocks, &mut stats.attribution_issues)
            } else {
                build_indexed_search_result(
                    ctx,
                    located.span,
                    located.line,
                    open,
                    &mut tracker,
                    &mut stats.attribution_issues,
                    &mut stats.invalid_timestamps,
                )
            }
        })();
        if tracker.pending_len() > MAX_TOOL_BLOCKS {
            push_unique(&mut stats.metadata_issues, "tool_pending_cap");
            break;
        }
        if tracker.pending_bytes() > MAX_TOOL_PENDING_BYTES {
            push_unique(&mut stats.metadata_issues, "tool_pending_bytes_cap");
            break;
        }
        let result = match parsed {
            Ok(result) => result,
            Err(error) if matches!(error.error.as_str(), "parse_error" | "invalid_utf8") => {
                if in_range {
                    stats.parse_errors += 1;
                } else {
                    stats.metadata_parse_errors += 1;
                }
                push_unique(
                    &mut stats.metadata_issues,
                    format!("{}:{}:{}", error.error, ctx.source.display(), located.line),
                );
                continue;
            }
            Err(error) if error.error == "regex_content_limit" => {
                push_unique(&mut stats.metadata_issues, "regex_content_limit");
                push_unique(
                    &mut stats.metadata_issues,
                    format!("regex_content_limit:{}:{}", ctx.source.display(), located.line),
                );
                continue;
            }
            Err(error)
                if matches!(
                    error.error.as_str(),
                    "tool_blocks_cap"
                        | "tool_pending_cap"
                        | "tool_pending_bytes_cap"
                        | "record_index_limit"
                        | "redaction_index_limit"
                ) =>
            {
                push_unique(&mut stats.metadata_issues, error.error);
                break;
            }
            Err(error) => return Err(error),
        };
        if let Some(mut result) = result {
            result.r#ref = format!("{}:{}", ctx.prefix, located.line);
            if ctx.params.output_content == "full" {
                result.locator = Some((located.span, metadata.clone()));
                result.content.clear();
                result.tool_input_redacted = None;
                result.tool_result_redacted = None;
                result.truncated = false;
            }
            if !consume(result)? {
                break;
            }
        }
    }
    open()?;
    Ok(stats)
}

/// 单文件读取与 aggregate 共享记录匹配、诊断和关联路径
fn search_file(
    project_id: &str,
    session_id: &str,
    path: &Path,
    params: &SearchParams,
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
    limits: FileSearchLimits,
) -> Result<FileSearchResult, ErrorResponse> {
    let prefix = ref_prefix(session_id);
    let ctx = RecordBuildContext {
        project_id,
        session_id,
        source: path,
        prefix: &prefix,
        params,
        regex,
        pattern,
    };
    let mut results = Vec::new();
    let mut result_bytes = 0;
    let mut truncated = false;
    let mut memory_capped = false;
    let mut stats = visit_search_file(&ctx, |result| {
        if results.len() == limits.max_matches {
            truncated = true;
            return Ok(false);
        }
        let bytes = crate::record_reader::serialize_json(std::io::sink(), &result, false)?.saturating_add(256);
        if bytes > limits.max_bytes.saturating_sub(result_bytes) {
            memory_capped = true;
            return Ok(false);
        }
        result_bytes += bytes;
        results.push(result);
        Ok(true)
    })?;
    stats.results = results;
    stats.result_bytes = result_bytes;
    stats.truncated = truncated;
    stats.memory_capped = memory_capped;
    Ok(stats)
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::{env, fs, process};

    #[test]
    fn normal_large_record_matching_association_and_regex_limits() {
        let root = env::temp_dir().join(format!("history-large-normal-{}", process::id()));
        fs::create_dir_all(root.join("project")).unwrap();
        let source = root.join("project/session-large.jsonl");
        let mut file = File::create(&source).unwrap();
        let padding = "x".repeat(MAX_JSONL_LINE_BYTES + 128);
        writeln!(file,"{}",serde_json::json!({"uuid":"call","type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"call-1","name":"mcp__fixture__large","input":{"note":padding}}]}})).unwrap();
        writeln!(file,"{}",serde_json::json!({"uuid":"result","type":"user","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":format!("{padding} 末尾 NEEDLE password=fixture-secret")} ]}})).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"api-request-blob","message":{"cache":padding}})
        )
        .unwrap();
        writeln!(file,"{}",serde_json::json!({"uuid":"small","type":"user","timestamp":"2026-01-01T00:00:02Z","message":{"content":"NEEDLE small"}})).unwrap();
        file.write_all(b"{\xff}\n{bad json}\n").unwrap();
        drop(file);
        let config = Config {
            projects_dir: root.clone(),
        };
        for aggregate in [false, true] {
            let response = search(
                &config,
                SearchParams {
                    projects: vec!["project".into()],
                    pattern: "末尾 NEEDLE|unused !absent".into(),
                    tools: vec!["mcp__fixture__large".into()],
                    lines: parse_optional_line_ranges_param(Some("2-4")).unwrap(),
                    structured: (!aggregate).then(|| "preview".into()),
                    redaction: RedactionMode::Off,
                    aggregate,
                    max_total: 10000,
                    ..SearchParams::default()
                },
            )
            .unwrap();
            assert_eq!(response.stats.total_matches, 1);
            assert!(
                !response
                    .stats
                    .incomplete_reasons
                    .iter()
                    .any(|reason| reason.starts_with("oversized_jsonl"))
            );
            assert!(
                response
                    .stats
                    .incomplete_reasons
                    .iter()
                    .any(|reason| reason.starts_with("metadata_parse_error="))
            );
            if !aggregate {
                assert_eq!(response.results[0].line, 2);
                assert_eq!(response.results[0].tool.as_deref(), Some("large"));
                assert!(response.results[0].content.contains("NEEDLE"));
            }
        }
        let response = search(
            &config,
            SearchParams {
                projects: vec!["project".into()],
                pattern: "NEEDLE".into(),
                use_regex: true,
                structured: Some("preview".into()),
                redaction: RedactionMode::Off,
                max_total: 10000,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].line, 4);
        assert!(
            response
                .stats
                .incomplete_reasons
                .contains(&"regex_content_limit".to_string())
        );
        assert!(!response.stats.total_matches_exact);
        let spaced = root.join("project/session-spaced.jsonl");
        fs::write(&spaced,format!("{{{}\"uuid\":\"spaced\",\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{{\"content\":\"small\"}}}}\n"," ".repeat(MAX_JSONL_LINE_BYTES))).unwrap();
        let response = search(
            &config,
            SearchParams {
                source: Some(spaced.to_string_lossy().to_string()),
                pattern: "^small$".into(),
                use_regex: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(response.stats.total_matches, 1);
        assert!(response.stats.total_matches_exact);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn aggregate_large_tool_defaults_skip_payload_materialization() {
        let root = env::temp_dir().join(format!("history-large-aggregate-default-{}", process::id()));
        fs::create_dir_all(root.join("project")).unwrap();
        let source = root.join("project/session-aggregate.jsonl");
        let row = serde_json::json!({
            "uuid": "duplicate", "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{"type": "tool_use", "id": "call", "name": "mcp__fixture__large",
                "input": {"note": "x".repeat(MAX_JSONL_LINE_BYTES + 128)}}]}
        });
        fs::write(&source, format!("{row}\n{row}\n")).unwrap();
        let response = search(
            &Config {
                projects_dir: root.clone(),
            },
            SearchParams {
                projects: vec!["project".into()],
                aggregate: true,
                tools: vec!["mcp__fixture__large".into()],
                redaction: RedactionMode::Off,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(response.stats.total_matches, 1);
        assert!(response.stats.total_matches_exact);
        assert!(response.results.is_empty());
        assert!(response.stats.summary.is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_output_preserves_body_and_independent_structured_mode() {
        let root = env::temp_dir().join(format!("history-full-output-{}", process::id()));
        fs::create_dir_all(root.join("project")).unwrap();
        let source = root.join("project/full-output-session.jsonl");
        let body = format!("{} TAIL-4515", "中".repeat(4515));
        fs::write(&source,format!("{}\n{}\n",serde_json::json!({"uuid":"body","type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":body}}),serde_json::json!({"uuid":"tool","type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"thinking","thinking":"fixture thought"},{"type":"text","text":"Tool explanation"},{"type":"tool_use","id":"tool","name":"Bash","input":{"nested":{"password":"fixture-secret","note":body}}}]}}))).unwrap();
        let config = Config {
            projects_dir: root.clone(),
        };
        for (content, structured, redaction) in [
            ("preview", "full", RedactionMode::Auto),
            ("full", "full", RedactionMode::Strict),
            ("full", "preview", RedactionMode::Off),
        ] {
            let response = search(
                &config,
                SearchParams {
                    projects: vec!["project".into()],
                    output: Some(format!("tmp:full-body-{content}-{structured}")),
                    output_content: content.into(),
                    structured: Some(structured.into()),
                    redaction,
                    max_content: 100,
                    max_total: 10000,
                    ..SearchParams::default()
                },
            )
            .unwrap();
            let output = response.output.unwrap();
            let raw = fs::read_to_string(&output.results).unwrap();
            let rows: Vec<serde_json::Value> = raw.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
            let manifest: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&output.manifest).unwrap()).unwrap();
            assert_eq!(rows.len(), 2);
            assert_eq!(manifest["bytes"].as_u64(), Some(raw.len() as u64));
            if content == "full" {
                assert_eq!(rows[0]["content"], body);
                assert_eq!(manifest["content_complete"], true);
                assert_eq!(manifest["content_truncated_count"], 0);
            } else {
                assert!(!rows[0]["content"].as_str().unwrap().contains("TAIL-4515"));
                assert_eq!(manifest["content_complete"], false);
            }
            if redaction == RedactionMode::Strict {
                assert!(!raw.contains("fixture-secret"));
                assert_eq!(rows[1]["tool_input_redacted"]["nested"]["note"], body);
            }
            if structured == "preview" {
                assert_eq!(rows[1]["tool_input_redacted"]["truncated"], true);
                assert_eq!(rows[1]["tool_input_redacted"]["get"]["block"], 2);
                assert_eq!(
                    rows[1]["tool_input_redacted"]["get"]["source"],
                    source.to_string_lossy().as_ref()
                );
            }
        }
        let params = SearchParams {
            projects: vec!["project".into()],
            output: Some("tmp:full-failure".into()),
            output_content: "full".into(),
            ..SearchParams::default()
        };
        let inputs = prepare_search_inputs(&config, &params).unwrap();
        let collection = collect_search_results(&params, &inputs.files, None, None).unwrap();
        let mut output = File::create(root.join("bounded.jsonl")).unwrap();
        assert_eq!(
            write_full_result(&mut output, &collection.results[0], &params, 30)
                .unwrap_err()
                .error,
            "export_byte_cap"
        );
        assert_eq!(output.metadata().unwrap().len(), 0);
        fs::OpenOptions::new()
            .append(true)
            .open(&source)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        assert_eq!(
            write_full_result(&mut output, &collection.results[0], &params, 100000)
                .unwrap_err()
                .error,
            "source_changed"
        );
        drop(output);
        fs::remove_dir_all(root).unwrap();
    }

    fn write_jsonl(dir: &Path, name: &str, lines: usize) -> PathBuf {
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        for i in 0..lines {
            // 构造最小可被 classify_message 识别为 "user" 类型的 jsonl 行
            // 时间戳带毫秒偏移以保证 sort 顺序
            writeln!(
                f,
                "{}",
                serde_json::json!({
                    "uuid": format!("u-{i:08}"),
                    "type": "user",
                    "timestamp": format!("2026-04-26T10:00:{:02}.{:03}Z", i % 60, i % 1000),
                    "message": {"role": "user", "content": format!("hit-{i}")}
                })
            )
            .unwrap();
        }
        path
    }

    #[test]
    fn mixed_tool_filters_preserve_each_server_tool_pair() {
        let root = env::temp_dir().join(format!("mcp-search-mixed-tools-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("mixed-tools-session.jsonl")).unwrap();
        let names = [
            "Bash",
            "mcp__alpha__read",
            "mcp__alpha__write",
            "mcp__beta__read",
            "mcp__beta__write",
            "mcp__mcp-ssh__ssh_exec",
        ];
        for (idx, name) in names.iter().enumerate() {
            for record in [
                serde_json::json!({"uuid": format!("call-{idx}"), "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_use", "id": format!("tool-{idx}"), "name": name, "input": {"command": "fixture"}}]}}),
                serde_json::json!({"uuid": format!("result-{idx}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_result", "tool_use_id": format!("tool-{idx}"),
                        "is_error": idx % 2 == 0, "content": "fixture"}]}}),
            ] {
                writeln!(file, "{record}").unwrap();
            }
        }
        drop(file);
        let config = Config {
            projects_dir: root.clone(),
        };
        for (servers, tools, expected) in [
            ("", "Bash,mcp__mcp-ssh__ssh_exec", vec![0, 5]),
            ("", "mcp__alpha__read,mcp__beta__write", vec![1, 4]),
            ("", "read", vec![1, 3]),
            ("", "mcp__alpha__read,mcp__alpha__read", vec![1]),
            ("alpha", "Bash,mcp__alpha__read", vec![1]),
            ("alpha", "mcp__beta__read", vec![]),
            ("alpha", "read", vec![1]),
            ("alpha,beta", "mcp__alpha__read,mcp__beta__write", vec![1, 4]),
            ("", "bash", vec![]),
            ("", "", vec![0, 1, 2, 3, 4, 5]),
        ] {
            for failed in [false, true] {
                let response = search(
                    &config,
                    SearchParams {
                        projects: vec!["project".to_string()],
                        servers: split_csv_param(Some(servers)),
                        tools: split_csv_param(Some(tools)),
                        failed_tool_results: failed,
                        ..SearchParams::default()
                    },
                )
                .unwrap();
                let expected_lines = expected
                    .iter()
                    .flat_map(|idx| {
                        if failed {
                            if idx % 2 == 0 { vec![idx * 2 + 2] } else { vec![] }
                        } else {
                            vec![idx * 2 + 1, idx * 2 + 2]
                        }
                    })
                    .collect::<Vec<_>>();
                assert_eq!(
                    response.results.iter().map(|result| result.line).collect::<Vec<_>>(),
                    expected_lines,
                    "servers={servers}, tools={tools}, failed={failed}"
                );
                assert_eq!(response.stats.effective_filters.servers, split_csv_param(Some(servers)));
                let mut unique_tools = Vec::new();
                for tool in split_csv_param(Some(tools)) {
                    push_unique(&mut unique_tools, tool);
                }
                assert_eq!(response.stats.effective_filters.tools, unique_tools);
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "explicit synthetic phase measurement"]
    fn normal_summary_phase_measurement() {
        for count in [200, 1000, 5000] {
            let owner = format!(
                "{}-{}",
                process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let root = env::temp_dir().join(format!("history-summary-measurement-{owner}"));
            fs::create_dir(&root).unwrap();
            fs::write(root.join(".owner"), &owner).unwrap();
            let directory = root.join("-summary-fixture");
            fs::create_dir(&directory).unwrap();
            let path = directory.join("summary0.jsonl");
            let mut output = std::io::BufWriter::new(File::create(&path).unwrap());
            for index in 0..count {
                let record = serde_json::json!({"uuid":format!("summary-{index}"), "type":"assistant", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_use", "id":format!("call-{index}"), "name":format!("mcp__mcp-ssh__probe_{index}"), "input":{"note":"x".repeat(1500), "password":"synthetic-not-a-credential"}}]}});
                writeln!(output, "{record}").unwrap();
                let result = serde_json::json!({"uuid":format!("result-{index}"), "type":"user", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_result", "tool_use_id":format!("call-{index}"), "content":"completed"}]}});
                writeln!(output, "{result}").unwrap();
            }
            output.flush().unwrap();
            drop(output);
            let read = Instant::now();
            let raw = fs::read_to_string(&path).unwrap();
            let read_ms = read.elapsed().as_secs_f64() * 1000.0;
            let parse = Instant::now();
            let records: Vec<_> = raw
                .lines()
                .map(|line| parse_message_record(line).unwrap().unwrap())
                .collect();
            let parse_ms = parse.elapsed().as_secs_f64() * 1000.0;
            let redaction = Instant::now();
            for record in &records {
                std::hint::black_box(redact_text_with_mode(
                    &replace_images_with_placeholders(record),
                    RedactionMode::Strict,
                ));
            }
            let redaction_ms = redaction.elapsed().as_secs_f64() * 1000.0;
            let config = Config {
                projects_dir: root.clone(),
            };
            let (since, until) =
                parse_time_bounds(Some("2026-07-14T00:00:00Z"), Some("2026-10-12T12:33:55.391Z")).unwrap();
            let params = prepare_search_params(SearchParams {
                all_projects: true,
                summary: true,
                redaction: RedactionMode::Strict,
                servers: vec!["mcp-ssh".to_string()],
                subagents: true,
                subtypes: vec!["tool_use".to_string()],
                types: vec!["assistant".to_string()],
                since,
                until,
                limit: None,
                max_total: 38000,
                ..SearchParams::default()
            })
            .unwrap();
            let files = vec![("-summary-fixture".to_string(), "summary0".to_string(), path)];
            let collect = Instant::now();
            let collection = collect_search_results(&params, &files, None, None).unwrap();
            let collect_ms = collect.elapsed().as_secs_f64() * 1000.0;
            let summary = Instant::now();
            std::hint::black_box(build_summary(&collection.results).unwrap());
            let summary_ms = summary.elapsed().as_secs_f64() * 1000.0;
            let response = build_search_response(params.clone(), files, collection, Instant::now()).unwrap();
            let serialize = Instant::now();
            let full_bytes = compact_response_size(&response).unwrap();
            let serialize_full_ms = serialize.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{}",
                serde_json::json!({"phase":"before_budget", "records":count, "source_bytes":raw.len(), "full_response_bytes":full_bytes, "read_ms":read_ms, "parse_ms":parse_ms, "redaction_ms":redaction_ms, "collect_ms":collect_ms, "summary_ms":summary_ms, "serialize_full_ms":serialize_full_ms})
            );
            let budget = Instant::now();
            let budgeted = apply_response_budget(response, params.max_total, build_next_query(&params, 0)).unwrap();
            let budget_ms = budget.elapsed().as_secs_f64() * 1000.0;
            assert!(budgeted.serialized_bytes <= 38000);
            assert_eq!(budgeted.stats.total_matches, count);
            assert!(budgeted.stats.total_matches_exact);
            assert!(budgeted.has_more);
            assert_eq!(budgeted.next_offset, budgeted.results.len());
            let query = Instant::now();
            let response = search(&config, params).unwrap();
            let query_ms = query.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(response.stats.total_matches, count);
            assert!(!response.results.is_empty());
            println!(
                "{}",
                serde_json::json!({"records":count, "source_bytes":raw.len(), "full_response_bytes":full_bytes, "response_bytes":response.serialized_bytes, "returned":response.results.len(), "read_ms":read_ms, "parse_ms":parse_ms, "redaction_ms":redaction_ms, "collect_ms":collect_ms, "summary_ms":summary_ms, "serialize_full_ms":serialize_full_ms, "budget_ms":budget_ms, "query_ms":query_ms})
            );
            assert_eq!(fs::read_to_string(root.join(".owner")).unwrap(), owner);
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn response_with_content(content: String) -> SearchResponse {
        SearchResponse {
            stats: SearchStats {
                files_scanned: 1,
                lines_scanned: 1,
                skipped_invalid_timestamps: 0,
                total_matches: 1,
                returned_count: 1,
                time_ms: 0,
                total_matches_exact: true,
                incomplete: false,
                incomplete_reasons: Vec::new(),
                attribution_incomplete_reasons: Vec::new(),
                coverage: SearchCoverage {
                    start: None,
                    end: None,
                    projects: vec!["project".to_string()],
                    sessions: vec!["session".to_string()],
                    searched_files: Vec::new(),
                    skipped_files: Vec::new(),
                },
                summary: None,
                slice: None,
                effective_filters: effective_filters(&SearchParams::default()),
                ignored_keys: Vec::new(),
                warnings: Vec::new(),
                metadata_dimensions: BTreeMap::new(),
                truncated_global: None,
            },
            results: vec![SearchResult {
                r#ref: "session:1".to_string(),
                session: "session".to_string(),
                line: 1,
                uuid: "uuid".to_string(),
                r#type: "user".to_string(),
                subtype: "human".to_string(),
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                content_size: content.chars().count(),
                content,
                truncated: false,
                image_count: 0,
                images: Vec::new(),
                project: "project".to_string(),
                source: None,
                block: None,
                server: None,
                tool: None,
                metadata_incomplete_reason: None,
                tool_input_redacted: None,
                tool_result_redacted: None,
                tool_result_is_error: None,
                tool_result_has_error_payload: None,
                raw_available: None,
                redacted: None,
                matched_filters: Vec::new(),
                match_pos: None,
                locator: None,
            }],
            has_more: false,
            next_offset: 1,
            next_query: None,
            output: None,
            warning: None,
            serialized_bytes: 0,
            max_total_bytes: DEFAULT_MAX_TOTAL,
            limits_applied: Vec::new(),
            complete: true,
        }
    }

    #[test]
    fn zero_result_summary_query_keeps_exact_counts_and_a_progressing_next_query() {
        let params = SearchParams {
            limit: Some(0),
            summary: true,
            structured: Some("preview".to_string()),
            ..SearchParams::default()
        };
        let collection = SearchCollection {
            files_scanned: 0,
            lines_scanned: 0,
            invalid_timestamps: 0,
            results: response_with_content("fixture".to_string()).results,
            incomplete_reasons: Vec::new(),
            attribution_issues: Vec::new(),
            truncated_global: false,
        };
        let response = build_search_response(params, Vec::new(), collection, Instant::now()).unwrap();
        assert!(response.results.is_empty());
        assert!(response.has_more);
        assert_eq!(response.stats.total_matches, 1);
        assert!(response.stats.total_matches_exact);
        let next = response.next_query.unwrap();
        assert_eq!(next["offset"], 0);
        assert_eq!(next["limit"], 1);
        assert_eq!(next["structured"], "preview");
        assert_eq!(next["summary"], true);
    }

    #[test]
    fn final_response_budget_counts_compact_json_bytes() {
        let response = response_with_content("\\\"中文".repeat(2_000));
        let continuation = build_next_query(&SearchParams::default(), 0);
        let budgeted = apply_response_budget(response, 2_000, continuation).unwrap();
        let bytes = serde_json::to_vec(&budgeted).unwrap();
        assert!(bytes.len() <= 2_000, "serialized response was {} bytes", bytes.len());
        assert_eq!(budgeted.serialized_bytes, bytes.len());
        assert_eq!(budgeted.max_total_bytes, 2_000);
        assert!(budgeted.limits_applied.iter().any(|limit| limit == "max_total"));
        assert!(!budgeted.complete);
    }

    #[test]
    fn budget_metadata_reports_each_omitted_dimension_without_changing_exact_counts() {
        let mut response = response_with_content("fixture".to_string());
        let buckets = (0..200)
            .map(|index| SummaryBucket {
                key: format!("bucket-中文-\\\"-{index:04}-{}", "x".repeat(40)),
                count: index + 1,
            })
            .collect::<Vec<_>>();
        response.stats.summary = Some(SearchSummary {
            by_project: buckets.clone(),
            by_session: buckets.clone(),
            by_type: buckets.clone(),
            by_server: buckets.clone(),
            by_tool: buckets.clone(),
            by_day: buckets,
        });
        response.stats.total_matches = 200;
        let budgeted = apply_response_budget(response, 8_192, build_next_query(&SearchParams::default(), 0)).unwrap();
        let body = serde_json::to_value(&budgeted).unwrap();
        for name in ["by_project", "by_session", "by_type", "by_server", "by_tool", "by_day"] {
            let returned = body["stats"]["summary"][name].as_array().unwrap().len();
            if returned < 200 {
                let dimension = &body["stats"]["metadata_dimensions"][format!("summary.{name}")];
                assert_eq!(dimension["total"], 200);
                assert_eq!(dimension["returned"], returned);
                assert_eq!(dimension["omitted"], 200 - returned);
            }
        }
        assert_eq!(budgeted.stats.total_matches, 200);
        assert!(budgeted.stats.total_matches_exact);
        assert!(budgeted.stats.incomplete);
        assert!(!budgeted.complete);
        assert_eq!(budgeted.serialized_bytes, serde_json::to_vec(&budgeted).unwrap().len());
        assert!(budgeted.serialized_bytes <= 8_192);
    }

    #[test]
    fn budget_full_structured_rejection_has_exact_source_and_executable_query() {
        let mut response = response_with_content("fixture".to_string());
        response.results[0].tool_input_redacted = Some(serde_json::json!({"payload":"x".repeat(20_000)}));
        response.results[0].source = Some("/fixture/project/session.jsonl".to_string());
        response.results[0].block = Some(3);
        let params = SearchParams {
            structured: Some("full".to_string()),
            redaction: RedactionMode::Strict,
            summary: true,
            ..SearchParams::default()
        };
        let error = apply_response_budget(response.clone(), 2_000, build_next_query(&params, 0)).unwrap_err();
        let available = error.available.unwrap();
        assert_eq!(error.error, "response_too_large");
        assert_eq!(available["get"]["source"], "/fixture/project/session.jsonl");
        assert_eq!(available["get"]["view"], "tool_input");
        assert_eq!(available["get"]["block"], 3);
        assert_eq!(available["next_query"]["structured"], "full");
        assert_eq!(available["next_query"]["redaction"], "strict");
        assert_eq!(available["next_query"]["summary"], true);
        let next = available["next_query"].clone();
        let max_total = next["max_total"].as_u64().unwrap() as usize;
        let recovered = apply_response_budget(response, max_total, next).unwrap();
        assert!(
            recovered.results[0]
                .tool_input_redacted
                .as_ref()
                .unwrap()
                .get("budget_preview")
                .is_none()
        );
        assert!(recovered.stats.total_matches_exact);
        assert!(recovered.serialized_bytes <= max_total);
    }

    #[test]
    fn budget_and_json_serialization_stop_during_cpu_work() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let control = crate::record_reader::WorkControl::from_checkpoint(move |_| {
            if observed.fetch_add(1, Ordering::SeqCst) >= 10 {
                return Err(crate::record_reader::reader_error("cancelled", "fixture cancellation"));
            }
            Ok(())
        });
        let response = response_with_content("x".repeat(1_000_000));
        let error = control
            .run(|| apply_response_budget(response, 2_000, build_next_query(&SearchParams::default(), 0)))
            .unwrap_err();
        assert_eq!(error.error, "cancelled");
        assert_eq!(calls.load(Ordering::SeqCst), 11);
        assert!(crate::record_reader::check_work().is_ok());
    }

    #[test]
    fn normal_and_aggregate_cancelled_reads_stop_without_becoming_read_errors() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let owner = format!(
            "{}-{}",
            process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = env::temp_dir().join(format!("history-normal-cancel-{owner}"));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".owner"), &owner).unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        write_jsonl(&project, "cancel-session.jsonl", 1000);
        let config = Config {
            projects_dir: root.clone(),
        };
        for aggregate in [false, true] {
            let bytes = Arc::new(AtomicUsize::new(0));
            let observed = bytes.clone();
            let control = crate::record_reader::WorkControl::from_checkpoint(move |count| {
                if observed.fetch_add(count, Ordering::SeqCst).saturating_add(count) >= 16_384 {
                    return Err(crate::record_reader::reader_error(
                        "cancelled",
                        "fixture byte cancellation",
                    ));
                }
                Ok(())
            });
            let error = control
                .run(|| {
                    search(
                        &config,
                        SearchParams {
                            projects: vec!["project".to_string()],
                            aggregate,
                            summary: true,
                            ..SearchParams::default()
                        },
                    )
                })
                .unwrap_err();
            assert_eq!(error.error, "cancelled");
            assert!((16_384..32_768).contains(&bytes.load(Ordering::SeqCst)));
        }
        assert_eq!(fs::read_to_string(root.join(".owner")).unwrap(), owner);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn budget_preserves_query_and_bounded_structured_tool_preview() {
        let mut response = response_with_content("short".to_string());
        response.results[0].subtype = "tool_result".to_string();
        response.results[0].tool_result_redacted = Some(serde_json::json!({
            "payload": "x".repeat(20_000), "original_bytes": 1, "budget_preview": true,
            "get": {"ref":"unrelated:1", "source":"/outside/history.jsonl"}
        }));
        let params = SearchParams {
            pattern: "needle".to_string(),
            projects: vec!["project".to_string()],
            max_content_tool_result: 123,
            ..Default::default()
        };
        let budgeted = apply_response_budget(response, 2_000, build_next_query(&params, 0)).unwrap();
        assert_eq!(budgeted.results.len(), 1);
        assert_eq!(budgeted.results[0].r#ref, "session:1");
        let preview = budgeted.results[0].tool_result_redacted.as_ref().unwrap();
        assert_eq!(preview["get"]["ref"], "session:1");
        assert!(preview["original_bytes"].as_u64().unwrap() > 20_000);
        assert_eq!(
            budgeted.results[0]
                .tool_result_redacted
                .as_ref()
                .and_then(|value| value.get("truncated"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert!(serde_json::to_vec(&budgeted).unwrap().len() <= 2_000);

        let mut paged_response = response_with_content("first".to_string());
        let mut oversized = paged_response.results[0].clone();
        oversized.r#ref = "r".repeat(5_000);
        paged_response.results.push(oversized);
        paged_response.stats.total_matches = 2;
        paged_response.stats.returned_count = 2;
        paged_response.next_offset = 2;
        let paged = apply_response_budget(paged_response, 2_000, build_next_query(&params, 0)).unwrap();
        assert_eq!(paged.results.len(), 1);
        let query = paged.next_query.unwrap();
        assert_eq!(query.get("pattern").and_then(serde_json::Value::as_str), Some("needle"));
        assert_eq!(
            query.get("project").and_then(serde_json::Value::as_str),
            Some("project")
        );
        assert_eq!(
            query.get("max_content_tool_result").and_then(serde_json::Value::as_u64),
            Some(123)
        );
    }

    #[test]
    fn budgeted_slice_continuation_keeps_normalized_range() {
        for (raw, start, end) in [("[10:20]", 10, 20), ("[-10:]", 90, 100)] {
            let mut response = response_with_content("first".to_string());
            let first = response.results[0].clone();
            response.results = (0..10)
                .map(|index| {
                    let mut result = first.clone();
                    result.r#ref = if index == 0 {
                        format!("session:{}", start + index)
                    } else {
                        format!("{}-{index}", "r".repeat(5_000))
                    };
                    result.line = start + index;
                    result
                })
                .collect();
            response.stats.total_matches = 100;
            response.stats.returned_count = 10;
            response.stats.slice = Some(SearchSliceInfo {
                raw: raw.to_string(),
                start,
                end,
                total_before_slice: 100,
                total_after_slice: 10,
            });
            response.next_offset = 0;

            let params = SearchParams::default();
            let budgeted = apply_response_budget(response, 2_000, build_next_query(&params, 0)).unwrap();
            assert_eq!(budgeted.results.len(), 1);
            assert_eq!(budgeted.next_offset, start + 1);
            assert!(budgeted.has_more);
            let next_query = budgeted.next_query.as_ref().unwrap();
            let expected_slice = format!("[{}:{end}]", start + 1);
            assert_eq!(
                next_query.get("slice").and_then(serde_json::Value::as_str),
                Some(expected_slice.as_str())
            );
            assert!(next_query.get("offset").is_none());
            assert!(next_query.get("limit").is_none());
            assert!(serde_json::to_vec(&budgeted).unwrap().len() <= 2_000);
        }
    }

    #[test]
    fn budgeted_slice_continuation_repeats_without_leaving_range() {
        let end = 6usize;
        let mut start = 2usize;
        let mut returned_lines = Vec::new();

        while start < end {
            let mut response = response_with_content("first".to_string());
            let first = response.results[0].clone();
            response.results = (start..end)
                .map(|line| {
                    let mut result = first.clone();
                    result.r#ref = if line == start {
                        format!("session:{line}")
                    } else {
                        format!("{}-{line}", "r".repeat(5_000))
                    };
                    result.line = line;
                    result
                })
                .collect();
            response.stats.total_matches = 10;
            response.stats.returned_count = response.results.len();
            response.stats.slice = Some(SearchSliceInfo {
                raw: format!("[{start}:{end}]"),
                start,
                end,
                total_before_slice: 10,
                total_after_slice: end - start,
            });
            response.next_offset = 0;

            let params = SearchParams::default();
            let budgeted = apply_response_budget(response, 2_000, build_next_query(&params, 0)).unwrap();
            assert_eq!(budgeted.results.len(), 1);
            returned_lines.push(budgeted.results[0].line);

            let Some(next_query) = budgeted.next_query else {
                break;
            };
            let next_slice = next_query
                .get("slice")
                .and_then(serde_json::Value::as_str)
                .expect("slice continuation must retain its normalized range");
            let parsed = parse_message_slice_param(next_slice).unwrap();
            start = parsed.start.unwrap().try_into().unwrap();
            assert_eq!(parsed.end, Some(end.try_into().unwrap()));
        }

        assert_eq!(returned_lines, vec![2, 3, 4, 5]);
    }

    #[test]
    fn budgeted_slice_rejects_a_continuation_that_cannot_advance() {
        let mut response = response_with_content("first".to_string());
        let first = response.results[0].clone();
        response.results = (2..6)
            .map(|line| {
                let mut result = first.clone();
                result.r#ref = format!("{}-{line}", "r".repeat(5_000));
                result.line = line;
                result
            })
            .collect();
        response.stats.total_matches = 10;
        response.stats.returned_count = response.results.len();
        response.stats.slice = Some(SearchSliceInfo {
            raw: "[2:6]".to_string(),
            start: 2,
            end: 6,
            total_before_slice: 10,
            total_after_slice: 4,
        });
        response.next_offset = 0;

        let params = SearchParams::default();
        let error = apply_response_budget(response, 1_500, build_next_query(&params, 0)).unwrap_err();
        assert_eq!(error.error, "response_too_large");
        assert!(error.message.contains("无法在 max_total 字节预算内返回任何结果"));
    }

    #[test]
    fn pending_tool_ids_stop_search_before_unbounded_memory_growth() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = env::temp_dir().join(format!("mcp-search-pending-{}-{nonce}", process::id()));
        let project = tmp.join("project");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("session-pending.jsonl");
        let mut file = File::create(&path).unwrap();
        for (index, letter) in ['x', 'y'].into_iter().enumerate() {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("assistant-{index}"),
                    "type": "assistant",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_use", "id": letter.to_string().repeat(MAX_TOOL_PENDING_BYTES / 2 + 1024), "name": "Bash"}]}
                })
            )
            .unwrap();
        }
        drop(file);
        let params = SearchParams {
            pattern: "absent".to_string(),
            ..Default::default()
        };
        let result = search_file(
            "project",
            "session-pending",
            &path,
            &params,
            None,
            None,
            FileSearchLimits {
                max_matches: 10,
                max_bytes: MAX_SEARCH_RESULTS_BYTES,
            },
        )
        .unwrap();
        assert!(result.metadata_issues.contains(&"tool_pending_bytes_cap".to_string()));
        assert_eq!(result.lines_scanned, 2);
        let aggregate = search(
            &Config {
                projects_dir: tmp.clone(),
            },
            SearchParams {
                projects: vec!["project".to_string()],
                aggregate: true,
                pattern: "absent".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            aggregate
                .stats
                .incomplete_reasons
                .contains(&"tool_pending_bytes_cap".to_string())
        );
        fs::remove_dir_all(tmp).unwrap();
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
        let file_result = search_file(
            "proj",
            "session-aaa",
            &path,
            &p,
            None,
            None,
            FileSearchLimits {
                max_matches: cap,
                max_bytes: MAX_SEARCH_RESULTS_BYTES,
            },
        )
        .unwrap();
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
            "lines_scanned={lines_scanned} should be near cap={cap}"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn line_range_observes_tool_use_before_filtering_result_rows() {
        assert!(
            parse_message_record(r#"{"type":"custom-title","customTitle":"fixture"}"#)
                .unwrap()
                .is_none()
        );
        assert!(parse_message_record(r#"{"type":"assistant","message":{}}"#).is_err());

        let tmp = env::temp_dir().join(format!("mcp-search-metadata-test-{}", process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("session-metadata.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "custom-title",
                "customTitle": "metadata fixture"
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-1",
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [{"type": "tool_use", "id": "call-1", "name": "mcp__mcp-chrome__browse"}]}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-1",
                "type": "user",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "ok"}]}
            })
        )
        .unwrap();

        let mut params = SearchParams::default();
        params.types = vec!["user".to_string()];
        params.subtypes = vec!["tool_result".to_string()];
        params.lines = vec![Range {
            start: Some(3),
            end: Some(3),
            exclude: false,
        }];
        let result = search_file(
            "proj",
            "session-metadata",
            &path,
            &params,
            None,
            None,
            FileSearchLimits {
                max_matches: 10,
                max_bytes: MAX_SEARCH_RESULTS_BYTES,
            },
        )
        .unwrap();
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.parse_errors, 0);
        assert_eq!(result.metadata_parse_errors, 0);
        assert_eq!(result.results[0].server.as_deref(), Some("mcp-chrome"));
        assert_eq!(result.results[0].tool.as_deref(), Some("browse"));

        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        fs::copy(&path, project_dir.join("session-metadata.jsonl")).unwrap();
        let config = Config {
            projects_dir: tmp.clone(),
        };
        let base_params = SearchParams {
            projects: vec!["project".to_string()],
            types: vec!["user".to_string()],
            subtypes: vec!["tool_result".to_string()],
            lines: vec![Range {
                start: Some(3),
                end: Some(3),
                exclude: false,
            }],
            ..Default::default()
        };
        let normal = search(&config, base_params).unwrap();
        assert!(normal.stats.incomplete_reasons.is_empty());
        assert_eq!(normal.results[0].server.as_deref(), Some("mcp-chrome"));

        let aggregate = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                subtypes: vec!["tool_result".to_string()],
                lines: vec![Range {
                    start: Some(3),
                    end: Some(3),
                    exclude: false,
                }],
                aggregate: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(aggregate.stats.incomplete_reasons.is_empty());
        let summary = aggregate.stats.summary.unwrap();
        assert_eq!(summary.by_server[0].key, "mcp-chrome");
        assert_eq!(summary.by_tool[0].key, "browse");

        let output = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                subtypes: vec!["tool_result".to_string()],
                lines: vec![Range {
                    start: Some(3),
                    end: Some(3),
                    exclude: false,
                }],
                output: Some(format!("tmp:metadata-paths-{}", process::id())),
                summary: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(output.stats.incomplete_reasons.is_empty());
        let summary = output.stats.summary.as_ref().unwrap();
        assert_eq!(summary.by_server[0].key, "mcp-chrome");
        assert_eq!(summary.by_tool[0].key, "browse");
        assert!(
            output
                .output
                .as_ref()
                .unwrap()
                .retention
                .as_deref()
                .unwrap()
                .contains("24 小时")
        );
        assert!(serde_json::to_vec(&output).unwrap().len() <= output.max_total_bytes);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn unrelated_tool_attribution_does_not_make_content_search_incomplete() {
        let root = env::temp_dir().join(format!("mcp-search-attribution-test-{}", process::id()));
        for reason in ["unknown_id", "missing_id", "ambiguous_parent"] {
            let project = root.join(reason);
            fs::create_dir_all(&project).unwrap();
            let mut records = Vec::new();
            if reason == "ambiguous_parent" {
                records.push(serde_json::json!({
                    "uuid": "calls", "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [
                        {"type": "tool_use", "id": "a", "name": "mcp__mcp-chrome__browse"},
                        {"type": "tool_use", "id": "b", "name": "mcp__mcp-chrome__extract"}
                    ]}
                }));
            }
            let mut block = serde_json::json!({"type": "tool_result", "content": "tool needle"});
            if reason == "unknown_id" {
                block["tool_use_id"] = serde_json::json!("orphan");
            }
            records.push(serde_json::json!({
                "uuid": "result", "parentUuid": "calls", "type": "user",
                "timestamp": "2026-01-01T00:00:01Z", "message": {"content": [block]}
            }));
            records.push(serde_json::json!({
                "uuid": "human", "type": "user", "timestamp": "2026-01-02T00:00:00Z",
                "message": {"content": "human needle"}
            }));
            fs::write(
                project.join("session.jsonl"),
                records.iter().map(|record| format!("{record}\n")).collect::<String>(),
            )
            .unwrap();
            let config = Config {
                projects_dir: root.clone(),
            };
            for mode in ["normal", "summary", "aggregate", "output"] {
                for filter in ["keyword", "type", "time", "lines", "matched", "named"] {
                    let attributed = filter == "matched" || filter == "named";
                    let params = SearchParams {
                        projects: vec![reason.to_string()],
                        pattern: if attributed {
                            "tool"
                        } else if filter == "keyword" {
                            "human"
                        } else {
                            "needle"
                        }
                        .to_string(),
                        tools: if filter == "named" {
                            vec!["browse".to_string()]
                        } else {
                            Vec::new()
                        },
                        types: vec!["user".to_string()],
                        subtypes: if filter == "type" {
                            vec!["human".to_string()]
                        } else {
                            Vec::new()
                        },
                        since: (filter == "time").then(|| parse_time("2026-01-02T00:00:00Z").unwrap()),
                        lines: if filter == "lines" {
                            vec![Range {
                                start: Some(records.len()),
                                end: Some(records.len()),
                                exclude: false,
                            }]
                        } else {
                            Vec::new()
                        },
                        summary: mode == "summary" || mode == "output",
                        aggregate: mode == "aggregate",
                        output: (mode == "output")
                            .then(|| format!("tmp:attribution-{reason}-{filter}-{}", process::id())),
                        ..Default::default()
                    };
                    let response = search(&config, params).unwrap();
                    assert_eq!(
                        response.complete,
                        filter != "named",
                        "{reason}/{mode}/{filter}: {:?}",
                        response.stats.incomplete_reasons
                    );
                    assert_eq!(response.stats.total_matches_exact, filter != "named");
                    assert_eq!(response.stats.total_matches, usize::from(filter != "named"));
                    let expected_attribution: Vec<String> = if attributed {
                        vec![reason.to_string()]
                    } else {
                        Vec::new()
                    };
                    assert_eq!(response.stats.attribution_incomplete_reasons, expected_attribution);
                    if filter == "named" {
                        assert_eq!(response.stats.incomplete_reasons, ["tool_filter_unverifiable"]);
                    } else {
                        assert!(response.stats.incomplete_reasons.is_empty());
                    }
                    if filter == "matched" && !response.results.is_empty() {
                        assert_eq!(response.results[0].metadata_incomplete_reason.as_deref(), Some(reason));
                    }
                    if let Some(output) = response.output {
                        let manifest: serde_json::Value =
                            serde_json::from_slice(&fs::read(&output.manifest).unwrap()).unwrap();
                        assert_eq!(manifest["complete"], filter != "named");
                        assert_eq!(
                            manifest["attribution_incomplete_reasons"],
                            serde_json::json!(expected_attribution)
                        );
                        fs::remove_dir_all(output.results.parent().unwrap()).unwrap();
                    }
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coverage_paths_do_not_displace_search_hits() {
        let content = "needle正文".repeat(10);
        let mut response = response_with_content(content.clone());
        response.stats.coverage.searched_files = (0..100)
            .map(|i| format!("/history/unrelated-long-project-path/session-{i}.jsonl"))
            .collect();
        let response = apply_response_budget(response, 1800, serde_json::json!({})).unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].content, content);
        assert!(!response.results[0].truncated);
        assert!(response.stats.coverage.searched_files.len() < 100);
    }

    #[test]
    fn tool_result_uses_its_independent_preview_limit() {
        let mut params = SearchParams::default();
        params.max_content = 100;
        params.max_content_tool_result = 7;
        let result = SearchResult {
            r#ref: "session:1".to_string(),
            session: "session".to_string(),
            line: 1,
            uuid: "uuid".to_string(),
            r#type: "user".to_string(),
            subtype: "tool_result".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            content: "0123456789abcdef".to_string(),
            content_size: 16,
            truncated: false,
            image_count: 0,
            images: Vec::new(),
            project: "project".to_string(),
            source: None,
            block: None,
            server: None,
            tool: None,
            metadata_incomplete_reason: None,
            tool_input_redacted: None,
            tool_result_redacted: None,
            tool_result_is_error: None,
            tool_result_has_error_payload: None,
            raw_available: None,
            redacted: None,
            matched_filters: Vec::new(),
            match_pos: None,
            locator: None,
        };
        let results = truncate_selected_results(&params, vec![result]);
        assert!(results[0].content.chars().count() <= params.max_content_tool_result);
        assert!(results[0].truncated);
    }

    #[test]
    fn aggregate_limits_empty_uuid_and_unique_tool_names_before_retaining_them() {
        let result = SearchResult {
            r#ref: "session:1".to_string(),
            session: "session".to_string(),
            line: 1,
            uuid: String::new(),
            r#type: "assistant".to_string(),
            subtype: "tool_use".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            content: String::new(),
            content_size: 0,
            truncated: false,
            image_count: 0,
            images: Vec::new(),
            project: "project".to_string(),
            source: None,
            block: None,
            server: None,
            tool: Some("unique-tool".to_string()),
            metadata_incomplete_reason: None,
            tool_input_redacted: None,
            tool_result_redacted: None,
            tool_result_is_error: None,
            tool_result_has_error_payload: None,
            raw_available: None,
            redacted: None,
            matched_filters: Vec::new(),
            match_pos: None,
            locator: None,
        };
        let mut aggregation = SearchAggregation {
            retained_bytes: MAX_SEARCH_RESULTS_BYTES - 1,
            ..Default::default()
        };
        assert_eq!(aggregation.observe(&result), Err("aggregate_bytes_cap"));
        assert!(aggregation.by_tool.is_empty());
        aggregation.retained_bytes = 0;
        aggregation.matches = GLOBAL_RESULT_CAP - 1;
        assert!(aggregation.observe(&result).is_ok());
        assert_eq!(aggregation.observe(&result), Err("aggregate_matches_cap"));
        assert_eq!(aggregation.by_tool["unique-tool"], 1);
    }

    #[test]
    fn test_search_file_no_break_when_under_cap() {
        let tmp = env::temp_dir().join(format!("mcp-search-test2-{}", process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let path = write_jsonl(&tmp, "session-bbb.jsonl", 30);

        let mut p = SearchParams::default();
        p.types = vec!["user".to_string()];
        p.pattern = String::new();

        let file_result = search_file(
            "proj",
            "session-bbb",
            &path,
            &p,
            None,
            None,
            FileSearchLimits {
                max_matches: 1000,
                max_bytes: MAX_SEARCH_RESULTS_BYTES,
            },
        )
        .unwrap();
        assert_eq!(file_result.results.len(), 30, "all 30 should be returned");
        assert_eq!(file_result.lines_scanned, 30);
        assert!(!file_result.truncated, "should not mark truncation under cap");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn time_filter_excludes_invalid_timestamps_and_reports_the_count() {
        let tmp = env::temp_dir().join(format!("mcp-search-time-filter-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-time.jsonl")).unwrap();
        for (uuid, timestamp) in [("valid", "2026-01-02T00:00:00Z"), ("invalid", "not-a-time")] {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": uuid,
                    "type": "user",
                    "timestamp": timestamp,
                    "message": {"content": "message"}
                })
            )
            .unwrap();
        }

        let config = Config {
            projects_dir: tmp.clone(),
        };
        let filtered = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                since: Some(parse_time("2026-01-01").unwrap()),
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.results.len(), 1);
        assert_eq!(filtered.stats.skipped_invalid_timestamps, 1);
        assert!(
            filtered
                .stats
                .incomplete_reasons
                .iter()
                .any(|reason| reason == "timestamp_unparseable_excluded=1")
        );

        let unfiltered = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(unfiltered.results.len(), 2);
        assert_eq!(unfiltered.stats.skipped_invalid_timestamps, 0);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn search_matches_complete_tool_input_after_the_old_preview_boundary() {
        let tmp = env::temp_dir().join(format!("mcp-search-long-tool-input-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-long-input.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-long",
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [{
                    "type": "tool_use",
                    "id": "call-long",
                    "name": "Bash",
                    "input": {"command": format!("{}FAR_NEEDLE", "x".repeat(300))}
                }]}
            })
        )
        .unwrap();

        let response = search(
            &Config {
                projects_dir: tmp.clone(),
            },
            SearchParams {
                pattern: "FAR_NEEDLE".to_string(),
                projects: vec!["project".to_string()],
                types: vec!["assistant".to_string()],
                max_content: 100,
                ..SearchParams::default()
            },
        )
        .unwrap();

        assert_eq!(response.results.len(), 1);
        assert!(response.results[0].content.contains("FAR_NEEDLE"));
        assert!(
            response.results[0]
                .tool_input_redacted
                .as_ref()
                .and_then(|input| input.get("command"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|command| command.ends_with("FAR_NEEDLE"))
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn search_npm_tokens_are_redacted_in_structured_results_and_exports() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let command =
            format!("NPM-FIX-NEEDLE 前缀😀 printf '//registry.npmjs.org/:_authToken=%s\\n' '{secret}' --visible");
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("mcp-search-npm-{}-{nonce}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("npm-session-main.jsonl")).unwrap();
        for record in [
            serde_json::json!({"uuid":"npm-use","type":"assistant","timestamp":"2026-10-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"npm-call","name":"Bash","input":{"command":command,"note":"visible"}}]}}),
            serde_json::json!({"uuid":"npm-result","type":"user","timestamp":"2026-10-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"npm-call","content":command,"is_error":false}]}}),
        ] {
            writeln!(file, "{record}").unwrap();
        }
        let config = Config {
            projects_dir: root.clone(),
        };
        let params = |mode, structured: &str| SearchParams {
            projects: vec!["project".to_string()],
            pattern: "NPM-FIX-NEEDLE".to_string(),
            redaction: mode,
            structured: Some(structured.to_string()),
            max_content: 64,
            max_content_tool_result: 64,
            ..SearchParams::default()
        };
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            let expected = crate::utils::redact_text_with_mode(&command, mode).text;
            assert!(expected.contains("--visible"));
            for structured in ["full", "preview"] {
                let response = search(&config, params(mode, structured)).unwrap();
                assert_eq!(response.results.len(), 2);
                for row in &response.results {
                    let is_input = row.tool_input_redacted.is_some();
                    let value = row
                        .tool_input_redacted
                        .as_ref()
                        .or(row.tool_result_redacted.as_ref())
                        .unwrap();
                    let field = if is_input { "command" } else { "content" };
                    if mode.enabled() {
                        assert!(!row.content.contains(&secret));
                        assert!(!value.to_string().contains(&secret));
                    }
                    if structured == "full" {
                        assert_eq!(value[field].as_str().unwrap(), expected);
                        if is_input {
                            assert_eq!(value["note"], "visible");
                        }
                    } else {
                        let pointer = &value["get"];
                        assert_eq!(pointer["redaction"], mode.as_str());
                        let recovered = crate::get::get(
                            &config,
                            crate::get::GetParams {
                                r#ref: pointer["ref"].as_str().unwrap().to_string(),
                                range: None,
                                output: None,
                                project: pointer["project"].as_str().map(str::to_string),
                                source: pointer["source"].as_str().map(str::to_string),
                                redaction: mode,
                                overwrite: false,
                                view: pointer["view"].as_str().map(str::to_string),
                                block: pointer["block"].as_u64().map(|value| value as usize),
                            },
                        )
                        .unwrap();
                        let crate::types::GetResponse::Success { content, .. } = recovered else {
                            panic!("expected recovered content")
                        };
                        let recovered: serde_json::Value = serde_json::from_str(&content).unwrap();
                        assert_eq!(recovered[field].as_str().unwrap(), expected);
                        assert_eq!(content.contains(&secret), mode == RedactionMode::Off);
                    }
                }
            }
            let response = search(
                &config,
                SearchParams {
                    output: Some(format!(
                        "tmp:npm-search-export-{}-{nonce}-{}",
                        process::id(),
                        mode.as_str()
                    )),
                    ..params(mode, "full")
                },
            )
            .unwrap();
            let output = response.output.unwrap();
            let exported = fs::read_to_string(&output.results).unwrap();
            let rows: Vec<serde_json::Value> = exported
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(rows.len(), 2);
            assert_eq!(exported.contains(&secret), mode == RedactionMode::Off);
            let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&output.manifest).unwrap()).unwrap();
            assert_eq!(manifest["bytes"], exported.len());
            assert_eq!(manifest["count"], 2);
            assert_eq!(manifest["redaction"]["mode"], mode.as_str());
            fs::remove_dir_all(output.results.parent().unwrap()).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continuation_query_preserves_line_ranges_and_result_order() {
        let tmp = env::temp_dir().join(format!("mcp-search-lines-continuation-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        write_jsonl(&project_dir, "session-lines.jsonl", 8);
        let config = Config {
            projects_dir: tmp.clone(),
        };
        let first = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                lines: parse_line_ranges_param("5-7").unwrap(),
                limit: Some(1),
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(first.results[0].line, 5);
        let next_query = first.next_query.unwrap();
        assert_eq!(next_query["lines"], "5-7");

        let second = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                lines: parse_line_ranges_param(next_query["lines"].as_str().unwrap()).unwrap(),
                offset: next_query["offset"].as_u64().unwrap() as usize,
                limit: Some(next_query["limit"].as_u64().unwrap() as usize),
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(second.results[0].line, 6);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn multi_tool_search_keeps_name_payload_and_error_fields_on_one_block() {
        let tmp = env::temp_dir().join(format!("mcp-search-multi-tool-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let mut file = File::create(project_dir.join("session-multi-tool.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "assistant-tools",
                "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [
                    {"type": "tool_use", "id": "call-a", "name": "mcp__server__tool_a", "input": {"marker": "INPUT_A"}},
                    {"type": "tool_use", "id": "call-b", "name": "mcp__server__tool_b", "input": {"marker": "INPUT_B"}},
                    {"type": "tool_use", "id": "call-c", "name": "mcp__server__tool_c", "input": {"marker": "INPUT_C"}}
                ]}
            })
        )
        .unwrap();
        let payload_error = serde_json::json!({"success": false, "error": "A_FAIL"}).to_string();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-results",
                "type": "user",
                "timestamp": "2026-01-01T00:00:01Z",
                "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "call-a", "is_error": false, "content": payload_error},
                    {"type": "tool_result", "tool_use_id": "call-b", "is_error": true, "content": "B_FAIL"},
                    {"type": "tool_result", "tool_use_id": "call-c", "is_error": false, "content": "C_OK"}
                ]}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-inline-result",
                "type": "user",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": {"content": [
                    {
                        "type": "tool_use",
                        "id": "call-inline",
                        "name": "mcp__server__tool_inline",
                        "input": {"marker": "INPUT_INLINE"}
                    },
                    {
                        "type": "tool_result",
                        "tool_use_id": "call-inline",
                        "is_error": true,
                        "content": "INLINE_FAIL"
                    }
                ]}
            })
        )
        .unwrap();
        let config = Config {
            projects_dir: tmp.clone(),
        };

        let tool_use = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["assistant".to_string()],
                servers: vec!["server".to_string()],
                tools: vec!["tool_b".to_string()],
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(tool_use.results.len(), 1);
        assert_eq!(tool_use.results[0].tool.as_deref(), Some("tool_b"));
        assert_eq!(
            tool_use.results[0].tool_input_redacted.as_ref().unwrap()["marker"],
            "INPUT_B"
        );

        let failed = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                servers: vec!["server".to_string()],
                tools: vec!["tool_b".to_string()],
                failed_tool_results: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(failed.results.len(), 1);
        assert_eq!(failed.results[0].tool.as_deref(), Some("tool_b"));
        assert_eq!(failed.results[0].tool_result_is_error, Some(true));
        assert_eq!(
            failed.results[0].tool_result_redacted.as_ref().unwrap()["content"],
            "B_FAIL"
        );

        let payload_error = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                servers: vec!["server".to_string()],
                tools: vec!["tool_a".to_string()],
                tool_payload_errors: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(payload_error.results.len(), 1);
        assert_eq!(payload_error.results[0].tool.as_deref(), Some("tool_a"));
        assert_eq!(payload_error.results[0].tool_result_has_error_payload, Some(true));
        assert_eq!(payload_error.results[0].tool_result_is_error, Some(false));

        let inline_result = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                servers: vec!["server".to_string()],
                tools: vec!["tool_inline".to_string()],
                failed_tool_results: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(inline_result.results.len(), 1);
        assert_eq!(inline_result.results[0].tool.as_deref(), Some("tool_inline"));
        assert_eq!(inline_result.results[0].tool_result_is_error, Some(true));
        assert_eq!(
            inline_result.results[0].tool_result_redacted.as_ref().unwrap()["content"],
            "INLINE_FAIL"
        );

        for (tools, failed, payload, expected) in [
            ("Bash,mcp__server__tool_b", true, false, Some("tool_b")),
            ("Bash,mcp__server__tool_a", false, true, Some("tool_a")),
            ("mcp__server__tool_a,mcp__other__tool_b", true, false, None),
            ("mcp__server__tool_b,mcp__other__tool_a", false, true, None),
        ] {
            let response = search(
                &config,
                SearchParams {
                    projects: vec!["project".to_string()],
                    tools: split_csv_param(Some(tools)),
                    failed_tool_results: failed,
                    tool_payload_errors: payload,
                    ..SearchParams::default()
                },
            )
            .unwrap();
            assert_eq!(response.results.len(), usize::from(expected.is_some()));
            assert_eq!(
                response.results.first().and_then(|result| result.tool.as_deref()),
                expected
            );
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn agent_session_filter_uses_the_canonical_ref_prefix() {
        let tmp = env::temp_dir().join(format!("mcp-search-agent-ref-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let sidechain = tmp.join("project").join("main-session").join("subagents");
        fs::create_dir_all(&sidechain).unwrap();
        let mut file = File::create(sidechain.join("agent-12345678abcdef.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "agent-user",
                "type": "user",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": "agent message"}
            })
        )
        .unwrap();

        let response = search(
            &Config {
                projects_dir: tmp.clone(),
            },
            SearchParams {
                projects: vec!["project".to_string()],
                sessions: vec!["12345678".to_string()],
                types: vec!["user".to_string()],
                subagents: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].session, "agent-12345678abcdef");
        assert_eq!(response.results[0].r#ref, "12345678:1");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn literal_project_brackets_do_not_break_sidechain_lookup() {
        let root = env::temp_dir().join(format!("mcp-history[bracket]-{}", process::id()));
        let sidechain = root.join("project").join("main-session").join("subagents");
        fs::create_dir_all(&sidechain).unwrap();
        fs::write(
            sidechain.join("agent-12345678abcdef.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({
                    "uuid": "fixture-uuid", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "bracket fixture"}
                })
            ),
        )
        .unwrap();
        let config = Config {
            projects_dir: root.clone(),
        };
        let result = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                subagents: true,
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(result.results.len(), 1);
        let found = crate::get::find_session_file(&config, "12345678", Some("project"), None).unwrap();
        assert_eq!(found.1, "agent-12345678abcdef");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_export_uses_inline_filter_and_utc_order() {
        let root = env::temp_dir().join(format!("mcp-search-export-order-test-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        for (name, uuid, stamp, text) in [
            ("session-a.jsonl", "a", "2026-01-02T00:00:00+02:00", "needle a"),
            ("session-b.jsonl", "b", "2026-01-01T23:00:00Z", "needle b"),
            ("session-c.jsonl", "c", "2026-01-01T01:00:00Z", "ignored"),
        ] {
            fs::write(
                project.join(name),
                format!(
                    "{}\n",
                    serde_json::json!({
                        "uuid": uuid, "type": "user", "timestamp": stamp, "message": {"content": text}
                    })
                ),
            )
            .unwrap();
        }
        let config = Config {
            projects_dir: root.clone(),
        };
        let params = || SearchParams {
            projects: vec!["project".to_string()],
            pattern: "needle".to_string(),
            types: vec!["user".to_string()],
            summary: true,
            ..SearchParams::default()
        };
        let inline = search(&config, params()).unwrap();
        assert_eq!(
            inline
                .results
                .iter()
                .map(|result| result.uuid.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        let exported = search(
            &config,
            SearchParams {
                output: Some(format!("tmp:ordered-export-{}", process::id())),
                ..params()
            },
        )
        .unwrap();
        let info = exported.output.unwrap();
        let file = fs::read_to_string(&info.results).unwrap();
        let rows: Vec<serde_json::Value> = file.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(
            rows.iter()
                .map(|result| result["uuid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&info.manifest).unwrap()).unwrap();
        assert_eq!(manifest["count"], 2);
        assert_eq!(manifest["bytes"], file.len() as u64);
        assert_eq!(manifest["complete"], true);
        assert_eq!(manifest["schema"], "mcp-claude-history.search-results.v2");
        assert_eq!(manifest["summary"]["by_day"][0]["key"], "2026-01-01");
        fs::remove_dir_all(info.results.parent().unwrap()).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_export_caps_records_with_manifest_reason() {
        let root = env::temp_dir().join(format!("mcp-search-export-cap-test-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-many.jsonl")).unwrap();
        for i in 0..=MAX_EXPORT_RECORDS {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("row-{i}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "row"}
                })
            )
            .unwrap();
        }
        let output = search(
            &Config {
                projects_dir: root.clone(),
            },
            SearchParams {
                projects: vec!["project".to_string()],
                types: vec!["user".to_string()],
                output: Some(format!("tmp:capped-export-{}", process::id())),
                ..SearchParams::default()
            },
        )
        .unwrap();
        let info = output.output.unwrap();
        assert_eq!(info.written_count, MAX_EXPORT_RECORDS);
        assert!(!info.complete);
        assert!(info.cap_reasons.contains(&"export_record_cap".to_string()));
        let file = fs::read_to_string(&info.results).unwrap();
        assert_eq!(file.lines().count(), MAX_EXPORT_RECORDS);
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&info.manifest).unwrap()).unwrap();
        assert_eq!(manifest["count"], MAX_EXPORT_RECORDS);
        assert_eq!(manifest["bytes"], file.len() as u64);
        assert_eq!(manifest["complete"], false);
        assert_eq!(manifest["cap_reasons"], serde_json::json!(["export_record_cap"]));
        fs::remove_dir_all(info.results.parent().unwrap()).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_export_byte_cap_reports_actual_bytes() {
        let root = env::temp_dir().join(format!("mcp-search-export-byte-test-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-bytes.jsonl")).unwrap();
        for i in 0..20 {
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": format!("bytes-{i}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "x".repeat(1_000_000)}
                })
            )
            .unwrap();
        }
        let output = search(
            &Config {
                projects_dir: root.clone(),
            },
            SearchParams {
                projects: vec!["project".to_string()],
                output: Some(format!("tmp:byte-export-{}", process::id())),
                max_content: 1_000_000,
                ..SearchParams::default()
            },
        )
        .unwrap();
        let info = output.output.unwrap();
        assert!(!info.complete);
        assert!(info.bytes <= MAX_EXPORT_BYTES);
        assert!(info.cap_reasons.contains(&"export_byte_cap".to_string()));
        assert_eq!(info.bytes, fs::metadata(&info.results).unwrap().len());
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&info.manifest).unwrap()).unwrap();
        assert_eq!(manifest["bytes"], info.bytes);
        assert_eq!(manifest["max_export_bytes"], MAX_EXPORT_BYTES);
        fs::remove_dir_all(info.results.parent().unwrap()).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_capacity_reasons_make_counts_inexact_in_all_modes() {
        let root = env::temp_dir().join(format!("mcp-search-capacity-matrix-{}", process::id()));
        for reason in ["tool_blocks_cap", "tool_pending_cap", "tool_pending_bytes_cap"] {
            let project = root.join(reason.replace('=', "-"));
            fs::create_dir_all(&project).unwrap();
            let first = project.join("a-session.jsonl");
            let second = project.join("b-session.jsonl");
            let mut file = File::create(&first).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "uuid": "first", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": "needle"}
                })
            )
            .unwrap();
            if reason.starts_with("oversized") {
                writeln!(
                    file,
                    "{}",
                    serde_json::json!({
                        "uuid": "oversized", "type": "user", "timestamp": "2026-01-01T00:00:01Z",
                        "message": {"content": format!("needle{}", "x".repeat(MAX_JSONL_LINE_BYTES))}
                    })
                )
                .unwrap();
            } else {
                let counts = if reason == "tool_blocks_cap" {
                    vec![MAX_TOOL_BLOCKS + 1]
                } else if reason == "tool_pending_cap" {
                    vec![MAX_TOOL_BLOCKS, 1]
                } else {
                    vec![1, 1]
                };
                for (record, count) in counts.into_iter().enumerate() {
                    let blocks: Vec<_> = (0..count)
                        .map(|index| {
                            serde_json::json!({
                                "type": "tool_use", "name": "Bash",
                                "id": if reason == "tool_pending_bytes_cap" {
                                    format!("{record}{}", "x".repeat(MAX_TOOL_PENDING_BYTES / 2 + 1024))
                                } else { format!("call-{record}-{index}") }
                            })
                        })
                        .collect();
                    writeln!(
                        file,
                        "{}",
                        serde_json::json!({
                            "uuid": format!("calls-{record}"), "type": "assistant",
                            "timestamp": "2026-01-01T00:00:02Z", "message": {"content": blocks}
                        })
                    )
                    .unwrap();
                }
            }
            drop(file);
            fs::write(
                &second,
                format!(
                    "{}\n",
                    serde_json::json!({
                        "uuid": "second", "type": "user", "timestamp": "2026-01-01T00:00:03Z",
                        "message": {"content": "later needle"}
                    })
                ),
            )
            .unwrap();
            let config = Config {
                projects_dir: root.clone(),
            };
            for mode in ["normal", "summary", "aggregate", "output"] {
                let response = search(
                    &config,
                    SearchParams {
                        pattern: "needle".to_string(),
                        projects: vec![reason.replace('=', "-")],
                        types: vec!["user".to_string()],
                        summary: mode == "summary",
                        aggregate: mode == "aggregate",
                        output: (mode == "output")
                            .then(|| format!("tmp:capacity-matrix-{}-{reason}.jsonl", process::id())),
                        max_content: 100,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    response.stats.incomplete_reasons.contains(&reason.to_string()),
                    "{reason}/{mode}"
                );
                assert!(response.stats.incomplete, "{reason}/{mode}");
                assert!(!response.stats.total_matches_exact, "{reason}/{mode}");
                assert!(response.stats.attribution_incomplete_reasons.is_empty());
                let stopped = mode == "aggregate" && !reason.starts_with("oversized");
                assert_eq!(response.stats.files_scanned, if stopped { 1 } else { 2 });
                assert_eq!(
                    response.stats.coverage.searched_files,
                    if stopped {
                        vec![first.display().to_string()]
                    } else {
                        vec![first.display().to_string(), second.display().to_string()]
                    }
                );
                assert_eq!(
                    response.stats.coverage.skipped_files,
                    if stopped {
                        vec![second.display().to_string()]
                    } else {
                        Vec::new()
                    }
                );
                if let Some(output) = response.output {
                    let manifest: serde_json::Value =
                        serde_json::from_slice(&fs::read(output.manifest).unwrap()).unwrap();
                    assert_eq!(manifest["complete"], false);
                    assert_eq!(
                        manifest["coverage"],
                        serde_json::to_value(&response.stats.coverage).unwrap()
                    );
                    fs::remove_dir_all(output.results.parent().unwrap()).unwrap();
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn result_memory_cap_reports_only_attempted_files_and_disjoint_manifest_paths() {
        let root = env::temp_dir().join(format!("mcp-search-memory-coverage-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let first = project.join("a-session.jsonl");
        let second = project.join("b-session.jsonl");
        let mut file = File::create(&first).unwrap();
        let content = format!("needle{}", "x".repeat(7 * 1024 * 1024));
        for index in 0..5 {
            let record = serde_json::json!({
                "uuid": format!("large-{index}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": content}
            })
            .to_string();
            assert!(record.len() < MAX_JSONL_LINE_BYTES);
            writeln!(file, "{record}").unwrap();
        }
        drop(file);
        fs::write(
            &second,
            format!(
                "{}\n",
                serde_json::json!({
                    "uuid": "later", "type": "user", "timestamp": "2026-01-01T00:00:01Z",
                    "message": {"content": "later needle"}
                })
            ),
        )
        .unwrap();
        let config = Config {
            projects_dir: root.clone(),
        };
        for mode in ["normal", "summary", "output"] {
            let response = search(
                &config,
                SearchParams {
                    projects: vec!["project".to_string()],
                    pattern: "needle".to_string(),
                    types: vec!["user".to_string()],
                    redaction: RedactionMode::Off,
                    max_content: 100,
                    summary: mode == "summary",
                    output: (mode == "output").then(|| format!("tmp:memory-coverage-{}.jsonl", process::id())),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(response.stats.files_scanned, 1);
            assert_eq!(response.stats.total_matches, 4);
            assert!(
                response
                    .stats
                    .incomplete_reasons
                    .contains(&"result_memory_cap".to_string())
            );
            assert!(!response.stats.total_matches_exact);
            assert_eq!(response.stats.coverage.searched_files, [first.display().to_string()]);
            assert_eq!(response.stats.coverage.skipped_files, [second.display().to_string()]);
            if let Some(output) = response.output {
                let manifest: serde_json::Value = serde_json::from_slice(&fs::read(output.manifest).unwrap()).unwrap();
                assert_eq!(
                    manifest["coverage"],
                    serde_json::to_value(&response.stats.coverage).unwrap()
                );
                assert!(
                    !manifest["coverage"]["searched_files"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|path| manifest["coverage"]["skipped_files"].as_array().unwrap().contains(path))
                );
                fs::remove_dir_all(output.results.parent().unwrap()).unwrap();
            } else {
                let budgeted = match apply_response_budget(response.clone(), 1400, serde_json::json!({})) {
                    Ok(budgeted) => {
                        assert!(budgeted.serialized_bytes <= 1400);
                        budgeted
                    }
                    Err(error) => {
                        assert_eq!(error.error, "response_too_large");
                        let available = error.available.unwrap();
                        assert!(available["required_bytes"].as_u64().unwrap() > 1400);
                        assert_eq!(available["get"]["source"], first.display().to_string());
                        let next_query = available["next_query"].clone();
                        assert_eq!(next_query["offset"], 0);
                        let max_total = next_query["max_total"].as_u64().unwrap() as usize;
                        let budgeted = apply_response_budget(response, max_total, next_query).unwrap();
                        assert!(budgeted.serialized_bytes <= max_total);
                        budgeted
                    }
                };
                assert_eq!(budgeted.serialized_bytes, serde_json::to_vec(&budgeted).unwrap().len());
                assert!(!budgeted.stats.total_matches_exact);
                assert!(
                    budgeted.stats.coverage.searched_files.iter().all(|path| !budgeted
                        .stats
                        .coverage
                        .skipped_files
                        .contains(path))
                );
            }
        }
        let dry_run = search(
            &config,
            SearchParams {
                projects: vec!["project".to_string()],
                dry_run: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(dry_run.stats.files_scanned, 0);
        assert_eq!(dry_run.stats.coverage.searched_files.len(), 2);
        assert!(dry_run.stats.coverage.skipped_files.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn aggregate_early_stops_exclude_unopened_suffix_files() {
        let root = env::temp_dir().join(format!("mcp-search-aggregate-coverage-{}", process::id()));
        for reason in ["uuid_dedupe_cap", "aggregate_matches_cap", "aggregate_bytes_cap"] {
            let project = root.join(reason);
            fs::create_dir_all(&project).unwrap();
            let first = project.join("a-session.jsonl");
            let second = project.join("b-session.jsonl");
            let mut file = File::create(&first).unwrap();
            let count = if reason == "aggregate_bytes_cap" {
                5
            } else {
                GLOBAL_RESULT_CAP + 1
            };
            for index in 0..count {
                let uuid = match reason {
                    "aggregate_matches_cap" => String::new(),
                    "aggregate_bytes_cap" => format!("{index}{}", "x".repeat(7 * 1024 * 1024)),
                    _ => format!("uuid-{index}"),
                };
                writeln!(
                    file,
                    "{}",
                    serde_json::json!({
                        "uuid": uuid, "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                        "message": {"content": "needle"}
                    })
                )
                .unwrap();
            }
            drop(file);
            fs::write(&second, "").unwrap();
            let response = search(
                &Config {
                    projects_dir: root.clone(),
                },
                SearchParams {
                    projects: vec![reason.to_string()],
                    aggregate: true,
                    redaction: RedactionMode::Off,
                    pattern: "needle".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(response.stats.incomplete_reasons, [reason]);
            assert_eq!(response.stats.files_scanned, 1);
            assert_eq!(
                response.stats.total_matches,
                if reason == "aggregate_bytes_cap" {
                    4
                } else {
                    GLOBAL_RESULT_CAP
                }
            );
            assert!(!response.stats.total_matches_exact);
            assert_eq!(response.stats.coverage.searched_files, [first.display().to_string()]);
            assert_eq!(response.stats.coverage.skipped_files, [second.display().to_string()]);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn coverage_attempts_include_empty_and_failed_files_in_every_mode() {
        let root = env::temp_dir().join(format!("mcp-search-attempted-coverage-{}", process::id()));
        fs::create_dir_all(&root).unwrap();
        let empty = root.join("empty.jsonl");
        fs::write(&empty, "").unwrap();
        let missing = root.join("missing.jsonl");
        for mode in ["normal", "summary", "aggregate", "output"] {
            for paths in [Vec::new(), vec![empty.clone()], vec![missing.clone(), empty.clone()]] {
                let files: Vec<SearchFile> = paths
                    .iter()
                    .enumerate()
                    .map(|(index, path)| ("project".to_string(), format!("session-{index}"), path.clone()))
                    .collect();
                let params = SearchParams {
                    summary: mode == "summary",
                    aggregate: mode == "aggregate",
                    output: (mode == "output")
                        .then(|| format!("tmp:attempted-coverage-{}-{}.jsonl", process::id(), paths.len())),
                    ..Default::default()
                };
                let response = if mode == "aggregate" {
                    search_aggregate_streaming(&params, &files, None, None, Instant::now()).unwrap()
                } else if mode == "output" {
                    search_to_output_bounded(&params, &files, None, None, Instant::now()).unwrap()
                } else {
                    let collection = collect_search_results(&params, &files, None, None).unwrap();
                    build_search_response(params, files, collection, Instant::now()).unwrap()
                };
                assert_eq!(response.stats.files_scanned, paths.len());
                assert_eq!(
                    response.stats.coverage.searched_files,
                    paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>()
                );
                assert!(response.stats.coverage.skipped_files.is_empty());
                assert_eq!(response.stats.total_matches_exact, !paths.contains(&missing));
                if let Some(output) = response.output {
                    fs::remove_dir_all(output.results.parent().unwrap()).unwrap();
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_large_record_reports_parse_error_and_preserves_following_line() {
        let root = env::temp_dir().join(format!("mcp-search-oversized-test-{}", process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = File::create(project.join("session-oversized.jsonl")).unwrap();
        writeln!(file, "{}", "x".repeat(MAX_JSONL_LINE_BYTES + 1)).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "valid", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": "needle"}
            })
        )
        .unwrap();
        let config = Config {
            projects_dir: root.clone(),
        };
        let result = search(
            &config,
            SearchParams {
                pattern: "needle".to_string(),
                projects: vec!["project".to_string()],
                ..SearchParams::default()
            },
        )
        .unwrap();
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].line, 2);
        assert!(result.stats.incomplete_reasons.contains(&"parse_errors=1".to_string()));
        assert!(result.stats.incomplete);
        fs::remove_dir_all(root).unwrap();
    }
}

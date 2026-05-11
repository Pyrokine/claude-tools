use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use std::fs::File;
use std::io::{BufRead, BufReader};
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
    pub lines: Vec<Range>,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub offset: usize,
    pub limit: Option<usize>,
    pub max_content: usize,
    /// tool_result 子类型的最大内容长度（独立控制，默认 500）
    pub max_content_tool_result: usize,
    pub max_total: usize,
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
            lines: Vec::new(),
            use_regex: false,
            case_sensitive: false,
            offset: 0,
            limit: None,
            max_content: 4000,
            max_content_tool_result: 500,
            max_total: 40000,
            subagents: false,
        }
    }
}

/// 单文件命中上限（避免单一巨型 jsonl 把内存吃满）
/// 上限 = clamp((offset + limit) * 2, 1_000, GLOBAL_RESULT_CAP)
/// 不让 offset 把单文件 cap 拉到无限，否则并行 search_file 会先 OOM 再被全局截断
fn per_file_cap(params: &SearchParams) -> usize {
    let target = params.offset.saturating_add(params.limit.unwrap_or(10_000));
    target.saturating_mul(2).clamp(1_000, GLOBAL_RESULT_CAP)
}

/// 全局命中硬上限（防止 OOM；超过即截断 + 在响应里标 truncated）
const GLOBAL_RESULT_CAP: usize = 50_000;

/// 执行搜索
pub fn search(config: &Config, params: SearchParams) -> Result<SearchResponse, ErrorResponse> {
    let start = Instant::now();

    // 确定要搜索的项目
    let project_dirs = get_project_dirs(config, &params)?;

    // 收集所有 jsonl 文件
    let files = collect_jsonl_files(&project_dirs, &params.sessions, params.subagents);

    // 编译正则（如果需要）
    // 注：Rust 的 `regex` crate 基于 NFA，无回溯，最坏 O(n*m)，因此不需要 ReDoS 启发式检测
    // （与 mcp-chrome extension 的 JS 路径不同，JS RegExp 是回溯实现）
    let regex = if params.use_regex && !params.pattern.is_empty() {
        match RegexBuilder::new(&params.pattern)
            .case_insensitive(!params.case_sensitive)
            .build()
        {
            Ok(r) => Some(r),
            Err(e) => {
                return Err(ErrorResponse {
                    error: "invalid_regex".to_string(),
                    message: format!("无效的正则表达式: {}", e),
                    available: None,
                });
            }
        }
    } else {
        None
    };

    // 解析搜索模式
    let search_pattern = if !params.use_regex && !params.pattern.is_empty() {
        Some(parse_search_pattern(&params.pattern, params.case_sensitive))
    } else {
        None
    };

    // 单文件早停阈值（防止单文件命中过多直接拖垮内存）
    let file_cap = per_file_cap(&params);

    // 并行搜索所有文件
    let file_results: Vec<_> = files
        .par_iter()
        .map(|(project_id, session_id, path)| {
            search_file(
                project_id,
                session_id,
                path,
                &params,
                regex.as_ref(),
                search_pattern.as_ref(),
                file_cap,
            )
        })
        .collect();

    // 汇总结果
    let mut all_results: Vec<SearchResult> = Vec::new();
    let mut files_scanned = 0;
    let mut lines_scanned = 0;

    for (file_lines, results) in file_results {
        files_scanned += 1;
        lines_scanned += file_lines;
        all_results.extend(results);
    }

    // 全局硬截断：超过 GLOBAL_RESULT_CAP 直接砍掉，避免后续 sort/dedup 处理超大 Vec
    let truncated_global = all_results.len() > GLOBAL_RESULT_CAP;
    if truncated_global {
        all_results.truncate(GLOBAL_RESULT_CAP);
    }

    // 按时间排序
    all_results.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    // UUID 去重：跨会话去重（延续会话镜像场景），保留最早出现的一条
    let mut seen_uuids = std::collections::HashSet::new();
    // 空 UUID（uuid: ""）跳过去重，避免将多条无 uuid 消息合并为一条
    all_results.retain(|r| r.uuid.is_empty() || seen_uuids.insert(r.uuid.clone()));

    let total_matches = all_results.len();

    // 应用 offset 和 limit
    let results: Vec<SearchResult> = all_results
        .into_iter()
        .skip(params.offset)
        .take(params.limit.unwrap_or(usize::MAX))
        .collect();

    // 应用 max_total 限制
    // 每条结果的 JSON 元数据（ref、session、uuid、timestamp、project 等）约 300 字符
    const METADATA_OVERHEAD: usize = 300;
    let mut final_results = Vec::new();
    let mut total_chars = 0;

    for mut result in results {
        // tool_result 默认使用更小的截断限制（除非用户显式设置了 max_content）
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
            break;
        }

        total_chars += result_size;
        final_results.push(result);
    }

    let returned_count = final_results.len();
    // 使用 saturating_sub 防止下溢
    let remaining = total_matches.saturating_sub(params.offset);
    // has_more 仅表示"还有可继续翻的页"；truncated_global 通过 stats 单独告知客户端"被截"
    // 不能让 has_more = ... || truncated_global，否则到底后客户端拿 has_more=true + next_offset 不动，分页死循环
    let has_more = returned_count < remaining;
    let next_offset = params.offset + returned_count;

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned,
            lines_scanned,
            total_matches,
            returned_count,
            time_ms: start.elapsed().as_millis() as u64,
            truncated_global: truncated_global.then_some(true),
        },
        results: final_results,
        has_more,
        next_offset,
    })
}

/// 获取要搜索的项目目录
fn get_project_dirs(config: &Config, params: &SearchParams) -> Result<Vec<(String, PathBuf)>, ErrorResponse> {
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
            let dir = config.project_dir(project_id)?;
            if !dir.exists() {
                return Err(ErrorResponse {
                    error: "project_not_found".to_string(),
                    message: format!("项目不存在: {}", project_id),
                    available: Some(config.available_projects_json()),
                });
            }
            dirs.push((project_id.clone(), dir));
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
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    if let Some(session_id) = session_id_from_filename(&entry.file_name().to_string_lossy()) {
                        if session_matches_filter(&session_id, sessions) {
                            files.push((project_id.clone(), session_id, path));
                        }
                    }
                }
            }
        }

        if !include_subagents {
            continue;
        }

        // subagents 目录
        let subagents_pattern = dir.join("*/subagents");
        if let Ok(entries) = glob::glob(&subagents_pattern.to_string_lossy()) {
            for subdir in entries.flatten() {
                if let Ok(sub_entries) = std::fs::read_dir(&subdir) {
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

    files
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
) -> (usize, Vec<SearchResult>) {
    let mut results = Vec::new();
    let mut lines_scanned = 0;

    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, results),
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

        // 类型分类
        let (effective_type, subtype) = classify_message(&record);

        // 类型过滤（使用分类后的 effective_type）
        if !params.types.iter().any(|t| t == effective_type) {
            continue;
        }

        // 子类型过滤
        if !params.subtypes.is_empty() && !params.subtypes.iter().any(|s| s == subtype) {
            continue;
        }

        // 时间过滤
        if !time_in_range(&record.timestamp, params.since.as_ref(), params.until.as_ref()) {
            continue;
        }

        // 一次遍历同时提取文本内容和图片列表
        let (content, images) = extract_and_replace_images(&record);

        // 内容匹配
        let (matches, match_pos) = if params.pattern.is_empty() {
            (true, None)
        } else if let Some(regex) = regex {
            if let Some(m) = regex.find(&content) {
                (true, Some(content[..m.start()].chars().count()))
            } else {
                (false, None)
            }
        } else if let Some(pattern) = pattern {
            matches_pattern(&content, pattern, params.case_sensitive)
        } else {
            (true, None)
        };

        if !matches {
            continue;
        }

        // 图片信息已在 extract_and_replace_images 中一并提取
        let image_count = images.len();
        let content_size = content.chars().count();

        results.push(SearchResult {
            r#ref: format!("{}:{}", prefix, line_num),
            session: session_id.to_string(),
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
            project: project_id.to_string(),
            match_pos,
        });

        // 单文件早停（避免一个巨型 jsonl 把内存吃满）
        if results.len() >= max_per_file {
            break;
        }
    }

    (lines_scanned, results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_jsonl(dir: &Path, name: &str, lines: usize) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
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
        let tmp = std::env::temp_dir().join(format!("mcp-search-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = write_jsonl(&tmp, "session-aaa.jsonl", 200);

        let mut p = SearchParams::default();
        p.types = vec!["user".to_string()]; // 默认含 user，但显式收紧避免被其他默认类型干扰
        p.pattern = String::new(); // 全部命中

        let cap = 50;
        let (lines_scanned, results) = search_file("proj", "session-aaa", &path, &p, None, None, cap);
        assert!(
            results.len() <= cap,
            "results.len()={} should be <= cap={}",
            results.len(),
            cap
        );
        assert_eq!(results.len(), cap, "should hit exactly cap");
        // lines_scanned 在 break 前已 +1，所以 ≤ cap 行（每行命中即 push 后才检查 break）
        assert!(
            lines_scanned <= cap + 1 && lines_scanned >= cap,
            "lines_scanned={} should be near cap={}",
            lines_scanned,
            cap
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_search_file_no_break_when_under_cap() {
        let tmp = std::env::temp_dir().join(format!("mcp-search-test2-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let path = write_jsonl(&tmp, "session-bbb.jsonl", 30);

        let mut p = SearchParams::default();
        p.types = vec!["user".to_string()];
        p.pattern = String::new();

        let (lines_scanned, results) = search_file("proj", "session-bbb", &path, &p, None, None, 1000);
        assert_eq!(results.len(), 30, "all 30 should be returned");
        assert_eq!(lines_scanned, 30);

        std::fs::remove_dir_all(&tmp).ok();
    }
}

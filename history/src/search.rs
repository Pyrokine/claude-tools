use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use rayon::prelude::*;
use regex::Regex;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
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
    pub lines: Vec<Range>,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub offset: usize,
    pub limit: Option<usize>,
    pub max_content: usize,
    pub max_total: usize,
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
            lines: Vec::new(),
            use_regex: false,
            case_sensitive: false,
            offset: 0,
            limit: None,
            max_content: 4000,
            max_total: 40000,
        }
    }
}

/// 执行搜索
pub fn search(config: &Config, params: SearchParams) -> Result<SearchResponse, ErrorResponse> {
    let start = Instant::now();

    // 确定要搜索的项目
    let project_dirs = get_project_dirs(config, &params)?;

    // 收集所有 jsonl 文件
    let files = collect_jsonl_files(&project_dirs, &params.sessions);

    // 编译正则（如果需要）
    let regex = if params.use_regex && !params.pattern.is_empty() {
        let flags = if params.case_sensitive { "" } else { "(?i)" };
        match Regex::new(&format!("{}{}", flags, params.pattern)) {
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
        Some(parse_search_pattern(&params.pattern))
    } else {
        None
    };

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

    let total_matches = all_results.len();

    // 按时间排序
    all_results.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    // 应用 offset 和 limit
    let results: Vec<SearchResult> = all_results
        .into_iter()
        .skip(params.offset)
        .take(params.limit.unwrap_or(usize::MAX))
        .collect();

    // 应用 max_total 限制
    let mut final_results = Vec::new();
    let mut total_chars = 0;

    for mut result in results {
        // 截断单条内容
        let (content, truncated) = truncate_content(&result.content, params.max_content);
        result.content = content;
        result.truncated = truncated || result.truncated;

        let result_chars = result.content.len();
        if total_chars + result_chars > params.max_total && !final_results.is_empty() {
            break;
        }

        total_chars += result_chars;
        final_results.push(result);
    }

    let returned_count = final_results.len();
    // 使用 saturating_sub 防止下溢
    let remaining = total_matches.saturating_sub(params.offset);
    let has_more = returned_count < remaining;
    let next_offset = params.offset + returned_count;

    Ok(SearchResponse {
        stats: SearchStats {
            files_scanned,
            lines_scanned,
            total_matches,
            returned_count,
            time_ms: start.elapsed().as_millis() as u64,
        },
        results: final_results,
        has_more,
        next_offset,
    })
}

/// 获取要搜索的项目目录
fn get_project_dirs(config: &Config, params: &SearchParams) -> Result<Vec<(String, PathBuf)>, ErrorResponse> {
    if params.all_projects {
        // 搜索所有项目
        let entries = std::fs::read_dir(&config.projects_dir).map_err(|e| ErrorResponse {
            error: "io_error".to_string(),
            message: format!("无法读取项目目录: {}", e),
            available: None,
        })?;

        let mut dirs = Vec::new();
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let id = entry.file_name().to_string_lossy().to_string();
                dirs.push((id, entry.path()));
            }
        }
        return Ok(dirs);
    }

    if !params.projects.is_empty() {
        // 搜索指定项目
        let mut dirs = Vec::new();
        for project_id in &params.projects {
            let dir = config.project_dir(project_id);
            if !dir.exists() {
                return Err(ErrorResponse {
                    error: "project_not_found".to_string(),
                    message: format!("项目不存在: {}", project_id),
                    available: Some(list_available_projects(config)),
                });
            }
            dirs.push((project_id.clone(), dir));
        }
        return Ok(dirs);
    }

    // 默认：当前项目
    if let Some(project_id) = config.current_project_id() {
        let dir = config.project_dir(&project_id);
        return Ok(vec![(project_id, dir)]);
    }

    // 找不到当前项目，返回错误
    Err(ErrorResponse {
        error: "no_current_project".to_string(),
        message: "无法确定当前项目，请使用 --project 指定".to_string(),
        available: Some(list_available_projects(config)),
    })
}

/// 列出可用项目
fn list_available_projects(config: &Config) -> serde_json::Value {
    let mut projects = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&config.projects_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let id = entry.file_name().to_string_lossy().to_string();
                let path = id.replace('-', "/");
                projects.push(serde_json::json!({ "id": id, "path": path }));
            }
        }
    }
    serde_json::json!(projects)
}

/// 收集所有 jsonl 文件
fn collect_jsonl_files(
    project_dirs: &[(String, PathBuf)],
    sessions: &[String],
) -> Vec<(String, String, PathBuf)> {
    let mut files = Vec::new();

    for (project_id, dir) in project_dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    if let Some(session_id) = session_id_from_filename(&entry.file_name().to_string_lossy()) {
                        // 过滤 sessions
                        if !sessions.is_empty() {
                            let prefix = ref_prefix(&session_id);
                            if !sessions.iter().any(|s| s == &session_id || s == &prefix) {
                                continue;
                            }
                        }
                        files.push((project_id.clone(), session_id, path));
                    }
                }
            }
        }

        // 也搜索 subagents 目录
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
                                files.push((project_id.clone(), session_id, path));
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
    path: &PathBuf,
    params: &SearchParams,
    regex: Option<&Regex>,
    pattern: Option<&SearchPattern>,
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

        // 类型过滤
        if !params.types.iter().any(|t| t == &record.msg_type) {
            continue;
        }

        // 时间过滤
        if !time_in_range(&record.timestamp, params.since.as_ref(), params.until.as_ref()) {
            continue;
        }

        // 提取内容（图片替换为占位符）
        let content = replace_images_with_placeholders(&record);

        // 内容匹配
        let matches = if params.pattern.is_empty() {
            true
        } else if let Some(regex) = regex {
            matches_regex(&content, regex)
        } else if let Some(pattern) = pattern {
            matches_pattern(&content, pattern, params.case_sensitive)
        } else {
            true
        };

        if !matches {
            continue;
        }

        // 提取图片信息
        let images = extract_images(&record);
        let image_count = images.len();
        let content_size = content.len();

        results.push(SearchResult {
            r#ref: format!("{}:{}", prefix, line_num),
            session: session_id.to_string(),
            line: line_num,
            uuid: record.uuid,
            r#type: record.msg_type,
            timestamp: record.timestamp,
            content,
            content_size,
            truncated: false,
            image_count,
            images,
            project: project_id.to_string(),
        });
    }

    (lines_scanned, results)
}

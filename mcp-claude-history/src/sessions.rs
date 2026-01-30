use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};

/// 列出项目的会话
pub fn list_sessions(config: &Config, project_id: Option<&str>) -> Result<SessionsResponse, ErrorResponse> {
    // 确定项目
    let project_id = match project_id {
        Some(id) => id.to_string(),
        None => config.current_project_id().ok_or_else(|| ErrorResponse {
            error: "no_current_project".to_string(),
            message: "无法确定当前项目，请使用 --project 指定".to_string(),
            available: None,
        })?,
    };

    let project_dir = config.project_dir(&project_id);
    if !project_dir.exists() {
        return Err(ErrorResponse {
            error: "project_not_found".to_string(),
            message: format!("项目不存在: {}", project_id),
            available: None,
        });
    }

    let entries = fs::read_dir(&project_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法读取项目目录: {}", e),
        available: None,
    })?;

    let mut sessions = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            continue;
        }

        let filename = entry.file_name().to_string_lossy().to_string();
        let Some(session_id) = session_id_from_filename(&filename) else {
            continue;
        };

        // 获取文件信息
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        // 统计行数并获取时间范围
        let (line_count, start_time, end_time) = get_session_stats(&path);

        sessions.push(SessionInfo {
            id: session_id.clone(),
            ref_prefix: ref_prefix(&session_id),
            line_count,
            start_time,
            end_time,
            size_bytes,
        });
    }

    // 按结束时间排序（最新的在前）
    sessions.sort_by(|a, b| b.end_time.cmp(&a.end_time));

    Ok(SessionsResponse {
        project: project_id,
        sessions,
    })
}

/// 获取会话统计信息
fn get_session_stats(path: &std::path::Path) -> (usize, String, String) {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, String::new(), String::new()),
    };

    let reader = BufReader::new(file);
    let mut line_count = 0;
    let mut start_time = String::new();
    let mut end_time = String::new();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        line_count += 1;

        // 只解析时间字段，不解析整个消息
        if let Ok(record) = serde_json::from_str::<MessageRecord>(&line) {
            if start_time.is_empty() {
                start_time = record.timestamp.clone();
            }
            end_time = record.timestamp;
        }
    }

    (line_count, start_time, end_time)
}

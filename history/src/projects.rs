use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::fs;

/// 列出所有项目
pub fn list_projects(config: &Config) -> Result<ProjectsResponse, ErrorResponse> {
    let entries = fs::read_dir(&config.projects_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法读取项目目录: {}", e),
        available: None,
    })?;

    let mut projects = Vec::new();

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let id = entry.file_name().to_string_lossy().to_string();
        let path = id.replace('-', "/");
        let dir = entry.path();

        // 统计会话数量和最后活动时间
        let mut session_count = 0;
        let mut last_activity = String::new();
        let mut last_mtime = std::time::SystemTime::UNIX_EPOCH;

        if let Ok(files) = fs::read_dir(&dir) {
            for file in files.flatten() {
                let file_path = file.path();
                if file_path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    if let Some(_session_id) = session_id_from_filename(&file.file_name().to_string_lossy()) {
                        session_count += 1;

                        if let Ok(meta) = file.metadata() {
                            if let Ok(mtime) = meta.modified() {
                                if mtime > last_mtime {
                                    last_mtime = mtime;
                                }
                            }
                        }
                    }
                }
            }
        }

        // 转换时间
        if last_mtime != std::time::SystemTime::UNIX_EPOCH {
            if let Ok(duration) = last_mtime.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                let dt = chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0);
                if let Some(dt) = dt {
                    last_activity = dt.format("%Y-%m-%dT%H:%M:%SZ").to_string();
                }
            }
        }

        projects.push(ProjectInfo {
            id,
            path,
            session_count,
            last_activity,
        });
    }

    // 按最后活动时间排序（最新的在前）
    projects.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    Ok(ProjectsResponse { projects })
}

use crate::config::Config;
use crate::types::*;
use crate::utils::*;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};

/// 列出项目的会话
pub fn list_sessions(
    config: &Config,
    project_id: Option<&str>,
    redaction: RedactionMode,
) -> Result<SessionsResponse, ErrorResponse> {
    // 确定项目
    let project_id = match project_id {
        Some(id) => config.normalize_project_id(id)?,
        None => config.current_project_id().ok_or_else(|| {
            let available = config.available_projects_json();
            ErrorResponse {
                error: "no_current_project".to_string(),
                message: "无法确定当前项目，请使用 --project 指定".to_string(),
                available: if available.as_array().map(|a| a.is_empty()).unwrap_or(true) {
                    None
                } else {
                    Some(available)
                },
            }
        })?,
    };

    let project_dir = config.project_dir(&project_id)?;
    if !project_dir.exists() {
        return Err(ErrorResponse {
            error: "project_not_found".to_string(),
            message: format!("项目不存在: {project_id}"),
            available: None,
        });
    }

    let entries = fs::read_dir(&project_dir).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法读取项目目录: {e}"),
        available: None,
    })?;

    let mut sessions = Vec::new();
    let mut redacted_count = 0usize;

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

        // 统计行数并获取时间范围和主题
        let (line_count, start_time, end_time, topic, topic_redacted_count) = get_session_stats(&path, redaction);
        redacted_count += topic_redacted_count;

        sessions.push(SessionInfo {
            id: session_id.clone(),
            ref_prefix: ref_prefix(&session_id),
            line_count,
            start_time,
            end_time,
            size_bytes,
            topic,
            topic_redacted_count,
        });
    }

    // 按结束时间排序（最新的在前）
    sessions.sort_by(|a, b| b.end_time.cmp(&a.end_time));

    Ok(SessionsResponse {
        project: project_id,
        sessions,
        redaction: redaction_info(
            redaction,
            redacted_count,
            redaction == RedactionMode::Off || redacted_count > 0,
        ),
    })
}

/// 获取会话统计信息
fn get_session_stats(
    path: &std::path::Path,
    redaction_mode: RedactionMode,
) -> (usize, String, String, Option<String>, usize) {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, String::new(), String::new(), None, 0),
    };

    let reader = BufReader::new(file);
    let mut line_count = 0;
    let mut start_time = String::new();
    let mut end_time = String::new();
    let mut topic: Option<String> = None;
    let mut topic_redacted_count = 0usize;

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
            end_time = record.timestamp.clone();

            // 提取首条 user 消息作为 topic（跳过 summary 和 meta）
            if topic.is_none()
                && record.msg_type == "user"
                && !record.is_compact_summary
                && !record.is_meta
                && let Some(text) = extract_topic_text(&record)
                && !text.is_empty()
            {
                let redaction = redact_text_with_mode(&text, redaction_mode);
                topic_redacted_count += redaction.count;
                let preview: String = redaction.text.chars().take(100).collect();
                topic = Some(if redaction.text.chars().count() > 100 {
                    format!("{preview}...")
                } else {
                    preview
                });
            }
        }
    }

    (line_count, start_time, end_time, topic, topic_redacted_count)
}

/// 从消息记录中提取文本内容（用于生成会话主题）
fn extract_topic_text(record: &MessageRecord) -> Option<String> {
    let message = record.message.as_ref()?;
    let content = message.get("content")?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(arr) = content.as_array() {
        for item in arr {
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                return Some(text.to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::io::Write;
    use std::process;

    #[test]
    fn session_topics_redact_before_truncation_for_string_and_content_block_messages() {
        let tmp = env::temp_dir().join(format!("mcp-sessions-redaction-test-{}", process::id()));
        fs::remove_dir_all(&tmp).ok();
        let project_dir = tmp.join("project");
        fs::create_dir_all(&project_dir).unwrap();
        let topic = "topic token=SESSION_TEST_SECRET https://session.example.test";
        let mut file = File::create(project_dir.join("session-topic.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "uuid": "user-1",
                "type": "user",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": [{"type": "text", "text": topic}]}
            })
        )
        .unwrap();

        let config = Config {
            projects_dir: tmp.clone(),
        };
        let auto = list_sessions(&config, Some("project"), RedactionMode::Auto).unwrap();
        let auto_topic = auto.sessions[0].topic.as_deref().unwrap();
        assert!(!auto_topic.contains("SESSION_TEST_SECRET"));
        assert!(auto_topic.contains("token=[redacted]"));
        assert!(auto.sessions[0].topic_redacted_count > 0);
        assert!(auto.redaction.redacted_count > 0);

        let strict = list_sessions(&config, Some("project"), RedactionMode::Strict).unwrap();
        assert!(
            !strict.sessions[0]
                .topic
                .as_deref()
                .unwrap()
                .contains("session.example.test")
        );

        let off = list_sessions(&config, Some("project"), RedactionMode::Off).unwrap();
        assert!(
            off.sessions[0]
                .topic
                .as_deref()
                .unwrap()
                .contains("SESSION_TEST_SECRET")
        );

        fs::remove_dir_all(&tmp).ok();
    }
}

use crate::config::Config;
use crate::types::*;
use crate::utils::*;
#[cfg(test)]
use std::fs::{self, File};
use std::io::BufReader;

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

    let sources = crate::session_files::collect_session_files(&[(project_id.clone(), project_dir)], &[], false)?;
    let mut sessions = Vec::new();
    let mut redacted_count = 0usize;

    for (_, session_id, path) in sources {
        // 获取文件信息
        let size_bytes = crate::session_files::open_session_file(&path)
            .and_then(|file| file.metadata())
            .map_err(|e| ErrorResponse {
                error: "io_error".to_string(),
                message: format!("无法读取会话文件属性 {}: {e}", path.display()),
                available: None,
            })?
            .len();

        // 统计行数并获取时间范围和主题
        let stats = get_session_stats(&path, redaction)?;
        redacted_count += stats.topic_redacted_count;

        sessions.push(SessionInfo {
            id: session_id.clone(),
            ref_prefix: ref_prefix(&session_id),
            line_count: stats.line_count,
            start_time: stats.start_time,
            end_time: stats.end_time,
            size_bytes,
            topic: stats.topic,
            topic_redacted_count: stats.topic_redacted_count,
            skipped_oversized_lines: stats.skipped_oversized_lines,
        });
    }

    // 按结束时间排序（最新的在前）
    sessions.sort_by(|a, b| {
        parse_time(&b.end_time)
            .cmp(&parse_time(&a.end_time))
            .then_with(|| a.id.cmp(&b.id))
    });

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
#[derive(Debug)]
struct SessionStats {
    line_count: usize,
    start_time: String,
    end_time: String,
    topic: Option<String>,
    topic_redacted_count: usize,
    skipped_oversized_lines: usize,
}

fn get_session_stats(path: &std::path::Path, redaction_mode: RedactionMode) -> Result<SessionStats, ErrorResponse> {
    let file = crate::session_files::open_session_file(path).map_err(|e| ErrorResponse {
        error: "io_error".to_string(),
        message: format!("无法读取会话文件 {}: {e}", path.display()),
        available: None,
    })?;

    let reader = BufReader::new(file);
    let mut line_count = 0;
    let mut start_time = String::new();
    let mut end_time = String::new();
    let mut topic: Option<String> = None;
    let mut topic_redacted_count = 0usize;
    let mut skipped_oversized_lines = 0usize;

    for line in bounded_jsonl_lines(reader) {
        let line = match line {
            Ok(BoundedLine::Record(l)) => l,
            Ok(BoundedLine::TooLarge) => {
                skipped_oversized_lines += 1;
                line_count += 1;
                continue;
            }
            Err(e) => {
                return Err(ErrorResponse {
                    error: "io_error".to_string(),
                    message: format!("读取会话文件 {} 失败: {e}", path.display()),
                    available: None,
                });
            }
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

    Ok(SessionStats {
        line_count,
        start_time,
        end_time,
        topic,
        topic_redacted_count,
        skipped_oversized_lines,
    })
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
    fn missing_session_file_is_not_reported_as_an_empty_session() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!("mcp-history-missing-session-{}-{nonce}.jsonl", process::id()));
        assert_eq!(
            get_session_stats(&path, RedactionMode::Auto).unwrap_err().error,
            "io_error"
        );
    }

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

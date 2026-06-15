use crate::types::ErrorResponse;
use crate::utils::project_id_to_display_path;
use std::env;
use std::fs;
use std::path::PathBuf;

/// 配置
#[derive(Debug, Clone)]
pub struct Config {
    pub projects_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let claude_dir = dirs::home_dir()
            .map(|h| h.join(".claude"))
            .unwrap_or_else(|| PathBuf::from(".claude"));

        Self {
            projects_dir: claude_dir.join("projects"),
        }
    }

    /// 获取当前项目 ID（从 CWD 推断）
    pub fn current_project_id(&self) -> Option<String> {
        let cwd = env::current_dir().ok()?;
        // Claude Code 的转换规则：/、\、:、_ 都变成 -
        let project_id = cwd.to_string_lossy().replace(['\\', '/', ':', '_'], "-");

        // 检查该项目目录是否存在
        if self.projects_dir.join(&project_id).exists() {
            Some(project_id)
        } else {
            None
        }
    }

    /// 获取项目目录，允许传 project id；普通路径只会被归一化为已存在的唯一 project id
    pub fn project_dir(&self, project_id: &str) -> Result<PathBuf, ErrorResponse> {
        let project_id = self.normalize_project_id(project_id)?;
        Ok(self.projects_dir.join(project_id))
    }

    pub fn normalize_project_id(&self, raw: &str) -> Result<String, ErrorResponse> {
        if validate_project_id(raw).is_ok() {
            return Ok(raw.to_string());
        }

        let normalized = raw.replace(['\\', '/', ':', '_'], "-");
        let candidates: Vec<_> = self
            .list_project_dirs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(id, _)| {
                let path = project_id_to_display_path(&id);
                if id == normalized || path == raw {
                    Some(serde_json::json!({ "id": id, "path": path }))
                } else {
                    None
                }
            })
            .collect();

        if candidates.len() == 1
            && let Some(id) = candidates[0].get("id").and_then(|v| v.as_str())
        {
            return Ok(id.to_string());
        }

        let mut available = serde_json::Map::new();
        available.insert(
            "candidate_project_id".to_string(),
            serde_json::Value::String(normalized),
        );
        available.insert("candidates".to_string(), serde_json::Value::Array(candidates));
        available.insert(
            "examples".to_string(),
            serde_json::json!(["project=<project-id>", "project=<absolute-project-path>"]),
        );

        Err(ErrorResponse {
            error: "invalid_project_id".to_string(),
            message: format!(
                "project 参数既不是有效 project id，也不能唯一映射到已存在 project: {}",
                raw
            ),
            available: Some(serde_json::Value::Object(available)),
        })
    }

    /// 列出所有项目目录
    pub fn list_project_dirs(&self) -> std::io::Result<Vec<(String, PathBuf)>> {
        let mut dirs = Vec::new();
        for entry in fs::read_dir(&self.projects_dir)?.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let id = entry.file_name().to_string_lossy().to_string();
                dirs.push((id, entry.path()));
            }
        }
        Ok(dirs)
    }

    /// 列出可用项目（用于错误提示）
    pub fn available_projects_json(&self) -> serde_json::Value {
        let projects: Vec<_> = self
            .list_project_dirs()
            .unwrap_or_default()
            .into_iter()
            .map(|(id, _)| {
                let path = project_id_to_display_path(&id);
                serde_json::json!({ "id": id, "path": path })
            })
            .collect();
        serde_json::json!(projects)
    }
}

/// 校验 project_id 字符白名单,拒绝路径注入字符
fn validate_project_id(project_id: &str) -> Result<(), ErrorResponse> {
    if project_id.is_empty() {
        return Err(ErrorResponse {
            error: "invalid_project_id".to_string(),
            message: "project_id 不能为空".to_string(),
            available: None,
        });
    }
    if project_id.starts_with('.') {
        return Err(ErrorResponse {
            error: "invalid_project_id".to_string(),
            message: format!("project_id 不允许以 `.` 开头: {}", project_id),
            available: None,
        });
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if !project_id.chars().all(allowed) {
        return Err(ErrorResponse {
            error: "invalid_project_id".to_string(),
            message: format!("project_id 仅允许字母、数字、`-`、`_`,实际值: {}", project_id),
            available: None,
        });
    }
    Ok(())
}

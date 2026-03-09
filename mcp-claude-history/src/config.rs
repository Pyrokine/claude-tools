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
        let cwd_str = cwd.to_string_lossy()
            .replace('\\', "-")
            .replace('/', "-")
            .replace(':', "-");
        // On Linux, paths start with / which becomes -, so the ID naturally starts with -
        // On Windows, paths start with a drive letter (e.g. D:), so no leading - is added
        // Claude Code uses the same conversion, so just use the result directly
        let project_id = cwd_str;

        // 检查该项目目录是否存在
        if self.projects_dir.join(&project_id).exists() {
            Some(project_id)
        } else {
            None
        }
    }

    /// 获取项目目录
    pub fn project_dir(&self, project_id: &str) -> PathBuf {
        self.projects_dir.join(project_id)
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
        let projects: Vec<_> = self.list_project_dirs().unwrap_or_default()
            .into_iter()
            .map(|(id, _)| {
                let path = project_id_to_display_path(&id);
                serde_json::json!({ "id": id, "path": path })
            })
            .collect();
        serde_json::json!(projects)
    }
}

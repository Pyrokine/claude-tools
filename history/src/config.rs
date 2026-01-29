use std::env;
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
        let cwd_str = cwd.to_string_lossy().replace('/', "-");
        let project_id = if cwd_str.starts_with('-') {
            cwd_str.to_string()
        } else {
            format!("-{}", cwd_str)
        };

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
}

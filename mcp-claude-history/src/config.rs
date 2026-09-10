use crate::types::ErrorResponse;
use crate::utils::project_id_to_display_path;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDisplayPath {
    pub path: String,
    pub approximate: bool,
}

pub fn project_path_to_id(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

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
        let project_id = project_path_to_id(&cwd.to_string_lossy());

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

        let normalized = project_path_to_id(raw);
        let candidates: Vec<_> = self
            .list_project_dirs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(id, _)| {
                let display = self.project_display_path(&id);
                if id == normalized || (!display.approximate && display.path == raw) {
                    Some(serde_json::json!({
                        "id": id,
                        "path": display.path,
                        "path_approximate": display.approximate,
                    }))
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
            message: format!("project 参数既不是有效 project id，也不能唯一映射到已存在 project: {raw}"),
            available: Some(serde_json::Value::Object(available)),
        })
    }

    pub fn project_display_path(&self, project_id: &str) -> ProjectDisplayPath {
        if let Some(path) = resolve_existing_project_path(project_id) {
            return ProjectDisplayPath {
                path: path.to_string_lossy().to_string(),
                approximate: false,
            };
        }
        ProjectDisplayPath {
            path: project_id_to_display_path(project_id),
            approximate: true,
        }
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
                let display = self.project_display_path(&id);
                serde_json::json!({
                    "id": id,
                    "path": display.path,
                    "path_approximate": display.approximate,
                })
            })
            .collect();
        serde_json::json!(projects)
    }
}

fn resolve_existing_project_path(project_id: &str) -> Option<PathBuf> {
    let (root, remaining) = project_root_and_remaining(project_id)?;
    if remaining.is_empty() {
        return None;
    }
    let mut matches = Vec::new();
    resolve_path_components(&root, remaining, &mut matches);
    (matches.len() == 1).then(|| matches.remove(0))
}

fn resolve_path_components(current: &Path, remaining: &str, matches: &mut Vec<PathBuf>) {
    if matches.len() > 1 {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path();
        if !candidate.is_dir() {
            continue;
        }
        let encoded_name = project_path_to_id(&entry.file_name().to_string_lossy());
        if encoded_name.is_empty() {
            continue;
        }
        let next_remaining = if remaining == encoded_name {
            Some("")
        } else {
            remaining
                .strip_prefix(&encoded_name)
                .and_then(|suffix| suffix.strip_prefix('-'))
        };
        let Some(next_remaining) = next_remaining else {
            continue;
        };
        if next_remaining.is_empty() {
            matches.push(candidate);
        } else {
            resolve_path_components(&candidate, next_remaining, matches);
        }
        if matches.len() > 1 {
            return;
        }
    }
}

#[cfg(unix)]
fn project_root_and_remaining(project_id: &str) -> Option<(PathBuf, &str)> {
    Some((PathBuf::from("/"), project_id.strip_prefix('-')?))
}

#[cfg(windows)]
fn project_root_and_remaining(project_id: &str) -> Option<(PathBuf, &str)> {
    let bytes = project_id.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b"--" {
        return None;
    }
    Some((PathBuf::from(format!("{}:\\", &project_id[..1])), &project_id[3..]))
}

#[cfg(not(any(unix, windows)))]
fn project_root_and_remaining(_: &str) -> Option<(PathBuf, &str)> {
    None
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
            message: format!("project_id 不允许以 `.` 开头: {project_id}"),
            available: None,
        });
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if !project_id.chars().all(allowed) {
        return Err(ErrorResponse {
            error: "invalid_project_id".to_string(),
            message: format!("project_id 仅允许字母、数字、`-`、`_`,实际值: {project_id}"),
            available: None,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;

    #[test]
    fn resolves_existing_project_paths_without_losing_punctuation() {
        let temp_root = env::temp_dir().join(format!("mcp-project-path-test-{}", process::id()));
        fs::remove_dir_all(&temp_root).ok();
        let project_path = temp_root.join("claude-tools").join("dev_foo").join(".local");
        fs::create_dir_all(&project_path).unwrap();
        let project_id = project_path_to_id(&project_path.to_string_lossy());
        let projects_dir = temp_root.join("projects");
        fs::create_dir_all(projects_dir.join(&project_id)).unwrap();
        let config = Config { projects_dir };

        let display = config.project_display_path(&project_id);
        assert_eq!(display.path, project_path.to_string_lossy());
        assert!(!display.approximate);
        assert_eq!(
            config.normalize_project_id(&project_path.to_string_lossy()).unwrap(),
            project_id
        );
        assert_eq!(project_path_to_id("/home/a_b/.cache/x y"), "-home-a-b--cache-x-y");

        fs::remove_dir_all(&temp_root).ok();
    }

    #[test]
    fn marks_nonexistent_project_paths_as_approximate() {
        let config = Config {
            projects_dir: env::temp_dir(),
        };
        let project_id = format!("-mcp-missing-project-path-{}", process::id());
        let display = config.project_display_path(&project_id);
        assert!(display.approximate);
        assert_eq!(display.path, project_id_to_display_path(&project_id));
    }
}

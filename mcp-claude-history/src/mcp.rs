use crate::config::Config;
use crate::context::{context, ContextParams};
use crate::get::{get, GetParams};
use crate::projects::list_projects;
use crate::search::{search, SearchParams};
use crate::sessions::list_sessions;
use crate::types::Range;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

thread_local! {
    /// 从客户端 roots 获取的当前项目 ID
    static CLIENT_PROJECT: RefCell<Option<String>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

/// MCP 工具定义 - 按设计方案
fn get_tools() -> Vec<Value> {
    vec![
        // history_search - 搜索对话
        json!({
            "name": "history_search",
            "description": "Search through Claude Code conversation history",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Search pattern (empty string returns all messages)"
                    },
                    "project": {
                        "type": "string",
                        "description": "Project ID to search (comma-separated for multiple)"
                    },
                    "all": {
                        "type": "boolean",
                        "description": "Search all projects",
                        "default": false
                    },
                    "sessions": {
                        "type": "string",
                        "description": "Session IDs to search (comma-separated)"
                    },
                    "since": {
                        "type": "string",
                        "description": "Start time (ISO 8601 or relative: today, week, month)"
                    },
                    "until": {
                        "type": "string",
                        "description": "End time (ISO 8601)"
                    },
                    "types": {
                        "type": "string",
                        "description": "Message types: assistant,user,summary (comma-separated)",
                        "default": "assistant,user,summary"
                    },
                    "lines": {
                        "type": "string",
                        "description": "Line ranges: 100, 100-200, 100-, -200, !100-200"
                    },
                    "regex": {
                        "type": "boolean",
                        "description": "Use regex pattern matching",
                        "default": false
                    },
                    "case_sensitive": {
                        "type": "boolean",
                        "description": "Case sensitive search",
                        "default": false
                    },
                    "offset": {
                        "type": "number",
                        "description": "Skip first N results",
                        "default": 0
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum results to return"
                    },
                    "max_content": {
                        "type": "number",
                        "description": "Max characters per result",
                        "default": 4000
                    },
                    "max_total": {
                        "type": "number",
                        "description": "Max total characters",
                        "default": 40000
                    }
                }
            }
        }),
        // history_get - 获取完整内容
        json!({
            "name": "history_get",
            "description": "Get full content of a message by ref",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Message reference (session_prefix:line, e.g. c86bc677:1234)"
                    },
                    "range": {
                        "type": "string",
                        "description": "Character range for chunked retrieval (e.g. 0-100000)"
                    },
                    "output": {
                        "type": "string",
                        "description": "Output directory path (auto-extract images)"
                    },
                    "project": {
                        "type": "string",
                        "description": "Project ID"
                    }
                },
                "required": ["ref"]
            }
        }),
        // history_context - 获取上下文
        json!({
            "name": "history_context",
            "description": "Get surrounding messages for context",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Message reference (session_prefix:line)"
                    },
                    "before": {
                        "type": "number",
                        "description": "Number of messages before (counts only matching types if types specified)"
                    },
                    "after": {
                        "type": "number",
                        "description": "Number of messages after (counts only matching types if types specified)"
                    },
                    "until_type": {
                        "type": "string",
                        "description": "Continue until this message type"
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["forward", "backward"],
                        "description": "Direction to search",
                        "default": "forward"
                    },
                    "types": {
                        "type": "string",
                        "description": "Message types to include: user,assistant,summary (comma-separated)"
                    },
                    "project": {
                        "type": "string",
                        "description": "Project ID"
                    },
                    "max_content": {
                        "type": "number",
                        "description": "Max characters per message",
                        "default": 4000
                    },
                    "max_total": {
                        "type": "number",
                        "description": "Max total characters",
                        "default": 40000
                    }
                },
                "required": ["ref"]
            }
        }),
        // history_projects - 列出项目
        json!({
            "name": "history_projects",
            "description": "List all projects with conversation history",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        // history_sessions - 列出会话
        json!({
            "name": "history_sessions",
            "description": "List sessions in a project",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project ID (optional, defaults to current)"
                    }
                }
            }
        }),
    ]
}

pub fn run_mcp_server() {
    let config = Config::from_env();
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if line.is_empty() {
            continue;
        }

        // 尝试解析为 roots/list 响应（必须匹配我们发出的请求 ID）
        if let Ok(response) = serde_json::from_str::<Value>(&line) {
            if response.get("id") == Some(&Value::String("roots-list-1".to_string()))
                && response.get("result").is_some()
            {
                handle_roots_response(&response);
                continue;
            }
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let response = JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: Value::Null,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {}", e),
                        data: None,
                    }),
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap_or_default());
                let _ = stdout.flush();
                continue;
            }
        };

        if let Some(response) = handle_request(&config, &request, &mut stdout) {
            let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap_or_default());
            let _ = stdout.flush();
        }
    }
}

/// 处理来自客户端的 roots/list 响应
fn handle_roots_response(response: &Value) {
    if let Some(result) = response.get("result") {
        if let Some(roots) = result.get("roots").and_then(|r| r.as_array()) {
            for root in roots {
                if let Some(uri) = root.get("uri").and_then(|u| u.as_str()) {
                    // uri 格式: file:///path/to/project
                    if let Some(path) = uri.strip_prefix("file://") {
                        // 从路径推断 project ID
                        if let Some(project_id) = path_to_project_id(path) {
                            CLIENT_PROJECT.with(|p| {
                                *p.borrow_mut() = Some(project_id);
                            });
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// 将路径转换为 project ID
/// 路径格式: /home/py/CLion/dev_xxx → -home-py-CLion-dev-xxx
/// Claude Code 会把 `/` 和 `_` 都替换成 `-`，并保留前导 `-`
fn path_to_project_id(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    // Claude Code 的转换规则：/ 和 _ 都变成 -，且必须以 - 开头
    let id = path.replace('/', "-").replace('_', "-");
    if id.starts_with('-') {
        Some(id)
    } else {
        Some(format!("-{}", id))
    }
}

/// 发送 roots/list 请求给客户端
fn send_roots_request(stdout: &mut io::Stdout) {
    let request = json!({
        "jsonrpc": "2.0",
        "id": "roots-list-1",
        "method": "roots/list"
    });
    let _ = writeln!(stdout, "{}", serde_json::to_string(&request).unwrap_or_default());
    let _ = stdout.flush();
}

fn handle_request(config: &Config, request: &JsonRpcRequest, stdout: &mut io::Stdout) -> Option<JsonRpcResponse> {
    let id = request.id.clone().unwrap_or(Value::Null);

    match request.method.as_str() {
        "initialize" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {},
                    "roots": {
                        "listChanged": true
                    }
                },
                "serverInfo": {
                    "name": "mcp-claude-history",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })),
            error: None,
        }),

        "notifications/initialized" | "initialized" => {
            // 发送 roots/list 请求获取客户端工作目录
            send_roots_request(stdout);
            None
        }

        "tools/list" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({
                "tools": get_tools()
            })),
            error: None,
        }),

        "tools/call" => {
            let tool_name = request.params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let arguments = request.params.get("arguments").cloned().unwrap_or(json!({}));

            Some(match execute_tool(config, tool_name, arguments) {
                Ok(result) => JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                        }]
                    })),
                    error: None,
                },
                Err(e) => JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&e).unwrap_or_else(|_| e.to_string())
                        }],
                        "isError": true
                    })),
                    error: None,
                },
            })
        }

        _ => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", request.method),
                data: None,
            }),
        }),
    }
}

fn execute_tool(config: &Config, tool_name: &str, args: Value) -> Result<Value, Value> {
    match tool_name {
        "history_search" => execute_search(config, args),
        "history_get" => execute_get(config, args),
        "history_context" => execute_context(config, args),
        "history_projects" => execute_projects(config),
        "history_sessions" => execute_sessions(config, args),
        _ => Err(json!({
            "error": "unknown_tool",
            "message": format!("Unknown tool: {}", tool_name)
        })),
    }
}

fn execute_search(config: &Config, args: Value) -> Result<Value, Value> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    let project = args.get("project").and_then(|v| v.as_str());
    let all = args.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
    let sessions = args.get("sessions").and_then(|v| v.as_str());
    let since = args.get("since").and_then(|v| v.as_str());
    let until = args.get("until").and_then(|v| v.as_str());
    let types = args.get("types").and_then(|v| v.as_str());
    let lines = args.get("lines").and_then(|v| v.as_str());
    let regex = args.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
    let case_sensitive = args.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false);
    let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    let max_content = args.get("max_content").and_then(|v| v.as_u64()).unwrap_or(4000) as usize;
    let max_total = args.get("max_total").and_then(|v| v.as_u64()).unwrap_or(40000) as usize;

    // 优先级：指定 project > 从 roots 获取 > 搜索所有
    let (projects, all_projects) = if let Some(p) = project {
        (p.split(',').map(|s| s.trim().to_string()).collect(), false)
    } else if all {
        (vec![], true)
    } else {
        // 尝试使用从 roots 获取的当前项目
        let client_project = CLIENT_PROJECT.with(|p| p.borrow().clone());
        if let Some(proj) = client_project {
            (vec![proj], false)
        } else {
            // 无法确定当前项目，搜索所有
            (vec![], true)
        }
    };

    let params = SearchParams {
        pattern: pattern.to_string(),
        projects,
        all_projects,
        sessions: sessions.map(|s| s.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default(),
        since: parse_datetime(since),
        until: parse_datetime(until),
        types: types.map(|t| t.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_else(|| vec!["assistant".to_string(), "user".to_string(), "summary".to_string()]),
        lines: lines.map(|l| Range::parse_ranges(l)).unwrap_or_default(),
        use_regex: regex,
        case_sensitive,
        offset,
        limit,
        max_content,
        max_total,
    };

    match search(config, params) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn execute_get(config: &Config, args: Value) -> Result<Value, Value> {
    let r#ref = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
    let range = args.get("range").and_then(|v| v.as_str());
    let output = args.get("output").and_then(|v| v.as_str());
    let project = args.get("project").and_then(|v| v.as_str());

    let range = range.and_then(|r| {
        let parts: Vec<&str> = r.split('-').collect();
        if parts.len() == 2 {
            let start = parts[0].parse().ok()?;
            let end = parts[1].parse().ok()?;
            Some((start, end))
        } else {
            None
        }
    });

    let params = GetParams {
        r#ref: r#ref.to_string(),
        range,
        output: output.map(PathBuf::from),
        project: project.map(String::from),
    };

    match get(config, params) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn execute_context(config: &Config, args: Value) -> Result<Value, Value> {
    let r#ref = args.get("ref").and_then(|v| v.as_str()).unwrap_or("");
    let before = args.get("before").and_then(|v| v.as_u64()).map(|v| v as usize);
    let after = args.get("after").and_then(|v| v.as_u64()).map(|v| v as usize);
    let until_type = args.get("until_type").and_then(|v| v.as_str());
    let direction = args.get("direction").and_then(|v| v.as_str()).unwrap_or("forward");
    let types = args.get("types").and_then(|v| v.as_str());
    let project = args.get("project").and_then(|v| v.as_str());
    let max_content = args.get("max_content").and_then(|v| v.as_u64()).unwrap_or(4000) as usize;
    let max_total = args.get("max_total").and_then(|v| v.as_u64()).unwrap_or(40000) as usize;

    let params = ContextParams {
        r#ref: r#ref.to_string(),
        before,
        after,
        until_type: until_type.map(String::from),
        direction: direction.to_string(),
        project: project.map(String::from),
        types: types.map(|t| t.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default(),
        max_content,
        max_total,
    };

    match context(config, params) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn execute_projects(config: &Config) -> Result<Value, Value> {
    match list_projects(config) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn execute_sessions(config: &Config, args: Value) -> Result<Value, Value> {
    let project = args.get("project").and_then(|v| v.as_str());

    match list_sessions(config, project) {
        Ok(response) => Ok(serde_json::to_value(response).unwrap_or(Value::Null)),
        Err(e) => Err(serde_json::to_value(e).unwrap_or(Value::Null)),
    }
}

fn parse_datetime(s: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    use chrono::TimeZone;

    let s = s?;
    // 使用本地时区
    let local = chrono::Local::now();
    let local_tz = local.timezone();

    match s {
        "today" => {
            // 今天 0 点（本地时间）转 UTC
            let start = local.date_naive().and_hms_opt(0, 0, 0)?;
            let local_dt = local_tz.from_local_datetime(&start).single()?;
            Some(local_dt.with_timezone(&chrono::Utc))
        }
        "week" => Some(chrono::Utc::now() - chrono::Duration::days(7)),
        "month" => Some(chrono::Utc::now() - chrono::Duration::days(30)),
        _ => {
            // 优先尝试 RFC3339（带时区）
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(dt.with_timezone(&chrono::Utc));
            }
            // 尝试 ISO8601 格式（不带时区，假设本地时间）
            if let Ok(naive_dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
                if let Some(local_dt) = local_tz.from_local_datetime(&naive_dt).single() {
                    return Some(local_dt.with_timezone(&chrono::Utc));
                }
            }
            // 尝试只有日期（本地时间 0 点）
            if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                let naive_dt = date.and_hms_opt(0, 0, 0)?;
                if let Some(local_dt) = local_tz.from_local_datetime(&naive_dt).single() {
                    return Some(local_dt.with_timezone(&chrono::Utc));
                }
            }
            None
        }
    }
}

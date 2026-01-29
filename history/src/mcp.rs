use crate::config::Config;
use crate::search::{search, SearchParams};
use crate::sessions::list_sessions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

/// JSON-RPC 请求
#[derive(Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// JSON-RPC 响应
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

/// MCP 工具定义
fn get_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "search_conversations",
            "description": "Search through Claude Code conversation history",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query to find relevant conversations"
                    },
                    "project": {
                        "type": "string",
                        "description": "Optional project name to filter results"
                    },
                    "timeframe": {
                        "type": "string",
                        "description": "Time range filter (today, week, month)"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 10)",
                        "default": 10
                    },
                    "detail_level": {
                        "type": "string",
                        "enum": ["summary", "detailed", "raw"],
                        "description": "Response detail: summary (default), detailed, raw",
                        "default": "summary"
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "find_file_context",
            "description": "Find all conversations and changes related to a specific file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filepath": {
                        "type": "string",
                        "description": "File path to search for in conversation history"
                    },
                    "operation_type": {
                        "type": "string",
                        "enum": ["read", "edit", "create", "all"],
                        "description": "Filter by operation: read, edit, create, or all",
                        "default": "all"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 15)",
                        "default": 15
                    },
                    "detail_level": {
                        "type": "string",
                        "enum": ["summary", "detailed", "raw"],
                        "description": "Response detail: summary (default), detailed, raw",
                        "default": "summary"
                    }
                },
                "required": ["filepath"]
            }
        }),
        json!({
            "name": "find_similar_queries",
            "description": "Search for previous user messages containing similar keywords",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query to find similar previous questions"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 8)",
                        "default": 8
                    },
                    "detail_level": {
                        "type": "string",
                        "enum": ["summary", "detailed", "raw"],
                        "description": "Response detail: summary (default), detailed, raw",
                        "default": "summary"
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "get_error_solutions",
            "description": "Search assistant messages for content matching error patterns",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "error_pattern": {
                        "type": "string",
                        "description": "Error message or pattern to search for solutions"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 8)",
                        "default": 8
                    },
                    "detail_level": {
                        "type": "string",
                        "enum": ["summary", "detailed", "raw"],
                        "description": "Response detail: summary (default), detailed, raw",
                        "default": "summary"
                    }
                },
                "required": ["error_pattern"]
            }
        }),
        json!({
            "name": "list_recent_sessions",
            "description": "List recent conversation sessions sorted by time",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Optional project name to filter sessions"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of sessions (default: 10)",
                        "default": 10
                    }
                }
            }
        }),
        json!({
            "name": "extract_compact_summary",
            "description": "Extract recent messages from a session (filtered search, not AI summary)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID to extract messages from"
                    },
                    "max_messages": {
                        "type": "number",
                        "description": "Maximum messages to return (default: 10)",
                        "default": 10
                    },
                    "focus": {
                        "type": "string",
                        "enum": ["solutions", "tools", "files", "all"],
                        "description": "Filter by message type: solutions (assistant), tools (tool_use/result), all (user+assistant)",
                        "default": "all"
                    }
                },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "find_tool_patterns",
            "description": "Search for tool-related messages (regex-based search, not pattern analysis)",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool_name": {
                        "type": "string",
                        "description": "Optional specific tool name to analyze"
                    },
                    "pattern_type": {
                        "type": "string",
                        "enum": ["tools", "workflows", "solutions"],
                        "description": "Type of patterns: tools, workflows, or solutions",
                        "default": "tools"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of patterns (default: 12)",
                        "default": 12
                    }
                }
            }
        }),
        json!({
            "name": "search_plans",
            "description": "Search Claude Code plan files for past implementation approaches, decisions, and patterns",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for plan content"
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum number of results (default: 10)",
                        "default": 10
                    },
                    "detail_level": {
                        "type": "string",
                        "enum": ["summary", "detailed", "raw"],
                        "description": "Response detail level",
                        "default": "summary"
                    }
                },
                "required": ["query"]
            }
        }),
    ]
}

/// 运行 MCP 服务器
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
                let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };

        // notification 没有 id，不应返回响应
        if let Some(response) = handle_request(&config, &request) {
            let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
            let _ = stdout.flush();
        }
    }
}

/// 处理请求，notification 返回 None
fn handle_request(config: &Config, request: &JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = request.id.clone().unwrap_or(Value::Null);

    match request.method.as_str() {
        "initialize" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "claude-historian-mcp",
                    "version": "0.1.0"
                }
            })),
            error: None,
        }),

        // notification 不返回响应
        "notifications/initialized" | "initialized" => None,

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
                            "text": format!("Error: {}", e)
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

/// 执行工具
fn execute_tool(config: &Config, tool_name: &str, args: Value) -> Result<Value, String> {
    match tool_name {
        "search_conversations" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let project = args.get("project").and_then(|v| v.as_str());
            let timeframe = args.get("timeframe").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            let detail_level = args.get("detail_level").and_then(|v| v.as_str()).unwrap_or("summary");

            let (since, until) = parse_timeframe(timeframe);

            let params = SearchParams {
                pattern: query.to_string(),
                projects: project.map(|p| vec![p.to_string()]).unwrap_or_default(),
                all_projects: project.is_none(),
                since,
                until,
                limit: Some(limit),
                max_content: match detail_level {
                    "raw" => 100000,
                    "detailed" => 8000,
                    _ => 2000,
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "find_file_context" => {
            let filepath = args.get("filepath").and_then(|v| v.as_str()).unwrap_or("");
            let operation_type = args.get("operation_type").and_then(|v| v.as_str()).unwrap_or("all");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(15) as usize;
            let detail_level = args.get("detail_level").and_then(|v| v.as_str()).unwrap_or("summary");

            // 根据操作类型构建搜索模式
            let pattern = match operation_type {
                "read" => format!("Read.*{}", regex::escape(filepath)),
                "edit" => format!("Edit.*{}", regex::escape(filepath)),
                "create" => format!("Write.*{}", regex::escape(filepath)),
                _ => regex::escape(filepath),
            };

            let params = SearchParams {
                pattern,
                use_regex: true,
                all_projects: true,
                limit: Some(limit),
                max_content: match detail_level {
                    "raw" => 100000,
                    "detailed" => 8000,
                    _ => 2000,
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "find_similar_queries" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
            let detail_level = args.get("detail_level").and_then(|v| v.as_str()).unwrap_or("summary");

            let params = SearchParams {
                pattern: query.to_string(),
                types: vec!["user".to_string()],
                all_projects: true,
                limit: Some(limit),
                max_content: match detail_level {
                    "raw" => 100000,
                    "detailed" => 8000,
                    _ => 2000,
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "get_error_solutions" => {
            let error_pattern = args.get("error_pattern").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
            let detail_level = args.get("detail_level").and_then(|v| v.as_str()).unwrap_or("summary");

            // 搜索包含错误的 assistant 回复
            let params = SearchParams {
                pattern: error_pattern.to_string(),
                types: vec!["assistant".to_string()],
                all_projects: true,
                limit: Some(limit),
                max_content: match detail_level {
                    "raw" => 100000,
                    "detailed" => 8000,
                    _ => 4000,
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "list_recent_sessions" => {
            let project = args.get("project").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

            match list_sessions(config, project) {
                Ok(mut response) => {
                    response.sessions.truncate(limit);
                    Ok(serde_json::to_value(response).unwrap())
                }
                Err(e) => Err(e.message),
            }
        }

        "extract_compact_summary" => {
            let session_id = args.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
            let max_messages = args.get("max_messages").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            let focus = args.get("focus").and_then(|v| v.as_str()).unwrap_or("all");

            // 搜索指定 session 的消息
            let params = SearchParams {
                pattern: String::new(),
                sessions: vec![session_id.to_string()],
                all_projects: true,
                limit: Some(max_messages),
                types: match focus {
                    "solutions" => vec!["assistant".to_string()],
                    "tools" => vec!["tool_use".to_string(), "tool_result".to_string()],
                    _ => vec!["user".to_string(), "assistant".to_string()],
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "find_tool_patterns" => {
            let tool_name = args.get("tool_name").and_then(|v| v.as_str());
            let pattern_type = args.get("pattern_type").and_then(|v| v.as_str()).unwrap_or("tools");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(12) as usize;

            let pattern = match (pattern_type, tool_name) {
                (_, Some(name)) => name.to_string(),
                ("workflows", _) => "workflow|pipeline|step".to_string(),
                ("solutions", _) => "fix|solve|resolve".to_string(),
                _ => "tool_use|tool_result".to_string(),
            };

            let params = SearchParams {
                pattern,
                use_regex: true,
                all_projects: true,
                limit: Some(limit),
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        "search_plans" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            let detail_level = args.get("detail_level").and_then(|v| v.as_str()).unwrap_or("summary");

            // 搜索包含 plan 相关内容的消息
            // 对 query 进行正则转义，防止注入；使用括号明确优先级
            let pattern = if query.is_empty() {
                "plan|implementation|approach".to_string()
            } else {
                let escaped = regex::escape(query);
                format!("({}.*plan)|(plan.*{})", escaped, escaped)
            };

            let params = SearchParams {
                pattern,
                use_regex: true,
                all_projects: true,
                limit: Some(limit),
                max_content: match detail_level {
                    "raw" => 100000,
                    "detailed" => 8000,
                    _ => 4000,
                },
                ..Default::default()
            };

            match search(config, params) {
                Ok(response) => Ok(serde_json::to_value(response).unwrap()),
                Err(e) => Err(e.message),
            }
        }

        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

/// 解析时间范围
fn parse_timeframe(timeframe: Option<&str>) -> (Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>) {
    let now = chrono::Utc::now();
    match timeframe {
        Some("today") => {
            let start = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
            (Some(chrono::DateTime::from_naive_utc_and_offset(start, chrono::Utc)), None)
        }
        Some("week") => {
            let start = now - chrono::Duration::days(7);
            (Some(start), None)
        }
        Some("month") => {
            let start = now - chrono::Duration::days(30);
            (Some(start), None)
        }
        _ => (None, None),
    }
}

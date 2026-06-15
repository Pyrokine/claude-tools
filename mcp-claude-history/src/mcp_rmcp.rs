//! rmcp 路径：用 SDK 替代手写 JSON-RPC（mcp.rs）
//!
//! 业务函数（search/get/context/projects/sessions）保持同步，通过
//! tokio::task::spawn_blocking 包装，避免阻塞 rmcp 异步运行时

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters}, model::*, schemars,
    tool,
    tool_handler,
    tool_router, ErrorData as McpError, ServerHandler, ServiceExt,
};
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::config::Config;
use crate::context::{context, ContextParams};
use crate::get::{get, GetParams};
use crate::projects::list_projects;
use crate::search::{search, SearchParams};
use crate::sessions::list_sessions;
use crate::trace::{trace, TraceParams};
use crate::types::ErrorResponse;
use crate::utils::{
    parse_line_ranges_param, parse_message_slice_param, parse_range_param, parse_redaction_mode_param, parse_time_param,
    RedactionMode,
};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchToolParams {
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub all: Option<bool>,
    #[serde(default)]
    pub sessions: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub subtypes: Option<String>,
    #[serde(default)]
    pub servers: Option<String>,
    #[serde(default)]
    pub tools: Option<String>,
    #[serde(default)]
    pub summary: Option<bool>,
    #[serde(default)]
    pub aggregate: Option<bool>,
    #[serde(default)]
    pub failed_tool_results: Option<bool>,
    #[serde(default, alias = "failedToolsOnly", alias = "tool_error")]
    pub failed_tools_only: Option<bool>,
    #[serde(default, alias = "dryRun", alias = "explain")]
    pub dry_run: Option<bool>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub redaction: Option<String>,
    #[serde(default)]
    pub lines: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub slice: Option<String>,
    #[serde(default)]
    pub max_content: Option<usize>,
    #[serde(default)]
    pub max_total: Option<usize>,
    #[serde(default)]
    pub subagents: Option<bool>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetToolParams {
    pub r#ref: String,
    #[serde(default)]
    pub range: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub redaction: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ContextToolParams {
    pub r#ref: String,
    #[serde(default)]
    pub before: Option<usize>,
    #[serde(default)]
    pub after: Option<usize>,
    #[serde(default)]
    pub until_type: Option<String>,
    /// 截止到另一个 ref（session:line），从 anchor 到该 ref（含）
    #[serde(default)]
    pub until_ref: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub subtypes: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub max_content: Option<usize>,
    #[serde(default)]
    pub max_total: Option<usize>,
    /// 导出到文件，支持 tmp: / cwd: 前缀
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub redaction: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TraceToolParams {
    pub r#ref: String,
    #[serde(default)]
    pub before: Option<usize>,
    #[serde(default)]
    pub after: Option<usize>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub max_content: Option<usize>,
    #[serde(default)]
    pub max_total: Option<usize>,
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub subtypes: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub servers: Option<String>,
    #[serde(default)]
    pub tools: Option<String>,
    #[serde(default)]
    pub until_type: Option<String>,
    #[serde(default)]
    pub until_ref: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub redaction: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct ProjectsToolParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct SessionsToolParams {
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Clone)]
pub struct McpHistoryService {
    config: Config,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

fn comma_split(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn arg_error(message: impl Into<String>) -> ErrorResponse {
    ErrorResponse {
        error: "invalid_arguments".to_string(),
        message: message.into(),
        available: None,
    }
}

fn parse_optional_time(
    value: Option<String>,
    name: &str,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, ErrorResponse> {
    value
        .as_deref()
        .map(|s| parse_time_param(s, name).map_err(arg_error))
        .transpose()
}

fn parse_optional_range(value: Option<String>) -> Result<Option<(usize, usize)>, ErrorResponse> {
    value.as_deref().map(parse_range_param).transpose().map_err(arg_error)
}

fn parse_optional_slice(value: Option<String>) -> Result<Option<crate::utils::MessageSlice>, ErrorResponse> {
    value
        .as_deref()
        .map(parse_message_slice_param)
        .transpose()
        .map_err(arg_error)
}

fn parse_optional_lines(value: Option<String>) -> Result<Vec<crate::types::Range>, ErrorResponse> {
    value
        .as_deref()
        .map(parse_line_ranges_param)
        .transpose()
        .map_err(arg_error)
        .map(|v| v.unwrap_or_default())
}

fn parse_redaction(value: Option<String>) -> Result<RedactionMode, ErrorResponse> {
    value
        .as_deref()
        .map(parse_redaction_mode_param)
        .transpose()
        .map_err(arg_error)
        .map(|v| v.unwrap_or_default())
}

fn pretty_or<E: serde::Serialize>(r: Result<impl serde::Serialize, E>) -> String {
    match r {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
        Err(e) => serde_json::to_string_pretty(&e).unwrap_or_default(),
    }
}

fn pretty_error(error: ErrorResponse) -> String {
    serde_json::to_string_pretty(&error).unwrap_or_default()
}

fn ok_text(text: String) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::text(text)]))
}

impl McpHistoryService {
    pub fn new() -> Self {
        Self {
            config: Config::from_env(),
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router]
impl McpHistoryService {
    #[tool(description = "Search through Claude Code conversation history")]
    async fn history_search(&self, Parameters(p): Parameters<SearchToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();

        let projects: Vec<String> = p.project.as_deref().map(comma_split).unwrap_or_default();
        let sessions: Vec<String> = p.sessions.as_deref().map(comma_split).unwrap_or_default();
        let types: Vec<String> = comma_split(p.types.as_deref().unwrap_or("assistant,user,summary"));
        let subtypes: Vec<String> = p.subtypes.as_deref().map(comma_split).unwrap_or_default();
        let servers: Vec<String> = p.servers.as_deref().map(comma_split).unwrap_or_default();
        let tools: Vec<String> = p.tools.as_deref().map(comma_split).unwrap_or_default();
        let ignored_keys = p.extra.keys().cloned().collect::<Vec<_>>();
        let lines = match parse_optional_lines(p.lines.clone()) {
            Ok(lines) => lines,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let since = match parse_optional_time(p.since.clone(), "since") {
            Ok(since) => since,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let until = match parse_optional_time(p.until.clone(), "until") {
            Ok(until) => until,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let slice = match parse_optional_slice(p.slice.clone()) {
            Ok(slice) => slice,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let redaction = match parse_redaction(p.redaction.clone()) {
            Ok(redaction) => redaction,
            Err(e) => return ok_text(pretty_error(e)),
        };

        let params = SearchParams {
            pattern: p.pattern.unwrap_or_default(),
            projects,
            all_projects: p.all.unwrap_or(false),
            sessions,
            since,
            until,
            types,
            subtypes,
            servers,
            tools,
            lines,
            use_regex: p.regex.unwrap_or(false),
            case_sensitive: p.case_sensitive.unwrap_or(false),
            offset: p.offset.unwrap_or(0),
            limit: p.limit,
            slice,
            max_content: p.max_content.unwrap_or(4000),
            max_content_tool_result: 500,
            max_total: p.max_total.unwrap_or(40000),
            summary: p.summary.unwrap_or(false),
            aggregate: p.aggregate.unwrap_or(false),
            failed_tool_results: p.failed_tool_results.unwrap_or(false) || p.failed_tools_only.unwrap_or(false),
            dry_run: p.dry_run.unwrap_or(false),
            redaction,
            ignored_keys,
            warnings: Vec::new(),
            output: p.output,
            output_format: p.output_format,
            subagents: p.subagents.unwrap_or(false),
        };
        let result = tokio::task::spawn_blocking(move || search(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "Get full content of a message by ref")]
    async fn history_get(&self, Parameters(p): Parameters<GetToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let range = match parse_optional_range(p.range.clone()) {
            Ok(range) => range,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let redaction = match parse_redaction(p.redaction.clone()) {
            Ok(redaction) => redaction,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let params = GetParams {
            r#ref: p.r#ref,
            range,
            output: p.output,
            project: p.project,
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || get(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "Get surrounding messages for context")]
    async fn history_context(&self, Parameters(p): Parameters<ContextToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let types: Vec<String> = p.types.as_deref().map(comma_split).unwrap_or_default();
        let subtypes: Vec<String> = p.subtypes.as_deref().map(comma_split).unwrap_or_default();
        let redaction = match parse_redaction(p.redaction.clone()) {
            Ok(redaction) => redaction,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let params = ContextParams {
            r#ref: p.r#ref,
            before: p.before,
            after: p.after,
            until_type: p.until_type,
            until_ref: p.until_ref,
            direction: p.direction.unwrap_or_else(|| "forward".to_string()),
            project: p.project,
            types,
            subtypes,
            max_content: p.max_content.unwrap_or(4000),
            max_total: p.max_total.unwrap_or(40000),
            pattern: p.pattern,
            regex: p.regex.unwrap_or(false),
            case_sensitive: p.case_sensitive.unwrap_or(false),
            output: p.output,
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || context(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "Trace nearby messages and tool call/result pairs for a message ref")]
    async fn history_trace(&self, Parameters(p): Parameters<TraceToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let redaction = match parse_redaction(p.redaction.clone()) {
            Ok(redaction) => redaction,
            Err(e) => return ok_text(pretty_error(e)),
        };
        let params = TraceParams {
            r#ref: p.r#ref,
            before: p.before.unwrap_or(20),
            after: p.after.unwrap_or(20),
            project: p.project,
            max_content: p.max_content.unwrap_or(4000),
            max_total: p.max_total.unwrap_or(40000),
            types: p.types.as_deref().map(comma_split).unwrap_or_default(),
            subtypes: p.subtypes.as_deref().map(comma_split).unwrap_or_default(),
            pattern: p.pattern,
            regex: p.regex.unwrap_or(false),
            case_sensitive: p.case_sensitive.unwrap_or(false),
            servers: p.servers.as_deref().map(comma_split).unwrap_or_default(),
            tools: p.tools.as_deref().map(comma_split).unwrap_or_default(),
            until_type: p.until_type,
            until_ref: p.until_ref,
            direction: p.direction.unwrap_or_else(|| "forward".to_string()),
            output: p.output,
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || trace(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "List all projects with conversation history")]
    async fn history_projects(&self, _: Parameters<ProjectsToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let result = tokio::task::spawn_blocking(move || list_projects(&cfg))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "List sessions in a project")]
    async fn history_sessions(
        &self,
        Parameters(p): Parameters<SessionsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let project = p.project.clone();
        let result = tokio::task::spawn_blocking(move || list_sessions(&cfg, project.as_deref()))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }
}

#[tool_handler]
impl ServerHandler for McpHistoryService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(Implementation::new("mcp-claude-history", env!("CARGO_PKG_VERSION")))
            .with_instructions("MCP server for searching Claude Code conversation history")
    }
}

/// rmcp 路径启动入口（替代 mcp.rs 的 run_mcp_server）
pub async fn run_mcp_server_rmcp() -> anyhow::Result<()> {
    let service = McpHistoryService::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

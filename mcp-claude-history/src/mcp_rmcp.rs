//! rmcp 路径：用 SDK 替代手写 JSON-RPC（mcp.rs）
//!
//! 业务函数（search/get/context/projects/sessions）保持同步，通过
//! tokio::task::spawn_blocking 包装，避免阻塞 rmcp 异步运行时

use rmcp::{
    ErrorData as McpError, ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
};
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::config::Config;
use crate::context::{ContextParams, context};
use crate::get::{GetParams, get};
use crate::projects::list_projects;
use crate::search::{SearchParams, search};
use crate::sessions::list_sessions;
use crate::trace::{TraceParams, trace};
use crate::types::ErrorResponse;
use crate::utils::{
    parse_optional_line_ranges_param, parse_optional_message_slice_param, parse_optional_range_param,
    parse_optional_redaction_mode_param, parse_optional_time_param, split_csv_param,
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
    #[serde(
        default,
        alias = "toolPayloadErrors",
        alias = "payload_errors",
        alias = "error_payload_only"
    )]
    pub tool_payload_errors: Option<bool>,
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

fn pretty_error(error: ErrorResponse) -> String {
    serde_json::to_string_pretty(&error).unwrap_or_default()
}

fn ok_text(text: String) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn error_text(text: String) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
}

fn tool_text_result(result: Result<impl serde::Serialize, ErrorResponse>) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => ok_text(serde_json::to_string_pretty(&value).unwrap_or_default()),
        Err(error) => error_text(pretty_error(error)),
    }
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

        let projects: Vec<String> = split_csv_param(p.project.as_deref());
        let sessions: Vec<String> = split_csv_param(p.sessions.as_deref());
        let types: Vec<String> = split_csv_param(Some(p.types.as_deref().unwrap_or("assistant,user,summary")));
        let subtypes: Vec<String> = split_csv_param(p.subtypes.as_deref());
        let servers: Vec<String> = split_csv_param(p.servers.as_deref());
        let tools: Vec<String> = split_csv_param(p.tools.as_deref());
        let ignored_keys = p.extra.keys().cloned().collect::<Vec<_>>();
        let lines = match parse_optional_line_ranges_param(p.lines.as_deref()) {
            Ok(lines) => lines,
            Err(e) => return error_text(pretty_error(e)),
        };
        let since = match parse_optional_time_param(p.since.as_deref(), "since") {
            Ok(since) => since,
            Err(e) => return error_text(pretty_error(e)),
        };
        let until = match parse_optional_time_param(p.until.as_deref(), "until") {
            Ok(until) => until,
            Err(e) => return error_text(pretty_error(e)),
        };
        let slice = match parse_optional_message_slice_param(p.slice.as_deref()) {
            Ok(slice) => slice,
            Err(e) => return error_text(pretty_error(e)),
        };
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
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
            tool_payload_errors: p.tool_payload_errors.unwrap_or(false),
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
        tool_text_result(result)
    }

    #[tool(description = "Get full content of a message by ref")]
    async fn history_get(&self, Parameters(p): Parameters<GetToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let range = match parse_optional_range_param(p.range.as_deref()) {
            Ok(range) => range,
            Err(e) => return error_text(pretty_error(e)),
        };
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
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
        tool_text_result(result)
    }

    #[tool(description = "Get surrounding messages for context")]
    async fn history_context(&self, Parameters(p): Parameters<ContextToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let types: Vec<String> = split_csv_param(p.types.as_deref());
        let subtypes: Vec<String> = split_csv_param(p.subtypes.as_deref());
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
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
        tool_text_result(result)
    }

    #[tool(description = "Trace nearby messages and tool call/result pairs for a message ref")]
    async fn history_trace(&self, Parameters(p): Parameters<TraceToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
        };
        let params = TraceParams {
            r#ref: p.r#ref,
            before: p.before.unwrap_or(20),
            after: p.after.unwrap_or(20),
            project: p.project,
            max_content: p.max_content.unwrap_or(4000),
            max_total: p.max_total.unwrap_or(40000),
            types: split_csv_param(p.types.as_deref()),
            subtypes: split_csv_param(p.subtypes.as_deref()),
            pattern: p.pattern,
            regex: p.regex.unwrap_or(false),
            case_sensitive: p.case_sensitive.unwrap_or(false),
            servers: split_csv_param(p.servers.as_deref()),
            tools: split_csv_param(p.tools.as_deref()),
            until_type: p.until_type,
            until_ref: p.until_ref,
            direction: p.direction.unwrap_or_else(|| "forward".to_string()),
            output: p.output,
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || trace(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        tool_text_result(result)
    }

    #[tool(description = "List all projects with conversation history")]
    async fn history_projects(&self, _: Parameters<ProjectsToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let result = tokio::task::spawn_blocking(move || list_projects(&cfg))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        tool_text_result(result)
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
        tool_text_result(result)
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

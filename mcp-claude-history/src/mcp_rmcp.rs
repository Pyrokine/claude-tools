//! rmcp 路径：用 SDK 替代手写 JSON-RPC（mcp.rs）
//!
//! 业务函数（search/get/context/projects/sessions）保持同步，通过
//! tokio::task::spawn_blocking 包装，避免阻塞 rmcp 异步运行时

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler, ServiceExt,
};
use serde::Deserialize;
use std::path::PathBuf;

use crate::config::Config;
use crate::context::{context, ContextParams};
use crate::get::{get, GetParams};
use crate::projects::list_projects;
use crate::search::{search, SearchParams};
use crate::sessions::list_sessions;
use crate::types::Range;
use crate::utils::parse_iso_utc;
use crate::utils::parse_range;

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
    pub max_content: Option<usize>,
    #[serde(default)]
    pub max_total: Option<usize>,
    #[serde(default)]
    pub subagents: Option<bool>,
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
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub max_content: Option<usize>,
    #[serde(default)]
    pub max_total: Option<usize>,
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
    tool_router: ToolRouter<Self>,
}

fn comma_split(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).collect()
}

fn pretty_or<E: serde::Serialize>(r: Result<impl serde::Serialize, E>) -> String {
    match r {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
        Err(e) => serde_json::to_string_pretty(&e).unwrap_or_default(),
    }
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
    async fn history_search(
        &self,
        Parameters(p): Parameters<SearchToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();

        let projects: Vec<String> = p.project.as_deref().map(comma_split).unwrap_or_default();
        let sessions: Vec<String> = p.sessions.as_deref().map(comma_split).unwrap_or_default();
        let types: Vec<String> =
            comma_split(p.types.as_deref().unwrap_or("assistant,user,summary"));
        let subtypes: Vec<String> = p.subtypes.as_deref().map(comma_split).unwrap_or_default();
        let lines: Vec<Range> = p
            .lines
            .as_deref()
            .map(Range::parse_ranges)
            .unwrap_or_default();

        let params = SearchParams {
            pattern: p.pattern.unwrap_or_default(),
            projects,
            all_projects: p.all.unwrap_or(false),
            sessions,
            since: p.since.as_deref().and_then(parse_iso_utc),
            until: p.until.as_deref().and_then(parse_iso_utc),
            types,
            subtypes,
            lines,
            use_regex: p.regex.unwrap_or(false),
            case_sensitive: p.case_sensitive.unwrap_or(false),
            offset: p.offset.unwrap_or(0),
            limit: p.limit,
            max_content: p.max_content.unwrap_or(4000),
            max_content_tool_result: 500,
            max_total: p.max_total.unwrap_or(40000),
            subagents: p.subagents.unwrap_or(false),
        };
        let result = tokio::task::spawn_blocking(move || search(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "Get full content of a message by ref")]
    async fn history_get(
        &self,
        Parameters(p): Parameters<GetToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let params = GetParams {
            r#ref: p.r#ref,
            range: p.range.as_deref().and_then(parse_range),
            output: p.output.map(PathBuf::from),
            project: p.project,
        };
        let result = tokio::task::spawn_blocking(move || get(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "Get surrounding messages for context")]
    async fn history_context(
        &self,
        Parameters(p): Parameters<ContextToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let types: Vec<String> = p.types.as_deref().map(comma_split).unwrap_or_default();
        let params = ContextParams {
            r#ref: p.r#ref,
            before: p.before,
            after: p.after,
            until_type: p.until_type,
            direction: p.direction.unwrap_or_else(|| "forward".to_string()),
            project: p.project,
            types,
            max_content: p.max_content.unwrap_or(4000),
            max_total: p.max_total.unwrap_or(40000),
            pattern: None,
            regex: false,
            case_sensitive: false,
        };
        let result = tokio::task::spawn_blocking(move || context(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {}", e), None))?;
        ok_text(pretty_or(result))
    }

    #[tool(description = "List all projects with conversation history")]
    async fn history_projects(
        &self,
        _: Parameters<ProjectsToolParams>,
    ) -> Result<CallToolResult, McpError> {
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
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "mcp-claude-history".to_string(),
                title: None,
                version: env!("CARGO_PKG_VERSION").to_string(),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "MCP server for searching Claude Code conversation history".to_string(),
            ),
        }
    }
}

/// rmcp 路径启动入口（替代 mcp.rs 的 run_mcp_server）
pub async fn run_mcp_server_rmcp() -> anyhow::Result<()> {
    let service = McpHistoryService::new()
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}

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
use crate::search::{DEFAULT_MAX_CONTENT, DEFAULT_MAX_CONTENT_TOOL_RESULT, DEFAULT_MAX_TOTAL, SearchParams, search};
use crate::sessions::list_sessions;
use crate::trace::{TraceParams, trace};
use crate::types::{BuildIdentity, ErrorResponse};
use crate::utils::{
    parse_optional_line_ranges_param, parse_optional_message_slice_param, parse_optional_range_param,
    parse_optional_redaction_mode_param, parse_time_bounds, split_csv_param,
};

fn default_max_content_schema() -> Option<usize> {
    Some(DEFAULT_MAX_CONTENT)
}

fn default_max_content_tool_result_schema() -> Option<usize> {
    Some(DEFAULT_MAX_CONTENT_TOOL_RESULT)
}

fn default_max_total_schema() -> Option<usize> {
    Some(DEFAULT_MAX_TOTAL)
}

fn default_subagents_schema() -> Option<bool> {
    Some(false)
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[allow(dead_code)]
#[serde(rename_all = "lowercase")]
enum RedactionSchema {
    Auto,
    Strict,
    Off,
}

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
    /// Comma-separated classifications. `human` denotes a user-shaped record, not verified human authorship.
    #[serde(default)]
    pub subtypes: Option<String>,
    #[serde(default)]
    #[schemars(
        description = "Comma-separated MCP servers; combined with tools using AND. Full tool names do not add server filters."
    )]
    pub servers: Option<String>,
    #[serde(default)]
    #[schemars(
        description = "Comma-separated tool names matched using OR. Full mcp__server__tool names bind server and tool; short names match the tool across servers and can include local tools such as Bash."
    )]
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
    pub overwrite: Option<bool>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    #[schemars(with = "Option<RedactionSchema>")]
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
    #[schemars(
        description = "Regular result preview limit in characters; independent from max_content_tool_result",
        default = "default_max_content_schema",
        range(min = 1, max = 1000000)
    )]
    pub max_content: Option<usize>,
    #[serde(default)]
    #[schemars(
        description = "Tool-result preview limit in characters; independent from max_content",
        default = "default_max_content_tool_result_schema",
        range(min = 1, max = 1000000)
    )]
    pub max_content_tool_result: Option<usize>,
    #[serde(default)]
    #[schemars(
        description = "Maximum compact SearchResponse JSON payload in UTF-8 bytes; excludes JSON-RPC framing",
        default = "default_max_total_schema",
        range(min = 512, max = 10000000)
    )]
    pub max_total: Option<usize>,
    #[serde(default)]
    #[schemars(
        description = "Default false searches only main JSONL files. True also includes <session>/subagents and <session>/remote-agents. sessions matches each file's own ID; a parent ID does not include its children.",
        default = "default_subagents_schema"
    )]
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
    pub overwrite: Option<bool>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    #[schemars(with = "Option<RedactionSchema>")]
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
    /// `forward` or `backward`; applies only to until_type.
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub types: Option<String>,
    /// Comma-separated classifications. `human` denotes a user-shaped record, not verified human authorship.
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
    #[schemars(range(min = 1, max = 1000000))]
    pub max_content: Option<usize>,
    #[serde(default)]
    #[schemars(
        description = "Maximum complete compact response JSON bytes, including metadata",
        range(min = 512, max = 10000000)
    )]
    pub max_total: Option<usize>,
    /// 导出到文件，支持 tmp: / cwd: 前缀
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub overwrite: Option<bool>,
    #[serde(default)]
    #[schemars(with = "Option<RedactionSchema>")]
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
    #[schemars(range(min = 1, max = 1000000))]
    pub max_content: Option<usize>,
    #[serde(default)]
    #[schemars(
        description = "Maximum complete compact response JSON bytes, including tool_calls and metadata",
        range(min = 512, max = 10000000)
    )]
    pub max_total: Option<usize>,
    #[serde(default)]
    pub types: Option<String>,
    /// Comma-separated classifications. `human` denotes a user-shaped record, not verified human authorship.
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
    /// `forward` or `backward`; applies only to until_type.
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub overwrite: Option<bool>,
    #[serde(default)]
    #[schemars(with = "Option<RedactionSchema>")]
    pub redaction: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct ProjectsToolParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct SessionsToolParams {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    #[schemars(with = "Option<RedactionSchema>")]
    pub redaction: Option<String>,
}

#[derive(Clone)]
pub struct McpHistoryService {
    config: Config,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

fn pretty_error(error: ErrorResponse) -> String {
    serde_json::to_string_pretty(&error)
        .unwrap_or_else(|failure| format!("history error {} (error serialization failed: {failure})", error.error))
}

fn ok_text(text: String) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn error_text(text: String) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
}

fn tool_text_result(result: Result<impl serde::Serialize, ErrorResponse>) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => ok_text(
            serde_json::to_string_pretty(&value)
                .map_err(|e| McpError::internal_error(format!("history response serialization failed: {e}"), None))?,
        ),
        Err(error) => error_text(pretty_error(error)),
    }
}

fn compact_tool_text_result(result: Result<impl serde::Serialize, ErrorResponse>) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => ok_text(
            serde_json::to_string(&value)
                .map_err(|e| McpError::internal_error(format!("history response serialization failed: {e}"), None))?,
        ),
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
    #[tool(description = "Search Claude Code history. `human` means user-shaped; it does not verify human authorship.")]
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
        let (since, until) = match parse_time_bounds(p.since.as_deref(), p.until.as_deref()) {
            Ok(bounds) => bounds,
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
            max_content: p.max_content.unwrap_or(DEFAULT_MAX_CONTENT),
            max_content_tool_result: p.max_content_tool_result.unwrap_or(DEFAULT_MAX_CONTENT_TOOL_RESULT),
            max_total: p.max_total.unwrap_or(DEFAULT_MAX_TOTAL),
            summary: p.summary.unwrap_or(false),
            aggregate: p.aggregate.unwrap_or(false),
            failed_tool_results: p.failed_tool_results.unwrap_or(false) || p.failed_tools_only.unwrap_or(false),
            tool_payload_errors: p.tool_payload_errors.unwrap_or(false),
            dry_run: p.dry_run.unwrap_or(false),
            redaction,
            ignored_keys,
            warnings: Vec::new(),
            output: p.output,
            overwrite: p.overwrite.unwrap_or(false),
            output_format: p.output_format,
            subagents: p.subagents.unwrap_or(false),
        };
        let result = tokio::task::spawn_blocking(move || search(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
        compact_tool_text_result(result)
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
            overwrite: p.overwrite.unwrap_or(false),
            project: p.project,
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || get(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
        tool_text_result(result)
    }

    #[tool(
        description = "Get surrounding messages using before/after, until_type, or until_ref. Local queries support large sessions; the selected span is limited to 2,000 messages and 32 MiB, including hidden messages. Diagnostics cover the scanned prefix only."
    )]
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
            overwrite: p.overwrite.unwrap_or(false),
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || context(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
        compact_tool_text_result(result)
    }

    #[tool(
        description = "Trace nearby messages and tool call/result pairs. Choose one range mode. Local queries support large sessions; the selected span is limited to 2,000 messages and 32 MiB, including hidden messages. Diagnostics cover the scanned prefix only."
    )]
    async fn history_trace(&self, Parameters(p): Parameters<TraceToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
        };
        let params = TraceParams {
            r#ref: p.r#ref,
            before: p.before,
            after: p.after,
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
            overwrite: p.overwrite.unwrap_or(false),
            redaction,
        };
        let result = tokio::task::spawn_blocking(move || trace(&cfg, params))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
        compact_tool_text_result(result)
    }

    #[tool(description = "Get the running server build identity")]
    async fn history_build_info(&self, _: Parameters<ProjectsToolParams>) -> Result<CallToolResult, McpError> {
        tool_text_result(Ok::<_, ErrorResponse>(BuildIdentity::current()))
    }

    #[tool(description = "List all projects with conversation history")]
    async fn history_projects(&self, _: Parameters<ProjectsToolParams>) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let result = tokio::task::spawn_blocking(move || list_projects(&cfg))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
        tool_text_result(result)
    }

    #[tool(description = "List project sessions. Topics are redacted before preview; redaction defaults to auto.")]
    async fn history_sessions(
        &self,
        Parameters(p): Parameters<SessionsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let cfg = self.config.clone();
        let project = p.project.clone();
        let redaction = match parse_optional_redaction_mode_param(p.redaction.as_deref()) {
            Ok(redaction) => redaction,
            Err(e) => return error_text(pretty_error(e)),
        };
        let result = tokio::task::spawn_blocking(move || list_sessions(&cfg, project.as_deref(), redaction))
            .await
            .map_err(|e| McpError::internal_error(format!("join error: {e}"), None))?;
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
    crate::get::cleanup_expired_temp_sessions();
    let service = McpHistoryService::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subagent_scope_is_explicit_across_public_search_modes() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("mcp-history-scope-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".owner"), "H-SUBAGENT-SCOPE").unwrap();
        let project = root.join("scope");
        let sessions = [
            ("parent00", "parent00.jsonl"),
            ("agent-local000", "parent00/subagents/agent-local000.jsonl"),
            ("agent-remote00", "parent00/remote-agents/agent-remote00.jsonl"),
        ];
        for (id, path) in sessions {
            let path = project.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!(
                    "{}\n",
                    serde_json::json!({"uuid": id, "type": "user",
                "timestamp": "2026-01-01T00:00:00Z", "message": {"content": format!("scope-needle-{id} {}", "x".repeat(1000))}})
                ),
            )
            .unwrap();
        }
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        for subagents in [None, Some(false), Some(true)] {
            for session in [None, Some("parent00"), Some("agent-local000"), Some("agent-remote00")] {
                let expected = sessions
                    .iter()
                    .map(|(id, _)| *id)
                    .filter(|id| (subagents == Some(true) || *id == "parent00") && session.is_none_or(|s| *id == s))
                    .collect::<Vec<_>>();
                for mode in ["normal", "summary", "aggregate", "dry_run"] {
                    let mut params = serde_json::json!({"project": "scope", "pattern": "scope-needle"});
                    if let Some(subagents) = subagents {
                        params["subagents"] = serde_json::json!(subagents);
                    }
                    if let Some(session) = session {
                        params["sessions"] = serde_json::json!(session);
                    }
                    if mode != "normal" {
                        params[mode] = serde_json::json!(true);
                    }
                    let result = service
                        .history_search(Parameters(serde_json::from_value(params).unwrap()))
                        .await
                        .unwrap();
                    let wrapper = serde_json::to_value(result).unwrap();
                    let response: serde_json::Value =
                        serde_json::from_str(wrapper["content"][0]["text"].as_str().unwrap()).unwrap();
                    if expected.is_empty() {
                        assert_eq!(wrapper["isError"], true);
                        assert_eq!(response["error"], "session_not_found");
                    } else {
                        assert_ne!(wrapper["isError"], true);
                        assert_eq!(
                            response["stats"]["effective_filters"]["subagents"],
                            subagents == Some(true)
                        );
                        let mut actual = response["stats"]["coverage"]["sessions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap())
                            .collect::<Vec<_>>();
                        actual.sort_unstable();
                        let mut expected = expected.clone();
                        expected.sort_unstable();
                        assert_eq!(actual, expected);
                    }
                }
            }
        }
        let mut query =
            serde_json::json!({"project": "scope", "pattern": "scope-needle", "subagents": true, "max_total": 3000});
        let mut found = Vec::new();
        let mut pages = 0;
        loop {
            let result = service
                .history_search(Parameters(serde_json::from_value(query).unwrap()))
                .await
                .unwrap();
            let wrapper = serde_json::to_value(result).unwrap();
            assert_ne!(wrapper["isError"], true, "{wrapper}");
            let text = wrapper["content"][0]["text"].as_str().unwrap();
            assert!(text.len() <= 3000);
            let response: serde_json::Value = serde_json::from_str(text).unwrap();
            assert_eq!(response["stats"]["effective_filters"]["subagents"], true);
            found.extend(
                response["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["session"].as_str().unwrap().to_string()),
            );
            pages += 1;
            assert!(pages <= 3);
            let Some(next) = response.get("next_query").filter(|q| !q.is_null()) else {
                break;
            };
            assert_eq!(next["subagents"], true);
            query = next.clone();
        }
        assert!(pages > 1);
        found.sort_unstable();
        assert_eq!(found, ["agent-local000", "agent-remote00", "parent00"]);
        let schema = serde_json::to_value(schemars::schema_for!(SearchToolParams)).unwrap();
        let description = schema["properties"]["subagents"]["description"].as_str().unwrap();
        assert!(description.contains("remote-agents") && description.contains("subagents"));
        assert_eq!(schema["properties"]["subagents"]["default"], false);
        assert_eq!(fs::read_to_string(root.join(".owner")).unwrap(), "H-SUBAGENT-SCOPE");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn code_redaction_is_shared_by_search_context_trace_and_exports() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("mcp-history-code-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".owner"), "H-REDACTION-CODE").unwrap();
        let project = root.join("code");
        fs::create_dir(&project).unwrap();
        let code = "token = text(node, 1)";
        let secret = "fixture_secret_NOT_A_REAL_CREDENTIAL";
        let records = [code.to_string(), format!("token=build(\"{secret}\")")];
        let body = records.iter().enumerate().map(|(i, text)| format!("{}\n", serde_json::json!({
            "uuid": format!("code-{i}"), "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
            "message": {"content": [{"type": "tool_use", "id": format!("tool-{i}"), "name": "Bash", "input": {"command": text}}]}
        }))).collect::<String>();
        fs::write(project.join("code0000.jsonl"), body).unwrap();
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        for mode in ["auto", "strict", "off"] {
            for tool in ["search", "context", "trace"] {
                for export in [false, true] {
                    let mut params = serde_json::json!({"project": "code", "redaction": mode});
                    if tool == "search" {
                        params["pattern"] = serde_json::json!("token");
                    } else {
                        params["ref"] = serde_json::json!("code0000:1");
                        params["before"] = serde_json::json!(0);
                        params["after"] = serde_json::json!(1);
                    }
                    if export {
                        params["output"] =
                            serde_json::json!(format!("tmp:mcp-history-code-{}/{tool}-{mode}", std::process::id()));
                    }
                    let result = match tool {
                        "search" => {
                            service
                                .history_search(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        "context" => {
                            service
                                .history_context(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        _ => {
                            service
                                .history_trace(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                    }
                    .unwrap();
                    let wrapper = serde_json::to_value(result).unwrap();
                    assert_ne!(wrapper["isError"], true, "{wrapper}");
                    let response: serde_json::Value =
                        serde_json::from_str(wrapper["content"][0]["text"].as_str().unwrap()).unwrap();
                    let body = if export {
                        let key = if tool == "search" { "results" } else { "content" };
                        fs::read_to_string(response["output"][key].as_str().unwrap()).unwrap()
                    } else {
                        response.to_string()
                    };
                    assert!(body.contains(code), "{tool}/{mode}/{export}: {body}");
                    assert_eq!(body.contains(secret), mode == "off", "{tool}/{mode}/{export}: {body}");
                }
            }
        }
        assert_eq!(fs::read_to_string(root.join(".owner")).unwrap(), "H-REDACTION-CODE");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn mixed_tool_search_modes_and_continuations_keep_full_names() {
        use std::{fs, io::Write};
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("mcp-history-mixed-public-{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = fs::File::create(project.join("mixed-tools-session.jsonl")).unwrap();
        for (idx, name) in [
            "Bash",
            "mcp__mcp-ssh__ssh_exec",
            "mcp__other__ssh_exec",
            "Bash",
            "mcp__mcp-ssh__ssh_exec",
        ]
        .iter()
        .enumerate()
        {
            writeln!(file, "{}", serde_json::json!({"uuid": format!("call-{idx}"), "type": "assistant",
                "timestamp": "2026-01-01T00:00:00Z", "message": {"content": [{"type": "tool_use", "id": format!("tool-{idx}"),
                    "name": name, "input": {"command": "fixture-needle"}}]}})).unwrap();
        }
        drop(file);
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        let base = serde_json::json!({"pattern": "fixture-needle", "project": "project", "tools": "Bash,mcp__mcp-ssh__ssh_exec"});
        for mode in ["normal", "dry_run", "summary", "aggregate", "output"] {
            let mut params = base.clone();
            if mode == "output" {
                params["output"] = serde_json::json!(root.join("export"));
            } else if mode != "normal" {
                params[mode] = serde_json::json!(true);
            }
            let result = service
                .history_search(Parameters(serde_json::from_value(params).unwrap()))
                .await
                .unwrap();
            let wrapper = serde_json::to_value(result).unwrap();
            assert_ne!(wrapper["isError"], true, "{mode}: {wrapper}");
            let response: serde_json::Value =
                serde_json::from_str(wrapper["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(
                response["stats"]["total_matches"],
                if mode == "dry_run" { 0 } else { 4 },
                "{mode}"
            );
            assert_eq!(
                response["stats"]["effective_filters"]["tools"],
                serde_json::json!(["Bash", "mcp__mcp-ssh__ssh_exec"])
            );
            assert_eq!(response["stats"]["effective_filters"]["servers"], serde_json::json!([]));
            if mode == "output" {
                let content = fs::read_to_string(response["output"]["results"].as_str().unwrap()).unwrap();
                let refs = content
                    .lines()
                    .map(|line| {
                        serde_json::from_str::<serde_json::Value>(line).unwrap()["ref"]
                            .as_str()
                            .unwrap()
                            .to_string()
                    })
                    .collect::<Vec<_>>();
                assert_eq!(refs, ["mixed-to:1", "mixed-to:2", "mixed-to:4", "mixed-to:5"]);
            }
        }
        for mode in ["limit", "budget", "slice"] {
            let mut query = base.clone();
            if mode == "limit" {
                query["limit"] = serde_json::json!(1);
            } else {
                query["max_total"] = serde_json::json!(2000);
            }
            if mode == "slice" {
                query["slice"] = serde_json::json!("[1:4]");
            }
            let mut refs = Vec::new();
            let mut pages = 0;
            loop {
                let result = service
                    .history_search(Parameters(serde_json::from_value(query).unwrap()))
                    .await
                    .unwrap();
                let wrapper = serde_json::to_value(result).unwrap();
                assert_ne!(wrapper["isError"], true, "{mode}: {wrapper}");
                let text = wrapper["content"][0]["text"].as_str().unwrap();
                if mode != "limit" {
                    assert!(text.len() <= 2000);
                }
                let response: serde_json::Value = serde_json::from_str(text).unwrap();
                refs.extend(
                    response["results"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|r| r["ref"].as_str().unwrap().to_string()),
                );
                pages += 1;
                assert!(pages <= 4);
                let Some(next) = response.get("next_query").filter(|q| !q.is_null()) else {
                    break;
                };
                assert_eq!(next["tools"], "Bash,mcp__mcp-ssh__ssh_exec");
                assert!(next.get("servers").is_none());
                query = next.clone();
            }
            assert!(pages > 1, "{mode} must exercise continuation");
            let expected = if mode == "slice" {
                vec!["mixed-to:2", "mixed-to:4", "mixed-to:5"]
            } else {
                vec!["mixed-to:1", "mixed-to:2", "mixed-to:4", "mixed-to:5"]
            };
            assert_eq!(refs, expected, "{mode}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn large_sessions_allow_local_context_and_trace_windows() {
        use std::{fs, io::Write};
        let root = std::env::temp_dir().join(format!("mcp-history-large-window-{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = std::io::BufWriter::new(fs::File::create(project.join("large-session.jsonl")).unwrap());
        for line in 1..=100_005 {
            let record = if line % 2 == 1 {
                serde_json::json!({"uuid": format!("call-{line}"), "type": "assistant", "timestamp": "2026-01-01T00:00:00Z",
                    "message": {"content": [{"type": "tool_use", "id": format!("tool-{line}"),
                        "name": "Bash", "input": {"command": "fixture"}}]}})
            } else {
                serde_json::json!({"uuid": format!("result-{line}"), "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                    "parentUuid": format!("call-{}", line - 1),
                    "message": {"content": [{"type": "tool_result", "tool_use_id": format!("tool-{}", line - 1),
                        "content": format!("message-{line} password=fixture_secret")}]}})
            };
            writeln!(file, "{record}").unwrap();
        }
        file.flush().unwrap();
        drop(file);
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        for line in [31_714, 100_002] {
            for tool in ["context", "trace"] {
                let params = serde_json::json!({
                    "ref": format!("large-session:{line}"), "project": "project", "before": 0, "after": 1,
                    "types": "user", "subtypes": "tool_result", "max_content": 1500, "max_total": 3500
                });
                let result = if tool == "context" {
                    service
                        .history_context(Parameters(serde_json::from_value(params).unwrap()))
                        .await
                } else {
                    service
                        .history_trace(Parameters(serde_json::from_value(params).unwrap()))
                        .await
                }
                .unwrap();
                let wrapper = serde_json::to_value(result).unwrap();
                assert_ne!(wrapper["isError"], true, "{tool}/{line}: {wrapper}");
                let text = wrapper["content"][0]["text"].as_str().unwrap();
                assert!(text.len() <= 3500);
                assert!(!text.contains("fixture_secret"));
                let response: serde_json::Value = serde_json::from_str(text).unwrap();
                let refs: Vec<_> = response["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["ref"].as_str().unwrap())
                    .collect();
                assert_eq!(refs, [format!("large-se:{line}"), format!("large-se:{}", line + 2)]);
                assert_eq!(response["messages"][0]["is_anchor"], true);
                if tool == "trace" {
                    assert!(
                        response["tool_calls"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|call| call["status"] == "completed")
                    );
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn public_window_modes_preserve_defaults_filters_and_export_anchor_indices() {
        use std::{fs, io::Write};
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("mcp-history-window-modes-{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut file = fs::File::create(project.join("window-session.jsonl")).unwrap();
        for line in 1..=60 {
            writeln!(file, "{}", serde_json::json!({"uuid": format!("message-{line}"), "type": "user",
                "timestamp": "2026-01-01T00:00:00Z", "message": {"content": format!("message-{line} password=fixture_secret")}})).unwrap();
        }
        drop(file);
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        for tool in ["context", "trace"] {
            let cases = [
                (
                    serde_json::json!({}),
                    if tool == "context" { (31, 60) } else { (11, 51) },
                ),
                (
                    serde_json::json!({"before": 0}),
                    if tool == "context" { (31, 31) } else { (31, 51) },
                ),
                (
                    serde_json::json!({"after": 0}),
                    if tool == "context" { (31, 31) } else { (11, 31) },
                ),
                (serde_json::json!({"before": 2, "after": 2}), (29, 33)),
                (serde_json::json!({"until_type": "user"}), (31, 32)),
                (
                    serde_json::json!({"until_type": "user", "direction": "backward"}),
                    (30, 31),
                ),
                (serde_json::json!({"until_type": "system"}), (31, 31)),
                (serde_json::json!({"until_ref": "window-session:29"}), (29, 31)),
                (serde_json::json!({"until_ref": "window-session:33"}), (31, 33)),
                (serde_json::json!({"until_ref": "window-session:31"}), (31, 31)),
                (
                    serde_json::json!({"until_ref": "window-session:29", "types": "assistant"}),
                    (31, 31),
                ),
                (
                    serde_json::json!({"until_ref": "window-session:29", "pattern": "absent"}),
                    (31, 31),
                ),
                (
                    serde_json::json!({"before": 2, "after": 2, "pattern": "message-(29|33)", "regex": true}),
                    (29, 33),
                ),
            ];
            for (case, (mut params, (start, end))) in cases.into_iter().enumerate() {
                params["ref"] = serde_json::json!("window-session:31");
                params["project"] = serde_json::json!("project");
                params["output"] = serde_json::json!(root.join(format!("export-{tool}-{case}")));
                let result = if tool == "context" {
                    service
                        .history_context(Parameters(serde_json::from_value(params.clone()).unwrap()))
                        .await
                } else {
                    service
                        .history_trace(Parameters(serde_json::from_value(params.clone()).unwrap()))
                        .await
                }
                .unwrap();
                let wrapper = serde_json::to_value(result).unwrap();
                assert_ne!(wrapper["isError"], true, "{tool}/{case}: {wrapper}");
                let text = wrapper["content"][0]["text"].as_str().unwrap();
                assert!(text.len() <= 40000);
                assert!(!text.contains("fixture_secret"));
                let response: serde_json::Value = serde_json::from_str(text).unwrap();
                let expected = if params["regex"] == true {
                    vec![29, 31, 33]
                } else {
                    (start..=end).collect()
                };
                assert_eq!(
                    response["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|message| message["ref"].as_str().unwrap().to_string())
                        .collect::<Vec<_>>(),
                    expected
                        .iter()
                        .map(|line| format!("window-s:{line}"))
                        .collect::<Vec<_>>(),
                    "{tool}/{case}"
                );
                let content = fs::read_to_string(response["output"]["content"].as_str().unwrap()).unwrap();
                assert!(!content.contains("fixture_secret"));
                assert_eq!(content.matches("[anchor]").count(), 1);
                assert!(content.contains("window-s:31"));
                assert_eq!(response["output"]["lines"], expected.len());
                let manifest: serde_json::Value =
                    serde_json::from_slice(&fs::read(response["output"]["manifest"].as_str().unwrap()).unwrap())
                        .unwrap();
                assert_eq!(manifest["complete"], true);
                assert_eq!(manifest["lines"], expected.len());
                fs::remove_dir_all(
                    std::path::Path::new(response["output"]["content"].as_str().unwrap())
                        .parent()
                        .unwrap(),
                )
                .unwrap();
            }
            for (until_ref, expected) in [
                ("invalid", "ref_invalid"),
                ("other-session:31", "ref_invalid"),
                ("window-session:0", "ref_invalid"),
                ("window-session:61", "ref_not_found"),
            ] {
                let params =
                    serde_json::json!({"ref": "window-session:31", "project": "project", "until_ref": until_ref});
                let result = if tool == "context" {
                    service
                        .history_context(Parameters(serde_json::from_value(params).unwrap()))
                        .await
                } else {
                    service
                        .history_trace(Parameters(serde_json::from_value(params).unwrap()))
                        .await
                }
                .unwrap();
                let wrapper = serde_json::to_value(result).unwrap();
                assert_eq!(wrapper["isError"], true);
                let error: serde_json::Value =
                    serde_json::from_str(wrapper["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(error["error"], expected, "{tool}/{until_ref}");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unicode_escaped_keys_are_redacted_by_public_tools_and_exports() {
        use std::{fs, io::Write};
        let root = std::env::temp_dir().join(format!("mcp-history-public-unicode-{}", std::process::id()));
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let body = format!("{{\"pass{}u0077ord\":\"fixture_secret\"}}", char::from(92));
        assert!(body.contains(&format!("pass{}u0077ord", char::from(92))));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["password"],
            "fixture_secret"
        );
        let text = format!("前缀 {body} 后缀");
        let embedded = serde_json::to_string(&serde_json::to_string(&body).unwrap()).unwrap();
        let mut file = fs::File::create(project.join("fixture-session.jsonl")).unwrap();
        for record in [
            serde_json::json!({"uuid": "human", "type": "user", "timestamp": "2026-01-01T00:00:00Z",
                "message": {"content": text}}),
            serde_json::json!({"uuid": "call", "type": "assistant", "timestamp": "2026-01-01T00:00:01Z",
                "message": {"content": [{"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": embedded}}]}}),
            serde_json::json!({"uuid": "result", "parentUuid": "call", "type": "user", "timestamp": "2026-01-01T00:00:02Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "call-1",
                    "content": [{"type": "text", "text": body}]}]}}),
        ] {
            writeln!(file, "{record}").unwrap();
        }
        drop(file);
        let service = McpHistoryService {
            config: Config {
                projects_dir: root.clone(),
            },
            tool_router: McpHistoryService::tool_router(),
        };
        for mode in ["auto", "strict", "off"] {
            for tool in ["get", "search", "context", "trace", "sessions"] {
                for export in [false, true] {
                    if export && tool == "sessions" {
                        continue;
                    }
                    let mut params = serde_json::json!({"project": "project", "redaction": mode});
                    if tool == "get" || tool == "context" || tool == "trace" {
                        params["ref"] = serde_json::json!("fixture-session:1");
                    }
                    if tool == "context" || tool == "trace" {
                        params["before"] = serde_json::json!(0);
                        params["after"] = serde_json::json!(2);
                    }
                    if export {
                        params["output"] =
                            serde_json::json!(format!("tmp:unicode-public-{}-{mode}-{tool}", std::process::id()));
                    }
                    let result = match tool {
                        "get" => {
                            service
                                .history_get(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        "search" => {
                            service
                                .history_search(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        "context" => {
                            service
                                .history_context(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        "trace" => {
                            service
                                .history_trace(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        "sessions" => {
                            service
                                .history_sessions(Parameters(serde_json::from_value(params).unwrap()))
                                .await
                        }
                        _ => unreachable!(),
                    }
                    .unwrap();
                    let wrapper = serde_json::to_value(result).unwrap();
                    assert_ne!(wrapper["isError"], true, "{mode}/{tool}: {wrapper}");
                    let response = wrapper["content"][0]["text"].as_str().unwrap();
                    if !export {
                        assert_eq!(
                            response.contains("fixture_secret"),
                            mode == "off",
                            "{mode}/{tool}: {response}"
                        );
                        if mode != "off" {
                            assert!(response.contains("[redacted]"), "{mode}/{tool}: {response}");
                        }
                    }
                    let payload: serde_json::Value = serde_json::from_str(response).unwrap();
                    if export {
                        let output = &payload["output"];
                        let content = output[if tool == "search" { "results" } else { "content" }]
                            .as_str()
                            .unwrap();
                        let manifest = output["manifest"].as_str().unwrap();
                        let exported = fs::read_to_string(content).unwrap();
                        assert_eq!(
                            exported.contains("fixture_secret"),
                            mode == "off",
                            "{mode}/{tool} export"
                        );
                        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
                        assert!(manifest["schema"].as_str().unwrap().ends_with(".v2"));
                        if mode != "off" {
                            assert!(manifest["redaction"]["redacted_count"].as_u64().unwrap() > 0);
                        }
                        fs::remove_dir_all(std::path::Path::new(content).parent().unwrap()).unwrap();
                    }
                }
            }
            let secret_start = text[..text.find("fixture_secret").unwrap()].chars().count();
            let result = service
                .history_get(Parameters(
                    serde_json::from_value(serde_json::json!({
                        "project": "project", "redaction": mode, "ref": "fixture-session:1",
                        "range": format!("{}-{}", secret_start + 3, secret_start + 8)
                    }))
                    .unwrap(),
                ))
                .await
                .unwrap();
            let wrapper = serde_json::to_value(result).unwrap();
            let payload: serde_json::Value =
                serde_json::from_str(wrapper["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(payload["content"], if mode == "off" { "ture_" } else { "[redacted]" });
            let result = service
                .history_get(Parameters(
                    serde_json::from_value(serde_json::json!({
                        "project": "project", "redaction": mode, "ref": "fixture-session:3"
                    }))
                    .unwrap(),
                ))
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_string(&result).unwrap().contains("fixture_secret"),
                mode == "off"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn redaction_schema_lists_public_modes_and_legacy_aliases_still_parse() {
        let schema = serde_json::to_string(&schemars::schema_for!(SearchToolParams)).unwrap();
        for mode in ["auto", "strict", "off"] {
            assert!(schema.contains(&format!("\"{mode}\"")));
        }
        for alias in ["none", "raw"] {
            let input: SearchToolParams = serde_json::from_value(serde_json::json!({"redaction": alias})).unwrap();
            assert_eq!(
                parse_optional_redaction_mode_param(input.redaction.as_deref()).unwrap(),
                crate::utils::RedactionMode::Off
            );
        }
    }
}

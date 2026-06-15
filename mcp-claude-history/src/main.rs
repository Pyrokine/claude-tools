mod config;
mod context;
mod get;
mod mcp_rmcp;
mod projects;
mod search;
mod sessions;
mod trace;
mod types;
mod utils;

use clap::{Parser, Subcommand};

use config::Config;
use context::{context, ContextParams};
use get::{get, GetParams};
use mcp_rmcp::run_mcp_server_rmcp;
use projects::list_projects;
use search::{search, SearchParams};
use sessions::list_sessions;
use trace::{trace, TraceParams};
use types::ErrorResponse;
use utils::{
    parse_line_ranges_param, parse_message_slice_param, parse_range_param, parse_redaction_mode_param, parse_time_param,
    RedactionMode,
};

fn arg_error(message: impl Into<String>) -> ErrorResponse {
    ErrorResponse {
        error: "invalid_arguments".to_string(),
        message: message.into(),
        available: None,
    }
}

fn split_csv(value: Option<String>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
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

fn parse_optional_slice(value: Option<String>) -> Result<Option<utils::MessageSlice>, ErrorResponse> {
    value
        .as_deref()
        .map(parse_message_slice_param)
        .transpose()
        .map_err(arg_error)
}

fn parse_optional_lines(value: Option<String>) -> Result<Vec<types::Range>, ErrorResponse> {
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

/// 把 domain Result<T, E> 序列化为 Result<String, String>:
///   - 成功 → Ok(json)
///   - 业务错误 → Err(json)
///   - 序列化失败（本地不可能,T/E 都 derive Serialize）→ Err(serde 错误描述)
fn serialize_result<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> Result<String, String> {
    match result {
        Ok(v) => serde_json::to_string_pretty(&v).map_err(|e| e.to_string()),
        Err(e) => match serde_json::to_string_pretty(&e) {
            Ok(s) => Err(s),
            Err(serde_err) => Err(serde_err.to_string()),
        },
    }
}

#[derive(Parser)]
#[command(name = "claude-history")]
#[command(about = "Claude Code conversation history search tool")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Run as MCP server
    #[arg(long)]
    mcp: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Search conversations
    Search {
        /// Search pattern (empty for all)
        #[arg(default_value = "")]
        pattern: String,

        /// Project ID (default: current)
        #[arg(long)]
        project: Option<Vec<String>>,

        /// Search all projects
        #[arg(long)]
        all: bool,

        /// Session IDs
        #[arg(long)]
        sessions: Option<Vec<String>>,

        /// Start time (ISO 8601)
        #[arg(long)]
        since: Option<String>,

        /// End time (ISO 8601)
        #[arg(long)]
        until: Option<String>,

        /// Message types (comma separated)
        #[arg(long, default_value = "assistant,user,summary")]
        types: String,

        /// Message subtypes filter (comma separated).
        /// user subtypes: human, tool_result, meta;
        /// assistant subtypes: text, tool_use, thinking, empty; summary, system
        #[arg(long)]
        subtypes: Option<String>,

        /// MCP server names (comma separated)
        #[arg(long)]
        servers: Option<String>,

        /// Tool names (comma separated)
        #[arg(long)]
        tools: Option<String>,

        /// Return aggregation summary in stats
        #[arg(long)]
        summary: bool,

        /// Return full aggregation only, without result rows
        #[arg(long)]
        aggregate: bool,

        /// Only return failed tool_result messages
        #[arg(long)]
        failed_tool_results: bool,

        /// Preview scanned projects, sessions and files without reading message contents
        #[arg(long)]
        dry_run: bool,

        /// Export search results as JSONL to output directory or .jsonl file
        #[arg(long)]
        output: Option<String>,

        /// Output format for --output
        #[arg(long)]
        output_format: Option<String>,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,

        /// Line ranges (e.g., "1-100,200-300,!150-160")
        #[arg(long)]
        lines: Option<String>,

        /// Use regex pattern
        #[arg(long)]
        regex: bool,

        /// Case sensitive search
        #[arg(long)]
        case_sensitive: bool,

        /// Include subagent sessions (sidechain) — same as MCP `subagents` parameter
        #[arg(long)]
        subagents: bool,

        /// Skip first N results
        #[arg(long, default_value = "0")]
        offset: usize,

        /// Max results
        #[arg(long)]
        limit: Option<usize>,

        /// Python-style message slice, e.g. [-10:] or [-10:-1]
        #[arg(long)]
        slice: Option<String>,

        /// Max chars per result
        #[arg(long, default_value = "4000")]
        max_content: usize,

        /// Max total chars
        #[arg(long, default_value = "40000")]
        max_total: usize,
    },

    /// Get full content by ref
    Get {
        /// Reference (session_prefix:line)
        #[arg(long)]
        r#ref: String,

        /// Char range for chunked reading (start-end)
        #[arg(long)]
        range: Option<String>,

        /// Output directory (relative path defaults to controlled temp dir, use cwd: prefix to persist in repo)
        #[arg(long)]
        output: Option<String>,

        /// Project ID
        #[arg(long)]
        project: Option<String>,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,
    },

    /// Get context around a message
    Context {
        /// Reference (session_prefix:line)
        #[arg(long)]
        r#ref: String,

        /// Lines before anchor (counts only messages matching both --types and --pattern)
        #[arg(long)]
        before: Option<usize>,

        /// Lines after anchor (counts only messages matching both --types and --pattern)
        #[arg(long)]
        after: Option<usize>,

        /// Expand until message type
        #[arg(long)]
        until_type: Option<String>,

        /// Direction for until_type (forward/backward)
        #[arg(long, default_value = "forward")]
        direction: String,

        /// Message types to include (comma separated)
        #[arg(long)]
        types: Option<String>,

        /// Message subtypes to include (comma separated)
        #[arg(long)]
        subtypes: Option<String>,

        /// Filter pattern for counting and returned messages
        #[arg(long)]
        pattern: Option<String>,

        /// Use regex for pattern matching
        #[arg(long)]
        regex: bool,

        /// Case-sensitive pattern matching
        #[arg(long)]
        case_sensitive: bool,

        /// Project ID
        #[arg(long)]
        project: Option<String>,

        /// Max chars per message
        #[arg(long, default_value = "4000")]
        max_content: usize,

        /// Expand until another ref (session:line), range from anchor to that ref inclusive
        #[arg(long)]
        until_ref: Option<String>,

        /// Export context to output directory (supports tmp:/cwd: prefix)
        #[arg(long)]
        output: Option<String>,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,

        /// Max total chars
        #[arg(long, default_value = "40000")]
        max_total: usize,
    },

    /// Trace nearby messages and tool call/result pairs
    Trace {
        /// Reference (session_prefix:line)
        #[arg(long)]
        r#ref: String,

        /// Messages before anchor (counts only matching --types and --pattern)
        #[arg(long, default_value = "20")]
        before: usize,

        /// Messages after anchor (counts only matching --types and --pattern)
        #[arg(long, default_value = "20")]
        after: usize,

        /// Project ID
        #[arg(long)]
        project: Option<String>,

        /// Max chars per message
        #[arg(long, default_value = "4000")]
        max_content: usize,

        /// Max total chars
        #[arg(long, default_value = "40000")]
        max_total: usize,

        /// Message types to include (comma separated)
        #[arg(long)]
        types: Option<String>,

        /// Message subtypes to include (comma separated)
        #[arg(long)]
        subtypes: Option<String>,

        /// Filter pattern for counting and returned messages
        #[arg(long)]
        pattern: Option<String>,

        /// Use regex for pattern matching
        #[arg(long)]
        regex: bool,

        /// Case-sensitive pattern matching
        #[arg(long)]
        case_sensitive: bool,

        /// Filter tool_calls by server name (comma separated)
        #[arg(long)]
        servers: Option<String>,

        /// Filter tool_calls by tool name (comma separated)
        #[arg(long)]
        tools: Option<String>,

        /// Expand until message type
        #[arg(long)]
        until_type: Option<String>,

        /// Expand until another ref (session:line)
        #[arg(long)]
        until_ref: Option<String>,

        /// Direction for until_type (forward/backward)
        #[arg(long, default_value = "forward")]
        direction: String,

        /// Export trace to output directory (supports tmp:/cwd: prefix)
        #[arg(long)]
        output: Option<String>,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,
    },

    /// List all projects
    Projects,

    /// List sessions in a project
    Sessions {
        /// Project ID (default: current)
        #[arg(long)]
        project: Option<String>,
    },
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // MCP 服务器模式（用 rmcp SDK 替代手写 JSON-RPC）
    if cli.mcp {
        return run_mcp_server_rmcp().await;
    }

    let config = Config::from_env();

    // 无子命令时默认 MCP 模式
    let command = match cli.command {
        Some(cmd) => cmd,
        None => {
            return run_mcp_server_rmcp().await;
        }
    };

    let result: Result<String, String> = match command {
        Commands::Search {
            pattern,
            project,
            all,
            sessions,
            since,
            until,
            types,
            subtypes,
            servers,
            tools,
            summary,
            aggregate,
            failed_tool_results,
            dry_run,
            output,
            output_format,
            redaction,
            lines,
            regex,
            case_sensitive,
            subagents,
            offset,
            limit,
            slice,
            max_content,
            max_total,
        } => {
            let parsed: Result<SearchParams, ErrorResponse> = (|| {
                Ok(SearchParams {
                    pattern,
                    projects: project.unwrap_or_default(),
                    all_projects: all,
                    sessions: sessions.unwrap_or_default(),
                    since: parse_optional_time(since, "since")?,
                    until: parse_optional_time(until, "until")?,
                    types: types
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                    subtypes: split_csv(subtypes),
                    servers: split_csv(servers),
                    tools: split_csv(tools),
                    lines: parse_optional_lines(lines)?,
                    use_regex: regex,
                    case_sensitive,
                    offset,
                    limit,
                    slice: parse_optional_slice(slice)?,
                    max_content,
                    max_content_tool_result: 500,
                    max_total,
                    summary,
                    aggregate,
                    failed_tool_results,
                    dry_run,
                    redaction: parse_redaction(redaction)?,
                    ignored_keys: Vec::new(),
                    warnings: Vec::new(),
                    output,
                    output_format,
                    subagents,
                })
            })();

            match parsed {
                Ok(params) => serialize_result(search(&config, params)),
                Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
            }
        }

        Commands::Get {
            r#ref,
            range,
            output,
            project,
            redaction,
        } => match parse_optional_range(range) {
            Ok(range) => {
                let params = parse_redaction(redaction).map(|redaction| GetParams {
                    r#ref,
                    range,
                    output,
                    project,
                    redaction,
                });
                match params {
                    Ok(params) => serialize_result(get(&config, params)),
                    Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
                }
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::Context {
            r#ref,
            before,
            after,
            until_type,
            until_ref,
            direction,
            types,
            subtypes,
            pattern,
            regex,
            case_sensitive,
            project,
            max_content,
            max_total,
            output,
            redaction,
        } => match parse_redaction(redaction) {
            Ok(redaction) => {
                let params = ContextParams {
                    r#ref,
                    before,
                    after,
                    until_type,
                    until_ref,
                    direction,
                    project,
                    types: types
                        .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
                        .unwrap_or_default(),
                    subtypes: split_csv(subtypes),
                    max_content,
                    max_total,
                    pattern,
                    regex,
                    case_sensitive,
                    output,
                    redaction,
                };

                serialize_result(context(&config, params))
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::Trace {
            r#ref,
            before,
            after,
            project,
            max_content,
            max_total,
            types,
            subtypes,
            pattern,
            regex,
            case_sensitive,
            servers,
            tools,
            until_type,
            until_ref,
            direction,
            output,
            redaction,
        } => match parse_redaction(redaction) {
            Ok(redaction) => {
                let params = TraceParams {
                    r#ref,
                    before,
                    after,
                    project,
                    max_content,
                    max_total,
                    types: types
                        .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
                        .unwrap_or_default(),
                    subtypes: split_csv(subtypes),
                    pattern,
                    regex,
                    case_sensitive,
                    servers: servers
                        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
                        .unwrap_or_default(),
                    tools: tools
                        .map(|t| t.split(',').map(|x| x.trim().to_string()).collect())
                        .unwrap_or_default(),
                    until_type,
                    until_ref,
                    direction,
                    output,
                    redaction,
                };
                serialize_result(trace(&config, params))
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::Projects => serialize_result(list_projects(&config)),

        Commands::Sessions { project } => serialize_result(list_sessions(&config, project.as_deref())),
    };

    match result {
        Ok(output) => {
            println!("{}", output);
            Ok(())
        }
        Err(output) => {
            eprintln!("{}", output);
            std::process::exit(1);
        }
    }
}

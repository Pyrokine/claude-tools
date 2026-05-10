mod config;
mod context;
mod get;
mod mcp_rmcp;
mod projects;
mod search;
mod sessions;
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
use types::Range;
use utils::parse_iso_utc;
use utils::parse_range;

/// 把 domain Result<T, E> 序列化为 Result<String, String>:
///   - 成功 → Ok(json)
///   - 业务错误 → Err(json)
///   - 序列化失败（本地不可能,T/E 都 derive Serialize）→ Err(serde 错误描述)
fn serialize_result<T: serde::Serialize, E: serde::Serialize>(
    result: Result<T, E>,
) -> Result<String, String> {
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

        /// Max total chars
        #[arg(long, default_value = "40000")]
        max_total: usize,
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
            lines,
            regex,
            case_sensitive,
            subagents,
            offset,
            limit,
            max_content,
            max_total,
        } => {
            let params = SearchParams {
                pattern,
                projects: project.unwrap_or_default(),
                all_projects: all,
                sessions: sessions.unwrap_or_default(),
                since: since.and_then(|s| parse_iso_utc(&s)),
                until: until.and_then(|s| parse_iso_utc(&s)),
                types: types.split(',').map(|s| s.trim().to_string()).collect(),
                subtypes: subtypes
                    .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default(),
                lines: lines.map(|s| Range::parse_ranges(&s)).unwrap_or_default(),
                use_regex: regex,
                case_sensitive,
                offset,
                limit,
                max_content,
                max_content_tool_result: 500,
                max_total,
                subagents,
            };

            serialize_result(search(&config, params))
        }

        Commands::Get {
            r#ref,
            range,
            output,
            project,
        } => {
            let range = range.and_then(|s| parse_range(&s));

            let params = GetParams {
                r#ref,
                range,
                output,
                project,
            };

            serialize_result(get(&config, params))
        }

        Commands::Context {
            r#ref,
            before,
            after,
            until_type,
            direction,
            types,
            pattern,
            regex,
            case_sensitive,
            project,
            max_content,
            max_total,
        } => {
            let params = ContextParams {
                r#ref,
                before,
                after,
                until_type,
                direction,
                project,
                types: types
                    .map(|t| t.split(',').map(|s| s.trim().to_string()).collect())
                    .unwrap_or_default(),
                max_content,
                max_total,
                pattern,
                regex,
                case_sensitive,
            };

            serialize_result(context(&config, params))
        }

        Commands::Projects => serialize_result(list_projects(&config)),

        Commands::Sessions { project } => {
            serialize_result(list_sessions(&config, project.as_deref()))
        }
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

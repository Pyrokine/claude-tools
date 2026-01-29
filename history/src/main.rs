mod config;
mod context;
mod get;
mod mcp;
mod projects;
mod search;
mod sessions;
mod types;
mod utils;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

use config::Config;
use context::{context, ContextParams};
use get::{get, GetParams};
use mcp::run_mcp_server;
use projects::list_projects;
use search::{search, SearchParams};
use sessions::list_sessions;
use types::Range;

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

        /// Line ranges (e.g., "1-100,200-300,!150-160")
        #[arg(long)]
        lines: Option<String>,

        /// Use regex pattern
        #[arg(long)]
        regex: bool,

        /// Case sensitive search
        #[arg(long)]
        case_sensitive: bool,

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

        /// Output directory (auto extract images)
        #[arg(long)]
        output: Option<PathBuf>,

        /// Project ID
        #[arg(long)]
        project: Option<String>,
    },

    /// Get context around a message
    Context {
        /// Reference (session_prefix:line)
        #[arg(long)]
        r#ref: String,

        /// Lines before anchor
        #[arg(long)]
        before: Option<usize>,

        /// Lines after anchor
        #[arg(long)]
        after: Option<usize>,

        /// Expand until message type
        #[arg(long)]
        until_type: Option<String>,

        /// Direction for until_type (forward/backward)
        #[arg(long, default_value = "forward")]
        direction: String,

        /// Project ID
        #[arg(long)]
        project: Option<String>,

        /// Max chars per message
        #[arg(long, default_value = "4000")]
        max_content: usize,
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

fn main() {
    let cli = Cli::parse();

    // MCP 服务器模式
    if cli.mcp {
        run_mcp_server();
        return;
    }

    let config = Config::from_env();

    // 无子命令时默认 MCP 模式
    let command = match cli.command {
        Some(cmd) => cmd,
        None => {
            run_mcp_server();
            return;
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
            lines,
            regex,
            case_sensitive,
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
                since: since.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.with_timezone(&chrono::Utc))),
                until: until.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.with_timezone(&chrono::Utc))),
                types: types.split(',').map(|s| s.trim().to_string()).collect(),
                lines: lines.map(|s| Range::parse_ranges(&s)).unwrap_or_default(),
                use_regex: regex,
                case_sensitive,
                offset,
                limit,
                max_content,
                max_total,
            };

            match search(&config, params) {
                Ok(response) => Ok(serde_json::to_string_pretty(&response).unwrap()),
                Err(e) => Err(serde_json::to_string_pretty(&e).unwrap()),
            }
        }

        Commands::Get {
            r#ref,
            range,
            output,
            project,
        } => {
            let range = range.and_then(|s| {
                let parts: Vec<&str> = s.split('-').collect();
                if parts.len() == 2 {
                    let start = parts[0].parse().ok()?;
                    let end = parts[1].parse().ok()?;
                    Some((start, end))
                } else {
                    None
                }
            });

            let params = GetParams {
                r#ref,
                range,
                output,
                project,
            };

            match get(&config, params) {
                Ok(response) => Ok(serde_json::to_string_pretty(&response).unwrap()),
                Err(e) => Err(serde_json::to_string_pretty(&e).unwrap()),
            }
        }

        Commands::Context {
            r#ref,
            before,
            after,
            until_type,
            direction,
            project,
            max_content,
        } => {
            let params = ContextParams {
                r#ref,
                before,
                after,
                until_type,
                direction,
                project,
                max_content,
            };

            match context(&config, params) {
                Ok(response) => Ok(serde_json::to_string_pretty(&response).unwrap()),
                Err(e) => Err(serde_json::to_string_pretty(&e).unwrap()),
            }
        }

        Commands::Projects => {
            match list_projects(&config) {
                Ok(response) => Ok(serde_json::to_string_pretty(&response).unwrap()),
                Err(e) => Err(serde_json::to_string_pretty(&e).unwrap()),
            }
        }

        Commands::Sessions { project } => {
            match list_sessions(&config, project.as_deref()) {
                Ok(response) => Ok(serde_json::to_string_pretty(&response).unwrap()),
                Err(e) => Err(serde_json::to_string_pretty(&e).unwrap()),
            }
        }
    };

    match result {
        Ok(output) => println!("{}", output),
        Err(output) => {
            eprintln!("{}", output);
            std::process::exit(1);
        }
    }
}

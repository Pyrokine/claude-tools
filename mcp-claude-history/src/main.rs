mod config;
mod context;
mod get;
mod mcp_rmcp;
mod projects;
mod record_reader;
mod search;
mod session_files;
mod sessions;
mod stream_scan;
mod trace;
mod types;
mod utils;

use clap::{Parser, Subcommand};

use config::Config;
use context::{ContextParams, context};
use get::{GetParams, get};
use mcp_rmcp::run_mcp_server_rmcp;
use projects::list_projects;
use search::{SearchParams, search};
use sessions::list_sessions;
use trace::{TraceParams, trace};
use types::{BuildIdentity, ErrorResponse};
use utils::{
    parse_optional_line_ranges_param, parse_optional_message_slice_param, parse_optional_range_param,
    parse_optional_redaction_mode_param, parse_time_bounds, split_csv_param,
};

/// 把 domain Result<T, E> 序列化为 Result<String, String>:
///   - 成功 → Ok(json)
///   - 业务错误 → Err(json)
///   - 序列化失败（本地不可能,T/E 都 derive Serialize）→ Err(serde 错误描述)
fn serialize_result<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> Result<String, String> {
    match result {
        Ok(v) => {
            let mut bytes = Vec::new();
            match record_reader::serialize_json(&mut bytes, &v, false) {
                Ok(_) => Ok(String::from_utf8(bytes).expect("JSON is UTF-8")),
                Err(error) => Err(serde_json::to_string(&error).unwrap_or_else(|failure| failure.to_string())),
            }
        }
        Err(e) => match serde_json::to_string(&e) {
            Ok(s) => Err(s),
            Err(serde_err) => Err(serde_err.to_string()),
        },
    }
}

#[derive(Parser)]
#[command(name = "claude-history")]
#[command(about = "Claude Code conversation history search tool")]
#[command(version)]
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
        /// normal or scan; scan prints NDJSON result pages, then metadata pages, in this process
        #[arg(long, default_value = "normal")]
        mode: String,

        /// Cursors cannot be reused across CLI processes
        #[arg(long)]
        cursor: Option<String>,

        #[arg(long)]
        scan_bytes: Option<u64>,

        #[arg(long)]
        scan_ms: Option<u64>,

        /// preview or full; normal defaults to full, scan defaults to preview
        #[arg(long)]
        structured: Option<String>,

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

        /// 精确 source，与显式项目和会话筛选取交集，子会话需要 --subagents
        #[arg(long)]
        source: Option<String>,

        /// Start time (ISO 8601)
        #[arg(long)]
        since: Option<String>,

        /// End time (ISO 8601)
        #[arg(long)]
        until: Option<String>,

        /// Message types (comma separated)
        #[arg(long, default_value = "assistant,user,summary")]
        types: String,

        /// Message subtype filter (comma separated). `human` means a user-shaped record, not verified human authorship.
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

        /// Only return tool_result messages whose JSON payload reports an error
        #[arg(long)]
        tool_payload_errors: bool,

        /// Preview scanned projects, sessions and files without reading message contents
        #[arg(long)]
        dry_run: bool,

        /// Export search results to an output directory or `.jsonl` file
        #[arg(long)]
        output: Option<String>,

        /// Replace an existing export bundle (requires --output)
        #[arg(long)]
        overwrite: bool,

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

        /// Use case-sensitive search
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

        /// Max chars per regular result
        #[arg(long, default_value_t = search::DEFAULT_MAX_CONTENT)]
        max_content: usize,

        /// Max chars per tool_result preview
        #[arg(long, default_value_t = search::DEFAULT_MAX_CONTENT_TOOL_RESULT)]
        max_content_tool_result: usize,

        /// Max compact response JSON bytes
        #[arg(long, default_value_t = search::DEFAULT_MAX_TOTAL)]
        max_total: usize,
    },

    /// Get full content by ref
    Get {
        /// content (default), tool_input, tool_result, or record (normalized, redacted JSON object)
        #[arg(long)]
        view: Option<String>,

        /// Original content array index for a tool view; not accepted with record
        #[arg(long)]
        block: Option<usize>,

        /// Reference (session_prefix:line)
        #[arg(long)]
        r#ref: String,

        /// Exact source returned by search or scan metadata
        #[arg(long)]
        source: Option<String>,

        /// Char range for chunked reading (start-end)
        #[arg(long)]
        range: Option<String>,

        /// Output directory (relative path defaults to controlled temp dir, use cwd: prefix to persist in repo)
        #[arg(long)]
        output: Option<String>,

        #[arg(long)]
        overwrite: bool,

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

        /// Exact source returned by search or scan metadata
        #[arg(long)]
        source: Option<String>,

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

        #[arg(long)]
        overwrite: bool,

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

        /// Exact source returned by search or scan metadata
        #[arg(long)]
        source: Option<String>,

        /// Messages before anchor (counts only matching --types and --pattern; default: 20)
        #[arg(long)]
        before: Option<usize>,

        /// Messages after anchor (counts only matching --types and --pattern; default: 20)
        #[arg(long)]
        after: Option<usize>,

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

        #[arg(long)]
        overwrite: bool,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,
    },

    /// Show the running binary build identity
    BuildInfo,

    /// List all projects
    Projects,

    /// List sessions in a project
    Sessions {
        /// Project ID (default: current)
        #[arg(long)]
        project: Option<String>,

        /// Redaction mode: auto, strict, off
        #[arg(long)]
        redaction: Option<String>,
    },
}

fn run_scan_cli(
    config: &Config,
    params: SearchParams,
    cursor: Option<String>,
    scan_bytes: Option<u64>,
    scan_ms: Option<u64>,
) -> Result<(), ErrorResponse> {
    use std::io::Write;
    if cursor.is_some() {
        return Err(utils::invalid_arguments(
            "CLI cursor 不能跨进程使用；--mode scan 会在当前进程中驱动所有批次",
        ));
    }
    let scans = stream_scan::ScanStore::default();
    let max_total = params.max_total;
    let limit = params.limit;
    let mut request = stream_scan::ScanRequest {
        params,
        cursor: None,
        scan_bytes,
        scan_ms,
        explicit_filters: serde_json::json!({}),
    };
    let mut output = std::io::stdout().lock();
    let id = loop {
        let page = record_reader::WorkControl::default()
            .run(|| scans.search(config, request, std::sync::Arc::new(|| false)))?;
        writeln!(output, "{page}")
            .map_err(|error| record_reader::reader_error("io_error", format!("写入扫描页失败: {error}")))?;
        output
            .flush()
            .map_err(|error| record_reader::reader_error("io_error", error.to_string()))?;
        let page: serde_json::Value = serde_json::from_str(&page)
            .map_err(|error| record_reader::reader_error("serialize_error", error.to_string()))?;
        if page["has_more"] == false {
            break page["scan_id"].as_str().expect("scan_id string").to_string();
        }
        request = stream_scan::ScanRequest {
            params: SearchParams {
                max_total,
                limit,
                ..SearchParams::default()
            },
            cursor: Some(
                page["next_query"]["cursor"]
                    .as_str()
                    .expect("cursor string")
                    .to_string(),
            ),
            scan_bytes,
            scan_ms,
            explicit_filters: serde_json::json!({}),
        };
    };
    let mut cursor = None;
    loop {
        let page = record_reader::WorkControl::default().run(|| {
            scans.metadata(stream_scan::MetadataRequest {
                scan_id: id.clone(),
                cursor,
                limit: limit.unwrap_or(100),
                max_total,
                release: false,
            })
        })?;
        writeln!(output, "{page}").map_err(|error| record_reader::reader_error("io_error", error.to_string()))?;
        let page: serde_json::Value = serde_json::from_str(&page)
            .map_err(|error| record_reader::reader_error("serialize_error", error.to_string()))?;
        if page["has_more"] == false {
            break;
        }
        cursor = Some(
            page["next_query"]["cursor"]
                .as_str()
                .expect("metadata cursor string")
                .to_string(),
        );
    }
    scans.release(&id)
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
            mode,
            cursor,
            scan_bytes,
            scan_ms,
            structured,
            pattern,
            project,
            all,
            sessions,
            source,
            since,
            until,
            types,
            subtypes,
            servers,
            tools,
            summary,
            aggregate,
            failed_tool_results,
            tool_payload_errors,
            dry_run,
            output,
            overwrite,
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
            max_content_tool_result,
            max_total,
        } => {
            let parsed: Result<SearchParams, ErrorResponse> = (|| {
                let (since, until) = parse_time_bounds(since.as_deref(), until.as_deref())?;
                Ok(SearchParams {
                    pattern,
                    projects: project.unwrap_or_default(),
                    all_projects: all,
                    sessions: sessions.unwrap_or_default(),
                    source,
                    since,
                    until,
                    types: split_csv_param(Some(types.as_str())),
                    subtypes: split_csv_param(subtypes.as_deref()),
                    servers: split_csv_param(servers.as_deref()),
                    tools: split_csv_param(tools.as_deref()),
                    lines: parse_optional_line_ranges_param(lines.as_deref())?,
                    use_regex: regex,
                    case_sensitive,
                    offset,
                    limit,
                    slice: parse_optional_message_slice_param(slice.as_deref())?,
                    max_content,
                    max_content_tool_result,
                    max_total,
                    summary,
                    aggregate,
                    failed_tool_results,
                    tool_payload_errors,
                    dry_run,
                    redaction: parse_optional_redaction_mode_param(redaction.as_deref())?,
                    ignored_keys: Vec::new(),
                    warnings: Vec::new(),
                    output,
                    overwrite,
                    output_format,
                    subagents,
                    structured,
                })
            })();

            match parsed {
                Ok(params) if mode == "scan" => match run_scan_cli(&config, params, cursor, scan_bytes, scan_ms) {
                    Ok(()) => Ok(String::new()),
                    Err(error) => serialize_result::<serde_json::Value, _>(Err(error)),
                },
                Ok(params) if mode == "normal" && cursor.is_none() && scan_bytes.is_none() && scan_ms.is_none() => {
                    record_reader::WorkControl::default().run(|| serialize_result(search(&config, params)))
                }
                Ok(_) => serialize_result::<serde_json::Value, _>(Err(utils::invalid_arguments(
                    "mode 仅支持 normal 或 scan；cursor 和 scan 预算需要 mode=scan",
                ))),
                Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
            }
        }

        Commands::Get {
            r#ref,
            source,
            view,
            block,
            range,
            output,
            overwrite,
            project,
            redaction,
        } => match parse_optional_range_param(range.as_deref()) {
            Ok(range) => {
                let params = parse_optional_redaction_mode_param(redaction.as_deref()).map(|redaction| GetParams {
                    r#ref,
                    source,
                    view,
                    block,
                    range,
                    output,
                    overwrite,
                    project,
                    redaction,
                });
                match params {
                    Ok(params) => record_reader::WorkControl::default().run(|| serialize_result(get(&config, params))),
                    Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
                }
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::Context {
            r#ref,
            source,
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
            overwrite,
            redaction,
        } => match parse_optional_redaction_mode_param(redaction.as_deref()) {
            Ok(redaction) => {
                let params = ContextParams {
                    r#ref,
                    source,
                    before,
                    after,
                    until_type,
                    until_ref,
                    direction,
                    project,
                    types: split_csv_param(types.as_deref()),
                    subtypes: split_csv_param(subtypes.as_deref()),
                    max_content,
                    max_total,
                    pattern,
                    regex,
                    case_sensitive,
                    output,
                    overwrite,
                    redaction,
                };

                record_reader::WorkControl::default().run(|| serialize_result(context(&config, params)))
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::Trace {
            r#ref,
            source,
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
            overwrite,
            redaction,
        } => match parse_optional_redaction_mode_param(redaction.as_deref()) {
            Ok(redaction) => {
                let params = TraceParams {
                    r#ref,
                    source,
                    before,
                    after,
                    project,
                    max_content,
                    max_total,
                    types: split_csv_param(types.as_deref()),
                    subtypes: split_csv_param(subtypes.as_deref()),
                    pattern,
                    regex,
                    case_sensitive,
                    servers: split_csv_param(servers.as_deref()),
                    tools: split_csv_param(tools.as_deref()),
                    until_type,
                    until_ref,
                    direction,
                    output,
                    overwrite,
                    redaction,
                };
                record_reader::WorkControl::default().run(|| serialize_result(trace(&config, params)))
            }
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },

        Commands::BuildInfo => serialize_result::<_, ErrorResponse>(Ok(BuildIdentity::current())),

        Commands::Projects => record_reader::WorkControl::default().run(|| serialize_result(list_projects(&config))),

        Commands::Sessions { project, redaction } => match parse_optional_redaction_mode_param(redaction.as_deref()) {
            Ok(redaction) => record_reader::WorkControl::default()
                .run(|| serialize_result(list_sessions(&config, project.as_deref(), redaction))),
            Err(e) => serialize_result::<serde_json::Value, _>(Err(e)),
        },
    };

    match result {
        Ok(output) => {
            if !output.is_empty() {
                println!("{output}");
            }
            Ok(())
        }
        Err(output) => {
            eprintln!("{output}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    #[test]
    fn cli_source_is_available_for_all_reference_readers() {
        for command in ["search", "get", "context", "trace"] {
            let mut args = vec![
                "claude-history",
                command,
                "--source",
                "/fixture/project/agent-same.jsonl",
            ];
            if command != "search" {
                args.extend(["--ref", "agent-same:1"]);
            }
            let parsed = Cli::try_parse_from(args).unwrap();
            let source = match parsed.command.unwrap() {
                Commands::Search { source, .. }
                | Commands::Get { source, .. }
                | Commands::Context { source, .. }
                | Commands::Trace { source, .. } => source,
                _ => panic!("unexpected command"),
            };
            assert_eq!(source.as_deref(), Some("/fixture/project/agent-same.jsonl"));
        }
    }

    #[test]
    fn cli_version_and_build_info_are_available() {
        assert_eq!(
            Cli::try_parse_from(["claude-history", "--version"])
                .err()
                .unwrap()
                .kind(),
            ErrorKind::DisplayVersion
        );
        assert!(matches!(
            Cli::try_parse_from(["claude-history", "build-info"]).unwrap().command,
            Some(Commands::BuildInfo)
        ));
    }
}

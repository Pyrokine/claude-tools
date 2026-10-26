use crate::config::Config;
use crate::record_reader::{LineStep, RecordLines, SourceSpan, WorkControl, check_work, reader_error};
use crate::search::{self, RecordBuildContext, SearchParams};
use crate::session_files::open_session_file;
use crate::types::{ErrorResponse, SearchResult, line_in_ranges};
use crate::utils::*;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, hash_map::RandomState};
use std::fs::Metadata;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

const MAX_SCANS: usize = 4;
const SCAN_TTL: Duration = Duration::from_secs(20 * 60);
const MAX_METADATA_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_SCAN_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_SCAN_MS: u64 = 1000;
const DEFAULT_PAGE_LIMIT: usize = 100;

pub struct ScanRequest {
    pub params: SearchParams,
    pub cursor: Option<String>,
    pub scan_bytes: Option<u64>,
    pub scan_ms: Option<u64>,
    pub explicit_filters: Value,
}

#[derive(Clone)]
pub struct ScanStore {
    entries: Arc<Mutex<BTreeMap<String, Arc<ScanEntry>>>>,
    instance: String,
    catalogs: Arc<Mutex<BTreeMap<String, SourceCatalog>>>,
}
struct ScanEntry {
    driver: Mutex<Driver>,
    commands: mpsc::Sender<Command>,
    stopped: Arc<AtomicBool>,
}
impl Drop for ScanEntry {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}
impl ScanEntry {
    fn stop(&self) -> Result<(), ErrorResponse> {
        self.stopped.store(true, Ordering::Release);
        let _ = self.commands.send(Command::Stop);
        let mut driver = self
            .driver
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描状态锁不可用"))?;
        if let Some(worker) = driver.thread.take() {
            worker
                .join()
                .map_err(|_| reader_error("scan_state_error", "扫描工作线程异常结束"))?;
        }
        Ok(())
    }
}

pub struct MetadataRequest {
    pub scan_id: String,
    pub cursor: Option<String>,
    pub limit: usize,
    pub max_total: usize,
    pub release: bool,
}

#[derive(Default, Serialize)]
struct Counters {
    files_total: usize,
    files_scanned: usize,
    lines_scanned: usize,
    total_matches: usize,
    returned_count: usize,
    bytes_processed: u64,
    oversized_records: usize,
    invalid_records: usize,
    invalid_timestamps: usize,
    attribution_issues: usize,
}

#[derive(Serialize)]
struct FileCoverage {
    project: String,
    session: String,
    source: String,
    snapshot_bytes: u64,
    status: String,
    lines: usize,
}

struct ScanMetadata {
    counters: Counters,
    phase: String,
    scan_complete: bool,
    counts_exact: bool,
    filters: Value,
    files: Vec<FileCoverage>,
    summary: BTreeMap<String, BTreeMap<String, usize>>,
    issues: Vec<Value>,
    warnings: Vec<String>,
    bytes: usize,
    active_source: Option<Snapshot>,
}

impl ScanMetadata {
    fn new(filters: Value) -> Self {
        let bytes = filters.to_string().len();
        Self {
            counters: Counters::default(),
            phase: "enumeration".to_string(),
            scan_complete: false,
            counts_exact: true,
            filters,
            files: Vec::new(),
            summary: BTreeMap::new(),
            issues: Vec::new(),
            warnings: Vec::new(),
            bytes,
            active_source: None,
        }
    }
    fn reserve(&mut self, bytes: usize) -> Result<(), ErrorResponse> {
        if bytes > MAX_METADATA_BYTES.saturating_sub(self.bytes) {
            return Err(ErrorResponse {
                error: "scan_metadata_quota".to_string(),
                message: "扫描 metadata 超过 32 MiB，请按项目或会话分别扫描".to_string(),
                available: Some(json!({
                    "metadata_bytes_used": self.bytes,
                    "requested_bytes": bytes,
                    "max_metadata_bytes": MAX_METADATA_BYTES,
                    "remaining_bytes": MAX_METADATA_BYTES.saturating_sub(self.bytes),
                    "files_enumerated": self.files.len(),
                    "scan_phase": self.phase,
                })),
            });
        }
        self.bytes += bytes;
        Ok(())
    }
    fn issue(
        &mut self,
        project: &str,
        session: &str,
        source: &str,
        line: usize,
        reason: &str,
        attribution: bool,
    ) -> Result<(), ErrorResponse> {
        let item = json!({"project": project, "session": session, "source": source, "ref": format!("{}:{line}", ref_prefix(session)), "line": line, "reason": reason, "kind": if attribution { "attribution" } else { "record" }});
        self.reserve(item.to_string().len() + 128)?;
        self.issues.push(item);
        if attribution {
            self.counters.attribution_issues += 1;
        } else {
            self.counts_exact = false;
        }
        Ok(())
    }
    fn count_match(&mut self, result: &SearchResult) -> Result<(), ErrorResponse> {
        let mut buckets = vec![
            ("by_project", result.project.clone()),
            ("by_session", result.session.clone()),
            ("by_type", format!("{}:{}", result.r#type, result.subtype)),
        ];
        if let Some(server) = &result.server {
            buckets.push(("by_server", server.clone()));
        }
        if let Some(tool) = &result.tool {
            buckets.push(("by_tool", tool.clone()));
        }
        if let Some(timestamp) = parse_time(&result.timestamp) {
            buckets.push(("by_day", timestamp.date_naive().format("%Y-%m-%d").to_string()));
        }
        for (dimension, key) in buckets {
            if !self
                .summary
                .get(dimension)
                .is_some_and(|buckets| buckets.contains_key(&key))
            {
                self.reserve(key.len() + dimension.len() + 128)?;
            }
            *self
                .summary
                .entry(dimension.to_string())
                .or_default()
                .entry(key)
                .or_default() += 1;
        }
        self.counters.total_matches += 1;
        Ok(())
    }
}

struct Batch {
    bytes: u64,
    deadline: Instant,
    cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
}
enum Command {
    Batch(Batch),
    Next,
    Stop,
}
enum Event {
    Row(Box<SearchResult>),
    Yield,
    Done,
    Failed(ErrorResponse),
}

struct GateState {
    commands: mpsc::Receiver<Command>,
    active: Option<Batch>,
}
struct Gate {
    state: Mutex<GateState>,
    events: mpsc::Sender<Event>,
    metadata: Arc<Mutex<ScanMetadata>>,
    stopped: Arc<AtomicBool>,
}

impl Gate {
    fn permission(&self, state: &mut GateState) -> Result<(), ErrorResponse> {
        match state.commands.recv_timeout(SCAN_TTL) {
            Ok(Command::Batch(batch)) => {
                if (batch.cancelled)() {
                    return Err(reader_error("cancelled", "扫描已取消"));
                }
                let snapshot = self
                    .metadata
                    .lock()
                    .map_err(|_| reader_error("scan_state_error", "扫描统计锁不可用"))?
                    .active_source
                    .clone();
                if let Some(snapshot) = snapshot {
                    snapshot_file(&snapshot)?;
                }
                state.active = Some(batch);
                Ok(())
            }
            Ok(Command::Next) if state.active.is_some() => Ok(()),
            Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(reader_error("cancelled", "扫描已释放或取消"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(reader_error("cursor_expired", "扫描空闲超过 20 分钟")),
            Ok(Command::Next) => Err(reader_error("scan_protocol_error", "扫描尚未收到批次预算")),
        }
    }
    fn checkpoint(&self, bytes: usize) -> Result<(), ErrorResponse> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描状态锁不可用"))?;
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Err(reader_error("cancelled", "扫描已释放或停止"));
            }
            if let Some(active) = &state.active {
                if (active.cancelled)() {
                    return Err(reader_error("cancelled", "扫描已取消"));
                }
                if active.bytes > 0 && Instant::now() < active.deadline {
                    break;
                }
                self.events
                    .send(Event::Yield)
                    .map_err(|_| reader_error("cancelled", "扫描调用方已关闭"))?;
                state.active = None;
            }
            self.permission(&mut state)?;
        }
        if let Some(active) = &mut state.active {
            active.bytes = active.bytes.saturating_sub(bytes as u64);
        }
        self.metadata
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描统计锁不可用"))?
            .counters
            .bytes_processed += bytes as u64;
        Ok(())
    }
    fn row(&self, result: SearchResult) -> Result<(), ErrorResponse> {
        self.checkpoint(0)?;
        self.events
            .send(Event::Row(Box::new(result)))
            .map_err(|_| reader_error("cancelled", "扫描调用方已关闭"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描状态锁不可用"))?;
        self.permission(&mut state)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PageBudget {
    max_total: usize,
    limit: usize,
    bytes: u64,
    milliseconds: u64,
}

struct Driver {
    commands: mpsc::Sender<Command>,
    events: mpsc::Receiver<Event>,
    thread: Option<JoinHandle<()>>,
    metadata: Arc<Mutex<ScanMetadata>>,
    frozen_params: SearchParams,
    last_access: Instant,
    sequence: u64,
    cached: Option<(u64, PageBudget, String)>,
    pending: Option<SearchResult>,
    done: bool,
    failure: Option<ErrorResponse>,
}

impl Drop for Driver {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn opaque_id() -> String {
    let mut first = RandomState::new().build_hasher();
    let mut second = RandomState::new().build_hasher();
    first.write_u128(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    second.write_u64(first.finish());
    format!("{:016x}{:016x}", first.finish(), second.finish())
}

impl Default for ScanStore {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(BTreeMap::new())),
            instance: opaque_id(),
            catalogs: catalog_store(),
        }
    }
}

fn prepare_scan_params(config: &Config, params: SearchParams) -> Result<SearchParams, ErrorResponse> {
    let mut params = search::prepare_search_params(params)?;
    if !params.ignored_keys.is_empty() {
        return Err(invalid_arguments(format!(
            "scan 不支持参数: {}",
            params.ignored_keys.join(",")
        )));
    }
    if params.pattern.len() > 1024 * 1024
        || [
            &params.projects,
            &params.sessions,
            &params.types,
            &params.subtypes,
            &params.servers,
            &params.tools,
        ]
        .into_iter()
        .flatten()
        .map(String::len)
        .sum::<usize>()
        .saturating_add(params.source.as_ref().map_or(0, String::len))
        .saturating_add(params.sources.iter().map(String::len).sum::<usize>())
            > 1024 * 1024
    {
        return Err(invalid_arguments("scan pattern 或筛选列表超过 1 MiB，请缩小查询范围"));
    }
    params.projects = params
        .projects
        .iter()
        .map(|project| config.normalize_project_id(project))
        .collect::<Result<_, _>>()?;
    for values in [
        &mut params.projects,
        &mut params.sessions,
        &mut params.types,
        &mut params.subtypes,
        &mut params.servers,
        &mut params.tools,
        &mut params.sources,
    ] {
        values.sort();
        values.dedup();
    }
    params
        .lines
        .sort_by_key(|range| (range.start, range.end, range.exclude));
    params
        .lines
        .dedup_by_key(|range| (range.start, range.end, range.exclude));
    Ok(params)
}

fn scan_filters(params: &SearchParams) -> Result<Value, ErrorResponse> {
    let mut filters = serde_json::to_value(search::effective_filters(params))
        .map_err(|error| reader_error("serialize_error", error.to_string()))?;
    let values = filters.as_object_mut().expect("effective filters object");
    for (key, value) in [
        ("summary", json!(params.summary)),
        ("aggregate", json!(params.aggregate)),
        ("failed_tool_results", json!(params.failed_tool_results)),
        ("redaction", json!(params.redaction.as_str())),
        ("structured", json!(params.structured)),
        ("max_content", json!(params.max_content)),
        ("max_content_tool_result", json!(params.max_content_tool_result)),
        (
            "lines",
            json!(
                params
                    .lines
                    .iter()
                    .map(|range| json!({"start":range.start,"end":range.end,"exclude":range.exclude}))
                    .collect::<Vec<_>>()
            ),
        ),
    ] {
        values.insert(key.to_string(), value);
    }
    Ok(filters)
}

fn check_frozen_filters(
    config: &Config,
    frozen: &SearchParams,
    supplied: &SearchParams,
    keys: &serde_json::Map<String, Value>,
) -> Result<(), ErrorResponse> {
    if keys.is_empty() {
        return Ok(());
    }
    let mut merged = frozen.clone();
    for key in keys.keys() {
        match key.as_str() {
            "pattern" => merged.pattern = supplied.pattern.clone(),
            "project" => merged.projects = supplied.projects.clone(),
            "all" => merged.all_projects = supplied.all_projects,
            "sessions" => merged.sessions = supplied.sessions.clone(),
            "source" => merged.source = supplied.source.clone(),
            "sources" => merged.sources = supplied.sources.clone(),
            "output_content" => merged.output_content = supplied.output_content.clone(),
            "since" => merged.since = supplied.since,
            "until" => merged.until = supplied.until,
            "types" => merged.types = supplied.types.clone(),
            "subtypes" => merged.subtypes = supplied.subtypes.clone(),
            "servers" => merged.servers = supplied.servers.clone(),
            "tools" => merged.tools = supplied.tools.clone(),
            "lines" => merged.lines = supplied.lines.clone(),
            "case_sensitive" => merged.case_sensitive = supplied.case_sensitive,
            "summary" => merged.summary = supplied.summary,
            "aggregate" => merged.aggregate = supplied.aggregate,
            "failed_tool_results" | "failed_tools_only" => merged.failed_tool_results = supplied.failed_tool_results,
            "tool_payload_errors" => merged.tool_payload_errors = supplied.tool_payload_errors,
            "redaction" => merged.redaction = supplied.redaction,
            "structured" => merged.structured = supplied.structured.clone(),
            "subagents" => merged.subagents = supplied.subagents,
            "max_content" => merged.max_content = supplied.max_content,
            "max_content_tool_result" => merged.max_content_tool_result = supplied.max_content_tool_result,
            "regex" => merged.use_regex = supplied.use_regex,
            "slice" => merged.slice = supplied.slice.clone(),
            "offset" => merged.offset = supplied.offset,
            "dry_run" => merged.dry_run = supplied.dry_run,
            "output" => merged.output = supplied.output.clone(),
            "overwrite" => merged.overwrite = supplied.overwrite,
            "output_format" => merged.output_format = supplied.output_format.clone(),
            _ => return Err(invalid_arguments(format!("scan 不支持续查参数: {key}"))),
        }
    }
    let merged = prepare_scan_params(config, merged)?;
    if scan_filters(&merged)? != scan_filters(frozen)? {
        return Err(reader_error(
            "cursor_filter_mismatch",
            "cursor 与冻结的有效筛选不一致；续查应原样使用 next_query",
        ));
    }
    Ok(())
}

impl ScanStore {
    fn prune(&self) -> Result<(), ErrorResponse> {
        let mut removed = Vec::new();
        {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| reader_error("scan_state_error", "扫描注册表不可用"))?;
            let expired: Vec<_> = entries
                .iter()
                .filter_map(|(id, driver)| {
                    driver
                        .driver
                        .try_lock()
                        .ok()
                        .filter(|driver| driver.last_access.elapsed() >= SCAN_TTL)
                        .map(|_| id.clone())
                })
                .collect();
            for id in expired {
                if let Some(driver) = entries.remove(&id) {
                    removed.push(driver);
                }
            }
        }
        for entry in removed {
            entry.stop()?;
        }
        Ok(())
    }

    pub fn search(
        &self,
        config: &Config,
        mut request: ScanRequest,
        cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, ErrorResponse> {
        if let Err(error) = check_work() {
            if let Some((id, _)) = request.cursor.as_deref().and_then(|cursor| cursor.rsplit_once(':'))
                && id.starts_with(&format!("{}-", self.instance))
            {
                self.release(id)?;
            }
            return Err(error);
        }
        if !request.explicit_filters.is_object() {
            return Err(invalid_arguments("续查筛选参数格式无效"));
        }
        self.prune()?;
        let bytes = request.scan_bytes.unwrap_or(DEFAULT_SCAN_BYTES);
        let milliseconds = request.scan_ms.unwrap_or(DEFAULT_SCAN_MS);
        if !(16 * 1024..=256 * 1024 * 1024).contains(&bytes) || !(10..=10_000).contains(&milliseconds) {
            return Err(invalid_arguments(
                "scan_bytes 必须为 16384..268435456，scan_ms 必须为 10..10000",
            ));
        }
        if !(search::MIN_TOTAL_LIMIT..=search::MAX_TOTAL_LIMIT).contains(&request.params.max_total) {
            return Err(invalid_arguments("max_total 必须为 512..10000000"));
        }
        let limit = request.params.limit.unwrap_or(DEFAULT_PAGE_LIMIT);
        if limit == 0 || limit > 10_000 {
            return Err(invalid_arguments("scan 每页 limit 必须为 1..10000"));
        }
        let max_total = request.params.max_total;
        let supplied_params = request.cursor.is_some().then(|| request.params.clone());
        let budget = PageBudget {
            max_total,
            limit,
            bytes,
            milliseconds,
        };
        if request.params.use_regex
            || request.params.slice.is_some()
            || request.params.offset != 0
            || request.params.output.is_some()
            || request.params.dry_run
        {
            return Err(invalid_arguments(
                "scan 不支持 regex、slice、非零 offset、output 或 dry_run",
            ));
        }
        let (id, sequence, driver) = if let Some(cursor) = &request.cursor {
            let (id, sequence) = cursor
                .rsplit_once(':')
                .ok_or_else(|| invalid_arguments("scan cursor 格式无效"))?;
            if !id.starts_with(&format!("{}-", self.instance)) {
                return Err(reader_error(
                    "cursor_instance_mismatch",
                    "cursor 不属于当前存活的 MCP 实例，跨进程 cursor 不能继续",
                ));
            }
            let sequence = sequence
                .parse::<u64>()
                .map_err(|_| invalid_arguments("scan cursor 页号无效"))?;
            let driver = self
                .entries
                .lock()
                .map_err(|_| reader_error("scan_state_error", "扫描注册表不可用"))?
                .get(id)
                .cloned()
                .ok_or_else(|| reader_error("cursor_unavailable", "cursor 已过期、释放或不存在"))?;
            (id.to_string(), sequence, driver)
        } else {
            if request.params.structured.is_none() {
                request.params.structured = Some("preview".to_string());
            }
            let params = prepare_scan_params(config, request.params)?;
            let frozen_params = params.clone();
            let metadata = Arc::new(Mutex::new(ScanMetadata::new(scan_filters(&params)?)));
            let (commands, incoming) = mpsc::channel();
            let (outgoing, events) = mpsc::channel();
            let stopped = Arc::new(AtomicBool::new(false));
            let gate = Arc::new(Gate {
                state: Mutex::new(GateState {
                    commands: incoming,
                    active: None,
                }),
                events: outgoing.clone(),
                metadata: metadata.clone(),
                stopped: stopped.clone(),
            });
            let config = config.clone();
            let worker_metadata = metadata.clone();
            let id = format!("{}-{}", self.instance, opaque_id());
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| reader_error("scan_state_error", "扫描注册表不可用"))?;
            if entries.len() == MAX_SCANS {
                return Err(reader_error("scan_quota", "最多保留 4 个扫描，请释放已完成的 scan_id"));
            }
            let thread = thread::Builder::new()
                .name("history-scan".to_string())
                .spawn(move || {
                    let control_gate = gate.clone();
                    let control = WorkControl::from_checkpoint(move |bytes| control_gate.checkpoint(bytes));
                    let result = control.run(|| scan_files(&config, params, &gate, &worker_metadata));
                    if let Ok(mut metadata) = worker_metadata.lock()
                        && let Err(error) = &result
                    {
                        metadata.phase = error.error.clone();
                        metadata.counts_exact = false;
                    }
                    let event = match result {
                        Ok(()) => Event::Done,
                        Err(error) => Event::Failed(error),
                    };
                    let _ = outgoing.send(event);
                })
                .map_err(|error| reader_error("scan_start_failed", error.to_string()))?;
            let driver = Arc::new(ScanEntry {
                commands: commands.clone(),
                stopped,
                driver: Mutex::new(Driver {
                    commands,
                    events,
                    thread: Some(thread),
                    metadata,
                    frozen_params,
                    last_access: Instant::now(),
                    sequence: 0,
                    cached: None,
                    pending: None,
                    done: false,
                    failure: None,
                }),
            });
            entries.insert(id.clone(), driver.clone());
            (id, 0, driver)
        };
        let mut guard = driver
            .driver
            .try_lock()
            .map_err(|_| reader_error("scan_busy", "同一 cursor 已有请求在执行"))?;
        if guard.last_access.elapsed() >= SCAN_TTL {
            return Err(reader_error("cursor_expired", "cursor 空闲超过 20 分钟"));
        }
        let mut replayed = false;
        let mut result = (|| {
            check_work()?;
            if cancelled() {
                return Err(reader_error("cancelled", "扫描已取消"));
            }
            let filters = request
                .explicit_filters
                .as_object()
                .ok_or_else(|| invalid_arguments("续查筛选参数格式无效"))?;
            if let Some(supplied) = supplied_params {
                check_frozen_filters(config, &guard.frozen_params, &supplied, filters)?;
            }
            if let Some((cached_sequence, cached_budget, response)) = &guard.cached
                && *cached_sequence == sequence
            {
                if *cached_budget != budget {
                    return Err(reader_error(
                        "cursor_replay_mismatch",
                        "最近返回页只支持按原 limit、max_total、scan_bytes 和 scan_ms 重放；调整预算请使用 next_query 的下一页 cursor",
                    ));
                }
                let response = response.clone();
                guard.last_access = Instant::now();
                replayed = true;
                return Ok(response);
            }
            if guard.sequence != sequence {
                return Err(reader_error("cursor_stale", "cursor 不再是下一页或最近返回页"));
            }
            guard.last_access = Instant::now();
            drive_page(&id, sequence, &mut guard, budget, cancelled.clone())
        })();
        if let Ok(response) = &result
            && !replayed
        {
            guard.cached = Some((sequence, budget, response.clone()));
            guard.sequence += 1;
        }
        let stopped = cancelled()
            || result
                .as_ref()
                .err()
                .is_some_and(|error| matches!(error.error.as_str(), "cancelled" | "deadline_exceeded"));
        if let Err(error) = &mut result {
            let mut available = match error.available.take() {
                Some(Value::Object(available)) => available,
                Some(value) => serde_json::Map::from_iter([("details".to_string(), value)]),
                None => serde_json::Map::new(),
            };
            available.insert("scan_id".to_string(), json!(id));
            available.insert("released".to_string(), json!(stopped));
            available.insert(
                "resume_possible".to_string(),
                json!(!stopped && guard.failure.is_none()),
            );
            if !stopped {
                available.insert("metadata_query".to_string(), json!({"scan_id":id}));
            }
            error.available = Some(Value::Object(available));
        }
        drop(guard);
        if stopped {
            self.release(&id)?;
        }
        result
    }

    pub fn release(&self, id: &str) -> Result<(), ErrorResponse> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描注册表不可用"))?
            .remove(id);
        if let Some(entry) = entry {
            entry.stop()?;
        }
        Ok(())
    }

    pub fn metadata(&self, request: MetadataRequest) -> Result<String, ErrorResponse> {
        check_work()?;
        self.prune()?;
        if !request.scan_id.starts_with(&format!("{}-", self.instance)) {
            return Err(reader_error(
                "cursor_instance_mismatch",
                "scan_id 不属于当前存活的 MCP 实例",
            ));
        }
        if request.release {
            if request.cursor.is_some() {
                return Err(invalid_arguments("release 不能和 metadata cursor 同时传入"));
            }
            self.release(&request.scan_id)?;
            return Ok(json!({"scan_id": request.scan_id, "released": true}).to_string());
        }
        if request.limit == 0
            || request.limit > 10_000
            || !(search::MIN_TOTAL_LIMIT..=search::MAX_TOTAL_LIMIT).contains(&request.max_total)
        {
            return Err(invalid_arguments(
                "metadata limit 必须为 1..10000，max_total 必须为 512..10000000",
            ));
        }
        let driver = self
            .entries
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描注册表不可用"))?
            .get(&request.scan_id)
            .cloned()
            .ok_or_else(|| reader_error("cursor_unavailable", "scan_id 已过期、释放或不存在"))?;
        let mut guard = driver
            .driver
            .try_lock()
            .map_err(|_| reader_error("scan_busy", "扫描正在执行，请在返回批次后读取 metadata"))?;
        guard.last_access = Instant::now();
        let metadata = guard
            .metadata
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描 metadata 不可用"))?;
        if !metadata.scan_complete && guard.failure.is_none() {
            return Err(reader_error(
                "scan_in_progress",
                "完整 metadata 的稳定分页需要先完成扫描",
            ));
        }
        let offset = if let Some(cursor) = &request.cursor {
            cursor
                .strip_prefix(&format!("meta:{}:", request.scan_id))
                .ok_or_else(|| invalid_arguments("metadata cursor 不属于指定 scan_id"))?
                .parse::<usize>()
                .map_err(|_| invalid_arguments("metadata cursor 位置无效"))?
        } else {
            0
        };
        let mut totals = BTreeMap::from([
            ("filters", 1),
            ("files", metadata.files.len()),
            ("issues", metadata.issues.len()),
            ("warnings", metadata.warnings.len()),
        ]);
        for name in ["by_project", "by_session", "by_type", "by_server", "by_tool", "by_day"] {
            totals.insert(name, metadata.summary.get(name).map_or(0, BTreeMap::len));
        }
        let total: usize = totals.values().sum();
        if offset > total {
            return Err(invalid_arguments("metadata cursor 超出总条目数"));
        }
        let next_query = |position: usize| json!({"scan_id": request.scan_id, "cursor": format!("meta:{}:{position}", request.scan_id), "limit": request.limit, "max_total": request.max_total});
        let make_response = |items: &[Value], dimensions: BTreeMap<&str, Value>, budgeting: bool| {
            let has_more = budgeting || offset + items.len() < total;
            json!({"scan_id": request.scan_id, "scan_complete": metadata.scan_complete,
                "counts_exact": metadata.counts_exact && metadata.scan_complete, "attribution_complete": metadata.counters.attribution_issues == 0,
                "stats":metadata.counters, "offset":offset, "total":total, "returned":if budgeting { request.limit } else { items.len() },
                "omitted":if budgeting { total } else { total - items.len() }, "remaining":if budgeting { total } else { total - offset - items.len() },
                "dimensions":dimensions, "items":items, "has_more":has_more,
                "next_query":if has_more { Some(next_query(offset + if budgeting { request.limit } else { items.len() })) } else { None }})
        };
        let dimension_budget = totals
            .iter()
            .map(|(name, count)| (*name, json!({"total":count, "returned":count, "omitted":count})))
            .collect();
        let fixed_size = make_response(&[], dimension_budget, true).to_string().len();
        let mut items = Vec::new();
        let mut returned = BTreeMap::<&str, usize>::new();
        let mut used = fixed_size;
        let entries = std::iter::once(("filters", metadata.filters.clone()))
            .chain(
                metadata
                    .files
                    .iter()
                    .map(|file| ("files", serde_json::to_value(file).expect("coverage serializable"))),
            )
            .chain(metadata.summary.iter().flat_map(|(dimension, buckets)| {
                buckets.iter().map(move |(key, count)| {
                    (
                        dimension.as_str(),
                        json!({"dimension": dimension, "key": key, "count": count}),
                    )
                })
            }))
            .chain(metadata.issues.iter().cloned().map(|issue| ("issues", issue)))
            .chain(
                metadata
                    .warnings
                    .iter()
                    .map(|warning| ("warnings", json!({"warning": warning}))),
            );
        for (dimension, value) in entries.skip(offset) {
            let item = json!({"kind":dimension, "value":value});
            let size = item.to_string().len() + 1;
            if used + size > request.max_total || items.len() == request.limit {
                if items.is_empty() {
                    let required = used + size;
                    let mut query = next_query(offset);
                    query["max_total"] = json!(required.saturating_add(64).min(search::MAX_TOTAL_LIMIT));
                    return Err(ErrorResponse {
                        error: "response_too_large".to_string(),
                        message: "metadata 单条与固定字段超过预算；条目没有被消费".to_string(),
                        available: Some(
                            json!({"required_bytes":required, "max_total_bytes":request.max_total, "next_query":query}),
                        ),
                    });
                }
                break;
            }
            used += size;
            *returned.entry(dimension).or_default() += 1;
            items.push(item);
        }
        let dimensions = totals
            .iter()
            .map(|(name, count)| {
                let returned = returned.get(name).copied().unwrap_or(0);
                (
                    *name,
                    json!({"total":count, "returned":returned, "omitted":count - returned}),
                )
            })
            .collect();
        let text = make_response(&items, dimensions, false).to_string();
        if text.len() > request.max_total {
            return Err(reader_error(
                "response_too_large",
                "metadata 固定字段超过预算，请提高 max_total；条目没有被消费",
            ));
        }
        Ok(text)
    }
}

fn page_value(
    id: &str,
    sequence: u64,
    driver: &Driver,
    results: &[SearchResult],
    budget: PageBudget,
) -> Result<Value, ErrorResponse> {
    let metadata = driver
        .metadata
        .lock()
        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
    let has_more = !driver.done || driver.pending.is_some();
    let mut next = search::build_next_query(&driver.frozen_params, 0);
    let values = next.as_object_mut().expect("scan query");
    values.remove("offset");
    for (key, value) in [
        ("mode", json!("scan")),
        ("cursor", json!(format!("{id}:{}", sequence + 1))),
        ("max_total", json!(budget.max_total)),
        ("limit", json!(budget.limit)),
        ("scan_bytes", json!(budget.bytes)),
        ("scan_ms", json!(budget.milliseconds)),
    ] {
        values.insert(key.to_string(), value);
    }
    let mut stats =
        serde_json::to_value(&metadata.counters).map_err(|error| reader_error("serialize_error", error.to_string()))?;
    stats["returned_count"] = json!(metadata.counters.returned_count + results.len());
    Ok(
        json!({"scan_id": id, "page": sequence, "phase": metadata.phase, "scan_complete": metadata.scan_complete,
        "counts_exact": metadata.counts_exact && metadata.scan_complete, "attribution_complete": metadata.counters.attribution_issues == 0,
        "stats": stats, "results": results, "has_more": has_more, "max_total_bytes": budget.max_total,
        "next_query": if has_more { Some(next) } else { None },
        "metadata_query": {"scan_id": id}}),
    )
}

fn drive_page(
    id: &str,
    sequence: u64,
    driver: &mut Driver,
    budget: PageBudget,
    cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<String, ErrorResponse> {
    let PageBudget {
        max_total,
        limit,
        bytes,
        milliseconds,
    } = budget;
    if let Some(failure) = &driver.failure {
        return Err(ErrorResponse {
            error: failure.error.clone(),
            message: failure.message.clone(),
            available: failure.available.clone(),
        });
    }
    let snapshot = driver
        .metadata
        .lock()
        .map_err(|_| reader_error("scan_state_error", "扫描统计锁不可用"))?
        .active_source
        .clone();
    if let Some(snapshot) = snapshot
        && let Err(error) = snapshot_file(&snapshot)
    {
        let _ = driver.commands.send(Command::Stop);
        if let Some(worker) = driver.thread.take() {
            worker
                .join()
                .map_err(|_| reader_error("scan_state_error", "扫描工作线程异常结束"))?;
        }
        driver.failure = Some(ErrorResponse {
            error: error.error.clone(),
            message: error.message.clone(),
            available: error.available.clone(),
        });
        let mut metadata = driver
            .metadata
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描统计锁不可用"))?;
        metadata.counts_exact = false;
        metadata.phase = error.error.clone();
        return Err(error);
    }
    let mut results = Vec::new();
    let mut serialized_rows = 0;
    let mut grant_sent = false;
    loop {
        check_work()?;
        if cancelled() {
            let _ = driver.commands.send(Command::Stop);
            return Err(reader_error("cancelled", "扫描已取消，扫描状态将释放"));
        }
        let row = if let Some(row) = driver.pending.take() {
            Some(row)
        } else if driver.done {
            None
        } else {
            if !grant_sent {
                driver
                    .commands
                    .send(Command::Batch(Batch {
                        bytes,
                        deadline: Instant::now() + Duration::from_millis(milliseconds),
                        cancelled: cancelled.clone(),
                    }))
                    .map_err(|_| reader_error("scan_stopped", "扫描工作线程已结束"))?;
                grant_sent = true;
            }
            loop {
                check_work()?;
                if cancelled() {
                    let _ = driver.commands.send(Command::Stop);
                    return Err(reader_error("cancelled", "扫描已取消"));
                }
                match driver.events.recv_timeout(Duration::from_millis(20)) {
                    Ok(Event::Row(row)) => break Some(*row),
                    Ok(Event::Yield) => break None,
                    Ok(Event::Done) => {
                        driver.done = true;
                        break None;
                    }
                    Ok(Event::Failed(error)) => {
                        let copied = ErrorResponse {
                            error: error.error.clone(),
                            message: error.message.clone(),
                            available: error.available.clone(),
                        };
                        driver.failure = Some(error);
                        return Err(copied);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err(reader_error("scan_stopped", "扫描线程没有返回结束状态"));
                    }
                }
            }
        };
        let Some(row) = row else {
            break;
        };
        let row_size = serde_json::to_vec(&row)
            .map_err(|error| reader_error("serialize_error", error.to_string()))?
            .len()
            + 1;
        let fixed_size = page_value(id, sequence, driver, &[], budget)?.to_string().len() + 128;
        if fixed_size + serialized_rows + row_size > max_total {
            driver.pending = Some(row);
            if results.is_empty() {
                return Err(ErrorResponse {
                    error: "response_too_large".to_string(),
                    message: "当前记录和固定字段超过响应预算；记录没有被丢弃".to_string(),
                    available: Some(
                        json!({"required_bytes": fixed_size + row_size, "max_total_bytes": max_total, "next_query": {"mode":"scan", "cursor":format!("{id}:{sequence}"), "max_total": (fixed_size + row_size).saturating_add(64).min(search::MAX_TOTAL_LIMIT), "limit":limit, "scan_bytes":bytes, "scan_ms":milliseconds}}),
                    ),
                });
            }
            break;
        }
        serialized_rows += row_size;
        results.push(row);
        if results.len() == limit {
            break;
        }
        if !driver.done {
            if grant_sent {
                driver
                    .commands
                    .send(Command::Next)
                    .map_err(|_| reader_error("scan_stopped", "扫描线程已结束"))?;
            } else {
                driver
                    .commands
                    .send(Command::Batch(Batch {
                        bytes,
                        deadline: Instant::now() + Duration::from_millis(milliseconds),
                        cancelled: cancelled.clone(),
                    }))
                    .map_err(|_| reader_error("scan_stopped", "扫描线程已结束"))?;
                grant_sent = true;
            }
        }
    }
    let response = page_value(id, sequence, driver, &results, budget)?.to_string();
    if response.len() > max_total {
        return Err(ErrorResponse {
            error: "response_too_large".to_string(),
            message: "扫描固定字段超过预算，请按 next_query 提高 max_total；本页未消费".to_string(),
            available: Some(
                json!({"required_bytes":response.len(), "max_total_bytes":max_total, "next_query":{"mode":"scan", "cursor":format!("{id}:{sequence}"), "max_total":response.len().saturating_add(64).min(search::MAX_TOTAL_LIMIT), "limit":limit, "scan_bytes":bytes, "scan_ms":milliseconds}}),
            ),
        });
    }
    driver
        .metadata
        .lock()
        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?
        .counters
        .returned_count += results.len();
    Ok(response)
}

#[derive(Clone)]
struct Snapshot {
    project: String,
    session: String,
    path: PathBuf,
    metadata: Metadata,
    source: String,
}
fn snapshot_file(snapshot: &Snapshot) -> Result<std::fs::File, ErrorResponse> {
    let file = open_session_file(&snapshot.path)
        .map_err(|error| reader_error("source_changed", format!("{}: {error}", snapshot.source)))?;
    let metadata = file
        .metadata()
        .map_err(|error| reader_error("source_changed", error.to_string()))?;
    if !crate::session_files::matches_snapshot(&snapshot.metadata, &metadata) {
        return Err(reader_error(
            "source_changed",
            format!("{} 已替换、截短或修改，扫描快照失效", snapshot.source),
        ));
    }
    Ok(file)
}

fn scan_files(
    config: &Config,
    params: SearchParams,
    gate: &Gate,
    shared: &Arc<Mutex<ScanMetadata>>,
) -> Result<(), ErrorResponse> {
    check_work()?;
    let inputs = search::prepare_search_inputs(config, &params)?;
    let files = inputs.files;
    let mut snapshots = Vec::with_capacity(files.len());
    for (project, session, path) in files {
        check_work()?;
        let file = open_session_file(&path)
            .map_err(|error| reader_error("source_unavailable", format!("{}: {error}", path.display())))?;
        let metadata = file
            .metadata()
            .map_err(|error| reader_error("source_unavailable", error.to_string()))?;
        let source = path.to_string_lossy().to_string();
        let mut scan = shared
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
        scan.reserve(source.len() + project.len() + session.len() + 256)?;
        scan.files.push(FileCoverage {
            project: project.clone(),
            session: session.clone(),
            source: source.clone(),
            snapshot_bytes: metadata.len(),
            status: "pending".to_string(),
            lines: 0,
        });
        snapshots.push(Snapshot {
            project,
            session,
            path,
            metadata,
            source,
        });
    }
    {
        let mut metadata = shared
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
        metadata.counters.files_total = snapshots.len();
        metadata.phase = "records".to_string();
        for warning in &params.warnings {
            metadata.reserve(warning.len() + 32)?;
            metadata.warnings.push(warning.clone());
        }
    }
    let pattern = inputs.search_pattern;
    for (file_index, snapshot) in snapshots.iter().enumerate() {
        check_work()?;
        let file = snapshot_file(snapshot)?;
        let mut lines = RecordLines::new(file, snapshot.metadata.len());
        let mut tracker = ToolAssociationTracker::default();
        {
            let mut metadata = shared
                .lock()
                .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
            metadata.files[file_index].status = "scanning".to_string();
            metadata.active_source = Some(snapshot.clone());
        }
        loop {
            let mut remaining = u64::MAX;
            let located = match lines.step(&mut remaining, Instant::now() + Duration::from_secs(120))? {
                LineStep::Record(record) => record,
                LineStep::Yield => continue,
                LineStep::End => break,
            };
            {
                let mut metadata = shared
                    .lock()
                    .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
                metadata.counters.lines_scanned += 1;
                metadata.files[file_index].lines += 1;
            }
            let mut attribution = Vec::new();
            let parsed_result = (|| {
                let result = if let Some(line) = located.small {
                    let parsed = std::str::from_utf8(&line)
                        .map_err(|_| reader_error("invalid_utf8", "JSONL UTF-8 无效"))
                        .and_then(|line| {
                            parse_message_record(line).map_err(|_| reader_error("parse_error", "JSONL 格式无效"))
                        });
                    match parsed {
                        Ok(Some(record)) => {
                            if tool_block_count(&record) > MAX_TOOL_BLOCKS {
                                return Err(reader_error("tool_blocks_cap", "单条消息工具块超出 2048"));
                            }
                            let blocks = tracker.observe_record(&record, params.tool_payload_errors);
                            if !line_in_ranges(located.line, &params.lines) {
                                Ok(None)
                            } else {
                                if time_in_range(&record.timestamp, params.since.as_ref(), params.until.as_ref())
                                    == TimeRangeMatch::UnparseableTimestamp
                                {
                                    let mut metadata = shared
                                        .lock()
                                        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
                                    metadata.counters.invalid_timestamps += 1;
                                    metadata.issue(
                                        &snapshot.project,
                                        &snapshot.session,
                                        &snapshot.source,
                                        located.line,
                                        "invalid_timestamp",
                                        false,
                                    )?;
                                }
                                let prefix = ref_prefix(&snapshot.session);
                                let result = search::build_search_result(
                                    &RecordBuildContext {
                                        project_id: &snapshot.project,
                                        session_id: &snapshot.session,
                                        source: &snapshot.path,
                                        prefix: &prefix,
                                        params: &params,
                                        regex: None,
                                        pattern: pattern.as_ref(),
                                    },
                                    located.line,
                                    record,
                                    &blocks,
                                    &mut attribution,
                                )?;
                                record_issues(shared, snapshot, located.line, &blocks, &params, Some(&attribution))?;
                                Ok(result)
                            }
                        }
                        Ok(None) => Ok(None),
                        Err(error) => Err(error),
                    }
                } else {
                    shared
                        .lock()
                        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?
                        .counters
                        .oversized_records += 1;
                    indexed_result(
                        snapshot,
                        located.span,
                        located.line,
                        &params,
                        pattern.as_ref(),
                        &mut tracker,
                        shared,
                    )
                }?;
                if tracker.pending_len() > MAX_TOOL_BLOCKS || tracker.pending_bytes() > MAX_TOOL_PENDING_BYTES {
                    return Err(reader_error(
                        "tool_pending_cap",
                        "未配对工具调用超出有界状态容量，请按会话分别调查",
                    ));
                }
                Ok(result)
            })();
            let result = match parsed_result {
                Ok(result) => result,
                Err(error) if matches!(error.error.as_str(), "parse_error" | "invalid_utf8") => {
                    let mut metadata = shared
                        .lock()
                        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
                    metadata.counters.invalid_records += 1;
                    metadata.issue(
                        &snapshot.project,
                        &snapshot.session,
                        &snapshot.source,
                        located.line,
                        &error.error,
                        false,
                    )?;
                    None
                }
                Err(mut error) => {
                    let mut available = match error.available.take() {
                        Some(Value::Object(available)) => available,
                        Some(value) => serde_json::Map::from_iter([("details".to_string(), value)]),
                        None => serde_json::Map::new(),
                    };
                    for (key, value) in [
                        ("project", json!(snapshot.project)),
                        ("session", json!(snapshot.session)),
                        ("source", json!(snapshot.source)),
                        ("ref", json!(format!("{}:{}", snapshot.session, located.line))),
                        ("line", json!(located.line)),
                        ("byte_start", json!(located.span.start)),
                        ("byte_end", json!(located.span.end)),
                    ] {
                        available.insert(key.to_string(), value);
                    }
                    error.available = Some(Value::Object(available));
                    return Err(error);
                }
            };
            if let Some(mut result) = result {
                result.source = Some(snapshot.source.clone());
                result.r#ref = format!("{}:{}", snapshot.session, located.line);
                let maximum = if result.subtype == "tool_result" {
                    params.max_content_tool_result
                } else {
                    params.max_content
                };
                let (preview, truncated) = truncate_around_match(&result.content, result.match_pos, maximum);
                result.content = preview;
                result.truncated |= truncated;
                shared
                    .lock()
                    .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?
                    .count_match(&result)?;
                if !params.aggregate {
                    gate.row(result)?;
                }
            }
        }
        let current = open_session_file(&snapshot.path)
            .map_err(|error| reader_error("source_changed", error.to_string()))?
            .metadata()
            .map_err(|error| reader_error("source_changed", error.to_string()))?;
        if !crate::session_files::matches_snapshot(&snapshot.metadata, &current) {
            return Err(reader_error(
                "source_changed",
                format!("{} 扫描期间已替换、截短或修改", snapshot.source),
            ));
        }
        let mut metadata = shared
            .lock()
            .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
        metadata.counters.files_scanned += 1;
        metadata.files[file_index].status = "complete".to_string();
        metadata.active_source = None;
    }
    let mut metadata = shared
        .lock()
        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
    metadata.scan_complete = true;
    metadata.phase = "complete".to_string();
    Ok(())
}

fn record_issues(
    shared: &Arc<Mutex<ScanMetadata>>,
    snapshot: &Snapshot,
    line: usize,
    blocks: &[AssociatedToolBlock],
    params: &SearchParams,
    reasons: Option<&[String]>,
) -> Result<(), ErrorResponse> {
    for block in blocks {
        if (!params.failed_tool_results || block.result_is_error == Some(true))
            && (!params.tool_payload_errors || block.result_has_error_payload == Some(true))
            && let Some(reason) = &block.metadata_incomplete_reason
            && reasons.is_none_or(|reasons| reasons.contains(reason))
        {
            let mut metadata = shared
                .lock()
                .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
            metadata.issue(
                &snapshot.project,
                &snapshot.session,
                &snapshot.source,
                line,
                reason,
                true,
            )?;
            if !params.servers.is_empty() || !params.tools.is_empty() {
                metadata.counts_exact = false;
            }
        }
    }
    Ok(())
}

fn indexed_result(
    snapshot: &Snapshot,
    span: SourceSpan,
    line: usize,
    params: &SearchParams,
    pattern: Option<&SearchPattern>,
    tracker: &mut ToolAssociationTracker,
    shared: &Arc<Mutex<ScanMetadata>>,
) -> Result<Option<SearchResult>, ErrorResponse> {
    let mut attribution = Vec::new();
    let mut invalid_timestamps = 0;
    let result = search::build_indexed_search_result(
        &RecordBuildContext {
            project_id: &snapshot.project,
            session_id: &snapshot.session,
            source: &snapshot.path,
            prefix: &ref_prefix(&snapshot.session),
            params,
            regex: None,
            pattern,
        },
        span,
        line,
        || snapshot_file(snapshot),
        tracker,
        &mut attribution,
        &mut invalid_timestamps,
    )?;
    let mut metadata = shared
        .lock()
        .map_err(|_| reader_error("scan_state_error", "扫描统计不可用"))?;
    metadata.counters.invalid_timestamps += invalid_timestamps;
    if invalid_timestamps > 0 {
        metadata.issue(
            &snapshot.project,
            &snapshot.session,
            &snapshot.source,
            line,
            "invalid_timestamp",
            false,
        )?;
    }
    for reason in attribution {
        metadata.issue(
            &snapshot.project,
            &snapshot.session,
            &snapshot.source,
            line,
            &reason,
            true,
        )?;
        if !params.servers.is_empty() || !params.tools.is_empty() {
            metadata.counts_exact = false;
        }
    }
    Ok(result)
}

const MAX_CATALOG_BYTES: u64 = 128 * 1024 * 1024;

pub struct SourcesRequest {
    pub params: SearchParams,
    pub cursor: Option<String>,
    pub release: bool,
    pub explicit_filters: Value,
}

struct SourceCatalog {
    directory: PathBuf,
    file: Option<std::fs::File>,
    params: SearchParams,
    bytes: u64,
    count: usize,
    offset: u64,
    returned: usize,
    sequence: u64,
    last_access: Instant,
    memory_bytes: usize,
    cached: Option<(u64, usize, usize, String)>,
}
impl Drop for SourceCatalog {
    fn drop(&mut self) {
        self.file.take();
        if let Err(error) = std::fs::remove_dir_all(&self.directory) {
            eprintln!("来源目录清理失败 {}: {error}", self.directory.display());
        }
    }
}

fn catalog_root() -> Result<PathBuf, ErrorResponse> {
    let root = std::env::temp_dir().join("mcp-history-sources-v1");
    match std::fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(reader_error("sources_io_error", error.to_string())),
    }
    crate::get::checked_temp_directory(&root).map_err(|error| reader_error("sources_io_error", error))?;
    set_private_permissions(&root, 0o700)?;
    for item in std::fs::read_dir(&root).map_err(|error| reader_error("sources_io_error", error.to_string()))? {
        let item = item.map_err(|error| reader_error("sources_io_error", error.to_string()))?;
        let name = item.file_name().to_string_lossy().to_string();
        let Some(pid) = name
            .strip_prefix("catalog-")
            .and_then(|name| name.split('-').next())
            .and_then(|pid| pid.parse().ok())
        else {
            continue;
        };
        let Ok(metadata) = crate::get::checked_temp_directory(&item.path()) else {
            continue;
        };
        if std::fs::metadata(item.path().join("sources.jsonl"))
            .unwrap_or(metadata)
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= SCAN_TTL)
            && crate::get::process_is_gone(pid)
            && std::fs::read_to_string(item.path().join(".owner")).ok().as_deref() == Some(&name)
        {
            std::fs::remove_dir_all(item.path())
                .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
        }
    }
    Ok(root)
}

fn catalog_store() -> Arc<Mutex<BTreeMap<String, SourceCatalog>>> {
    let store = Arc::new(Mutex::new(BTreeMap::<String, SourceCatalog>::new()));
    let weak = Arc::downgrade(&store);
    let _ = thread::Builder::new()
        .name("history-source-expiry".to_string())
        .spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(30));
                let Some(store) = weak.upgrade() else {
                    break;
                };
                let Ok(mut catalogs) = store.lock() else {
                    break;
                };
                catalogs.retain(|_, catalog| catalog.last_access.elapsed() < SCAN_TTL);
            }
        });
    store
}

impl ScanStore {
    pub fn sources(&self, config: &Config, request: SourcesRequest) -> Result<String, ErrorResponse> {
        use std::io::{BufRead, Seek, SeekFrom, Write};
        let mut catalogs = self
            .catalogs
            .lock()
            .map_err(|_| reader_error("sources_state_error", "来源目录状态不可用"))?;
        catalogs.retain(|_, catalog| catalog.last_access.elapsed() < SCAN_TTL);
        let (id, sequence) = if let Some(cursor) = &request.cursor {
            let (id, sequence) = cursor
                .rsplit_once(':')
                .ok_or_else(|| invalid_arguments("sources cursor 格式无效"))?;
            if !id.starts_with(&format!("{}-sources-", self.instance)) {
                return Err(reader_error(
                    "cursor_instance_mismatch",
                    "来源目录 cursor 不属于当前实例",
                ));
            }
            (
                id.to_string(),
                sequence
                    .parse::<u64>()
                    .map_err(|_| invalid_arguments("sources cursor 页号无效"))?,
            )
        } else {
            if request.release {
                return Err(invalid_arguments("sources release 需要 cursor"));
            }
            let params = prepare_scan_params(config, request.params.clone())?;
            if params.use_regex
                || params.slice.is_some()
                || params.offset != 0
                || params.output.is_some()
                || params.dry_run
            {
                return Err(invalid_arguments(
                    "sources 不支持 regex、slice、offset、output 或 dry_run；正文筛选保留在 scan_query",
                ));
            }
            if catalogs.len() >= MAX_SCANS {
                return Err(reader_error("sources_quota", "最多保留 4 个来源目录，请 release"));
            }
            let root = catalog_root()?;
            let name = format!("catalog-{}-{}", std::process::id(), opaque_id());
            let directory = root.join(&name);
            std::fs::create_dir(&directory).map_err(|error| reader_error("sources_io_error", error.to_string()))?;
            let created = (|| {
                set_private_permissions(&directory, 0o700)?;
                let mut owner = open_private_output_file(&directory.join(".owner"))?;
                owner
                    .write_all(name.as_bytes())
                    .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
                let path = directory.join("sources.jsonl");
                drop(open_private_output_file(&path)?);
                let file = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
                Ok::<_, ErrorResponse>(SourceCatalog {
                    directory: directory.clone(),
                    file: Some(file),
                    params: params.clone(),
                    bytes: 0,
                    count: 0,
                    offset: 0,
                    returned: 0,
                    sequence: 0,
                    last_access: Instant::now(),
                    memory_bytes: scan_filters(&params)?
                        .to_string()
                        .len()
                        .saturating_mul(2)
                        .saturating_add(4096),
                    cached: None,
                })
            })();
            let mut catalog = match created {
                Ok(catalog) => catalog,
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&directory);
                    return Err(error);
                }
            };
            let remaining = MAX_CATALOG_BYTES.saturating_sub(catalogs.values().map(|catalog| catalog.bytes).sum());
            let mut append = |file: crate::session_files::SessionFile| -> Result<(), ErrorResponse> {
                check_work()?;
                let mut line =
                    serde_json::to_vec(&file).map_err(|error| reader_error("serialize_error", error.to_string()))?;
                line.push(b'\n');
                if line.len() as u64 > remaining.saturating_sub(catalog.bytes) {
                    return Err(ErrorResponse {
                        error: "sources_disk_quota".to_string(),
                        message: "来源目录总存储超过 128 MiB，未发布清单".to_string(),
                        available: Some(
                            json!({"max_bytes":MAX_CATALOG_BYTES,"files_enumerated":catalog.count,"bytes_written":catalog.bytes,"enumeration_complete":false,"body_scan_started":false}),
                        ),
                    });
                }
                catalog
                    .file
                    .as_mut()
                    .expect("catalog file")
                    .write_all(&line)
                    .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
                catalog.bytes += line.len() as u64;
                catalog.count += 1;
                Ok(())
            };
            let enumeration = (|| {
                if params.source.is_some() || !params.sources.is_empty() {
                    for file in search::prepare_search_inputs(config, &params)?.files {
                        append(file)?;
                    }
                } else {
                    let projects = search::get_project_dirs(config, &params)?;
                    crate::session_files::visit_session_files(&projects, &params.sessions, params.subagents, append)?;
                }
                Ok::<_, ErrorResponse>(())
            })();
            if let Err(mut error) = enumeration {
                let available = error.available.get_or_insert_with(|| json!({}));
                available["files_enumerated"] = json!(catalog.count);
                available["enumeration_complete"] = json!(false);
                available["body_scan_started"] = json!(false);
                available["published"] = json!(false);
                available["consumed_sources"] = json!(0);
                return Err(error);
            }
            catalog
                .file
                .as_mut()
                .expect("catalog file")
                .sync_all()
                .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
            let id = format!("{}-sources-{}", self.instance, opaque_id());
            catalogs.insert(id.clone(), catalog);
            (id, 0)
        };
        if request.release {
            catalogs.remove(&id);
            return Ok(json!({"sources_id":id,"released":true}).to_string());
        }
        let memory_used = catalogs
            .values()
            .map(|catalog| catalog.memory_bytes + catalog.cached.as_ref().map_or(0, |cached| cached.3.len()))
            .sum::<usize>();
        let catalog = catalogs
            .get_mut(&id)
            .ok_or_else(|| reader_error("cursor_unavailable", "来源目录已过期、释放或不存在"))?;
        let result = (|| {
            check_work()?;
            let keys = request
                .explicit_filters
                .as_object()
                .ok_or_else(|| invalid_arguments("sources 筛选格式无效"))?;
            check_frozen_filters(config, &catalog.params, &request.params, keys)?;
            let limit = request.params.limit.unwrap_or(128);
            let maximum = request.params.max_total;
            if !(1..=128).contains(&limit) || !(search::MIN_TOTAL_LIMIT..=search::MAX_TOTAL_LIMIT).contains(&maximum) {
                return Err(invalid_arguments("sources limit 为 1..128；max_total 为 512..10000000"));
            }
            catalog.last_access = Instant::now();
            catalog
                .file
                .as_ref()
                .expect("catalog file")
                .set_modified(SystemTime::now())
                .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
            if let Some((cached, old_limit, old_maximum, page)) = &catalog.cached
                && *cached == sequence
            {
                if *old_limit != limit || *old_maximum != maximum {
                    return Err(reader_error("cursor_replay_mismatch", "来源目录最近页重放需要相同预算"));
                }
                return Ok(page.clone());
            }
            if sequence != catalog.sequence {
                return Err(reader_error("cursor_stale", "来源目录 cursor 不是下一页或最近页"));
            }
            catalog
                .file
                .as_mut()
                .expect("catalog file")
                .seek(SeekFrom::Start(catalog.offset))
                .map_err(|error| reader_error("sources_io_error", error.to_string()))?;
            let mut input = std::io::BufReader::new(catalog.file.as_ref().expect("catalog file"));
            let mut items = Vec::new();
            let mut sources = Vec::new();
            let mut offset = catalog.offset;
            let mut response = String::new();
            for _ in 0..limit {
                let mut line = String::new();
                if input
                    .read_line(&mut line)
                    .map_err(|error| reader_error("sources_io_error", error.to_string()))?
                    == 0
                {
                    break;
                }
                let (project, session, source): (String, String, String) =
                    serde_json::from_str(&line).map_err(|error| reader_error("sources_io_error", error.to_string()))?;
                sources.push(source.clone());
                items.push(json!({"project":project,"session":session,"source":source}));
                let mut query = search::build_next_query(&catalog.params, 0);
                query["mode"] = json!("scan");
                query["sources"] = json!(sources);
                query.as_object_mut().expect("query").remove("source");
                query.as_object_mut().expect("query").remove("offset");
                let mut next = search::build_next_query(&catalog.params, 0);
                next["mode"] = json!("sources");
                next["cursor"] = json!(format!("{id}:{}", sequence + 1));
                next["limit"] = json!(limit);
                next["max_total"] = json!(maximum);
                next.as_object_mut().expect("query").remove("offset");
                let consumed = catalog.returned + items.len();
                let page = json!({"mode":"sources","sources_id":id,"enumeration_complete":true,"body_scan_started":false,"files_total":catalog.count,"catalog_bytes":catalog.bytes,"max_catalog_bytes":MAX_CATALOG_BYTES,"source_progress":{"start":catalog.returned,"end":consumed},"items":items,"scan_query":query,"has_more":consumed < catalog.count,"next_query":if consumed < catalog.count {Some(next)} else {None},"release_query":{"mode":"sources","cursor":format!("{id}:{}",sequence+1),"release":true}}).to_string();
                if page.len() > maximum {
                    items.pop();
                    sources.pop();
                    if response.is_empty() {
                        return Err(ErrorResponse {
                            error: "response_too_large".to_string(),
                            message: "来源目录首项超过预算，本页未消费".to_string(),
                            available: Some(
                                json!({"required_bytes":page.len(),"next_query":{"mode":"sources","cursor":format!("{id}:{sequence}"),"limit":limit,"max_total":page.len().saturating_add(64)}}),
                            ),
                        });
                    }
                    break;
                }
                response = page;
                offset += line.len() as u64;
            }
            if response.is_empty() {
                response = json!({"mode":"sources","sources_id":id,"enumeration_complete":true,"body_scan_started":false,"files_total":catalog.count,"catalog_bytes":catalog.bytes,"items":[],"scan_query":null,"has_more":false,"next_query":null,"release_query":{"mode":"sources","cursor":format!("{id}:{}",sequence+1),"release":true}}).to_string();
                if response.len() > maximum {
                    return Err(reader_error("response_too_large", "来源目录固定字段超过预算"));
                }
            }
            let memory = memory_used
                .saturating_sub(catalog.cached.as_ref().map_or(0, |cached| cached.3.len()))
                .saturating_add(response.len());
            if memory > MAX_METADATA_BYTES {
                return Err(reader_error(
                    "sources_memory_quota",
                    "来源目录内存状态超过 32 MiB，本页未消费；请释放其他目录",
                ));
            }
            catalog.offset = offset;
            catalog.returned += items.len();
            catalog.sequence += 1;
            catalog.cached = Some((sequence, limit, maximum, response.clone()));
            Ok(response)
        })();
        let consumed_sources = catalog.returned;
        let failed = result.as_ref().err().is_some_and(|error| {
            matches!(
                error.error.as_str(),
                "cancelled" | "deadline_exceeded" | "sources_io_error" | "sources_memory_quota"
            )
        });
        let mut result = result;
        if let Err(error) = &mut result {
            let available = error.available.get_or_insert_with(|| json!({}));
            available["sources_id"] = json!(id);
            available["consumed_sources"] = json!(consumed_sources);
            available["released"] = json!(failed);
            available["enumeration_complete"] = json!(true);
            if !failed {
                available["release_query"] =
                    json!({"mode":"sources","cursor":format!("{id}:{sequence}"),"release":true});
            }
        }
        if failed {
            catalogs.remove(&id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::{BufWriter, Write};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Fixture {
        root: PathBuf,
        config: Config,
        source: PathBuf,
        owner: String,
    }
    impl Fixture {
        fn new(records: impl IntoIterator<Item = Value>) -> Self {
            let owner = opaque_id();
            let root = std::env::temp_dir().join(format!("history-scan-test-{owner}"));
            fs::create_dir(&root).unwrap();
            fs::write(root.join(".history-scan-test-owner"), &owner).unwrap();
            let projects_dir = root.join("projects");
            let project_dir = projects_dir.join("-scan-fixture");
            fs::create_dir_all(&project_dir).unwrap();
            let source = project_dir.join("scan-session-main.jsonl");
            let mut output = BufWriter::new(fs::File::create(&source).unwrap());
            for record in records {
                serde_json::to_writer(&mut output, &record).unwrap();
                output.write_all(b"\n").unwrap();
            }
            output.flush().unwrap();
            Self {
                root,
                config: Config { projects_dir },
                source,
                owner,
            }
        }
        fn request(&self) -> ScanRequest {
            ScanRequest {
                params: SearchParams {
                    projects: vec!["-scan-fixture".to_string()],
                    limit: Some(1000),
                    max_total: 1_000_000,
                    ..SearchParams::default()
                },
                cursor: None,
                scan_bytes: Some(1024 * 1024),
                scan_ms: Some(1000),
                explicit_filters: json!({}),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if fs::read_to_string(self.root.join(".history-scan-test-owner"))
                .ok()
                .as_deref()
                == Some(self.owner.as_str())
            {
                fs::remove_dir_all(&self.root).unwrap();
            }
        }
    }
    fn human(content: impl Into<String>) -> Value {
        json!({"type":"user", "uuid":"repeated-uuid", "timestamp":"2026-10-01T00:00:00Z", "message":{"role":"user", "content":content.into()}})
    }
    fn next_request(page: &Value) -> ScanRequest {
        let query = &page["next_query"];
        ScanRequest {
            params: SearchParams {
                limit: Some(query["limit"].as_u64().unwrap() as usize),
                max_total: query["max_total"].as_u64().unwrap() as usize,
                ..SearchParams::default()
            },
            cursor: Some(query["cursor"].as_str().unwrap().to_string()),
            scan_bytes: query["scan_bytes"].as_u64(),
            scan_ms: query["scan_ms"].as_u64(),
            explicit_filters: json!({}),
        }
    }
    fn page(store: &ScanStore, fixture: &Fixture, request: ScanRequest) -> Value {
        let maximum = request.params.max_total;
        let response = store.search(&fixture.config, request, Arc::new(|| false)).unwrap();
        assert!(response.len() <= maximum);
        serde_json::from_str(&response).unwrap()
    }
    fn finish(store: &ScanStore, fixture: &Fixture, mut current: Value) -> (Value, Vec<Value>, usize) {
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut rows = Vec::new();
        let mut empty = 0;
        loop {
            assert!(Instant::now() < deadline, "扫描续页未能结束");
            let batch = current["results"].as_array().unwrap();
            if batch.is_empty() && current["has_more"] == true {
                empty += 1;
            }
            rows.extend_from_slice(batch);
            if current["has_more"] == false {
                return (current, rows, empty);
            }
            current = page(store, fixture, next_request(&current));
        }
    }

    #[test]
    fn source_catalog_quota_cancellation_and_access_renewal_keep_boundaries() {
        let fixture = Fixture::new([human("quota")]);
        let store = ScanStore::default();
        let params = SearchParams {
            projects: vec!["-scan-fixture".into()],
            max_total: 20000,
            ..SearchParams::default()
        };
        let first: Value = serde_json::from_str(
            &store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: None,
                        release: false,
                        explicit_filters: json!({}),
                    },
                )
                .unwrap(),
        )
        .unwrap();
        let id = first["sources_id"].as_str().unwrap().to_string();
        store.catalogs.lock().unwrap().get_mut(&id).unwrap().last_access =
            Instant::now() - Duration::from_secs(19 * 60);
        store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params: params.clone(),
                    cursor: Some(format!("{id}:0")),
                    release: false,
                    explicit_filters: json!({}),
                },
            )
            .unwrap();
        assert!(store.catalogs.lock().unwrap()[&id].last_access.elapsed() < Duration::from_secs(1));
        store.catalogs.lock().unwrap().get_mut(&id).unwrap().bytes = MAX_CATALOG_BYTES;
        assert_eq!(
            store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: None,
                        release: false,
                        explicit_filters: json!({})
                    }
                )
                .unwrap_err()
                .error,
            "sources_disk_quota"
        );
        assert_eq!(store.catalogs.lock().unwrap().len(), 1);
        let directory = store.catalogs.lock().unwrap()[&id].directory.clone();
        let control = WorkControl::new(|| true, Duration::from_secs(1));
        assert_eq!(
            control
                .run(|| store.sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: Some(format!("{id}:1")),
                        release: false,
                        explicit_filters: json!({})
                    }
                ))
                .unwrap_err()
                .error,
            "cancelled"
        );
        assert!(!directory.exists());
        assert!(store.catalogs.lock().unwrap().is_empty());
        let first: Value = serde_json::from_str(
            &store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: None,
                        release: false,
                        explicit_filters: json!({}),
                    },
                )
                .unwrap(),
        )
        .unwrap();
        let id = first["sources_id"].as_str().unwrap();
        store.catalogs.lock().unwrap().get_mut(id).unwrap().memory_bytes = MAX_METADATA_BYTES;
        let error = store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params,
                    cursor: Some(format!("{id}:1")),
                    release: false,
                    explicit_filters: json!({}),
                },
            )
            .unwrap_err();
        assert_eq!(error.error, "sources_memory_quota");
        assert_eq!(error.available.as_ref().unwrap()["consumed_sources"], 1);
        assert_eq!(error.available.as_ref().unwrap()["released"], true);
        assert!(store.catalogs.lock().unwrap().is_empty());
    }

    #[test]
    fn sources_pages_freeze_filters_replay_and_cleanup() {
        let fixture = Fixture::new([human("one")]);
        let project = fixture.source.parent().unwrap();
        for index in 0..257 {
            fs::write(
                project.join(format!("catalog-{index:04}.jsonl")),
                format!("{}\n", human(format!("row-{index}"))),
            )
            .unwrap();
        }
        let store = ScanStore::default();
        let params = SearchParams {
            projects: vec!["-scan-fixture".into()],
            limit: Some(17),
            max_total: 20000,
            ..SearchParams::default()
        };
        let first = store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params: params.clone(),
                    cursor: None,
                    release: false,
                    explicit_filters: json!({}),
                },
            )
            .unwrap();
        let mut current: Value = serde_json::from_str(&first).unwrap();
        let id = current["sources_id"].as_str().unwrap().to_string();
        let directory = store.catalogs.lock().unwrap()[&id].directory.clone();
        assert!(directory.is_dir());
        let replay = store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params: params.clone(),
                    cursor: Some(format!("{id}:0")),
                    release: false,
                    explicit_filters: json!({}),
                },
            )
            .unwrap();
        assert_eq!(first, replay);
        let mut wrong = params.clone();
        wrong.pattern = "different".into();
        assert_eq!(
            store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: wrong,
                        cursor: current["next_query"]["cursor"].as_str().map(str::to_string),
                        release: false,
                        explicit_filters: json!({"pattern":"different"})
                    }
                )
                .unwrap_err()
                .error,
            "cursor_filter_mismatch"
        );
        let other = ScanStore::default();
        assert_eq!(
            other
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: Some(format!("{id}:0")),
                        release: false,
                        explicit_filters: json!({})
                    }
                )
                .unwrap_err()
                .error,
            "cursor_instance_mismatch"
        );
        let mut seen = std::collections::BTreeSet::new();
        loop {
            assert_eq!(current["enumeration_complete"], true);
            assert_eq!(current["body_scan_started"], false);
            for item in current["items"].as_array().unwrap() {
                assert!(seen.insert(item["source"].as_str().unwrap().to_string()));
            }
            assert!(current["scan_query"]["sources"].as_array().unwrap().len() <= 17);
            assert_eq!(current["scan_query"]["project"], "-scan-fixture");
            if current["has_more"] == false {
                break;
            }
            current = serde_json::from_str(
                &store
                    .sources(
                        &fixture.config,
                        SourcesRequest {
                            params: params.clone(),
                            cursor: current["next_query"]["cursor"].as_str().map(str::to_string),
                            release: false,
                            explicit_filters: json!({}),
                        },
                    )
                    .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(seen.len(), 258);
        let mut scan_params = params.clone();
        scan_params.sources = current["scan_query"]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().into())
            .collect();
        let page = page(
            &store,
            &fixture,
            ScanRequest {
                params: scan_params,
                cursor: None,
                scan_bytes: None,
                scan_ms: None,
                explicit_filters: json!({}),
            },
        );
        let (_, rows, _) = finish(&store, &fixture, page);
        assert!(!rows.is_empty());
        store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params: params.clone(),
                    cursor: current["release_query"]["cursor"].as_str().map(str::to_string),
                    release: true,
                    explicit_filters: json!({}),
                },
            )
            .unwrap();
        assert!(!directory.exists());
        let first: Value = serde_json::from_str(
            &store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor: None,
                        release: false,
                        explicit_filters: json!({}),
                    },
                )
                .unwrap(),
        )
        .unwrap();
        let id = first["sources_id"].as_str().unwrap();
        let directory = store.catalogs.lock().unwrap()[id].directory.clone();
        store.catalogs.lock().unwrap().get_mut(id).unwrap().last_access = Instant::now() - SCAN_TTL;
        assert_eq!(
            store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params,
                        cursor: Some(format!("{id}:1")),
                        release: false,
                        explicit_filters: json!({})
                    }
                )
                .unwrap_err()
                .error,
            "cursor_unavailable"
        );
        assert!(!directory.exists());
    }

    #[test]
    #[ignore = "explicit synthetic source-catalog resource regression"]
    fn sources_catalog_exceeds_old_metadata_scope_without_buffering_paths() {
        let fixture = Fixture::new([]);
        let project = "p".repeat(200);
        let directory = fixture.config.projects_dir.join(&project);
        fs::create_dir(&directory).unwrap();
        for index in 0..30_000 {
            fs::File::create(directory.join(format!("session-{index:05}-{}.jsonl", "s".repeat(200)))).unwrap();
        }
        let store = ScanStore::default();
        let params = SearchParams {
            projects: vec![project],
            max_total: 1_000_000,
            limit: Some(128),
            ..SearchParams::default()
        };
        let mut cursor = None;
        let mut count = 0;
        let mut previous = 0;
        let release = loop {
            let text = store
                .sources(
                    &fixture.config,
                    SourcesRequest {
                        params: params.clone(),
                        cursor,
                        release: false,
                        explicit_filters: json!({}),
                    },
                )
                .unwrap();
            assert!(text.len() <= params.max_total);
            let current: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(current["files_total"], 30000);
            assert!(current["catalog_bytes"].as_u64().unwrap() <= MAX_CATALOG_BYTES);
            assert_eq!(current["source_progress"]["start"], previous);
            count += current["items"].as_array().unwrap().len();
            previous = count;
            if current["has_more"] == false {
                break current["release_query"]["cursor"].as_str().unwrap().to_string();
            }
            cursor = current["next_query"]["cursor"].as_str().map(str::to_string);
        };
        assert_eq!(count, 30000);
        store
            .sources(
                &fixture.config,
                SourcesRequest {
                    params,
                    cursor: Some(release),
                    release: true,
                    explicit_filters: json!({}),
                },
            )
            .unwrap();
        assert!(store.catalogs.lock().unwrap().is_empty());
    }

    #[test]
    fn frozen_filters_compare_effective_aliases_order_and_time_bounds() {
        let fixture = Fixture::new([human("one"), human("two"), human("three")]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.limit = Some(1);
        request.params.types = vec!["human".to_string(), "human".to_string()];
        (request.params.since, request.params.until) =
            parse_time_bounds(Some("2026-10-01T00:00:00Z"), Some("2026-10-02T00:00:00Z")).unwrap();
        request.params.lines = parse_optional_line_ranges_param(Some("1-3,1-3")).unwrap();
        let first = page(&store, &fixture, request);
        let mut equivalent = next_request(&first);
        equivalent.params.projects = vec!["/scan/fixture".to_string(), "-scan-fixture".to_string()];
        equivalent.params.types = vec!["user".to_string()];
        equivalent.params.subtypes = vec!["human".to_string()];
        (equivalent.params.since, equivalent.params.until) =
            parse_time_bounds(Some("2026-10-01T02:00:00+02:00"), Some("2026-10-02T02:00:00+02:00")).unwrap();
        equivalent.params.lines = parse_optional_line_ranges_param(Some("1-3")).unwrap();
        equivalent.explicit_filters = json!({"project":"/scan/fixture,-scan-fixture", "types":"user", "subtypes":"human", "since":"2026-10-01T02:00:00+02:00", "until":"2026-10-02T02:00:00+02:00", "lines":"1-3"});
        let second = page(&store, &fixture, equivalent);
        assert_eq!(second["results"][0]["line"], 2);
        let mut wrong = next_request(&second);
        wrong.params.subtypes = vec!["meta".to_string()];
        wrong.explicit_filters = json!({"subtypes":"meta"});
        assert_eq!(
            store
                .search(&fixture.config, wrong, Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_filter_mismatch"
        );
        let (last, rows, _) = finish(&store, &fixture, second);
        assert_eq!(
            rows.iter().map(|row| row["line"].as_u64().unwrap()).collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(last["stats"]["total_matches"], 3);
    }

    #[test]
    fn attribution_diagnostics_only_affect_the_filtered_query_scope() {
        for inside_unknown in [false, true] {
            let mut records = vec![
                json!({"type":"user", "uuid":"outside", "timestamp":"2026-07-01T00:00:00Z", "message":{"content":[{"type":"tool_result", "tool_use_id":"outside-unknown", "content":"outside"}]}}),
                json!({"type":"assistant", "uuid":"known-call", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_use", "id":"known", "name":"mcp__fixture__probe", "input":{}}]}}),
                json!({"type":"user", "uuid":"known-result", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_result", "tool_use_id":"known", "content":"matched"}]}}),
            ];
            if inside_unknown {
                records.push(json!({"type":"user", "uuid":"inside", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_result", "tool_use_id":"inside-unknown", "content":"inside"}]}}));
            }
            let fixture = Fixture::new(records);
            let store = ScanStore::default();
            let mut request = fixture.request();
            request.params.since = Some(
                chrono::DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
                    .unwrap()
                    .into(),
            );
            request.params.subtypes = vec!["tool_result".to_string()];
            request.params.tools = vec!["mcp__fixture__probe".to_string()];
            let first = page(&store, &fixture, request);
            let (last, rows, _) = finish(&store, &fixture, first);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["line"], 3);
            assert_eq!(last["counts_exact"], !inside_unknown);
            assert_eq!(last["attribution_complete"], !inside_unknown);
            assert_eq!(last["stats"]["attribution_issues"], usize::from(inside_unknown));
            if inside_unknown {
                let metadata: Value = serde_json::from_str(
                    &store
                        .metadata(MetadataRequest {
                            scan_id: last["scan_id"].as_str().unwrap().to_string(),
                            cursor: None,
                            limit: 100,
                            max_total: 40_000,
                            release: false,
                        })
                        .unwrap(),
                )
                .unwrap();
                let issues: Vec<_> = metadata["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|item| item["kind"] == "issues")
                    .collect();
                assert_eq!(issues.len(), 1);
                assert_eq!(issues[0]["value"]["line"], 4);
                assert_eq!(issues[0]["value"]["source"], fixture.source.to_string_lossy().as_ref());
            }
        }
    }

    #[test]
    fn outer_deadline_stops_an_active_worker_and_releases_state() {
        let fixture = Fixture::new([human("x".repeat(16 * 1024 * 1024))]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.pattern = "absent".to_string();
        request.scan_bytes = Some(16 * 1024);
        let first = page(&store, &fixture, request);
        let entry = store
            .entries
            .lock()
            .unwrap()
            .get(first["scan_id"].as_str().unwrap())
            .unwrap()
            .clone();
        let metadata = entry.driver.lock().unwrap().metadata.clone();
        let mut request = next_request(&first);
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10_000);
        let started = Instant::now();
        let error = WorkControl::new(|| false, Duration::from_millis(50))
            .run(|| store.search(&fixture.config, request, Arc::new(|| false)))
            .unwrap_err();
        assert_eq!(error.error, "deadline_exceeded");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(entry.driver.lock().unwrap().thread.is_none());
        assert!(store.entries.lock().unwrap().is_empty());
        let processed = metadata.lock().unwrap().counters.bytes_processed;
        thread::sleep(Duration::from_millis(20));
        assert_eq!(metadata.lock().unwrap().counters.bytes_processed, processed);
    }

    #[test]
    fn empty_scan_budget_error_preserves_an_executable_continuation() {
        let fixture = Fixture::new([human("not matched")]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.pattern = "absent".to_string();
        request.params.max_total = 512;
        let error = store.search(&fixture.config, request, Arc::new(|| false)).unwrap_err();
        assert_eq!(error.error, "response_too_large");
        let query = error.available.unwrap()["next_query"].clone();
        let response = page(&store, &fixture, next_request(&json!({"next_query":query})));
        let (last, rows, _) = finish(&store, &fixture, response);
        assert!(rows.is_empty());
        assert_eq!(last["scan_complete"], true);
        assert_eq!(last["counts_exact"], true);
        assert_eq!(last["stats"]["lines_scanned"], 1);
    }

    #[test]
    fn metadata_quota_reports_occupancy_and_enumeration_progress() {
        let mut metadata = ScanMetadata::new(json!({"project":"fixture"}));
        metadata.files.push(FileCoverage {
            project: "fixture".to_string(),
            session: "session".to_string(),
            source: "fixture/session.jsonl".to_string(),
            snapshot_bytes: 0,
            status: "pending".to_string(),
            lines: 0,
        });
        metadata.reserve(MAX_METADATA_BYTES - metadata.bytes).unwrap();
        let error = metadata.reserve(512).unwrap_err();
        assert_eq!(error.error, "scan_metadata_quota");
        assert_eq!(
            error.available.unwrap(),
            json!({
                "metadata_bytes_used":MAX_METADATA_BYTES,
                "requested_bytes":512,
                "max_metadata_bytes":MAX_METADATA_BYTES,
                "remaining_bytes":0,
                "files_enumerated":1,
                "scan_phase":"enumeration",
            })
        );
        assert_eq!(metadata.bytes, MAX_METADATA_BYTES);
        assert_eq!(metadata.files.len(), 1);
    }

    #[test]
    fn api_request_blobs_preserve_exact_message_counts() {
        for padding in [0, MAX_JSONL_LINE_BYTES + 1024] {
            let mut after = human("after-cache");
            after["uuid"] = json!("after-cache-uuid");
            let fixture = Fixture::new([
                human("before-cache"),
                json!({"type":"api-request-blob", "hash":"fixture", "message":{"role":"user", "content":"x".repeat(padding)}}),
                after,
            ]);
            if padding == 0 {
                let normal = crate::search::search(&fixture.config, fixture.request().params).unwrap();
                assert!(normal.stats.total_matches_exact);
                assert_eq!(normal.stats.total_matches, 2);
                assert_eq!(normal.results.iter().map(|row| row.line).collect::<Vec<_>>(), [1, 3]);
            }
            let store = ScanStore::default();
            let first = page(&store, &fixture, fixture.request());
            let (last, rows, _) = finish(&store, &fixture, first);
            assert_eq!(
                rows.iter().map(|row| row["line"].as_u64().unwrap()).collect::<Vec<_>>(),
                [1, 3]
            );
            assert_eq!(last["counts_exact"], true);
            assert_eq!(last["stats"]["invalid_records"], 0);
            assert_eq!(last["stats"]["lines_scanned"], 3);
        }
    }

    #[test]
    fn invalid_records_report_physical_sources_and_preserve_valid_suffixes() {
        let fixture = Fixture::new([human("before-invalid")]);
        let mut output = BufWriter::new(OpenOptions::new().append(true).open(&fixture.source).unwrap());
        output
            .write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"\xff\"}}\n{not-json}\n")
            .unwrap();
        serde_json::to_writer(&mut output, &human("x".repeat(MAX_JSONL_LINE_BYTES + 1024))).unwrap();
        output.write_all(b" trailing\n").unwrap();
        output
            .write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"")
            .unwrap();
        output.write_all(&vec![b'x'; MAX_JSONL_LINE_BYTES + 1024]).unwrap();
        output.write_all(b"\xff\"}}\n").unwrap();
        serde_json::to_writer(&mut output, &human("after-invalid")).unwrap();
        output.write_all(b"\n").unwrap();
        output.flush().unwrap();
        drop(output);

        let store = ScanStore::default();
        let first = page(&store, &fixture, fixture.request());
        let (last, rows, _) = finish(&store, &fixture, first);
        assert_eq!(
            rows.iter().map(|row| row["line"].as_u64().unwrap()).collect::<Vec<_>>(),
            [1, 6]
        );
        assert_eq!(last["scan_complete"], true);
        assert_eq!(last["counts_exact"], false);
        assert_eq!(last["stats"]["invalid_records"], 4);
        assert_eq!(last["stats"]["oversized_records"], 2);
        assert_eq!(last["stats"]["lines_scanned"], 6);
        let metadata: Value = serde_json::from_str(
            &store
                .metadata(MetadataRequest {
                    scan_id: last["scan_id"].as_str().unwrap().to_string(),
                    cursor: None,
                    limit: 100,
                    max_total: 40_000,
                    release: false,
                })
                .unwrap(),
        )
        .unwrap();
        let issues: Vec<_> = metadata["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == "issues")
            .map(|item| &item["value"])
            .collect();
        assert_eq!(
            issues
                .iter()
                .map(|item| item["line"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [2, 3, 4, 5]
        );
        for issue in issues {
            assert_eq!(issue["source"], fixture.source.to_string_lossy().as_ref());
            assert_eq!(issue["ref"], format!("scan-ses:{}", issue["line"]));
            assert_eq!(issue["kind"], "record");
            assert!(matches!(issue["reason"].as_str(), Some("parse_error" | "invalid_utf8")));
        }
    }

    #[test]
    fn indexed_previews_match_small_record_filters_and_strict_recovery() {
        let records = [32, MAX_JSONL_LINE_BYTES + 1024].into_iter().flat_map(|length| [
            json!({"type":"assistant", "uuid":format!("call-{length}"), "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_use", "id":format!("id-{length}"), "name":"mcp__fixture__probe", "input":{"password":"x".repeat(length), "note":"前缀😀 https://private.example.test"}}]}}),
            json!({"type":"user", "uuid":format!("result-{length}"), "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_result", "tool_use_id":format!("id-{length}"), "content":format!("Authorization: Bearer {}\n尾部😀 https://private.example.test", "x".repeat(length))}]}}),
        ]);
        let fixture = Fixture::new(records);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.structured = Some("preview".to_string());
        request.params.redaction = RedactionMode::Strict;
        request.params.tools = vec!["probe".to_string()];
        request.params.max_content = 20;
        request.params.max_content_tool_result = 20;
        (request.params.since, request.params.until) =
            parse_time_bounds(Some("2026-10-01T00:00:00Z"), Some("2026-10-02T00:00:00Z")).unwrap();
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10_000);
        let first = page(&store, &fixture, request);
        let (last, rows, _) = finish(&store, &fixture, first);
        assert_eq!(rows.len(), 4);
        assert_eq!(last["stats"]["oversized_records"], 2);
        for (index, row) in rows.iter().enumerate() {
            let (field, view, kind, subtype) = if index % 2 == 0 {
                ("tool_input_redacted", "tool_input", "assistant", "tool_use")
            } else {
                ("tool_result_redacted", "tool_result", "user", "tool_result")
            };
            let filters = row["matched_filters"].as_array().unwrap();
            for filter in [
                "project=-scan-fixture".to_string(),
                "session=scan-session-main".to_string(),
                format!("type={kind}"),
                format!("subtype={subtype}"),
                "time=true".to_string(),
                "server=fixture".to_string(),
                "tool=probe".to_string(),
            ] {
                assert!(filters.contains(&json!(filter)));
            }
            if index >= 2 {
                assert_eq!(row["matched_filters"], rows[index - 2]["matched_filters"]);
            }
            let preview = &row[field];
            let pointer = &preview["get"];
            assert_eq!(pointer["redaction"], "strict");
            assert_eq!(pointer["view"], view);
            assert_eq!(pointer["source"], fixture.source.to_string_lossy().as_ref());
            let restored = crate::get::get(
                &fixture.config,
                crate::get::GetParams {
                    r#ref: pointer["ref"].as_str().unwrap().to_string(),
                    range: None,
                    output: None,
                    project: pointer["project"].as_str().map(str::to_string),
                    source: pointer["source"].as_str().map(str::to_string),
                    redaction: RedactionMode::Strict,
                    overwrite: false,
                    view: Some(view.to_string()),
                    block: Some(0),
                },
            )
            .unwrap();
            let crate::types::GetResponse::Success { content, .. } = restored else {
                panic!("脱敏结构应可完整内联恢复")
            };
            assert!(!content.contains("private.example.test"));
            assert!(!content.contains("xxxxxxxx"));
            assert!(serde_json::from_str::<Value>(&content).is_ok());
            assert_eq!(preview["original_bytes"], content.len());
            assert_eq!(preview["preview"], content.chars().take(20).collect::<String>());
            assert_eq!(preview["truncated"], true);
        }
    }

    #[test]
    fn failed_scan_page_does_not_count_undelivered_rows() {
        let blocks = (0..MAX_TOOL_BLOCKS + 1)
            .map(|index| json!({"type":"tool_use","id":format!("over-{index}"),"name":"Bash"}))
            .collect::<Vec<_>>();
        let fixture = Fixture::new([
            human("first"),
            json!({"type":"assistant","uuid":"over","timestamp":"2026-10-01T00:00:01Z","message":{"content":blocks}}),
        ]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10000);
        let error = store.search(&fixture.config, request, Arc::new(|| false)).unwrap_err();
        assert_eq!(error.error, "tool_blocks_cap");
        let id = error.available.as_ref().unwrap()["scan_id"].as_str().unwrap();
        let metadata: Value = serde_json::from_str(
            &store
                .metadata(MetadataRequest {
                    scan_id: id.to_string(),
                    cursor: None,
                    limit: 100,
                    max_total: 20000,
                    release: false,
                })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["stats"]["returned_count"], 0);
        store.release(id).unwrap();
    }

    #[test]
    fn fatal_record_errors_keep_source_coordinates_and_recovery_pointers() {
        for oversized in [false, true] {
            let padding = if oversized {
                "p".repeat(MAX_JSONL_LINE_BYTES + 1024)
            } else {
                String::new()
            };
            let input = json!({"note":"visible".repeat(400), "padding":padding, "url":"https://private.example.test"});
            let fixture = Fixture::new([
                json!({"type":"assistant", "uuid":"full-record", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_use", "id":"full-call", "name":"mcp__fixture__probe", "input":input}]}}),
            ]);
            let store = ScanStore::default();
            let mut request = fixture.request();
            request.params.structured = Some("full".to_string());
            request.params.redaction = RedactionMode::Strict;
            request.params.max_total = 1800;
            request.scan_bytes = Some(256 * 1024 * 1024);
            request.scan_ms = Some(10_000);
            let deadline = Instant::now() + Duration::from_secs(90);
            let error = loop {
                assert!(Instant::now() < deadline, "预算错误前的扫描续页未能结束");
                match store.search(&fixture.config, request, Arc::new(|| false)) {
                    Err(error) => break error,
                    Ok(response) => {
                        let current: Value = serde_json::from_str(&response).unwrap();
                        assert_eq!(current["results"], json!([]));
                        assert_eq!(current["has_more"], true);
                        request = next_request(&current);
                    }
                }
            };
            assert_eq!(
                error.error,
                if oversized {
                    "structured_response_too_large"
                } else {
                    "response_too_large"
                }
            );
            let available = error.available.unwrap();
            if oversized {
                assert_eq!(available["get"]["redaction"], "strict");
                assert_eq!(available["get"]["source"], fixture.source.to_string_lossy().as_ref());
                assert_eq!(available["get"]["view"], "tool_input");
                assert_eq!(available["source"], fixture.source.to_string_lossy().as_ref());
                assert_eq!(available["ref"], "scan-session-main:1");
                assert_eq!(available["line"], 1);
                assert_eq!(available["byte_start"], 0);
                assert!(available["byte_end"].as_u64().unwrap() > MAX_JSONL_LINE_BYTES as u64);
                assert_eq!(available["resume_possible"], false);
            } else {
                assert_eq!(available["resume_possible"], true);
                let restored = page(
                    &store,
                    &fixture,
                    next_request(&json!({"next_query":available["next_query"]})),
                );
                assert_eq!(restored["results"][0]["line"], 1);
                assert_eq!(
                    restored["results"][0]["tool_input_redacted"]["note"],
                    "visible".repeat(400)
                );
                assert!(!restored.to_string().contains("private.example.test"));
            }
        }
    }

    #[test]
    fn indexed_structured_full_is_complete_json_independent_of_preview_limit() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let fixture = Fixture::new([
            json!({"type":"assistant", "uuid":"full-record", "timestamp":"2026-10-01T00:00:00Z", "message":{"content":[{"type":"tool_use", "id":"full-call", "name":"mcp__fixture__full", "input":{"password":"x".repeat(MAX_JSONL_LINE_BYTES + 1024), "command":"前缀😀 Authorization: Bearer\tfixture-value", "array":[1,null,true], "note":"entire-structured-value", "zztext":format!("前缀😀 [{secret}] visible")}}]}}),
        ]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.structured = Some("full".to_string());
        request.params.max_content = 16;
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10_000);
        let first = page(&store, &fixture, request);
        let (last, rows, _) = finish(&store, &fixture, first);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["tool_input_redacted"],
            json!({"password":"[redacted]", "command":"前缀😀 Authorization: [redacted]", "array":[1,null,true], "note":"entire-structured-value", "zztext":"前缀😀 [[redacted]] visible"})
        );
        assert!(rows[0]["tool_input_redacted"].get("preview").is_none());
        assert!(rows[0]["content"].as_str().unwrap().chars().count() <= 16);
        assert_eq!(last["stats"]["oversized_records"], 1);
        assert_eq!(last["counts_exact"], true);
    }

    #[test]
    fn indexed_npm_token_previews_recover_redacted_input_and_result_ranges() {
        let secret = format!("npm_{}", "Aa0".repeat(12));
        for is_input in [true, false] {
            let text = format!("{} 前缀😀 [{secret}] visible", "x".repeat(MAX_JSONL_LINE_BYTES + 1024));
            let input = json!({"text":text,"note":"visible"});
            let block = if is_input {
                json!({"type":"tool_use","id":"npm-call","name":"Bash","input":input})
            } else {
                json!({"type":"tool_result","tool_use_id":"npm-call","content":[{"type":"text","text":text}],"is_error":false})
            };
            let original = if is_input { input.to_string() } else { block.to_string() };
            let start = original[..original.find(&secret).unwrap()].chars().count();
            let fixture = Fixture::new([
                json!({"type":if is_input { "assistant" } else { "user" },"uuid":"npm-record","timestamp":"2026-10-01T00:00:00Z","message":{"content":[block]}}),
            ]);
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let store = ScanStore::default();
                let mut request = fixture.request();
                request.params.redaction = mode;
                request.params.structured = Some("preview".to_string());
                request.params.max_content = 48;
                request.params.max_content_tool_result = 48;
                request.scan_bytes = Some(256 * 1024 * 1024);
                request.scan_ms = Some(10_000);
                let first = page(&store, &fixture, request);
                let (last, rows, _) = finish(&store, &fixture, first);
                assert_eq!(rows.len(), 1);
                assert_eq!(last["stats"]["oversized_records"], 1);
                let value = &rows[0][if is_input {
                    "tool_input_redacted"
                } else {
                    "tool_result_redacted"
                }];
                assert_eq!(value["truncated"], true);
                let pointer = &value["get"];
                assert_eq!(pointer["redaction"], mode.as_str());
                let recovered = crate::get::get(
                    &fixture.config,
                    crate::get::GetParams {
                        r#ref: pointer["ref"].as_str().unwrap().to_string(),
                        range: Some((start + 4, start + 10)),
                        output: None,
                        project: pointer["project"].as_str().map(str::to_string),
                        source: pointer["source"].as_str().map(str::to_string),
                        redaction: mode,
                        overwrite: false,
                        view: pointer["view"].as_str().map(str::to_string),
                        block: pointer["block"].as_u64().map(|value| value as usize),
                    },
                )
                .unwrap();
                let crate::types::GetResponse::Success { content, .. } = recovered else {
                    panic!("expected recovered content")
                };
                assert_eq!(content, if mode.enabled() { "[redacted]" } else { &secret[4..10] });
                if mode.enabled() {
                    assert!(!value.to_string().contains(&secret));
                }
                store.release(last["scan_id"].as_str().unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn indexed_preview_includes_a_match_far_from_the_record_start() {
        let text = format!("前缀😀 {} needle 尾部", "x".repeat(MAX_JSONL_LINE_BYTES + 1024));
        let original_count = text.chars().count();
        let fixture = Fixture::new([human(text)]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.pattern = "needle".to_string();
        request.params.max_content = 40;
        request.params.redaction = RedactionMode::Off;
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10_000);
        let first = page(&store, &fixture, request);
        let (_, rows, _) = finish(&store, &fixture, first);
        assert_eq!(rows.len(), 1);
        assert!(rows[0]["content"].as_str().unwrap().contains("needle"));
        assert!(rows[0]["content"].as_str().unwrap().chars().count() <= 40);
        assert_eq!(rows[0]["content_size"], original_count);
        assert_eq!(rows[0]["truncated"], true);
    }

    #[test]
    fn scan_returns_every_physical_row_beyond_the_normal_cap() {
        let fixture = Fixture::new((0..50_005).map(|index| human(format!("记录 {index}"))));
        let store = ScanStore::default();
        let first = page(&store, &fixture, fixture.request());
        let (last, rows, _) = finish(&store, &fixture, first);
        assert_eq!(rows.len(), 50_005);
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(row["line"], index + 1);
            assert_eq!(row["source"], fixture.source.to_string_lossy().as_ref());
        }
        assert_eq!(last["scan_complete"], true);
        assert_eq!(last["counts_exact"], true);
        assert_eq!(last["stats"]["total_matches"], 50_005);
        assert_eq!(last["stats"]["returned_count"], 50_005);
        assert_eq!(last["stats"]["lines_scanned"], 50_005);
        store.release(last["scan_id"].as_str().unwrap()).unwrap();
    }

    #[test]
    fn empty_batches_advance_and_preserve_tool_association() {
        let records = std::iter::once(json!({"type":"assistant", "uuid":"call-record", "timestamp":"2026-10-01T00:00:00Z", "message":{"role":"assistant", "content":[{"type":"tool_use","id":"call-id","name":"mcp__fixture__probe","input":{}}]}}))
            .chain((0..80).map(|_| human("x".repeat(8192))))
            .chain(std::iter::once(json!({"type":"user","uuid":"result-record","timestamp":"2026-10-01T00:00:00Z", "message":{"role":"user", "content":[{"type":"tool_result","tool_use_id":"call-id","content":"matched-result","is_error":false}]}})));
        let fixture = Fixture::new(records);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.subtypes = vec!["tool_result".to_string()];
        request.params.servers = vec!["fixture".to_string()];
        request.scan_bytes = Some(16 * 1024);
        let first = page(&store, &fixture, request);
        let (last, rows, empty) = finish(&store, &fixture, first);
        assert!(empty > 0);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["line"], 82);
        assert_eq!(rows[0]["server"], "fixture");
        assert_eq!(rows[0]["tool"], "probe");
        assert_eq!(last["attribution_complete"], true);
        assert_eq!(last["stats"]["lines_scanned"], 82);
    }

    #[test]
    fn oversized_response_is_not_consumed_and_recent_page_replays_exactly() {
        let fixture = Fixture::new([human("first"), human("second"), human("third")]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.limit = Some(1);
        request.params.max_total = 512;
        let error = store.search(&fixture.config, request, Arc::new(|| false)).unwrap_err();
        assert_eq!(error.error, "response_too_large");
        let query = error.available.unwrap()["next_query"].clone();
        let request = next_request(&json!({"next_query":query}));
        let maximum = request.params.max_total;
        let cursor = request.cursor.clone().unwrap();
        let response = store.search(&fixture.config, request, Arc::new(|| false)).unwrap();
        assert!(response.len() <= maximum);
        let first: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(first["results"][0]["line"], 1);
        let replay = ScanRequest {
            params: SearchParams {
                limit: Some(1),
                max_total: maximum,
                ..SearchParams::default()
            },
            cursor: Some(cursor.clone()),
            scan_bytes: Some(1024 * 1024),
            scan_ms: Some(1000),
            explicit_filters: json!({}),
        };
        assert_eq!(
            store.search(&fixture.config, replay, Arc::new(|| false)).unwrap(),
            response
        );
        let mismatched = ScanRequest {
            params: SearchParams {
                limit: Some(1),
                max_total: 512,
                ..SearchParams::default()
            },
            cursor: Some(cursor),
            scan_bytes: Some(1024 * 1024),
            scan_ms: Some(1000),
            explicit_filters: json!({}),
        };
        assert_eq!(
            store
                .search(&fixture.config, mismatched, Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_replay_mismatch"
        );
        let (last, rows, _) = finish(&store, &fixture, first);
        assert_eq!(
            rows.iter().map(|row| row["line"].as_u64().unwrap()).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(last["stats"]["returned_count"], 3);
    }

    #[test]
    fn empty_page_fixed_fields_recover_using_the_suggested_budget() {
        let fixture = Fixture::new([human("x".repeat(256 * 1024))]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.pattern = "absent".to_string();
        request.params.max_total = 512;
        request.scan_bytes = Some(16 * 1024);
        let error = store.search(&fixture.config, request, Arc::new(|| false)).unwrap_err();
        assert_eq!(error.error, "response_too_large");
        let available = error.available.unwrap();
        let response = page(&store, &fixture, next_request(&available));
        assert!(response["results"].as_array().unwrap().is_empty());
        let (last, rows, _) = finish(&store, &fixture, response);
        assert!(rows.is_empty());
        assert_eq!(last["scan_complete"], true);
        assert_eq!(last["stats"]["returned_count"], 0);
        store.release(last["scan_id"].as_str().unwrap()).unwrap();
    }

    #[test]
    fn metadata_first_item_recovers_using_the_suggested_budget() {
        let fixture = Fixture::new([]);
        let store = ScanStore::default();
        let first = page(&store, &fixture, fixture.request());
        let (last, _, _) = finish(&store, &fixture, first);
        let id = last["scan_id"].as_str().unwrap();
        let error = store
            .metadata(MetadataRequest {
                scan_id: id.to_string(),
                cursor: None,
                limit: 1,
                max_total: 512,
                release: false,
            })
            .unwrap_err();
        assert_eq!(error.error, "response_too_large");
        let query = &error.available.unwrap()["next_query"];
        let maximum = query["max_total"].as_u64().unwrap() as usize;
        let text = store
            .metadata(MetadataRequest {
                scan_id: query["scan_id"].as_str().unwrap().to_string(),
                cursor: Some(query["cursor"].as_str().unwrap().to_string()),
                limit: query["limit"].as_u64().unwrap() as usize,
                max_total: maximum,
                release: false,
            })
            .unwrap();
        assert!(text.len() <= maximum);
        let response: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(response["offset"], 0);
        assert_eq!(response["items"][0]["kind"], "filters");
        assert_eq!(response["dimensions"]["filters"]["returned"], 1);
        store.release(id).unwrap();
    }

    #[test]
    fn append_uses_frozen_file_end_but_truncation_and_replacement_reject_continuation() {
        for change in ["append", "truncate", "replace"] {
            let fixture = Fixture::new([human("first"), human("second")]);
            let store = ScanStore::default();
            let mut request = fixture.request();
            request.params.limit = Some(1);
            let first = page(&store, &fixture, request);
            let id = first["scan_id"].as_str().unwrap().to_string();
            match change {
                "append" => {
                    let mut file = OpenOptions::new().append(true).open(&fixture.source).unwrap();
                    serde_json::to_writer(&mut file, &human("not-in-snapshot")).unwrap();
                    file.write_all(b"\n").unwrap();
                }
                "truncate" => {
                    OpenOptions::new()
                        .write(true)
                        .open(&fixture.source)
                        .unwrap()
                        .set_len(0)
                        .unwrap();
                }
                "replace" => {
                    let replacement = fixture.source.with_extension("replacement");
                    fs::write(&replacement, format!("{}\n", human("replacement"))).unwrap();
                    fs::rename(&replacement, &fixture.source).unwrap();
                }
                _ => unreachable!(),
            }
            if change == "append" {
                let (last, rows, _) = finish(&store, &fixture, first);
                assert_eq!(rows.len(), 2);
                assert_eq!(last["stats"]["lines_scanned"], 2);
            } else {
                assert_eq!(
                    store
                        .search(&fixture.config, next_request(&first), Arc::new(|| false))
                        .unwrap_err()
                        .error,
                    "source_changed"
                );
            }
            store.release(&id).unwrap();
        }
    }

    #[test]
    fn cancel_and_release_stop_the_worker_even_with_a_live_entry_reference() {
        for release in [false, true] {
            let fixture = Fixture::new([human("first"), human("second")]);
            let store = ScanStore::default();
            let mut request = fixture.request();
            request.params.limit = Some(1);
            let first = page(&store, &fixture, request);
            let id = first["scan_id"].as_str().unwrap();
            let entry = store.entries.lock().unwrap().get(id).unwrap().clone();
            let metadata = entry.driver.lock().unwrap().metadata.clone();
            let processed = metadata.lock().unwrap().counters.bytes_processed;
            if release {
                store.release(id).unwrap();
            } else {
                assert_eq!(
                    store
                        .search(&fixture.config, next_request(&first), Arc::new(|| true))
                        .unwrap_err()
                        .error,
                    "cancelled"
                );
            }
            assert!(entry.driver.lock().unwrap().thread.is_none());
            assert_eq!(metadata.lock().unwrap().counters.bytes_processed, processed);
            assert!(!store.entries.lock().unwrap().contains_key(id));
        }
    }

    #[test]
    fn cancellation_during_record_read_stops_without_a_late_response() {
        let fixture = Fixture::new([human("x".repeat(16 * 1024 * 1024))]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.pattern = "absent-pattern".to_string();
        request.scan_bytes = Some(16 * 1024);
        let first = page(&store, &fixture, request);
        assert!(first["results"].as_array().unwrap().is_empty());
        let entry = store
            .entries
            .lock()
            .unwrap()
            .get(first["scan_id"].as_str().unwrap())
            .unwrap()
            .clone();
        let metadata = entry.driver.lock().unwrap().metadata.clone();
        let before = metadata.lock().unwrap().counters.bytes_processed;
        let mut request = next_request(&first);
        request.scan_bytes = Some(256 * 1024 * 1024);
        request.scan_ms = Some(10_000);
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let worker_store = store.clone();
        let config = fixture.config.clone();
        let call = thread::spawn(move || {
            worker_store.search(&config, request, Arc::new(move || signal.load(Ordering::SeqCst)))
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while metadata.lock().unwrap().counters.bytes_processed <= before {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(call.join().unwrap().unwrap_err().error, "cancelled");
        assert!(entry.driver.lock().unwrap().thread.is_none());
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn cursors_reject_cross_instance_changed_filters_and_stale_pages() {
        let fixture = Fixture::new([human("first"), human("second"), human("third")]);
        let store = ScanStore::default();
        let mut request = fixture.request();
        request.params.limit = Some(1);
        request.explicit_filters = json!({"pattern":""});
        let first = page(&store, &fixture, request);
        let other = ScanStore::default();
        assert_eq!(
            other
                .search(&fixture.config, next_request(&first), Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_instance_mismatch"
        );
        let mut mismatched = next_request(&first);
        mismatched.explicit_filters = json!({"pattern":"different"});
        mismatched.params.pattern = "different".to_string();
        assert_eq!(
            store
                .search(&fixture.config, mismatched, Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_filter_mismatch"
        );
        let second = page(&store, &fixture, next_request(&first));
        let _third = page(&store, &fixture, next_request(&second));
        assert_eq!(
            store
                .search(&fixture.config, next_request(&first), Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_stale"
        );
        let id = first["scan_id"].as_str().unwrap();
        store
            .entries
            .lock()
            .unwrap()
            .get(id)
            .unwrap()
            .driver
            .lock()
            .unwrap()
            .last_access = Instant::now() - SCAN_TTL;
        assert_eq!(
            store
                .search(&fixture.config, next_request(&second), Arc::new(|| false))
                .unwrap_err()
                .error,
            "cursor_unavailable"
        );
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn metadata_all_dimensions_are_paginated_without_changing_counts() {
        let fixture = Fixture::new((0..80).map(|index| json!({"type":"assistant", "uuid":format!("record-{index}"), "timestamp":"2026-10-01T00:00:00Z", "message":{"role":"assistant", "content":[{"type":"tool_use", "id":format!("call-{index}"), "name":format!("mcp__fixture__probe_{index}"), "input":{}}]}})));
        let store = ScanStore::default();
        let first = page(&store, &fixture, fixture.request());
        let (last, _, _) = finish(&store, &fixture, first);
        let id = last["scan_id"].as_str().unwrap();
        let mut cursor = None;
        let mut seen = BTreeMap::<String, usize>::new();
        let mut total = 0;
        let mut pages = 0;
        loop {
            let text = store
                .metadata(MetadataRequest {
                    scan_id: id.to_string(),
                    cursor,
                    limit: 7,
                    max_total: 2048,
                    release: false,
                })
                .unwrap();
            assert!(text.len() <= 2048);
            let metadata: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(metadata["counts_exact"], true);
            assert_eq!(metadata["scan_complete"], true);
            for item in metadata["items"].as_array().unwrap() {
                *seen.entry(item["kind"].as_str().unwrap().to_string()).or_default() += 1;
            }
            total += metadata["returned"].as_u64().unwrap();
            pages += 1;
            assert!(pages < 200);
            if metadata["has_more"] == false {
                assert_eq!(total, metadata["total"].as_u64().unwrap());
                break;
            }
            cursor = Some(metadata["next_query"]["cursor"].as_str().unwrap().to_string());
        }
        assert!(pages > 1);
        assert_eq!(seen["filters"], 1);
        assert_eq!(seen["files"], 1);
        assert_eq!(seen["by_tool"], 80);
        store.release(id).unwrap();
    }
}

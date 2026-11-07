use crate::types::{ErrorResponse, ImageInfo, MessageRecord};
use crate::utils::{MAX_JSONL_LINE_BYTES, invalid_arguments};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BUFFER_BYTES: usize = 16 * 1024;
const MAX_INDEX_NODES: usize = 65_536;
const MAX_KEY_BYTES: usize = 4096;

#[derive(Clone)]
pub struct WorkControl {
    checkpoint: Arc<dyn Fn(usize) -> Result<(), ErrorResponse> + Send + Sync>,
    output_published: Arc<std::sync::atomic::AtomicBool>,
}

impl Default for WorkControl {
    fn default() -> Self {
        Self::new(|| false, Duration::from_secs(120))
    }
}

thread_local! {
    static CURRENT_WORK: RefCell<Option<WorkControl>> = const { RefCell::new(None) };
    #[cfg(test)]
    pub(crate) static SERIALIZED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl WorkControl {
    pub fn new(cancelled: impl Fn() -> bool + Send + Sync + 'static, timeout: Duration) -> Self {
        let deadline = Instant::now() + timeout;
        Self::from_checkpoint(move |_| {
            if cancelled() {
                return Err(reader_error("cancelled", "历史读取已取消"));
            }
            if Instant::now() >= deadline {
                return Err(reader_error(
                    "deadline_exceeded",
                    "历史读取超过执行时间，请使用 mode=scan 分批读取",
                ));
            }
            Ok(())
        })
    }

    pub fn from_checkpoint(checkpoint: impl Fn(usize) -> Result<(), ErrorResponse> + Send + Sync + 'static) -> Self {
        Self {
            checkpoint: Arc::new(checkpoint),
            output_published: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn account(&self, bytes: usize) -> Result<(), ErrorResponse> {
        if self.output_published.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        (self.checkpoint)(bytes)
    }

    pub fn run<T>(&self, action: impl FnOnce() -> T) -> T {
        struct Restore(Option<WorkControl>);
        impl Drop for Restore {
            fn drop(&mut self) {
                CURRENT_WORK.with(|work| *work.borrow_mut() = self.0.take());
            }
        }
        let _restore = Restore(CURRENT_WORK.with(|work| work.replace(Some(self.clone()))));
        action()
    }
}

pub fn mark_output_published() {
    CURRENT_WORK.with(|work| {
        if let Some(work) = work.borrow().as_ref() {
            work.output_published.store(true, std::sync::atomic::Ordering::Release);
        }
    });
}

pub fn check_work() -> Result<(), ErrorResponse> {
    account_work(0)
}

pub fn account_work(bytes: usize) -> Result<(), ErrorResponse> {
    CURRENT_WORK.with(|work| match work.borrow().as_ref() {
        Some(work) => work.account(bytes),
        None => Ok(()),
    })
}

pub fn reader_error(code: &str, message: impl Into<String>) -> ErrorResponse {
    ErrorResponse {
        error: code.to_string(),
        message: message.into(),
        available: None,
    }
}

pub fn serialize_json<T: serde::Serialize, W: io::Write>(
    writer: W,
    value: &T,
    pretty: bool,
) -> Result<usize, ErrorResponse> {
    struct JsonWriter<W> {
        inner: W,
        bytes: usize,
        unchecked_bytes: usize,
        stopped: Option<ErrorResponse>,
    }

    impl<W: io::Write> io::Write for JsonWriter<W> {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.unchecked_bytes >= BUFFER_BYTES {
                if let Err(error) = check_work() {
                    self.stopped = Some(error);
                    return Err(io::Error::other("历史序列化已停止"));
                }
                self.unchecked_bytes = 0;
            }
            let written = self.inner.write(&buffer[..buffer.len().min(BUFFER_BYTES)])?;
            self.bytes += written;
            #[cfg(test)]
            SERIALIZED_BYTES.with(|bytes| bytes.set(bytes.get() + written));
            self.unchecked_bytes = self.unchecked_bytes.saturating_add(written);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }

    check_work()?;
    let mut writer = JsonWriter {
        inner: writer,
        bytes: 0,
        unchecked_bytes: 0,
        stopped: None,
    };
    let serialized = if pretty {
        serde_json::to_writer_pretty(&mut writer, value)
    } else {
        serde_json::to_writer(&mut writer, value)
    };
    if let Some(error) = writer.stopped {
        return Err(error);
    }
    serialized.map_err(|error| reader_error("serialize_error", format!("历史 JSON 序列化失败: {error}")))?;
    check_work()?;
    Ok(writer.bytes)
}

fn io_error(error: io::Error) -> ErrorResponse {
    reader_error("io_error", format!("历史来源读取失败: {error}"))
}

#[derive(Clone, Copy, Debug)]
pub struct SourceSpan {
    pub start: u64,
    pub end: u64,
}

/// 行边界扫描可以停在一条记录中间，下一批从真实字节位置继续
pub struct RecordLines {
    reader: BufReader<File>,
    snapshot_end: u64,
    pub offset: u64,
    pub line: usize,
    start: u64,
    small: Vec<u8>,
    oversized: bool,
}

pub struct LocatedRecord {
    pub line: usize,
    pub span: SourceSpan,
    pub small: Option<Vec<u8>>,
}

pub enum LineStep {
    Record(LocatedRecord),
    Yield,
    End,
}

impl RecordLines {
    pub fn new(file: File, snapshot_end: u64) -> Self {
        Self {
            reader: BufReader::with_capacity(BUFFER_BYTES, file),
            snapshot_end,
            offset: 0,
            line: 0,
            start: 0,
            small: Vec::new(),
            oversized: false,
        }
    }

    pub fn step(&mut self, remaining: &mut u64, deadline: Instant) -> Result<LineStep, ErrorResponse> {
        loop {
            check_work()?;
            if self.offset == self.snapshot_end {
                return if self.offset > self.start {
                    Ok(LineStep::Record(self.finish()))
                } else {
                    Ok(LineStep::End)
                };
            }
            if *remaining == 0 || Instant::now() >= deadline {
                return Ok(LineStep::Yield);
            }
            let available = self.reader.fill_buf().map_err(io_error)?;
            if available.is_empty() {
                return Err(reader_error("source_changed", "来源被截短，扫描快照已失效"));
            }
            let allowed = available
                .len()
                .min((self.snapshot_end - self.offset).min(*remaining) as usize);
            let length = (&available[..allowed]).skip_until(b'\n').map_err(io_error)?;
            let end = available[length - 1] == b'\n';
            account_work(length)?;
            if !self.oversized && self.small.len().saturating_add(length) > MAX_JSONL_LINE_BYTES {
                self.oversized = true;
                self.small = Vec::new();
            }
            if !self.oversized {
                self.small.extend_from_slice(&available[..length]);
            }
            self.reader.consume(length);
            self.offset += length as u64;
            *remaining -= length as u64;
            if end {
                return Ok(LineStep::Record(self.finish()));
            }
        }
    }

    fn finish(&mut self) -> LocatedRecord {
        self.line += 1;
        let span = SourceSpan {
            start: self.start,
            end: self.offset,
        };
        self.start = self.offset;
        let small = (!self.oversized).then(|| std::mem::take(&mut self.small));
        self.oversized = false;
        LocatedRecord {
            line: self.line,
            span,
            small,
        }
    }

    pub fn recycle(&mut self, record: &mut LocatedRecord) {
        if let Some(mut buffer) = record.small.take()
            && buffer.capacity() <= MAX_JSONL_LINE_BYTES
        {
            debug_assert!(self.small.is_empty());
            buffer.clear();
            self.small = buffer;
        }
    }
}

enum SourceBacking {
    File(File),
    Text(Box<TextCursor>),
}

pub struct SourceReader {
    backing: SourceBacking,
    start: u64,
    end: u64,
    base: u64,
    buffer: Vec<u8>,
}

impl SourceReader {
    pub fn new(file: File, span: SourceSpan) -> Self {
        Self {
            backing: SourceBacking::File(file),
            start: span.start,
            end: span.end,
            base: span.start,
            buffer: Vec::new(),
        }
    }

    fn logical(cursor: TextCursor) -> Self {
        let end = cursor.len() as u64;
        Self {
            backing: SourceBacking::Text(Box::new(cursor)),
            start: 0,
            end,
            base: 0,
            buffer: Vec::new(),
        }
    }

    pub fn byte(&mut self, position: u64) -> Result<Option<u8>, ErrorResponse> {
        if position < self.start || position >= self.end {
            return Ok(None);
        }
        if position < self.base || position >= self.base + self.buffer.len() as u64 {
            check_work()?;
            self.buffer.resize(BUFFER_BYTES.min((self.end - position) as usize), 0);
            account_work(self.buffer.len())?;
            match &mut self.backing {
                SourceBacking::File(file) => {
                    file.seek(SeekFrom::Start(position)).map_err(io_error)?;
                    file.read_exact(&mut self.buffer).map_err(io_error)?;
                }
                SourceBacking::Text(cursor) => {
                    cursor.seek(position as usize)?;
                    cursor.read_exact(&mut self.buffer).map_err(io_error)?;
                }
            }
            self.base = position;
        }
        Ok(Some(self.buffer[(position - self.base) as usize]))
    }

    fn required(&mut self, position: u64) -> Result<u8, ErrorResponse> {
        self.byte(position)?
            .ok_or_else(|| reader_error("parse_error", "JSON 值没有完整结束"))
    }

    pub fn text(&mut self, span: SourceSpan, maximum: usize) -> Result<String, ErrorResponse> {
        let mut position = span.start + 1;
        let mut text = String::new();
        while position < span.end - 1 {
            let character = decode_character(self, &mut position)?;
            if text.len() + character.len_utf8() > maximum {
                return Err(reader_error(
                    "record_index_limit",
                    "JSON 元数据或对象键超出有界索引长度",
                ));
            }
            text.push(character);
        }
        Ok(text)
    }
}

fn hex_word(
    next: &mut impl FnMut() -> Result<char, ErrorResponse>,
    invalid: fn(&str) -> ErrorResponse,
) -> Result<u16, ErrorResponse> {
    let mut value = 0u16;
    for _ in 0..4 {
        let digit = next()?.to_digit(16).ok_or_else(|| invalid("JSON Unicode 转义无效"))?;
        value = value * 16 + digit as u16;
    }
    Ok(value)
}

fn decode_escape(
    mut next: impl FnMut() -> Result<char, ErrorResponse>,
    invalid: fn(&str) -> ErrorResponse,
) -> Result<char, ErrorResponse> {
    match next()? {
        '"' => Ok('"'),
        '\\' => Ok('\\'),
        '/' => Ok('/'),
        'b' => Ok('\u{8}'),
        'f' => Ok('\u{c}'),
        'n' => Ok('\n'),
        'r' => Ok('\r'),
        't' => Ok('\t'),
        'u' => {
            let high = hex_word(&mut next, invalid)?;
            let value = if (0xd800..=0xdbff).contains(&high) {
                if next()? != '\\' || next()? != 'u' {
                    return Err(invalid("JSON 高代理项缺少低代理项"));
                }
                let low = hex_word(&mut next, invalid)?;
                if !(0xdc00..=0xdfff).contains(&low) {
                    return Err(invalid("JSON 低代理项无效"));
                }
                0x10000 + ((high as u32 - 0xd800) << 10) + (low as u32 - 0xdc00)
            } else {
                high as u32
            };
            char::from_u32(value).ok_or_else(|| invalid("JSON Unicode 字符无效"))
        }
        _ => Err(invalid("JSON 转义无效")),
    }
}

fn decode_character(reader: &mut SourceReader, position: &mut u64) -> Result<char, ErrorResponse> {
    let first = reader.required(*position)?;
    *position += 1;
    if first == b'\\' {
        return decode_escape(
            || {
                let byte = reader.required(*position)?;
                *position += 1;
                Ok(byte as char)
            },
            |message| reader_error("parse_error", message),
        );
    }
    if first < 0x20 || first == b'"' {
        return Err(reader_error("parse_error", "JSON 字符串含未转义控制字符或引号"));
    }
    if first < 0x80 {
        return Ok(first as char);
    }
    let length = match first {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Err(reader_error("parse_error", "JSON UTF-8 无效")),
    };
    let mut bytes = [0; 4];
    bytes[0] = first;
    for byte in bytes.iter_mut().take(length).skip(1) {
        *byte = reader.required(*position)?;
        *position += 1;
    }
    std::str::from_utf8(&bytes[..length])
        .ok()
        .and_then(|text| text.chars().next())
        .ok_or_else(|| reader_error("parse_error", "JSON UTF-8 无效"))
}

#[derive(Debug)]
pub enum NodeKind {
    String {
        bytes: usize,
        chars: usize,
        json_bytes: usize,
    },
    Scalar(String),
    Array(Vec<usize>),
    Object(BTreeMap<String, usize>),
}

#[derive(Debug)]
pub struct JsonNode {
    pub span: SourceSpan,
    pub kind: NodeKind,
}

#[derive(Clone, Copy)]
enum Expect {
    KeyOrEnd,
    Key,
    Colon,
    Value,
    ValueOrEnd,
    CommaOrEnd,
}
struct Frame {
    node: usize,
    expect: Expect,
    key: Option<String>,
}
struct StringToken {
    start: u64,
    bytes: usize,
    chars: usize,
    json_bytes: usize,
    key: bool,
}

/// 索引仅保存字段名与源跨度，长字符串的值保留在原始来源
pub struct JsonIndex {
    reader: SourceReader,
    position: u64,
    nodes: Vec<JsonNode>,
    stack: Vec<Frame>,
    string: Option<StringToken>,
    root: Option<usize>,
    complete: bool,
    key_bytes: usize,
}

impl JsonIndex {
    pub fn new(file: File, span: SourceSpan) -> Self {
        Self {
            reader: SourceReader::new(file, span),
            position: span.start,
            nodes: Vec::new(),
            stack: Vec::new(),
            string: None,
            root: None,
            complete: false,
            key_bytes: 0,
        }
    }

    fn logical(cursor: TextCursor) -> Self {
        Self {
            reader: SourceReader::logical(cursor),
            position: 0,
            nodes: Vec::new(),
            stack: Vec::new(),
            string: None,
            root: None,
            complete: false,
            key_bytes: 0,
        }
    }

    fn payload_error(&mut self) -> Result<bool, ErrorResponse> {
        let Some(root) = self.root else {
            return Ok(false);
        };
        node_payload_error(&mut self.reader, &self.nodes, root)
    }

    pub fn advance(&mut self, remaining: &mut u64, deadline: Instant) -> Result<bool, ErrorResponse> {
        let begin = self.position;
        loop {
            check_work()?;
            let spent = self.position - begin;
            if spent >= *remaining || Instant::now() >= deadline {
                *remaining = remaining.saturating_sub(spent);
                return Ok(false);
            }
            if let Some(mut token) = self.string.take() {
                while self.reader.byte(self.position)? != Some(b'"') {
                    if self.position - begin >= *remaining || Instant::now() >= deadline {
                        self.string = Some(token);
                        *remaining = remaining.saturating_sub(self.position - begin);
                        return Ok(false);
                    }
                    let offset = (self.position - self.reader.base) as usize;
                    let available = &self.reader.buffer[offset..];
                    let allowed = available.len().min((*remaining - (self.position - begin)) as usize);
                    let length = available[..allowed]
                        .iter()
                        .position(|byte| *byte < 0x20 || matches!(byte, b'"' | b'\\'))
                        .unwrap_or(allowed);
                    let text = match std::str::from_utf8(&available[..length]) {
                        Ok(text) => text,
                        Err(error) => {
                            std::str::from_utf8(&available[..error.valid_up_to()]).expect("validated UTF-8 prefix")
                        }
                    };
                    let length = text.len();
                    if length > 0 {
                        self.position += length as u64;
                        token.bytes = token
                            .bytes
                            .checked_add(length)
                            .ok_or_else(|| reader_error("record_index_limit", "文本长度溢出"))?;
                        token.chars += text.chars().count();
                        token.json_bytes += length;
                    } else {
                        let character = decode_character(&mut self.reader, &mut self.position)?;
                        token.bytes = token
                            .bytes
                            .checked_add(character.len_utf8())
                            .ok_or_else(|| reader_error("record_index_limit", "文本长度溢出"))?;
                        token.chars += 1;
                        token.json_bytes += json_character_length(character);
                    }
                }
                self.position += 1;
                let span = SourceSpan {
                    start: token.start,
                    end: self.position,
                };
                if token.key {
                    let key = self.reader.text(span, MAX_KEY_BYTES)?;
                    self.key_bytes += key.len();
                    if self.key_bytes > 4 * 1024 * 1024 {
                        return Err(reader_error("record_index_limit", "JSON 对象键超出 4 MiB 索引预算"));
                    }
                    let frame = self.stack.last_mut().expect("object key frame exists");
                    frame.key = Some(key);
                    frame.expect = Expect::Colon;
                } else {
                    self.add_node(JsonNode {
                        span,
                        kind: NodeKind::String {
                            bytes: token.bytes,
                            chars: token.chars,
                            json_bytes: token.json_bytes + 2,
                        },
                    })?;
                }
                continue;
            }
            let Some(byte) = self.reader.byte(self.position)? else {
                *remaining = remaining.saturating_sub(self.position - begin);
                if self.root.is_none() || !self.stack.is_empty() {
                    return Err(reader_error("parse_error", "JSON 容器没有完整结束"));
                }
                self.complete = true;
                return Ok(true);
            };
            if byte.is_ascii_whitespace() {
                self.position += 1;
                continue;
            }
            if self.root.is_some() && self.stack.is_empty() {
                return Err(reader_error("parse_error", "JSON 根值后有额外内容"));
            }
            let expectation = self.stack.last().map(|frame| frame.expect).unwrap_or(Expect::Value);
            match expectation {
                Expect::Colon => {
                    if byte != b':' {
                        return Err(reader_error("parse_error", "JSON 对象键后缺少冒号"));
                    }
                    self.position += 1;
                    self.stack.last_mut().unwrap().expect = Expect::Value;
                }
                Expect::CommaOrEnd => {
                    let frame = self.stack.last().unwrap();
                    let closing = match self.nodes[frame.node].kind {
                        NodeKind::Object(_) => b'}',
                        _ => b']',
                    };
                    if byte == closing {
                        self.close_container();
                    } else if byte == b',' {
                        self.position += 1;
                        self.stack.last_mut().unwrap().expect =
                            if closing == b'}' { Expect::Key } else { Expect::Value };
                    } else {
                        return Err(reader_error("parse_error", "JSON 容器缺少逗号或结束符"));
                    }
                }
                Expect::Key | Expect::KeyOrEnd => {
                    if byte == b'}' && matches!(expectation, Expect::KeyOrEnd) {
                        self.close_container();
                    } else if byte == b'"' {
                        self.start_string(true);
                    } else {
                        return Err(reader_error("parse_error", "JSON 对象键必须是字符串"));
                    }
                }
                Expect::Value | Expect::ValueOrEnd => {
                    if byte == b']' && matches!(expectation, Expect::ValueOrEnd) {
                        self.close_container();
                        continue;
                    }
                    match byte {
                        b'"' => self.start_string(false),
                        b'{' | b'[' => {
                            if self.stack.len() >= 128 {
                                return Err(reader_error("record_index_limit", "JSON 嵌套超过 128 层"));
                            }
                            let node = self.add_node(JsonNode {
                                span: SourceSpan {
                                    start: self.position,
                                    end: self.position,
                                },
                                kind: if byte == b'{' {
                                    NodeKind::Object(BTreeMap::new())
                                } else {
                                    NodeKind::Array(Vec::new())
                                },
                            })?;
                            self.stack.push(Frame {
                                node,
                                expect: if byte == b'{' {
                                    Expect::KeyOrEnd
                                } else {
                                    Expect::ValueOrEnd
                                },
                                key: None,
                            });
                            self.position += 1;
                        }
                        b'n' | b't' | b'f' | b'-' | b'0'..=b'9' => {
                            let start = self.position;
                            let mut scalar = Vec::new();
                            while let Some(byte) = self.reader.byte(self.position)? {
                                if byte.is_ascii_whitespace() || matches!(byte, b',' | b']' | b'}') {
                                    break;
                                }
                                if scalar.len() == 128 {
                                    return Err(reader_error("record_index_limit", "JSON 数字超出索引预算"));
                                }
                                scalar.push(byte);
                                self.position += 1;
                            }
                            let value: serde_json::Value = serde_json::from_slice(&scalar)
                                .map_err(|_| reader_error("parse_error", "JSON 标量无效"))?;
                            if matches!(
                                value,
                                serde_json::Value::Array(_)
                                    | serde_json::Value::Object(_)
                                    | serde_json::Value::String(_)
                            ) {
                                return Err(reader_error("parse_error", "JSON 标量类型无效"));
                            }
                            self.add_node(JsonNode {
                                span: SourceSpan {
                                    start,
                                    end: self.position,
                                },
                                kind: NodeKind::Scalar(value.to_string()),
                            })?;
                        }
                        _ => return Err(reader_error("parse_error", "JSON 值无效")),
                    }
                }
            }
        }
    }

    fn add_node(&mut self, node: JsonNode) -> Result<usize, ErrorResponse> {
        if self.nodes.len() == MAX_INDEX_NODES {
            return Err(reader_error("record_index_limit", "JSON 索引超过 65536 个节点"));
        }
        let index = self.nodes.len();
        self.nodes.push(node);
        if let Some(frame) = self.stack.last_mut() {
            match &mut self.nodes[frame.node].kind {
                NodeKind::Object(children) => {
                    children.insert(frame.key.take().expect("object value key exists"), index);
                }
                NodeKind::Array(children) => children.push(index),
                _ => unreachable!(),
            }
            frame.expect = Expect::CommaOrEnd;
        } else {
            self.root = Some(index);
        }
        Ok(index)
    }

    fn start_string(&mut self, key: bool) {
        self.string = Some(StringToken {
            start: self.position,
            bytes: 0,
            chars: 0,
            json_bytes: 0,
            key,
        });
        self.position += 1;
    }

    fn close_container(&mut self) {
        self.position += 1;
        let frame = self.stack.pop().unwrap();
        self.nodes[frame.node].span.end = self.position;
    }

    pub fn finish(mut self, with_metadata: bool) -> Result<IndexedRecord, ErrorResponse> {
        if !self.complete {
            return Err(reader_error("scan_in_progress", "JSON 索引尚未读取完成"));
        }
        let root = self.root.ok_or_else(|| reader_error("parse_error", "JSON 根值为空"))?;
        if !with_metadata {
            return Ok(IndexedRecord {
                nodes: self.nodes,
                root,
                metadata: None,
            });
        }
        if !matches!(self.nodes[root].kind, NodeKind::Object(_)) {
            return Err(reader_error("parse_error", "历史记录必须是 JSON 对象"));
        }
        let uuid = string_field(&mut self.reader, &self.nodes, root, "uuid")?;
        let msg_type = string_field(&mut self.reader, &self.nodes, root, "type")?;
        let timestamp = string_field(&mut self.reader, &self.nodes, root, "timestamp")?;
        if crate::utils::is_internal_record(
            msg_type.as_deref(),
            child(&self.nodes, root, "uuid").is_some(),
            child(&self.nodes, root, "message").is_some(),
        ) {
            return Ok(IndexedRecord {
                nodes: self.nodes,
                root,
                metadata: None,
            });
        }
        if matches!(msg_type.as_deref(), Some("user" | "assistant")) && child(&self.nodes, root, "message").is_none() {
            return Err(reader_error("parse_error", "消息缺少 message"));
        }
        let metadata = MessageRecord {
            uuid: uuid.ok_or_else(|| reader_error("parse_error", "消息缺少 uuid"))?,
            msg_type: msg_type.ok_or_else(|| reader_error("parse_error", "消息缺少 type"))?,
            timestamp: timestamp.ok_or_else(|| reader_error("parse_error", "消息缺少 timestamp"))?,
            message: None,
            is_compact_summary: boolean_field(&self.nodes, root, "isCompactSummary"),
            is_meta: boolean_field(&self.nodes, root, "isMeta"),
            parent_uuid: string_field(&mut self.reader, &self.nodes, root, "parentUuid")?,
            source_tool_assistant_uuid: string_field(&mut self.reader, &self.nodes, root, "sourceToolAssistantUUID")?
                .or(string_field(
                    &mut self.reader,
                    &self.nodes,
                    root,
                    "sourceToolAssistantUuid",
                )?),
        };
        Ok(IndexedRecord {
            nodes: self.nodes,
            root,
            metadata: Some(metadata),
        })
    }
}

fn string_field(
    reader: &mut SourceReader,
    nodes: &[JsonNode],
    node: usize,
    key: &str,
) -> Result<Option<String>, ErrorResponse> {
    child(nodes, node, key)
        .filter(|index| matches!(nodes[*index].kind, NodeKind::String { .. }))
        .map(|index| reader.text(nodes[index].span, MAX_KEY_BYTES))
        .transpose()
}

fn boolean_field(nodes: &[JsonNode], node: usize, key: &str) -> bool {
    child(nodes, node, key)
        .is_some_and(|index| matches!(&nodes[index].kind, NodeKind::Scalar(value) if value == "true"))
}

pub fn child(nodes: &[JsonNode], node: usize, key: &str) -> Option<usize> {
    match &nodes[node].kind {
        NodeKind::Object(children) => children.get(key).copied(),
        _ => None,
    }
}

fn node_payload_error(reader: &mut SourceReader, nodes: &[JsonNode], root: usize) -> Result<bool, ErrorResponse> {
    if child(nodes, root, "success")
        .is_some_and(|index| matches!(&nodes[index].kind, NodeKind::Scalar(value) if value == "false"))
        || boolean_field(nodes, root, "isError")
        || boolean_field(nodes, root, "is_error")
    {
        return Ok(true);
    }
    let Some(error) = child(nodes, root, "error") else {
        return Ok(false);
    };
    match &nodes[error].kind {
        NodeKind::Scalar(value) if value == "null" => Ok(false),
        NodeKind::String { .. } => {
            let mut position = nodes[error].span.start + 1;
            while position < nodes[error].span.end - 1 {
                if !decode_character(reader, &mut position)?.is_whitespace() {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(true),
    }
}

fn json_character_length(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
        '\u{0}'..='\u{1f}' => 6,
        _ => character.len_utf8(),
    }
}

fn encode_json_character(character: char, output: &mut Vec<u8>) {
    match character {
        '"' => output.extend_from_slice(b"\\\""),
        '\\' => output.extend_from_slice(b"\\\\"),
        '\u{8}' => output.extend_from_slice(b"\\b"),
        '\u{c}' => output.extend_from_slice(b"\\f"),
        '\n' => output.extend_from_slice(b"\\n"),
        '\r' => output.extend_from_slice(b"\\r"),
        '\t' => output.extend_from_slice(b"\\t"),
        '\u{0}'..='\u{1f}' => {
            let value = character as u8;
            const HEX: &[u8] = b"0123456789abcdef";
            output.extend_from_slice(&[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(value >> 4) as usize],
                HEX[(value & 15) as usize],
            ]);
        }
        _ => {
            let mut encoded = [0; 4];
            output.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
        }
    }
}

pub struct IndexedRecord {
    pub nodes: Vec<JsonNode>,
    pub root: usize,
    pub metadata: Option<MessageRecord>,
}

#[derive(Clone, Debug)]
enum TextPart {
    Literal(String),
    String {
        span: SourceSpan,
        length: usize,
        canonical: bool,
    },
}

#[derive(Clone, Debug, Default)]
pub struct TextProjection {
    parts: Vec<TextPart>,
    pub length: usize,
    pub characters: usize,
    redactions: Option<Vec<RedactionSpan>>,
    pub images: Vec<ImageInfo>,
}

impl TextProjection {
    fn literal(&mut self, value: impl Into<String>) {
        let value = value.into();
        self.length += value.len();
        self.characters += value.chars().count();
        self.parts.push(TextPart::Literal(value));
    }

    fn string(&mut self, node: &JsonNode, canonical: bool) {
        if let NodeKind::String {
            bytes,
            chars,
            json_bytes,
        } = &node.kind
        {
            if canonical {
                self.literal("\"");
            }
            let length = if canonical { json_bytes - 2 } else { *bytes };
            self.length += length;
            self.characters += chars + if canonical { json_bytes - bytes - 2 } else { 0 };
            self.parts.push(TextPart::String {
                span: node.span,
                length,
                canonical,
            });
            if canonical {
                self.literal("\"");
            }
        }
    }

    fn canonical(&mut self, record: &IndexedRecord, index: usize) -> Result<(), ErrorResponse> {
        check_work()?;
        match &record.nodes[index].kind {
            NodeKind::String { .. } => self.string(&record.nodes[index], true),
            NodeKind::Scalar(value) => self.literal(value),
            NodeKind::Array(children) => {
                self.literal("[");
                for (position, index) in children.iter().enumerate() {
                    if position > 0 {
                        self.literal(",");
                    }
                    self.canonical(record, *index)?;
                }
                self.literal("]");
            }
            NodeKind::Object(children) => {
                self.literal("{");
                for (position, (key, index)) in children.iter().enumerate() {
                    if position > 0 {
                        self.literal(",");
                    }
                    self.literal(serde_json::to_string(key).expect("string serializable"));
                    self.literal(":");
                    self.canonical(record, *index)?;
                }
                self.literal("}");
            }
        }
        Ok(())
    }

    pub fn cursor(self, file: File, span: SourceSpan) -> TextCursor {
        TextCursor::new(self, file, span)
    }
}

fn project_structured_node(
    record: &IndexedRecord,
    file: &File,
    span: SourceSpan,
    index: usize,
    mode: crate::utils::RedactionMode,
    projection: &mut TextProjection,
    edits: &mut Vec<RedactionSpan>,
) -> Result<(), ErrorResponse> {
    check_work()?;
    match &record.nodes[index].kind {
        NodeKind::Scalar(value) => projection.literal(value),
        NodeKind::Array(children) => {
            projection.literal("[");
            for (position, child) in children.iter().enumerate() {
                if position > 0 {
                    projection.literal(",");
                }
                project_structured_node(record, file, span, *child, mode, projection, edits)?;
            }
            projection.literal("]");
        }
        NodeKind::Object(children) => {
            projection.literal("{");
            for (position, (key, child)) in children.iter().enumerate() {
                if position > 0 {
                    projection.literal(",");
                }
                projection.literal(serde_json::to_string(key).expect("string serializable"));
                projection.literal(":");
                if mode.enabled() && crate::utils::is_sensitive_key(&key.to_ascii_lowercase(), mode) {
                    let start = projection.length;
                    projection.canonical(record, *child)?;
                    add_redaction(edits, start, projection.length, "\"[redacted]\"")?;
                } else {
                    project_structured_node(record, file, span, *child, mode, projection, edits)?;
                }
            }
            projection.literal("}");
        }
        NodeKind::String { .. } => {
            let start = projection.length + 1;
            projection.string(&record.nodes[index], true);
            if mode.enabled() {
                let mut decoded = TextProjection::default();
                decoded.string(&record.nodes[index], false);
                let mut text = TextBytes::new(decoded.cursor(file.try_clone().map_err(io_error)?, span));
                let source_edits = redaction_spans(&mut text, mode)?;
                let mut position = 0;
                let mut canonical = start;
                let mut encoded = Vec::with_capacity(6);
                for edit in source_edits {
                    while position < edit.start {
                        let (character, width) = character_at(&mut text, position)?;
                        encoded.clear();
                        encode_json_character(character, &mut encoded);
                        canonical += encoded.len();
                        position += width;
                    }
                    let edit_start = canonical;
                    while position < edit.end {
                        let (character, width) = character_at(&mut text, position)?;
                        encoded.clear();
                        encode_json_character(character, &mut encoded);
                        canonical += encoded.len();
                        position += width;
                    }
                    let replacement = if edit.replacement == "\"[redacted]\"" {
                        "\\\"[redacted]\\\""
                    } else {
                        edit.replacement
                    };
                    add_redaction(edits, edit_start, canonical, replacement)?;
                }
            }
        }
    }
    Ok(())
}

impl IndexedRecord {
    fn tool_node(&self, reader: &mut SourceReader, view: &str, block: Option<usize>) -> Result<usize, ErrorResponse> {
        let kind = match view {
            "tool_input" => "tool_use",
            "tool_result" => "tool_result",
            _ => return Err(invalid_arguments("view 仅支持 content、tool_input、tool_result")),
        };
        let content = child(&self.nodes, self.root, "message")
            .and_then(|message| child(&self.nodes, message, "content"))
            .ok_or_else(|| reader_error("block_not_found", "消息没有结构化工具块"))?;
        let NodeKind::Array(items) = &self.nodes[content].kind else {
            return Err(reader_error("block_not_found", "消息没有结构化工具块"));
        };
        let mut selected = None;
        for (position, item) in items.iter().enumerate() {
            if string_field(reader, &self.nodes, *item, "type")?.as_deref() == Some(kind)
                && block.is_none_or(|block| block == position)
            {
                if selected.is_some() {
                    return Err(invalid_arguments(
                        "消息包含多个工具块，请使用 block 指定原始 content 数组下标",
                    ));
                }
                selected = Some(*item);
            }
        }
        let selected = selected.ok_or_else(|| reader_error("block_not_found", "指定工具块不存在或类型不匹配"))?;
        if kind == "tool_use" {
            child(&self.nodes, selected, "input").ok_or_else(|| reader_error("block_not_found", "工具块没有 input"))
        } else {
            Ok(selected)
        }
    }

    pub fn structured_projection(
        &self,
        file: File,
        span: SourceSpan,
        view: &str,
        block: Option<usize>,
        mode: crate::utils::RedactionMode,
    ) -> Result<TextProjection, ErrorResponse> {
        let mut reader = SourceReader::new(file.try_clone().map_err(io_error)?, span);
        let node = if view == "record" {
            if block.is_some() {
                return Err(invalid_arguments("block 需要 view=tool_input 或 tool_result"));
            }
            if !matches!(self.nodes[self.root].kind, NodeKind::Object(_)) {
                return Err(reader_error("parse_error", "原记录必须为 JSON 对象"));
            }
            self.root
        } else {
            self.tool_node(&mut reader, view, block)?
        };
        let mut projection = TextProjection::default();
        let mut edits = Vec::new();
        project_structured_node(self, &file, span, node, mode, &mut projection, &mut edits)?;
        projection.redactions = Some(edits);
        Ok(projection)
    }

    pub fn tool_result_preview(
        &self,
        file: File,
        span: SourceSpan,
        block: usize,
        mode: crate::utils::RedactionMode,
        maximum: usize,
    ) -> Result<(String, usize), ErrorResponse> {
        let mut reader = SourceReader::new(file.try_clone().map_err(io_error)?, span);
        let block = self.tool_node(&mut reader, "tool_result", Some(block))?;
        let node = child(&self.nodes, block, "content").unwrap_or(block);
        let mut projection = TextProjection::default();
        if matches!(self.nodes[node].kind, NodeKind::String { .. }) {
            projection.string(&self.nodes[node], false);
        } else {
            let mut edits = Vec::new();
            project_structured_node(self, &file, span, node, mode, &mut projection, &mut edits)?;
            projection.redactions = Some(edits);
        }
        let mut text = TextBytes::new(projection.cursor(file, span));
        let mut preview = String::new();
        let mut characters = 0;
        let (_, _, count) = render_text_range(&mut text, mode, None, |chunk| {
            for character in std::str::from_utf8(chunk)
                .map_err(|_| reader_error("parse_error", "工具结果 UTF-8 无效"))?
                .chars()
                .take(maximum.saturating_sub(characters))
            {
                preview.push(character);
                characters += 1;
            }
            Ok(())
        })?;
        Ok((preview, count))
    }

    pub fn classify(&self, file: File, span: SourceSpan) -> Result<(&'static str, &'static str), ErrorResponse> {
        let Some(metadata) = self.metadata.as_ref() else {
            return Ok(("other", "other"));
        };
        if metadata.is_compact_summary {
            return Ok(("summary", "summary"));
        }
        match metadata.msg_type.as_str() {
            "user" if metadata.is_meta => Ok(("user", "meta")),
            "system" => Ok(("system", "system")),
            "user" | "assistant" => {
                let content =
                    child(&self.nodes, self.root, "message").and_then(|message| child(&self.nodes, message, "content"));
                let mut reader = SourceReader::new(file, span);
                let mut has_text = false;
                let mut has_use = false;
                let mut has_result = false;
                let mut has_thinking = false;
                if let Some(content) = content {
                    match &self.nodes[content].kind {
                        NodeKind::String { chars, .. } => has_text = *chars > 0,
                        NodeKind::Array(items) => {
                            for item in items {
                                match string_field(&mut reader, &self.nodes, *item, "type")?.as_deref() {
                                    Some("tool_use") => has_use = true,
                                    Some("tool_result") => has_result = true,
                                    Some("thinking") => has_thinking = true,
                                    Some("text") => {
                                        has_text |= child(&self.nodes, *item, "text").is_some_and(|index| {
                                            matches!(self.nodes[index].kind, NodeKind::String { chars: 1.., .. })
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if metadata.msg_type == "user" {
                    Ok(("user", if has_result { "tool_result" } else { "human" }))
                } else {
                    Ok((
                        "assistant",
                        if has_text {
                            "text"
                        } else if has_use {
                            "tool_use"
                        } else if has_thinking {
                            "thinking"
                        } else {
                            "empty"
                        },
                    ))
                }
            }
            _ => Ok(("other", "other")),
        }
    }

    fn payload_text_error(&self, file: File, span: SourceSpan, node: usize) -> Result<bool, ErrorResponse> {
        let mut projection = TextProjection::default();
        projection.string(&self.nodes[node], false);
        let mut index = JsonIndex::logical(projection.cursor(file, span));
        let mut remaining = u64::MAX;
        loop {
            match index.advance(&mut remaining, Instant::now() + Duration::from_secs(120)) {
                Ok(true) => return index.payload_error(),
                Ok(false) => {}
                Err(error) if error.error == "parse_error" => return Ok(false),
                Err(error) => return Err(error),
            }
        }
    }

    pub fn association_record(
        &self,
        file: File,
        span: SourceSpan,
        payload_errors: bool,
    ) -> Result<MessageRecord, ErrorResponse> {
        let mut metadata = self
            .metadata
            .clone()
            .ok_or_else(|| reader_error("parse_error", "目标行不是消息记录"))?;
        let content =
            child(&self.nodes, self.root, "message").and_then(|message| child(&self.nodes, message, "content"));
        let Some(content) = content else {
            return Ok(metadata);
        };
        let NodeKind::Array(items) = &self.nodes[content].kind else {
            return Ok(metadata);
        };
        let mut reader = SourceReader::new(file.try_clone().map_err(io_error)?, span);
        let mut blocks = Vec::with_capacity(items.len());
        for item in items {
            let kind = string_field(&mut reader, &self.nodes, *item, "type")?.unwrap_or_default();
            let mut block = serde_json::Map::new();
            block.insert("type".to_string(), serde_json::Value::String(kind.clone()));
            for key in ["id", "name", "tool_use_id"] {
                if let Some(value) = string_field(&mut reader, &self.nodes, *item, key)? {
                    block.insert(key.to_string(), serde_json::Value::String(value));
                }
            }
            if let Some(error) = child(&self.nodes, *item, "is_error")
                && let NodeKind::Scalar(value) = &self.nodes[error].kind
                && matches!(value.as_str(), "true" | "false")
            {
                block.insert("is_error".to_string(), serde_json::Value::Bool(value == "true"));
            }
            if kind == "tool_result" && payload_errors {
                let mut error = false;
                if let Some(result) = child(&self.nodes, *item, "content") {
                    match &self.nodes[result].kind {
                        NodeKind::String { .. } => {
                            error = self.payload_text_error(file.try_clone().map_err(io_error)?, span, result)?
                        }
                        NodeKind::Array(children) => {
                            for child_index in children {
                                if node_payload_error(&mut reader, &self.nodes, *child_index)? {
                                    error = true;
                                    break;
                                }
                                if let Some(text) = child(&self.nodes, *child_index, "text")
                                    .filter(|text| matches!(self.nodes[*text].kind, NodeKind::String { .. }))
                                    && self.payload_text_error(file.try_clone().map_err(io_error)?, span, text)?
                                {
                                    error = true;
                                    break;
                                }
                            }
                        }
                        _ => error = node_payload_error(&mut reader, &self.nodes, result)?,
                    }
                }
                block.insert("content".to_string(), serde_json::json!({"success": !error}));
            }
            blocks.push(serde_json::Value::Object(block));
        }
        metadata.message = Some(serde_json::json!({"content": blocks}));
        Ok(metadata)
    }

    pub fn image_sources(
        &self,
        file: File,
        span: SourceSpan,
    ) -> Result<Vec<(usize, TextProjection, String)>, ErrorResponse> {
        let mut reader = SourceReader::new(file, span);
        let content =
            child(&self.nodes, self.root, "message").and_then(|message| child(&self.nodes, message, "content"));
        let Some(content) = content else {
            return Ok(Vec::new());
        };
        let NodeKind::Array(items) = &self.nodes[content].kind else {
            return Ok(Vec::new());
        };
        let mut images = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if string_field(&mut reader, &self.nodes, *item, "type")?.as_deref() != Some("image") {
                continue;
            }
            let Some(source) = child(&self.nodes, *item, "source") else {
                continue;
            };
            let Some(data) = child(&self.nodes, source, "data")
                .filter(|data| matches!(self.nodes[*data].kind, NodeKind::String { .. }))
            else {
                continue;
            };
            let media = string_field(&mut reader, &self.nodes, source, "media_type")?;
            let extension = match media.as_deref() {
                Some("image/jpeg" | "image/jpg") => "jpg",
                Some("image/gif") => "gif",
                Some("image/webp") => "webp",
                _ => "png",
            };
            let mut projection = TextProjection::default();
            projection.string(&self.nodes[data], false);
            images.push((index, projection, extension.to_string()));
        }
        Ok(images)
    }

    pub fn projection(
        &self,
        file: File,
        span: SourceSpan,
        view: &str,
        block: Option<usize>,
    ) -> Result<TextProjection, ErrorResponse> {
        let mut reader = SourceReader::new(file, span);
        let Some(message) = child(&self.nodes, self.root, "message") else {
            return Ok(TextProjection::default());
        };
        let Some(content) = child(&self.nodes, message, "content") else {
            return Ok(TextProjection::default());
        };
        let mut projection = TextProjection::default();
        if view != "content" {
            let selected = self.tool_node(&mut reader, view, block)?;
            projection.canonical(self, selected)?;
            return Ok(projection);
        }
        if block.is_some() {
            return Err(invalid_arguments("block 需要 view=tool_input 或 tool_result"));
        }
        if matches!(self.nodes[content].kind, NodeKind::String { .. }) {
            projection.string(&self.nodes[content], false);
            return Ok(projection);
        }
        let NodeKind::Array(items) = &self.nodes[content].kind else {
            return Ok(projection);
        };
        let mut parts = 0usize;
        for (position, item) in items.iter().enumerate() {
            let kind = string_field(&mut reader, &self.nodes, *item, "type")?.unwrap_or_default();
            let mut add_separator = |projection: &mut TextProjection| {
                if parts > 0 {
                    projection.literal("\n");
                }
                parts += 1;
            };
            match kind.as_str() {
                "image" => {
                    if let Some(source) = child(&self.nodes, *item, "source") {
                        let size = child(&self.nodes, source, "data").map_or(0, |data| match self.nodes[data].kind {
                            NodeKind::String { bytes, .. } => bytes,
                            _ => 0,
                        });
                        add_separator(&mut projection);
                        projection.literal(format!(
                            "[IMAGE:{position} size={:.1}MB]",
                            size as f64 / 1024.0 / 1024.0
                        ));
                        projection.images.push(ImageInfo { index: position, size });
                    }
                }
                "tool_use" => {
                    let name =
                        string_field(&mut reader, &self.nodes, *item, "name")?.unwrap_or_else(|| "unknown".to_string());
                    add_separator(&mut projection);
                    projection.literal(format!("[TOOL_USE:{name}("));
                    if let Some(input) = child(&self.nodes, *item, "input") {
                        projection.canonical(self, input)?;
                    }
                    projection.literal(")]");
                }
                "tool_result" => {
                    if let Some(result) = child(&self.nodes, *item, "content") {
                        match &self.nodes[result].kind {
                            NodeKind::String { .. } => {
                                add_separator(&mut projection);
                                projection.string(&self.nodes[result], false);
                            }
                            NodeKind::Array(children) => {
                                for child_index in children {
                                    if let Some(text) = child(&self.nodes, *child_index, "text")
                                        .filter(|text| matches!(self.nodes[*text].kind, NodeKind::String { .. }))
                                    {
                                        add_separator(&mut projection);
                                        projection.string(&self.nodes[text], false);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {
                    if let Some(text) = child(&self.nodes, *item, "text")
                        .filter(|text| matches!(self.nodes[*text].kind, NodeKind::String { .. }))
                    {
                        add_separator(&mut projection);
                        projection.string(&self.nodes[text], false);
                    }
                }
            }
        }
        Ok(projection)
    }
}

pub struct TextCursor {
    projection: TextProjection,
    reader: SourceReader,
    part: usize,
    within: usize,
    raw: u64,
    pending: Vec<u8>,
    pending_position: usize,
    position: usize,
    starts: Vec<usize>,
    checkpoints: BTreeMap<usize, (usize, usize, u64)>,
    checkpoint_stride: usize,
    next_checkpoint: usize,
}

impl TextCursor {
    fn new(projection: TextProjection, file: File, span: SourceSpan) -> Self {
        let mut offset = 0;
        let starts = projection
            .parts
            .iter()
            .map(|part| {
                let start = offset;
                offset += match part {
                    TextPart::Literal(text) => text.len(),
                    TextPart::String { length, .. } => *length,
                };
                start
            })
            .collect();
        let checkpoint_stride = (projection.length / 1024 + 1).max(BUFFER_BYTES);
        Self {
            projection,
            reader: SourceReader::new(file, span),
            part: 0,
            within: 0,
            raw: 0,
            pending: Vec::with_capacity(6),
            pending_position: 0,
            position: 0,
            starts,
            checkpoints: BTreeMap::new(),
            checkpoint_stride,
            next_checkpoint: 0,
        }
    }
    pub fn len(&self) -> usize {
        self.projection.length
    }

    pub fn next_byte(&mut self) -> Result<Option<u8>, ErrorResponse> {
        while self.part < self.projection.parts.len() {
            match &self.projection.parts[self.part] {
                TextPart::Literal(text) => {
                    if let Some(byte) = text.as_bytes().get(self.within) {
                        self.within += 1;
                        self.position += 1;
                        return Ok(Some(*byte));
                    }
                }
                TextPart::String {
                    span,
                    length,
                    canonical,
                } => {
                    if self.within < *length {
                        if self.within == 0 {
                            self.raw = span.start + 1;
                        }
                        if self.pending_position == self.pending.len() {
                            self.pending.clear();
                            self.reader.required(self.raw)?;
                            let offset = (self.raw - self.reader.base) as usize;
                            let available = &self.reader.buffer[offset..];
                            let allowed = available
                                .len()
                                .min(span.end.saturating_sub(self.raw).saturating_sub(1) as usize)
                                .min(*length - self.within);
                            let count = available[..allowed]
                                .iter()
                                .position(|byte| !byte.is_ascii() || *byte < 0x20 || matches!(byte, b'"' | b'\\'))
                                .unwrap_or(allowed);
                            if count > 0 {
                                self.pending.extend_from_slice(&available[..count]);
                                self.raw += count as u64;
                            } else {
                                let character = decode_character(&mut self.reader, &mut self.raw)?;
                                if *canonical {
                                    encode_json_character(character, &mut self.pending);
                                } else {
                                    let mut encoded = [0; 4];
                                    self.pending
                                        .extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
                                }
                            }
                            self.pending_position = 0;
                        }
                        let byte = self.pending[self.pending_position];
                        self.pending_position += 1;
                        self.within += 1;
                        self.position += 1;
                        if self.pending_position == self.pending.len()
                            && self.checkpoints.len() < 1024
                            && self.position >= self.next_checkpoint
                        {
                            self.checkpoints
                                .insert(self.position, (self.part, self.within, self.raw));
                            self.next_checkpoint = self.position.saturating_add(self.checkpoint_stride);
                        }
                        return Ok(Some(byte));
                    }
                }
            }
            self.part += 1;
            self.within = 0;
            self.pending.clear();
            self.pending_position = 0;
        }
        Ok(None)
    }

    pub fn seek(&mut self, position: usize) -> Result<(), ErrorResponse> {
        if position > self.len() {
            return Err(invalid_arguments("文本位置越界"));
        }
        if position == self.position {
            return Ok(());
        }
        let part = self
            .starts
            .partition_point(|start| *start <= position)
            .saturating_sub(1);
        if position < self.position || part != self.part {
            self.part = part;
            self.within = 0;
            self.position = self.starts.get(part).copied().unwrap_or(0);
            self.raw = 0;
            self.pending.clear();
            self.pending_position = 0;
            if let Some((&offset, &(saved_part, within, raw))) = self.checkpoints.range(..=position).next_back()
                && saved_part == part
            {
                self.position = offset;
                self.within = within;
                self.raw = raw;
            }
            if let Some(TextPart::Literal(text)) = self.projection.parts.get(part) {
                self.within = (position - self.position).min(text.len());
                self.position += self.within;
            }
        }
        self.next_checkpoint = self
            .checkpoints
            .range(..=self.position)
            .next_back()
            .map_or(0, |(previous, _)| previous.saturating_add(self.checkpoint_stride));
        while self.position < position {
            self.next_byte()?
                .ok_or_else(|| reader_error("parse_error", "逻辑正文比索引短"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn read_text(&mut self, maximum: usize) -> Result<String, ErrorResponse> {
        if self.len() > maximum {
            return Err(reader_error(
                "content_too_large",
                "逻辑正文超出当前读取预算，请指定 range",
            ));
        }
        let mut bytes = Vec::with_capacity(self.len());
        while let Some(byte) = self.next_byte()? {
            bytes.push(byte);
        }
        String::from_utf8(bytes).map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))
    }
}

impl Read for TextCursor {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        check_work().map_err(|error| io::Error::other(error.message))?;
        let mut read = 0;
        for byte in output {
            let Some(value) = self.next_byte().map_err(|error| io::Error::other(error.message))? else {
                break;
            };
            *byte = value;
            read += 1;
        }
        Ok(read)
    }
}

pub fn index_record(file: File, span: SourceSpan, with_metadata: bool) -> Result<IndexedRecord, ErrorResponse> {
    let mut index = JsonIndex::new(file, span);
    let mut remaining = u64::MAX;
    while !index.advance(&mut remaining, Instant::now() + Duration::from_secs(120))? {
        check_work()?;
    }
    index.finish(with_metadata)
}

pub trait ByteSource {
    fn len(&self) -> usize;
    fn get(&mut self, position: usize) -> Result<Option<u8>, ErrorResponse>;

    fn at(&mut self, position: usize) -> Result<u8, ErrorResponse> {
        self.get(position)?
            .ok_or_else(|| reader_error("parse_error", "逻辑正文位置越界"))
    }
    fn starts(&mut self, position: usize, expected: &[u8]) -> Result<bool, ErrorResponse> {
        for (index, expected) in expected.iter().enumerate() {
            if self.get(position.saturating_add(index))? != Some(*expected) {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn range(&mut self, start: usize, end: usize, maximum: usize) -> Result<Vec<u8>, ErrorResponse> {
        if end.saturating_sub(start) > maximum {
            return Err(reader_error("record_index_limit", "脱敏字段名超出有界长度"));
        }
        (start..end).map(|position| self.at(position)).collect()
    }
}

pub(crate) struct SliceBytes<'a>(pub &'a [u8]);
impl ByteSource for SliceBytes<'_> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn get(&mut self, position: usize) -> Result<Option<u8>, ErrorResponse> {
        Ok(self.0.get(position).copied())
    }
}

struct LimitedBytes<'a, T> {
    source: &'a mut T,
    end: usize,
}

impl<T: ByteSource> ByteSource for LimitedBytes<'_, T> {
    fn len(&self) -> usize {
        self.end
    }
    fn get(&mut self, position: usize) -> Result<Option<u8>, ErrorResponse> {
        if position >= self.end {
            return Ok(None);
        }
        self.source.get(position)
    }
}

pub struct TextBytes {
    cursor: TextCursor,
    base: usize,
    buffer: Vec<u8>,
}
impl TextBytes {
    pub fn new(cursor: TextCursor) -> Self {
        Self {
            cursor,
            base: 0,
            buffer: Vec::new(),
        }
    }
}
impl ByteSource for TextBytes {
    fn len(&self) -> usize {
        self.cursor.len()
    }
    fn get(&mut self, position: usize) -> Result<Option<u8>, ErrorResponse> {
        if position >= self.len() {
            return Ok(None);
        }
        if position < self.base || position >= self.base + self.buffer.len() {
            check_work()?;
            self.cursor.seek(position)?;
            self.base = position;
            self.buffer.clear();
            for _ in 0..BUFFER_BYTES {
                let Some(byte) = self.cursor.next_byte()? else {
                    break;
                };
                self.buffer.push(byte);
            }
        }
        Ok(self.buffer.get(position - self.base).copied())
    }
}

#[derive(Debug, Clone)]
pub struct RedactionSpan {
    pub start: usize,
    pub end: usize,
    pub replacement: &'static str,
}
const MAX_REDACTION_SPANS: usize = 65_536;

fn add_redaction(
    edits: &mut Vec<RedactionSpan>,
    start: usize,
    end: usize,
    replacement: &'static str,
) -> Result<(), ErrorResponse> {
    if edits.len() == MAX_REDACTION_SPANS {
        return Err(reader_error("redaction_index_limit", "敏感区间超过 65536，未输出正文"));
    }
    if end > start {
        edits.push(RedactionSpan {
            start,
            end,
            replacement,
        });
    }
    Ok(())
}

pub(crate) fn preserve_json_redactions(
    bytes: &mut impl ByteSource,
    edits: &mut [RedactionSpan],
) -> Result<(), ErrorResponse> {
    if edits.is_empty() {
        return Ok(());
    }
    let mut start = 0;
    while bytes.get(start)?.is_some_and(|byte| byte.is_ascii_whitespace()) {
        start += 1;
    }
    if !bytes.get(start)?.is_some_and(|byte| matches!(byte, b'{' | b'[')) {
        return Ok(());
    }
    struct Reader<'a, T> {
        source: &'a mut T,
        position: usize,
        error: Option<ErrorResponse>,
    }
    impl<T: ByteSource> Read for Reader<'_, T> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let mut count = 0;
            while count < buffer.len() {
                match self.source.get(self.position) {
                    Ok(Some(byte)) => {
                        buffer[count] = byte;
                        count += 1;
                        self.position += 1;
                    }
                    Ok(None) => break,
                    Err(error) => {
                        self.error = Some(error);
                        return Err(io::Error::other("JSON input read failed"));
                    }
                }
            }
            Ok(count)
        }
    }
    let mut reader = Reader {
        source: bytes,
        position: 0,
        error: None,
    };
    let valid = serde_json::from_reader::<_, serde::de::IgnoredAny>(&mut reader).is_ok();
    if let Some(error) = reader.error {
        return Err(error);
    }
    if !valid {
        return Ok(());
    }
    edits.sort_by(|left, right| left.start.cmp(&right.start).then_with(|| right.end.cmp(&left.end)));
    let mut position = 0;
    let mut string_start = usize::MAX;
    let mut string_end = 0;
    for edit in edits {
        while position <= edit.start && position < reader.source.len() {
            if reader.source.at(position)? == b'"' {
                string_start = position;
                string_end = quoted_end(reader.source, position, b'"')?.expect("validated JSON string");
                position = string_end;
                if edit.start < string_end {
                    break;
                }
            } else {
                position += 1;
            }
        }
        if edit.start > string_start && edit.start < string_end {
            edit.end = edit.end.min(string_end - 1);
        } else {
            edit.replacement = "\"[redacted]\"";
        }
    }
    Ok(())
}

pub(crate) fn redaction_replacement(
    replacement: &'static str,
    edit_start: usize,
    edit_end: usize,
    range_start: usize,
    range_end: usize,
) -> &'static str {
    if (edit_start < range_start || edit_end > range_end)
        && matches!(replacement, "\"[redacted]\"" | "\\\"[redacted]\\\"")
    {
        "[redacted]"
    } else {
        replacement
    }
}

fn quoted_end(bytes: &mut impl ByteSource, start: usize, quote: u8) -> Result<Option<usize>, ErrorResponse> {
    let mut cursor = start + 1;
    let mut escaped = false;
    while let Some(byte) = bytes.get(cursor)? {
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Ok(Some(cursor + 1));
        }
        cursor += 1;
    }
    Ok(None)
}

fn escaped_quote(bytes: &mut impl ByteSource, start: usize) -> Result<Option<(usize, usize, usize)>, ErrorResponse> {
    if bytes.get(start)? != Some(b'\\') {
        return Ok(None);
    }
    let mut opening = start;
    while bytes.get(opening)? == Some(b'\\') {
        opening += 1;
    }
    let width = opening - start;
    if width.is_multiple_of(2) || bytes.get(opening)? != Some(b'"') {
        return Ok(None);
    }
    let content_start = opening + 1;
    let mut cursor = content_start;
    while cursor < bytes.len() {
        if bytes.at(cursor)? != b'\\' {
            cursor += 1;
            continue;
        }
        let run_start = cursor;
        while bytes.get(cursor)? == Some(b'\\') {
            cursor += 1;
        }
        if cursor - run_start == width && bytes.get(cursor)? == Some(b'"') {
            return Ok(Some((cursor + 1, content_start, run_start)));
        }
        if bytes.get(cursor)? == Some(b'"') {
            cursor += 1;
        }
    }
    Ok(None)
}

fn skip_whitespace(bytes: &mut impl ByteSource, mut cursor: usize, encoded: bool) -> Result<usize, ErrorResponse> {
    loop {
        if bytes.get(cursor)?.is_some_and(|byte| byte.is_ascii_whitespace()) {
            cursor += 1;
        } else if encoded && bytes.get(cursor)? == Some(b'\\') {
            let mut end = cursor;
            while bytes.get(end)? == Some(b'\\') {
                end += 1;
            }
            if !(end - cursor).is_power_of_two()
                || !bytes.get(end)?.is_some_and(|byte| matches!(byte, b't' | b'n' | b'r'))
            {
                break;
            }
            cursor = end + 1;
        } else {
            break;
        }
    }
    Ok(cursor)
}

pub(crate) fn value_end(
    bytes: &mut impl ByteSource,
    start: usize,
    command_scope: Option<(usize, u32)>,
) -> Result<usize, ErrorResponse> {
    if let Some((end, layers)) = command_scope {
        if start >= end {
            return Ok(start);
        }
        let mut cursor = start;
        let mut quote = None;
        let mut escaped = false;
        while cursor < end {
            let position = cursor;
            let Some(character) = field_character(bytes, &mut cursor, end, layers)? else {
                break;
            };
            if escaped {
                escaped = false;
            } else if character == '\\' && quote != Some('\'') {
                escaped = true;
            } else if let Some(delimiter) = quote {
                if character == delimiter {
                    quote = None;
                }
            } else if matches!(character, '"' | '\'') {
                quote = Some(character);
            } else if character.is_ascii_whitespace() || matches!(character, ';' | '&' | '|' | '<' | '>') {
                return Ok(position);
            }
        }
        return Ok(cursor);
    }
    let Some(first) = bytes.get(start)? else {
        return Ok(start);
    };
    if matches!(first, b'"' | b'\'') {
        return Ok(quoted_end(bytes, start, first)?.unwrap_or(bytes.len()));
    }
    if matches!(first, b'{' | b'[') {
        let mut stack = vec![first];
        let mut cursor = start + 1;
        while cursor < bytes.len() {
            match bytes.at(cursor)? {
                quote @ (b'"' | b'\'') => {
                    cursor = quoted_end(bytes, cursor, quote)?.unwrap_or(bytes.len());
                    continue;
                }
                open @ (b'{' | b'[') => {
                    if stack.len() == 128 {
                        return Err(reader_error(
                            "redaction_index_limit",
                            "敏感字段嵌套超过 128 层，未输出正文",
                        ));
                    }
                    stack.push(open);
                }
                b'}' if stack.last() == Some(&b'{') => {
                    stack.pop();
                    if stack.is_empty() {
                        return Ok(cursor + 1);
                    }
                }
                b']' if stack.last() == Some(&b'[') => {
                    stack.pop();
                    if stack.is_empty() {
                        return Ok(cursor + 1);
                    }
                }
                _ => {}
            }
            cursor += 1;
        }
        return Ok(bytes.len());
    }
    let mut cursor = start;
    while let Some(byte) = bytes.get(cursor)? {
        if byte.is_ascii_whitespace() || matches!(byte, b';' | b'&' | b'"' | b'\'' | b',' | b'}' | b']') {
            break;
        }
        cursor += 1;
    }
    Ok(cursor)
}

fn punctuation_split_suffix(bytes: &mut impl ByteSource, mut cursor: usize) -> Result<bool, ErrorResponse> {
    for expected in [b',', b'0', b')', b'['] {
        cursor = skip_whitespace(bytes, cursor, false)?;
        if expected == b'0' {
            let start = cursor;
            while bytes.get(cursor)?.is_some_and(|byte| byte.is_ascii_digit()) {
                cursor += 1;
            }
            if cursor == start {
                return Ok(false);
            }
        } else if bytes.get(cursor)? == Some(expected) {
            cursor += 1;
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}

fn expression_span(bytes: &mut impl ByteSource, start: usize) -> Result<(usize, bool), ErrorResponse> {
    let mut frames: Vec<(u8, bool, usize)> = Vec::new();
    let mut cursor = start;
    let mut end = start;
    let mut safe = true;
    let mut code = false;
    let mut needs_value = true;
    let mut property = false;
    let mut identifier = false;
    let mut method = false;
    let mut lambda_params = false;
    while cursor < bytes.len() {
        let byte = bytes.at(cursor)?;
        if byte.is_ascii_whitespace() {
            if frames.is_empty() && matches!(byte, b'\n' | b'\r') {
                break;
            }
            cursor += 1;
            continue;
        }
        if frames.is_empty() && !lambda_params {
            if matches!(byte, b',' | b';' | b')' | b']' | b'}')
                || (byte == b'&' && !code && !needs_value && cursor == end)
                || (byte == b'#' && code && !needs_value && cursor > end)
                || (byte == b'`' && code && !needs_value && cursor == end)
            {
                break;
            }
            if !needs_value
                && ((code && cursor == end && matches!(byte, b'"' | b'\'')) || bytes.starts(cursor, b"\\n")?)
            {
                break;
            }
            if safe
                && !needs_value
                && !property
                && cursor > end
                && ((!code && byte.is_ascii_alphabetic()) || byte >= 128)
            {
                break;
            }
        }
        let quoted = if let Some(escaped) = escaped_quote(bytes, cursor)? {
            Some(escaped)
        } else if matches!(byte, b'"' | b'\'' | b'`') {
            quoted_end(bytes, cursor, byte)?.map(|end| (end, cursor + 1, end - 1))
        } else {
            None
        };
        if let Some((quoted_end, content_start, content_end)) = quoted {
            let mut field_name = frames.last().is_some_and(|(open, _, args)| *open == b'[' && *args == 0)
                && bytes
                    .get(content_start)?
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_');
            if field_name {
                for position in content_start..content_end {
                    if !bytes.at(position)?.is_ascii_alphanumeric() && bytes.at(position)? != b'_' {
                        field_name = false;
                        break;
                    }
                }
                let next = skip_whitespace(bytes, quoted_end, false)?;
                field_name &= bytes.get(next)? == Some(b']');
            }
            let mut delimiter = frames
                .last()
                .is_some_and(|(open, method, args)| *open == b'(' && *method && *args == 0)
                && content_start < content_end;
            if delimiter {
                for position in content_start..content_end {
                    let byte = bytes.at(position)?;
                    if !byte.is_ascii_punctuation() || matches!(byte, b'\\' | b'"' | b'\'') {
                        delimiter = false;
                        break;
                    }
                }
                delimiter &= punctuation_split_suffix(bytes, quoted_end)?;
            }
            safe &= needs_value && (field_name || delimiter);
            needs_value = false;
            identifier = false;
            method = false;
            cursor = quoted_end;
        } else if matches!(byte, b'"' | b'\'' | b'`') {
            return Ok((bytes.len(), false));
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            let word_start = cursor;
            cursor += 1;
            while bytes
                .get(cursor)?
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                cursor += 1;
            }
            if cursor - word_start == 6 && bytes.starts(word_start, b"lambda")? && needs_value && !property {
                lambda_params = true;
                identifier = false;
                code = true;
            } else if lambda_params {
                safe &= !identifier;
                identifier = true;
            } else {
                safe &= needs_value;
                method = property;
                property = false;
                needs_value = false;
                identifier = true;
            }
        } else {
            match byte {
                b'0'..=b'9' => {
                    safe &= needs_value && !property && !lambda_params;
                    cursor += 1;
                    while bytes.get(cursor)?.is_some_and(|byte| byte.is_ascii_digit()) {
                        cursor += 1;
                    }
                    needs_value = false;
                    identifier = false;
                    method = false;
                    end = cursor;
                    continue;
                }
                b'.' => {
                    safe &= !needs_value && !lambda_params;
                    code = true;
                    property = true;
                    needs_value = true;
                }
                b'(' | b'[' | b'{' => {
                    if frames.len() == 32 {
                        return Ok((bytes.len(), false));
                    }
                    let postfix = !needs_value;
                    safe &= !property && !lambda_params && byte != b'{' && (byte != b'[' || postfix);
                    code |= postfix;
                    frames.push((byte, method && postfix, 0));
                    lambda_params = false;
                    needs_value = true;
                    identifier = false;
                    method = false;
                }
                b')' | b']' | b'}' => {
                    let opening = match byte {
                        b')' => b'(',
                        b']' => b'[',
                        _ => b'{',
                    };
                    let Some((open, _, args)) = frames.pop() else {
                        return Ok((end, false));
                    };
                    if open != opening {
                        return Ok((bytes.len(), false));
                    }
                    safe &= !property && !lambda_params && (!needs_value || (open == b'(' && args == 0));
                    lambda_params = false;
                    needs_value = false;
                    identifier = false;
                    method = false;
                }
                b',' if lambda_params => {
                    identifier = false;
                }
                b',' => {
                    safe &= !needs_value && !property;
                    if let Some(frame) = frames.last_mut() {
                        frame.2 += 1;
                    }
                    needs_value = true;
                    identifier = false;
                    method = false;
                }
                b':' if lambda_params => {
                    lambda_params = false;
                    needs_value = true;
                    identifier = false;
                }
                b'=' => {
                    safe &= identifier && frames.last().is_some_and(|frame| frame.0 == b'(');
                    needs_value = true;
                    identifier = false;
                }
                _ => {
                    safe = false;
                    needs_value = true;
                    identifier = false;
                }
            }
            cursor += 1;
        }
        end = cursor;
    }
    if !frames.is_empty() {
        return Ok((bytes.len(), false));
    }
    Ok((end, safe && code && !needs_value && !property && !lambda_params))
}

fn field_character(
    bytes: &mut impl ByteSource,
    position: &mut usize,
    end: usize,
    layers: u32,
) -> Result<Option<char>, ErrorResponse> {
    if layers == 0 {
        if *position == end {
            return Ok(None);
        }
        let (character, width) = character_at(bytes, *position)?;
        *position += width;
        if *position > end {
            return Err(reader_error("parse_error", "脱敏字段 UTF-8 边界无效"));
        }
        return Ok(Some(character));
    }
    let Some(character) = field_character(bytes, position, end, layers - 1)? else {
        return Ok(None);
    };
    if character == '\\' {
        return decode_escape(
            || {
                field_character(bytes, position, end, layers - 1)?
                    .ok_or_else(|| reader_error("field_decode_error", "字段转义没有完整结束"))
            },
            |message| reader_error("field_decode_error", message),
        )
        .map(Some);
    }
    if character == '"' || character < '\u{20}' {
        return Err(reader_error("field_decode_error", "字段含未转义控制字符或引号"));
    }
    Ok(Some(character))
}

fn field_key_sensitive(
    bytes: &mut impl ByteSource,
    start: usize,
    end: usize,
    layers: u32,
    mode: crate::utils::RedactionMode,
) -> Result<bool, ErrorResponse> {
    let mut scan = |layers| -> Result<bool, ErrorResponse> {
        let mut position = start;
        let mut window = String::with_capacity(MAX_KEY_BYTES + 5);
        let mut matched = false;
        while let Some(character) = field_character(bytes, &mut position, end, layers)? {
            window.push(character.to_ascii_lowercase());
            if window.len() >= MAX_KEY_BYTES {
                check_work()?;
                // 中间缓冲区不匹配 key 后缀，保留当前字段词项所需的 16 字符重叠
                window.push('!');
                matched |= crate::utils::is_sensitive_key(&window, mode);
                window.pop();
                let keep = window.char_indices().rev().nth(15).map_or(0, |(offset, _)| offset);
                window.drain(..keep);
            }
        }
        Ok(matched || crate::utils::is_sensitive_key(&window, mode))
    };
    match scan(layers) {
        Err(error) if layers > 0 && error.error == "field_decode_error" => scan(0),
        result => result,
    }
}

pub fn sensitive_field_spans(
    bytes: &mut impl ByteSource,
    mode: crate::utils::RedactionMode,
) -> Result<Vec<RedactionSpan>, ErrorResponse> {
    let mut edits = Vec::new();
    let mut cursor = 0;
    let mut quoted_scopes: Vec<(usize, usize, u32)> = Vec::new();
    let key_byte = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-');
    while cursor < bytes.len() {
        while let Some(&(content_end, end, _)) = quoted_scopes.last() {
            if cursor < content_end {
                break;
            }
            quoted_scopes.pop();
            cursor = cursor.max(end);
        }
        if cursor >= bytes.len() {
            break;
        }
        let next = skip_whitespace(bytes, cursor, quoted_scopes.last().is_some_and(|scope| scope.2 > 0))?;
        let separated = next > cursor;
        cursor = next;
        if cursor >= bytes.len() || quoted_scopes.last().is_some_and(|scope| cursor >= scope.0) {
            continue;
        }
        let scope = quoted_scopes
            .last()
            .map_or((bytes.len(), 0), |scope| (scope.0, scope.2));
        if (separated || cursor == 0 || !key_byte(bytes.at(cursor - 1)?))
            && let Some((start, end)) = authorization_header_span(bytes, cursor, scope)?
        {
            if end > start {
                add_redaction(&mut edits, start, end, "[redacted]")?;
            }
            cursor = end;
            continue;
        }
        let escaped = escaped_quote(bytes, cursor)?;
        let (key_start, key_end, content_start, content_end, quoted) = if let Some((end, start, content_end)) = escaped
        {
            (cursor, end, start, content_end, true)
        } else {
            match bytes.at(cursor)? {
                quote @ (b'"' | b'\'') => {
                    let Some(end) = quoted_end(bytes, cursor, quote)? else {
                        cursor += 1;
                        continue;
                    };
                    (cursor, end, cursor + 1, end - 1, true)
                }
                byte if key_byte(byte) && (separated || cursor == 0 || !key_byte(bytes.at(cursor - 1)?)) => {
                    let mut end = cursor + 1;
                    while bytes.get(end)?.is_some_and(key_byte) {
                        end += 1;
                    }
                    (cursor, end, cursor, end, false)
                }
                _ => {
                    cursor += 1;
                    continue;
                }
            }
        };
        let password_option = !quoted
            && key_end - key_start <= 16
            && bytes.starts(key_start, b"--")?
            && crate::utils::is_command_password_option(
                &std::str::from_utf8(&bytes.range(key_start, key_end, 16)?)
                    .map_err(|_| reader_error("parse_error", "命令行密码选项不是有效 UTF-8"))?
                    .to_ascii_lowercase(),
            );
        let layers = if escaped.is_some() {
            let width = content_start - key_start - 1;
            if (width + 1).is_power_of_two() {
                (width + 1).trailing_zeros() + 1
            } else {
                0
            }
        } else {
            u32::from(bytes.at(key_start)? == b'"')
        };
        let encoded_whitespace = password_option && quoted_scopes.last().is_some_and(|scope| scope.2 > 0);
        let separator = skip_whitespace(bytes, key_end, encoded_whitespace)?;
        let double_colon_separator = !quoted
            && bytes.starts(separator, b"::")?
            && bytes.get(separator + 2)? != Some(b':')
            && !field_key_sensitive(
                bytes,
                content_start,
                content_end,
                layers,
                crate::utils::RedactionMode::Auto,
            )?;
        let assignment =
            bytes.get(separator)?.is_some_and(|byte| matches!(byte, b':' | b'=')) && !double_colon_separator;
        if !(assignment || password_option && separator > key_end) {
            if quoted && quoted_scopes.last().is_none_or(|scope| content_end < scope.0) {
                if quoted_scopes.len() == 32 {
                    return Err(reader_error(
                        "redaction_index_limit",
                        "命令行字符串嵌套超过 32 层，未输出正文",
                    ));
                }
                quoted_scopes.push((content_end, key_end, layers));
            }
            cursor = if quoted { content_start } else { key_end };
            continue;
        }
        if !field_key_sensitive(bytes, content_start, content_end, layers, mode)? {
            cursor = key_end.max(cursor + 1);
            continue;
        }
        let value_start = skip_whitespace(bytes, separator + usize::from(assignment), encoded_whitespace)?;
        let value_end = if password_option {
            let scope = quoted_scopes
                .last()
                .map_or((bytes.len(), 0), |scope| (scope.0, scope.2));
            value_end(bytes, value_start, Some(scope))?
        } else if !quoted && bytes.at(separator)? == b'=' {
            let scope_end = quoted_scopes.last().map_or(bytes.len(), |scope| scope.0);
            let (end, preserve) = expression_span(
                &mut LimitedBytes {
                    source: bytes,
                    end: scope_end,
                },
                value_start,
            )?;
            if preserve {
                cursor = value_start;
                continue;
            }
            end
        } else if let Some((end, _, _)) = escaped_quote(bytes, value_start)? {
            end
        } else {
            value_end(bytes, value_start, None)?
        };
        if value_end > value_start {
            add_redaction(&mut edits, value_start, value_end, "[redacted]")?;
            cursor = value_end;
        } else {
            cursor = key_end.max(key_start + 1);
        }
    }
    Ok(edits)
}

fn character_at(bytes: &mut impl ByteSource, position: usize) -> Result<(char, usize), ErrorResponse> {
    let first = bytes.at(position)?;
    let length = if first < 0x80 {
        1
    } else if first < 0xe0 {
        2
    } else if first < 0xf0 {
        3
    } else {
        4
    };
    let mut buffer = [0; 4];
    for (index, byte) in buffer.iter_mut().take(length).enumerate() {
        *byte = bytes.at(position + index)?;
    }
    let character = std::str::from_utf8(&buffer[..length])
        .ok()
        .and_then(|text| text.chars().next())
        .ok_or_else(|| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?;
    Ok((character, length))
}

fn preceding_word(bytes: &mut impl ByteSource, position: usize) -> Result<bool, ErrorResponse> {
    if position == 0 {
        return Ok(false);
    }
    let mut start = position - 1;
    while start > 0 && bytes.at(start)? & 0xc0 == 0x80 {
        start -= 1;
    }
    let previous = bytes.range(start, position, 4)?;
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    Ok(WORD
        .get_or_init(|| regex::Regex::new(r"\w$").expect("valid regex"))
        .is_match(std::str::from_utf8(&previous).map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?))
}

fn prefix_regex(
    bytes: &mut impl ByteSource,
    position: usize,
    expression: &regex::Regex,
    maximum: usize,
) -> Result<Option<usize>, ErrorResponse> {
    let mut end = (position + maximum).min(bytes.len());
    while end > position && end < bytes.len() && bytes.at(end)? & 0xc0 == 0x80 {
        end -= 1;
    }
    let prefix = bytes.range(position, end, maximum)?;
    let text = std::str::from_utf8(&prefix).map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?;
    Ok(expression
        .find(text)
        .filter(|matched| matched.start() == 0)
        .map(|matched| position + matched.end()))
}

fn unicode_whitespace_end(bytes: &mut impl ByteSource, mut position: usize) -> Result<usize, ErrorResponse> {
    while position < bytes.len() {
        let (character, length) = character_at(bytes, position)?;
        if !character.is_whitespace() {
            break;
        }
        position += length;
    }
    Ok(position)
}

fn authorization_character_at(
    bytes: &mut impl ByteSource,
    position: usize,
    scope: (usize, u32),
) -> Result<Option<(char, usize)>, ErrorResponse> {
    let mut next = position;
    Ok(field_character(bytes, &mut next, scope.0, scope.1)?.map(|character| (character, next - position)))
}

pub(crate) fn authorization_header_span(
    bytes: &mut impl ByteSource,
    start: usize,
    scope: (usize, u32),
) -> Result<Option<(usize, usize)>, ErrorResponse> {
    let first = bytes.at(start)?;
    if !matches!(first, b'a' | b'A' | b'p' | b'P' | b'\\')
        || (first == b'\\' && start > 0 && bytes.at(start - 1)? == b'\\')
    {
        return Ok(None);
    }
    let result = (|| {
        let Some((first, _)) = authorization_character_at(bytes, start, scope)? else {
            return Ok(None);
        };
        let name = match first {
            'a' | 'A' => "authorization",
            'p' | 'P' => "proxy-authorization",
            _ => return Ok(None),
        };
        let mut position = start;
        for expected in name.chars() {
            let Some((character, width)) = authorization_character_at(bytes, position, scope)? else {
                return Ok(None);
            };
            if !character.eq_ignore_ascii_case(&expected) {
                return Ok(None);
            }
            position += width;
        }
        while let Some((character, width)) = authorization_character_at(bytes, position, scope)? {
            if character.is_whitespace() {
                position += width;
            } else if matches!(character, ':' | '=') {
                return authorization_value_span(bytes, position + width, scope).map(Some);
            } else {
                return Ok(None);
            }
        }
        Ok(None)
    })();
    match result {
        Err(error) if error.error == "field_decode_error" => Ok(None),
        result => result,
    }
}

fn authorization_whitespace_end(
    bytes: &mut impl ByteSource,
    mut position: usize,
    scope: (usize, u32),
) -> Result<usize, ErrorResponse> {
    while let Some((character, width)) = authorization_character_at(bytes, position, scope)? {
        if !character.is_whitespace() || matches!(character, '\n' | '\r') {
            break;
        }
        position += width;
    }
    Ok(position)
}

pub(crate) fn authorization_value_span(
    bytes: &mut impl ByteSource,
    from: usize,
    scope: (usize, u32),
) -> Result<(usize, usize), ErrorResponse> {
    let result: Result<_, ErrorResponse> = (|| {
        let start = authorization_whitespace_end(bytes, from, scope)?;
        if let Some((end, _, _)) = escaped_quote(
            &mut LimitedBytes {
                source: bytes,
                end: scope.0,
            },
            start,
        )? {
            return Ok((start, end));
        }
        if let Some(end) = authorization_quoted_end(bytes, start, scope)? {
            return Ok((start, end));
        }
        let mut end = start;
        let mut scheme = true;
        let mut name = String::with_capacity(17);
        while let Some((character, width)) = authorization_character_at(bytes, end, scope)? {
            if character.is_whitespace() || matches!(character, ',' | ';') {
                break;
            }
            if end == start {
                scheme &= character.is_ascii_alphabetic();
            }
            scheme &= character.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(character);
            if name.len() < 17 {
                name.push(character.to_ascii_lowercase());
            }
            end += width;
        }
        if !scheme || end == start {
            return Ok((start, end));
        }
        let credential_start = authorization_whitespace_end(bytes, end, scope)?;
        if credential_start == end {
            return Ok((start, end));
        }
        let token_scheme = matches!(name.as_str(), "basic" | "bearer");
        let aws_v4 = name == "aws4-hmac-sha256";
        if !token_scheme
            && let Some(mut parameter_end) = authorization_parameter_end(bytes, credential_start, aws_v4, scope)?
        {
            loop {
                let separator = authorization_whitespace_end(bytes, parameter_end, scope)?;
                let Some((',', width)) = authorization_character_at(bytes, separator, scope)? else {
                    break;
                };
                let next = authorization_whitespace_end(bytes, separator + width, scope)?;
                let Some(next_end) = authorization_parameter_end(bytes, next, aws_v4, scope)? else {
                    break;
                };
                parameter_end = next_end;
            }
            return Ok((start, parameter_end));
        }
        let mut credential_end = credential_start;
        while let Some((character, width)) = authorization_character_at(bytes, credential_end, scope)? {
            if character.is_whitespace() || matches!(character, ',' | ';') {
                break;
            }
            credential_end += width;
        }
        Ok((
            start,
            if credential_end > credential_start {
                credential_end
            } else {
                end
            },
        ))
    })();
    match result {
        // 无效的嵌套 JSON 转义按整个字符串范围脱敏
        Err(error) if error.error == "field_decode_error" => Ok((from, scope.0)),
        result => result,
    }
}

fn authorization_parameter_end(
    bytes: &mut impl ByteSource,
    start: usize,
    aws_v4: bool,
    scope: (usize, u32),
) -> Result<Option<usize>, ErrorResponse> {
    let mut end = start;
    let mut name = String::with_capacity(14);
    while let Some((character, width)) = authorization_character_at(bytes, end, scope)? {
        if !(character.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(character)) {
            break;
        }
        if name.len() < 14 {
            name.push(character.to_ascii_lowercase());
        }
        end += width;
    }
    let separator = authorization_whitespace_end(bytes, end, scope)?;
    let Some(('=', width)) = authorization_character_at(bytes, separator, scope)? else {
        return Ok(None);
    };
    if end == start {
        return Ok(None);
    }
    let signed_headers = aws_v4 && name == "signedheaders";
    end = authorization_whitespace_end(bytes, separator + width, scope)?;
    let Some((first, _)) = authorization_character_at(bytes, end, scope)? else {
        return Ok(None);
    };
    if first.is_whitespace() || matches!(first, '=' | ',' | ';') {
        return Ok(None);
    }
    if let Some(end) = authorization_quoted_end(bytes, end, scope)? {
        return Ok(Some(end));
    }
    while let Some((character, width)) = authorization_character_at(bytes, end, scope)? {
        if character.is_whitespace() || character == ',' || (character == ';' && !signed_headers) {
            break;
        }
        end += width;
    }
    Ok(Some(end))
}

fn authorization_quoted_end(
    bytes: &mut impl ByteSource,
    start: usize,
    scope: (usize, u32),
) -> Result<Option<usize>, ErrorResponse> {
    let Some((quote @ ('"' | '\''), width)) = authorization_character_at(bytes, start, scope)? else {
        return Ok(None);
    };
    let mut end = start + width;
    let mut escaped = false;
    while let Some((character, width)) = authorization_character_at(bytes, end, scope)? {
        if matches!(character, '\n' | '\r') {
            return Ok(Some(end));
        }
        end += width;
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            return Ok(Some(end));
        }
    }
    Ok(Some(scope.0))
}

pub fn redaction_spans(
    bytes: &mut impl ByteSource,
    mode: crate::utils::RedactionMode,
) -> Result<Vec<RedactionSpan>, ErrorResponse> {
    use crate::utils::RedactionMode;
    if mode == RedactionMode::Off {
        return Ok(Vec::new());
    }
    let mut edits = sensitive_field_spans(bytes, mode)?;
    static COOKIE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static HOST: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let cookie = COOKIE.get_or_init(|| regex::Regex::new(r"(?i)^cookie").expect("valid regex"));
    let host = HOST.get_or_init(|| {
        regex::Regex::new(
            r"^(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b",
        )
        .expect("valid regex")
    });
    let mut token_uuid_cursor = 0;
    let mut cookie_cursor = 0;
    let mut key_cursor = 0;
    let mut url_cursor = 0;
    let mut host_cursor = 0;
    let mut position = 0;
    while position < bytes.len() {
        let (character, width) = character_at(bytes, position)?;
        let escaped_whitespace =
            character == '\\' && bytes.get(position + 1)?.is_some_and(|byte| b"nrt".contains(&byte));
        let token_start = position + if escaped_whitespace { 2 } else { 0 };
        if ((character == 'n' && bytes.starts(position, b"npm_")? && !preceding_word(bytes, position)?)
            || (escaped_whitespace && bytes.starts(token_start, b"npm_")?))
            && let Some(end) = prefix_regex(bytes, position, crate::utils::npm_token_regex(), 46)?
        {
            add_redaction(&mut edits, end - 40, end, "[redacted]")?;
        }
        if position >= token_uuid_cursor
            && (matches!(character, 't' | 'T' | '令') || escaped_whitespace)
            && (character == '令' || escaped_whitespace || !preceding_word(bytes, position)?)
            && (bytes.range(token_start, (token_start + 5).min(bytes.len()), 5)?.eq_ignore_ascii_case(b"token")
                || bytes.starts(token_start, "令牌".as_bytes())?)
            // 单行上下文最多 256 字符，1536 字节覆盖 Unicode 和固定返回语句
            && let Some(end) = prefix_regex(bytes, position, crate::utils::token_uuid_statement_regex(), 1536)?
        {
            add_redaction(&mut edits, end - 36, end, "[redacted]")?;
            token_uuid_cursor = end;
        }
        if mode == RedactionMode::Strict {
            if position >= cookie_cursor
                && matches!(character, 'c' | 'C')
                && !preceding_word(bytes, position)?
                && let Some(name_end) = prefix_regex(bytes, position, cookie, 32)?
            {
                let separator = unicode_whitespace_end(bytes, name_end)?;
                if bytes.get(separator)?.is_some_and(|byte| matches!(byte, b':' | b'=')) {
                    let mut value_start = unicode_whitespace_end(bytes, separator + 1)?;
                    if value_start == bytes.len() {
                        let mut previous = value_start;
                        while previous > separator + 1 {
                            previous -= 1;
                            while previous > separator + 1 && bytes.at(previous)? & 0xc0 == 0x80 {
                                previous -= 1;
                            }
                            if !matches!(character_at(bytes, previous)?.0, '\n' | '\r') {
                                value_start = previous;
                                break;
                            }
                        }
                    }
                    let mut end = value_start;
                    while bytes.get(end)?.is_some_and(|byte| !matches!(byte, b'\n' | b'\r')) {
                        end += 1;
                    }
                    if end > value_start {
                        add_redaction(&mut edits, value_start, end, "[redacted]")?;
                        cookie_cursor = end;
                    }
                }
            }
            if position >= url_cursor
                && character == 'h'
                && (bytes.starts(position, b"http://")? || bytes.starts(position, b"https://")?)
            {
                let prefix = if bytes.starts(position, b"https://")? { 8 } else { 7 };
                let mut end = position + prefix;
                let value_start = end;
                while end < bytes.len() {
                    let (character, width) = character_at(bytes, end)?;
                    if character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>') {
                        break;
                    }
                    end += width;
                }
                if end > value_start {
                    add_redaction(&mut edits, position, end, "[redacted-url]")?;
                    url_cursor = end;
                }
            }
            if position >= host_cursor
                && matches!(character, '1')
                && !preceding_word(bytes, position)?
                && let Some(end) = prefix_regex(bytes, position, host, 96)?
            {
                add_redaction(&mut edits, position, end, "[redacted-host]")?;
                host_cursor = end;
            }
            if position >= key_cursor && character == '-' && bytes.starts(position, b"-----BEGIN ")? {
                let mut prefix_end = position + 11;
                while bytes
                    .get(prefix_end)?
                    .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b' ')
                {
                    prefix_end += 1;
                }
                // 贪婪的类型部分包含 PRIVATE KEY，按最长合法 header 查找
                let mut header_end = None;
                let mut candidate = position + 11;
                while candidate <= prefix_end {
                    if bytes.starts(candidate, b"PRIVATE KEY-----")? {
                        header_end = Some(candidate + 16);
                    }
                    candidate += 1;
                }
                if let Some(mut end) = header_end {
                    while end < bytes.len() {
                        if bytes.starts(end, b"-----END ")? {
                            let mut candidate = end + 9;
                            while bytes
                                .get(candidate)?
                                .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b' ')
                            {
                                if bytes.starts(candidate, b"PRIVATE KEY-----")? {
                                    let end = candidate + 16;
                                    add_redaction(&mut edits, position, end, "[redacted-private-key]")?;
                                    key_cursor = end;
                                    break;
                                }
                                candidate += 1;
                            }
                            if key_cursor > position {
                                break;
                            }
                        }
                        end += 1;
                    }
                }
            }
        }
        position += width;
    }
    preserve_json_redactions(bytes, &mut edits)?;
    edits.sort_by(|left, right| left.start.cmp(&right.start).then_with(|| right.end.cmp(&left.end)));
    let mut normalized: Vec<RedactionSpan> = Vec::new();
    for edit in edits {
        if let Some(previous) = normalized.last_mut()
            && edit.start < previous.end
        {
            previous.end = previous.end.max(edit.end);
        } else {
            normalized.push(edit);
        }
    }
    Ok(normalized)
}

/// 范围以原文 Unicode 字符计数，确定完整敏感区间后才写入选定正文
pub fn render_text_range(
    bytes: &mut TextBytes,
    mode: crate::utils::RedactionMode,
    range: Option<(usize, usize)>,
    mut write: impl FnMut(&[u8]) -> Result<(), ErrorResponse>,
) -> Result<(usize, usize, usize), ErrorResponse> {
    let character_count = bytes.cursor.projection.characters;
    let (start_char, end_char) = range.unwrap_or((0, character_count));
    if start_char > end_char || (range.is_some() && start_char >= character_count) {
        return Err(reader_error(
            "invalid_range",
            format!("range 无效，original_content_size={character_count}"),
        ));
    }
    if start_char == end_char {
        return Ok((character_count, 0, 0));
    }
    let structured = bytes.cursor.projection.redactions.is_some();
    let edits = match &bytes.cursor.projection.redactions {
        Some(edits) => edits.clone(),
        None => redaction_spans(bytes, mode)?,
    };
    let (start, end) = if range.is_none() {
        (0, bytes.len())
    } else {
        let mut start_byte = None;
        let mut position = 0;
        let mut characters = 0;
        while position < bytes.len() && characters < end_char {
            if characters == start_char {
                start_byte = Some(position);
            }
            let (_, width) = character_at(bytes, position)?;
            characters += 1;
            position += width;
        }
        if characters == start_char {
            start_byte = Some(position);
        }
        (start_byte.unwrap_or(bytes.len()), position)
    };
    let mut position = start;
    let mut count = 0;
    let mut written_chars = 0;
    let mut emit = |value: &[u8]| -> Result<(), ErrorResponse> {
        written_chars += std::str::from_utf8(value)
            .map_err(|_| reader_error("parse_error", "逻辑正文 UTF-8 无效"))?
            .chars()
            .count();
        write(value)
    };
    for edit in edits {
        if edit.end <= start || edit.start >= end {
            continue;
        }
        let visible_start = edit.start.max(start);
        write_plain(bytes, position, visible_start, &mut emit)?;
        let replacement = if structured {
            edit.replacement
        } else {
            redaction_replacement(edit.replacement, edit.start, edit.end, start, end)
        };
        emit(replacement.as_bytes())?;
        position = position.max(edit.end.min(end));
        count += 1;
    }
    write_plain(bytes, position, end, &mut emit)?;
    Ok((character_count, written_chars, count))
}

pub fn stream_matches_pattern(
    bytes: &mut TextBytes,
    pattern: &crate::utils::SearchPattern,
    case_sensitive: bool,
) -> Result<(bool, Option<usize>), ErrorResponse> {
    struct Term {
        characters: Vec<char>,
        prefix: Vec<usize>,
        matched: usize,
        first: Option<usize>,
    }
    let words: Vec<_> = pattern
        .must_have
        .iter()
        .chain(&pattern.must_not)
        .chain(pattern.any_of.iter().flatten())
        .collect();
    if words.len() > 256 || words.iter().map(|word| word.len()).sum::<usize>() > 1024 * 1024 {
        return Err(invalid_arguments("scan 词项最多 256 个，总长度最多 1 MiB"));
    }
    let mut terms: Vec<_> = words
        .iter()
        .map(|word| {
            let characters: Vec<_> = word.chars().collect();
            let mut prefix = vec![0; characters.len()];
            for index in 1..characters.len() {
                let mut previous = prefix[index - 1];
                while previous > 0 && characters[index] != characters[previous] {
                    previous = prefix[previous - 1];
                }
                if characters[index] == characters[previous] {
                    previous += 1;
                }
                prefix[index] = previous;
            }
            Term {
                characters,
                prefix,
                matched: 0,
                first: None,
            }
        })
        .collect();
    let max_length = terms.iter().map(|term| term.characters.len()).max().unwrap_or(0);
    let mut origins = std::collections::VecDeque::with_capacity(max_length + 1);
    let mut position = 0;
    let mut original_character = 0;
    while position < bytes.len() {
        let (character, width) = character_at(bytes, position)?;
        let ascii_fold = !case_sensitive && character.is_ascii();
        let mut folded = (!case_sensitive && !ascii_fold).then(|| character.to_lowercase());
        let mut original = Some(if ascii_fold {
            character.to_ascii_lowercase()
        } else {
            character
        });
        while let Some(character) = match &mut folded {
            Some(folded) => folded.next(),
            None => original.take(),
        } {
            if origins.len() == max_length + 1 {
                origins.pop_front();
            }
            origins.push_back(original_character);
            for term in &mut terms {
                if term.first.is_some() || term.characters.is_empty() {
                    continue;
                }
                while term.matched > 0 && term.characters[term.matched] != character {
                    term.matched = term.prefix[term.matched - 1];
                }
                if term.characters[term.matched] == character {
                    term.matched += 1;
                }
                if term.matched == term.characters.len() {
                    term.first = origins.get(origins.len() - term.characters.len()).copied();
                }
            }
        }
        original_character += 1;
        position += width;
    }
    if terms[..pattern.must_have.len()].iter().any(|term| term.first.is_none()) {
        return Ok((false, None));
    }
    let forbidden_start = pattern.must_have.len();
    let mut group_start = forbidden_start + pattern.must_not.len();
    if terms[forbidden_start..group_start]
        .iter()
        .any(|term| term.first.is_some())
    {
        return Ok((false, None));
    }
    let mut match_position = terms
        .first()
        .filter(|_| !pattern.must_have.is_empty())
        .and_then(|term| term.first);
    for group in &pattern.any_of {
        let position = terms[group_start..group_start + group.len()]
            .iter()
            .find_map(|term| term.first);
        if position.is_none() {
            return Ok((false, None));
        }
        match_position = match_position.or(position);
        group_start += group.len();
    }
    Ok((true, match_position))
}

fn write_plain(
    bytes: &mut TextBytes,
    start: usize,
    end: usize,
    write: &mut impl FnMut(&[u8]) -> Result<(), ErrorResponse>,
) -> Result<(), ErrorResponse> {
    let mut buffer = Vec::with_capacity(BUFFER_BYTES);
    let mut position = start;
    while position < end {
        check_work()?;
        let (character, width) = character_at(bytes, position)?;
        let mut encoded = [0; 4];
        buffer.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
        position += width;
        if buffer.len() >= BUFFER_BYTES {
            write(&buffer)?;
            buffer.clear();
        }
    }
    if !buffer.is_empty() {
        write(&buffer)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn ql_h01_authorization_corpus() -> Vec<(String, String)> {
    let mut cases = Vec::new();
    for header in ["Authorization", "Proxy-Authorization"] {
        for value in [
            "Basic Zml4dHVyZTpwYXNz",
            "\"Basic Zml4dHVyZTpwYXNz\"",
            "'Basic Zml4dHVyZTpwYXNz'",
            "Bearer fixture.value",
            "Fixture fixture.value:signature",
            "Custom fixture.value:signature",
            "Digest username=\"fixture user\", response=\"fixture-secret\"",
            "AWS EXAMPLEACCESS:fixture-signature=",
            "AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                SignedHeaders=host;x-amz-date, Signature=fixture.signature",
        ] {
            let mut text = format!("前缀😀\n{header}: {value}\nX-Diagnostic: visible");
            let mut expected = format!("前缀😀\n{header}: [redacted]\nX-Diagnostic: visible");
            for _ in 0..4 {
                cases.push((text.clone(), expected.clone()));
                text = serde_json::to_string(&text).unwrap();
                expected = serde_json::to_string(&expected).unwrap();
            }
        }
        for (value, encoded) in [
            ("Basic Zml4dHVyZTpwYXNz", "B"),
            ("Basic Zml4dHVyZTpwYXNz", "a"),
            ("Bearer fixture.value", "B "),
            ("Fixture fixture.value:signature", "Fi:"),
            ("\"Basic Zml4dHVyZTpwYXNz\"", "\""),
            ("AWS EXAMPLEACCESS:fixture-signature=", "W:"),
            (
                "Digest username=\"fixture user\", response=\"fixture-secret\"",
                "Drespon=,",
            ),
            (
                "AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                    SignedHeaders=host;x-amz-date, Signature=fixture.signature",
                "WS4Hi=,;",
            ),
        ] {
            let mut value = serde_json::to_string(value).unwrap();
            for character in encoded.chars() {
                let encoded = format!("\\u{:04x}", character as u32);
                value = if character == '"' {
                    value.replace("\\\"", &encoded)
                } else {
                    value.replace(character, &encoded)
                };
            }
            let value = &value[1..value.len() - 1];
            let mut text = format!("\"前缀😀\\n{header}: {value}\\nX-Diagnostic: visible\"");
            let mut expected = format!("\"前缀😀\\n{header}: [redacted]\\nX-Diagnostic: visible\"");
            for _ in 1..4 {
                cases.push((text.clone(), expected.clone()));
                text = serde_json::to_string(&text).unwrap();
                expected = serde_json::to_string(&expected).unwrap();
            }
        }
        for encoded_header in [
            header.replacen('A', "\\u0041", 1),
            header.replace('o', "\\u006f"),
            header
                .chars()
                .map(|character| format!("\\u{:04x}", character as u32))
                .collect(),
        ] {
            for separator in [":", "\\u003a"] {
                let mut text =
                    format!("\"前缀😀\\n{encoded_header}{separator} Basic Zml4dHVyZTpwYXNz\\nX-Diagnostic: visible\"");
                let mut expected =
                    format!("\"前缀😀\\n{encoded_header}{separator} [redacted]\\nX-Diagnostic: visible\"");
                for _ in 1..4 {
                    cases.push((text.clone(), expected.clone()));
                    text = serde_json::to_string(&text).unwrap();
                    expected = serde_json::to_string(&expected).unwrap();
                }
            }
        }
        let text = format!("\"{header}\\u003a Basic Zml4dHVyZTpwYXNz\\nX-Diagnostic: visible\"");
        let expected = format!("\"{header}\\u003a [redacted]\\nX-Diagnostic: visible\"");
        cases.push((text, expected));
        for literal in [
            format!(
                "{}: Basic Zml4dHVyZTpwYXNz\\nX-Diagnostic: visible",
                header.replacen('A', "\\u0041", 1)
            ),
            format!("{header}\\u003a Basic Zml4dHVyZTpwYXNz\\nX-Diagnostic: visible"),
        ] {
            cases.push((literal.clone(), literal.clone()));
            let quoted = serde_json::to_string(&literal).unwrap();
            cases.push((quoted.clone(), quoted));
        }
    }
    cases
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::{parse_message_record, replace_images_with_placeholders};

    struct Fixture {
        root: std::path::PathBuf,
        path: std::path::PathBuf,
        owner: String,
    }
    impl Fixture {
        fn new(line: &str) -> Self {
            let owner = format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let root = std::env::temp_dir().join(format!("history-record-reader-{owner}"));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join(".record-reader-test-owner"), &owner).unwrap();
            let path = root.join("fixture.jsonl");
            std::fs::write(&path, line).unwrap();
            Self { root, path, owner }
        }
        fn open(&self) -> File {
            File::open(&self.path).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if std::fs::read_to_string(self.root.join(".record-reader-test-owner"))
                .ok()
                .as_deref()
                == Some(self.owner.as_str())
            {
                std::fs::remove_dir_all(&self.root).unwrap();
            }
        }
    }

    #[test]
    fn record_lines_preserve_byte_boundaries_snapshots_and_batch_accounting() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut data = b"\n\r\n".to_vec();
        data.extend(0..=255);
        data.resize(data.len() + BUFFER_BYTES + 3, b'x');
        data.extend_from_slice(b"\nlast");
        let fixture = Fixture::new("");
        std::fs::write(&fixture.path, &data).unwrap();
        for snapshot_end in [0, data.len() - 2, data.len()] {
            let expected: Vec<_> = data[..snapshot_end].split_inclusive(|byte| *byte == b'\n').collect();
            for budget in [1, 2, 17, BUFFER_BYTES as u64 - 1, BUFFER_BYTES as u64, u64::MAX] {
                for recycle in [false, true] {
                    let accounted = Arc::new(AtomicUsize::new(0));
                    let control = WorkControl::from_checkpoint({
                        let accounted = Arc::clone(&accounted);
                        move |bytes| {
                            accounted.fetch_add(bytes, Ordering::Relaxed);
                            Ok(())
                        }
                    });
                    control.run(|| {
                        let mut lines = RecordLines::new(fixture.open(), snapshot_end as u64);
                        let mut remaining = budget;
                        let mut count = 0;
                        let mut offset = 0;
                        loop {
                            match lines
                                .step(&mut remaining, Instant::now() + Duration::from_secs(10))
                                .unwrap()
                            {
                                LineStep::Record(mut record) => {
                                    assert_eq!(record.line, count + 1);
                                    assert_eq!(record.span.start, offset);
                                    assert_eq!(record.small.as_deref(), Some(expected[count]));
                                    offset += expected[count].len() as u64;
                                    assert_eq!(record.span.end, offset);
                                    count += 1;
                                    if recycle {
                                        lines.recycle(&mut record);
                                    }
                                }
                                LineStep::Yield => {
                                    assert_eq!(remaining, 0);
                                    remaining = budget;
                                }
                                LineStep::End => break,
                            }
                        }
                        assert_eq!(count, expected.len());
                        assert_eq!(lines.offset, snapshot_end as u64);
                        assert_eq!(accounted.load(Ordering::Relaxed), snapshot_end);
                    });
                }
            }
        }
    }

    #[test]
    fn record_lines_reuse_consumed_buffers_with_bounded_capacity() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let row = format!("{}\n", "x".repeat(1023));
        let count = 2000;
        let data = row.repeat(count);
        let fixture = Fixture::new(&data);
        let accounted = Arc::new(AtomicUsize::new(0));
        let control = WorkControl::from_checkpoint({
            let accounted = Arc::clone(&accounted);
            move |bytes| {
                accounted.fetch_add(bytes, Ordering::Relaxed);
                Ok(())
            }
        });
        control.run(|| {
            let mut lines = RecordLines::new(fixture.open(), data.len() as u64);
            let mut remaining = u64::MAX;
            let mut capacity = 0;
            for index in 0..count {
                if index > 0 {
                    assert_eq!(lines.small.capacity(), capacity);
                }
                let LineStep::Record(mut record) = lines
                    .step(&mut remaining, Instant::now() + Duration::from_secs(10))
                    .unwrap()
                else {
                    panic!("expected complete row");
                };
                assert_eq!(record.small.as_deref(), Some(row.as_bytes()));
                assert_eq!(record.line, index + 1);
                assert_eq!(record.span.start, (index * row.len()) as u64);
                assert_eq!(record.span.end, ((index + 1) * row.len()) as u64);
                lines.recycle(&mut record);
                assert!(record.small.is_none());
                assert!(lines.small.is_empty());
                assert!(lines.small.capacity() >= row.len());
                if index == 0 {
                    capacity = lines.small.capacity();
                } else {
                    assert_eq!(lines.small.capacity(), capacity);
                }
            }
            assert!(matches!(
                lines.step(&mut remaining, Instant::now()).unwrap(),
                LineStep::End
            ));
            assert_eq!(accounted.load(Ordering::Relaxed), data.len());
            let mut record = LocatedRecord {
                line: count + 1,
                span: SourceSpan { start: 0, end: 0 },
                small: Some(Vec::with_capacity(MAX_JSONL_LINE_BYTES + 1)),
            };
            lines.recycle(&mut record);
            assert!(record.small.is_none());
            assert_eq!(lines.small.capacity(), capacity);
        });
    }

    #[test]
    fn indexed_string_runs_preserve_boundaries_escapes_and_scan_budgets() {
        for padding in [
            BUFFER_BYTES - 25,
            BUFFER_BYTES - 24,
            BUFFER_BYTES - 23,
            BUFFER_BYTES,
            BUFFER_BYTES * 2 + 1,
        ] {
            let text = format!("{}界\\\"\n😀\u{7f} end", "x".repeat(padding));
            let raw = serde_json::json!({"uuid":"fixture","type":"user","timestamp":"2026-10-01T00:00:00Z",
                "message":{"content":text}})
            .to_string();
            for raw in [
                raw.clone(),
                raw.replace('界', "\\u754c").replace('😀', "\\uD83D\\uDE00"),
            ] {
                let fixture = Fixture::new(&raw);
                let span = SourceSpan {
                    start: 0,
                    end: raw.len() as u64,
                };
                for budget in [17, BUFFER_BYTES as u64] {
                    let mut index = JsonIndex::new(fixture.open(), span);
                    loop {
                        let mut remaining = budget;
                        if index
                            .advance(&mut remaining, Instant::now() + Duration::from_secs(10))
                            .unwrap()
                        {
                            break;
                        }
                    }
                    let indexed = index.finish(true).unwrap();
                    let projection = indexed.projection(fixture.open(), span, "content", None).unwrap();
                    assert_eq!(projection.characters, text.chars().count());
                    assert_eq!(
                        projection.cursor(fixture.open(), span).read_text(raw.len()).unwrap(),
                        text
                    );
                }
                for invalid in [
                    raw.replace(" end", "\u{1} end"),
                    raw.replace('😀', "\\uD83Dinvalid")
                        .replace("\\uD83D\\uDE00", "\\uD83Dinvalid"),
                ] {
                    let fixture = Fixture::new(&invalid);
                    assert_eq!(
                        index_record(
                            fixture.open(),
                            SourceSpan {
                                start: 0,
                                end: invalid.len() as u64
                            },
                            true
                        )
                        .err()
                        .unwrap()
                        .error,
                        "parse_error"
                    );
                }
            }
        }
    }

    #[test]
    fn text_cursor_ascii_runs_preserve_projection_and_seek() {
        for padding in [BUFFER_BYTES - 1, BUFFER_BYTES, BUFFER_BYTES + 1, BUFFER_BYTES * 3 + 7] {
            let text = format!(
                "{}界\\\"\n😀\u{7f}\u{1}{}",
                "x".repeat(padding),
                "tail".repeat(BUFFER_BYTES / 4 + 1)
            );
            let raw = serde_json::to_string(&text).unwrap();
            for raw in [
                raw.clone(),
                raw.replace('界', "\\u754c").replace('😀', "\\uD83D\\uDE00"),
            ] {
                let fixture = Fixture::new(&raw);
                let span = SourceSpan {
                    start: 0,
                    end: raw.len() as u64,
                };
                let indexed = index_record(fixture.open(), span, false).unwrap();
                for canonical in [false, true] {
                    let mut projection = TextProjection::default();
                    projection.string(&indexed.nodes[indexed.root], canonical);
                    let mut cursor = projection.cursor(fixture.open(), span);
                    let expected = if canonical {
                        serde_json::to_string(&text).unwrap()
                    } else {
                        text.clone()
                    };
                    for _ in 0..if canonical { 2 } else { 1 } {
                        cursor.next_byte().unwrap().unwrap();
                    }
                    assert!(cursor.pending.len() > 1, "ASCII run was not buffered");
                    assert!(cursor.pending.len() <= BUFFER_BYTES);
                    cursor.seek(0).unwrap();
                    assert_eq!(cursor.read_text(raw.len() * 2).unwrap(), expected);
                    assert!(cursor.checkpoints.len() <= 1024);
                    for position in [
                        0,
                        padding - 1,
                        padding + 1,
                        expected.len() / 2,
                        expected.len() - 1,
                        expected.len(),
                        1,
                        BUFFER_BYTES + 2,
                    ] {
                        cursor.seek(position).unwrap();
                        let mut actual = [0; 17];
                        let count = cursor.read(&mut actual).unwrap();
                        let end = expected.len().min(position + actual.len());
                        assert_eq!(&actual[..count], &expected.as_bytes()[position..end]);
                    }
                }
            }
        }
    }

    #[test]
    fn streamed_ascii_case_folding_matches_ordinary_unicode_word_rules() {
        use crate::utils::{matches_pattern, parse_search_pattern};
        let text = format!("{} 前缀😀İD ΟΣ end\\\"\nTail", "ABC".repeat(BUFFER_BYTES));
        let raw = serde_json::to_string(&text).unwrap();
        let fixture = Fixture::new(&raw);
        let span = SourceSpan {
            start: 0,
            end: raw.len() as u64,
        };
        let indexed = index_record(fixture.open(), span, false).unwrap();
        for case_sensitive in [false, true] {
            for query in [
                "abc",
                "ABC",
                "i",
                "\u{307}",
                "d tail",
                "οσ",
                "ος",
                "missing|tail",
                "tail !absent",
                "tail !tail",
                "!absent",
                "missing",
            ] {
                let pattern = parse_search_pattern(query, case_sensitive);
                let mut projection = TextProjection::default();
                projection.string(&indexed.nodes[indexed.root], false);
                let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
                assert_eq!(
                    stream_matches_pattern(&mut bytes, &pattern, case_sensitive).unwrap(),
                    matches_pattern(&text, &pattern, case_sensitive),
                    "{query} case_sensitive={case_sensitive}"
                );
            }
        }
    }

    #[test]
    fn text_cursor_ascii_runs_preserve_cancellation_and_byte_accounting() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let text = "x".repeat(BUFFER_BYTES * 3);
        let raw = serde_json::to_string(&text).unwrap();
        let fixture = Fixture::new(&raw);
        let span = SourceSpan {
            start: 0,
            end: raw.len() as u64,
        };
        let indexed = index_record(fixture.open(), span, false).unwrap();
        let mut projection = TextProjection::default();
        projection.string(&indexed.nodes[indexed.root], false);
        let cancelled = Arc::new(AtomicBool::new(false));
        let control = WorkControl::new(
            {
                let cancelled = Arc::clone(&cancelled);
                move || cancelled.load(Ordering::Relaxed)
            },
            Duration::from_secs(10),
        );
        control.run(|| {
            let mut cursor = projection.clone().cursor(fixture.open(), span);
            assert_eq!(cursor.next_byte().unwrap(), Some(b'x'));
            cancelled.store(true, Ordering::Relaxed);
            let mut consumed = 1;
            loop {
                match cursor.next_byte() {
                    Ok(Some(_)) => consumed += 1,
                    Err(error) => {
                        assert_eq!(error.error, "cancelled");
                        assert!(consumed <= BUFFER_BYTES);
                        break;
                    }
                    Ok(None) => panic!("cancelled text cursor reached EOF"),
                }
            }
        });
        let accounted = Arc::new(AtomicUsize::new(0));
        let control = WorkControl::from_checkpoint({
            let accounted = Arc::clone(&accounted);
            move |bytes| {
                if accounted.fetch_add(bytes, Ordering::Relaxed) + bytes > BUFFER_BYTES {
                    return Err(reader_error("deadline_exceeded", "fixture byte budget"));
                }
                Ok(())
            }
        });
        let error = control.run(|| projection.cursor(fixture.open(), span).read_text(raw.len()));
        assert_eq!(error.unwrap_err().error, "deadline_exceeded");
        assert_eq!(accounted.load(Ordering::Relaxed), BUFFER_BYTES * 2);
    }

    #[test]
    fn internal_record_classification_matches_ordinary_parser() {
        for (value, expected) in [
            (
                serde_json::json!({
                    "type": "api-request-blob",
                    "hash": "fixture",
                    "message": {
                        "role": "user",
                        "content": []
                    }
                }),
                None,
            ),
            (
                serde_json::json!({"type":"queue-operation", "timestamp":"fixture"}),
                None,
            ),
            (
                serde_json::json!({
                    "uuid": "fixture",
                    "type": "user",
                    "timestamp": "2026-10-01T00:00:00Z",
                    "message": {
                        "content": "visible"
                    }
                }),
                Some(true),
            ),
            (
                serde_json::json!({
                    "type": "user",
                    "timestamp": "2026-10-01T00:00:00Z",
                    "message": {
                        "content": "missing uuid"
                    }
                }),
                Some(false),
            ),
            (
                serde_json::json!({"uuid":"fixture", "type":"user", "message":{"content":"missing timestamp"}}),
                Some(false),
            ),
            (
                serde_json::json!({"uuid":"fixture", "type":"user", "timestamp":"2026-10-01T00:00:00Z"}),
                Some(false),
            ),
            (
                serde_json::json!({"uuid":"fixture", "type":"assistant", "timestamp":"2026-10-01T00:00:00Z"}),
                Some(false),
            ),
            (
                serde_json::json!({
                    "uuid":"fixture", "type":"assistant", "timestamp":"2026-10-01T00:00:00Z", "message":null
                }),
                Some(true),
            ),
            (serde_json::json!({"uuid":null, "type":"user"}), Some(false)),
            (
                serde_json::json!({"uuid":"fixture", "type":"api-request-blob", "message":{}}),
                Some(false),
            ),
        ] {
            for padding in [0, MAX_JSONL_LINE_BYTES + 1] {
                let mut value = value.clone();
                value["padding"] = "x".repeat(padding).into();
                let line = value.to_string();
                let ordinary = parse_message_record(&line);
                let fixture = Fixture::new(&line);
                let indexed = index_record(
                    fixture.open(),
                    SourceSpan {
                        start: 0,
                        end: line.len() as u64,
                    },
                    true,
                );
                match expected {
                    None => {
                        assert!(ordinary.unwrap().is_none());
                        assert!(indexed.unwrap().metadata.is_none());
                    }
                    Some(true) => {
                        assert!(ordinary.unwrap().is_some());
                        assert!(indexed.unwrap().metadata.is_some());
                    }
                    Some(false) => {
                        assert!(ordinary.is_err());
                        assert_eq!(indexed.err().unwrap().error, "parse_error");
                    }
                }
            }
        }
        let malformed = r#"{"type":"api-request-blob","message":{]"#;
        assert!(parse_message_record(malformed).is_err());
        let fixture = Fixture::new(malformed);
        assert_eq!(
            index_record(
                fixture.open(),
                SourceSpan {
                    start: 0,
                    end: malformed.len() as u64
                },
                true
            )
            .err()
            .unwrap()
            .error,
            "parse_error"
        );
    }

    #[test]
    fn json_redaction_checks_each_string_once() {
        struct Counted<'a> {
            bytes: &'a [u8],
            reads: usize,
        }
        impl ByteSource for Counted<'_> {
            fn len(&self) -> usize {
                self.bytes.len()
            }
            fn get(&mut self, position: usize) -> Result<Option<u8>, ErrorResponse> {
                self.reads += 1;
                Ok(self.bytes.get(position).copied())
            }
        }
        let text = format!("{{\"note\":\"{}\"}}", "password=fixture-value ".repeat(128));
        let mut spans: Vec<_> = text
            .match_indices("fixture-value")
            .map(|(start, value)| RedactionSpan {
                start,
                end: start + value.len(),
                replacement: "[redacted]",
            })
            .collect();
        let mut bytes = Counted {
            bytes: text.as_bytes(),
            reads: 0,
        };
        preserve_json_redactions(&mut bytes, &mut spans).unwrap();
        assert!(bytes.reads < text.len() * 4, "reads={}", bytes.reads);
        assert!(spans.iter().all(|span| span.replacement == "[redacted]"));
    }

    #[test]
    fn json_text_redaction_reaches_search_and_get_in_small_and_streaming_records() {
        use crate::config::Config;
        use crate::get::{GetParams, get};
        use crate::search::{SearchParams, search};
        use crate::types::GetResponse;
        use crate::utils::RedactionMode;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("history-json-redaction-{}-{nonce}", std::process::id()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let body = r#"{"needle":"fixture-json-needle","sensitiveReads":{"password":0,"hidden":0},"nested":{"password":false,"secret":null},"token":"fixture-secret"}"#;
        for (session, padding) in [("normal01", 0), ("stream01", MAX_JSONL_LINE_BYTES + 1)] {
            let record = serde_json::json!({"uuid":session,"type":"user","timestamp":"2026-10-01T00:00:00Z",
                "padding":"x".repeat(padding),"message":{"content":[{"type":"tool_result","tool_use_id":"fixture-call","content":[{"type":"text","text":body}]}]}});
            std::fs::write(project.join(format!("{session}.jsonl")), format!("{record}\n")).unwrap();
        }
        let config = Config {
            projects_dir: root.clone(),
        };
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            let result = search(
                &config,
                SearchParams {
                    projects: vec!["project".into()],
                    pattern: "fixture-json-needle".into(),
                    redaction: mode,
                    structured: Some("full".into()),
                    ..SearchParams::default()
                },
            )
            .unwrap();
            assert_eq!(result.results.len(), 2);
            for row in result.results {
                let structured = row.tool_result_redacted.unwrap();
                let actual = structured["content"][0]["text"].as_str().unwrap();
                let parsed: serde_json::Value = serde_json::from_str(actual).unwrap();
                let expected = if mode.enabled() {
                    serde_json::json!("[redacted]")
                } else {
                    serde_json::json!(0)
                };
                assert_eq!(parsed["sensitiveReads"]["password"], expected);
                assert_eq!(parsed["sensitiveReads"]["hidden"], 0);
                assert_eq!(
                    parsed["nested"]["password"],
                    if mode.enabled() {
                        serde_json::json!("[redacted]")
                    } else {
                        serde_json::json!(false)
                    }
                );
                assert_eq!(
                    parsed["nested"]["secret"],
                    if mode.enabled() {
                        serde_json::json!("[redacted]")
                    } else {
                        serde_json::Value::Null
                    }
                );
                assert_eq!(
                    parsed["token"],
                    if mode.enabled() { "[redacted]" } else { "fixture-secret" }
                );
                if !mode.enabled() {
                    assert_eq!(actual, body);
                }
                let response = get(
                    &config,
                    GetParams {
                        r#ref: row.r#ref,
                        range: None,
                        output: None,
                        project: Some("project".into()),
                        source: None,
                        redaction: mode,
                        overwrite: false,
                        view: Some("tool_result".into()),
                        block: Some(0),
                    },
                )
                .unwrap();
                let GetResponse::Success { content, .. } = response else {
                    panic!("expected get result")
                };
                let output: serde_json::Value = serde_json::from_str(&content).unwrap();
                let inner: serde_json::Value =
                    serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
                assert_eq!(inner, parsed);
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rhs_redaction_stays_inside_outer_strings() {
        use crate::utils::{RedactionMode, redact_text_with_mode};
        for rhs in [
            "fixture-secret",
            "build(\"fixture-secret\")",
            "build(node] + \"fixture-secret\"",
            "build(\"前缀😀 fixture-secret\")",
            "build(node, \"fixture-secret\"",
        ] {
            let mut text = serde_json::json!({
                "command": format!("中文😀 token={rhs}"),
                "keep": "visible",
                "blocks": [
                    {
                        "type": "text",
                        "text": "later message"
                    }
                ]
            })
            .to_string();
            let mut expected = serde_json::json!({
                "command": "中文😀 token=[redacted]",
                "keep": "visible",
                "blocks": [
                    {
                        "type": "text",
                        "text": "later message"
                    }
                ]
            })
            .to_string();
            for _ in 0..3 {
                for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                    let fixture = Fixture::new(&text);
                    let mut projection = TextProjection::default();
                    projection.literal(text.clone());
                    let mut bytes = TextBytes::new(projection.cursor(
                        fixture.open(),
                        SourceSpan {
                            start: 0,
                            end: text.len() as u64,
                        },
                    ));
                    let mut rendered = Vec::new();
                    let (_, _, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                        rendered.extend_from_slice(chunk);
                        Ok(())
                    })
                    .unwrap();
                    let rendered = String::from_utf8(rendered).unwrap();
                    assert_eq!(
                        rendered,
                        if mode.enabled() { &expected } else { &text }.as_str(),
                        "{text}"
                    );
                    assert_eq!(count, usize::from(mode.enabled()));
                    let ordinary = redact_text_with_mode(&text, mode);
                    assert_eq!(ordinary.text, rendered);
                    assert_eq!(ordinary.count, count);
                }
                text = serde_json::to_string(&text).unwrap();
                expected = serde_json::to_string(&expected).unwrap();
            }
        }
    }

    #[test]
    fn empty_ranges_write_no_text_or_redaction_markers() {
        use crate::utils::RedactionMode;
        let text = "前缀😀 token=fixture-secret 后缀";
        let fixture = Fixture::new(text);
        for structured in [false, true] {
            let mut projection = TextProjection::default();
            projection.literal(text.to_string());
            if structured {
                projection.redactions =
                    Some(redaction_spans(&mut SliceBytes(text.as_bytes()), RedactionMode::Auto).unwrap());
            }
            let mut bytes = TextBytes::new(projection.cursor(
                fixture.open(),
                SourceSpan {
                    start: 0,
                    end: text.len() as u64,
                },
            ));
            let length = text.chars().count();
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                for position in 0..length {
                    let result = render_text_range(&mut bytes, mode, Some((position, position)), |_| {
                        panic!("empty range emitted text")
                    })
                    .unwrap();
                    assert_eq!(result, (length, 0, 0));
                }
                for range in [(length, length), (length + 1, length + 1), (5, 4)] {
                    assert_eq!(
                        render_text_range(&mut bytes, mode, Some(range), |_| panic!("invalid range emitted text"))
                            .unwrap_err()
                            .error,
                        "invalid_range"
                    );
                }
            }
        }
    }

    #[test]
    fn structured_projection_matches_tree_redaction_and_preserves_original_ranges() {
        use crate::utils::{RedactionMode, ToolAssociationTracker, ToolBlockKind, render_tool_block};
        let values = [
            serde_json::json!({
                "type": "tool_use",
                "id": "fixture-call",
                "name": "fixture",
                "input": {
                    "password": {
                        "nested": [
                            1,
                            "test-only-sensitive-value"
                        ]
                    },
                    "url": "https://example.com/中文",
                    "command": "前缀😀\nAuthorization: Bearer\tfixture-value\nword token='quoted-value'",
                    "values": [
                        1.0,
                        null,
                        true,
                        "key = config.get('ENV')"
                    ]
                }
            }),
            serde_json::json!({
                "type": "tool_result",
                "tool_use_id": "fixture-call",
                "content": [
                    {
                        "type": "text",
                        "text": "前缀😀\nAuthorization: Bearer \t fixture-value\nCookie: fixture=value"
                    },
                    {
                        "text": "{\"password\":\"test-only-sensitive-value\"}"
                    },
                    {
                        "text": "{\"password\":0,\"nested\":{\"password\":true},\"plain\":\"visible\"}"
                    }
                ],
                "is_error": false
            }),
        ];
        for value in values {
            let line = serde_json::json!({
                "uuid": "fixture",
                "type": if value[
                    "type"
                ] == "tool_use" {
                    "assistant"
                } else {
                    "user"
                },
                "timestamp": "2026-10-01T00:00:00Z",
                "message": {
                    "content": [
                        value
                    ]
                }
            })
            .to_string();
            let fixture = Fixture::new(&line);
            let span = SourceSpan {
                start: 0,
                end: line.len() as u64,
            };
            let mut index = JsonIndex::new(fixture.open(), span);
            loop {
                let mut budget = 7;
                if index
                    .advance(&mut budget, Instant::now() + Duration::from_secs(1))
                    .unwrap()
                {
                    break;
                }
            }
            let indexed = index.finish(true).unwrap();
            let record = parse_message_record(&line).unwrap().unwrap();
            let blocks = ToolAssociationTracker::default().observe_record(&record, false);
            let block = &blocks[0];
            let view = if block.kind == ToolBlockKind::Use {
                "tool_input"
            } else {
                "tool_result"
            };
            let original = if block.kind == ToolBlockKind::Use {
                block.input.as_ref().unwrap()
            } else {
                block.result.as_ref().unwrap()
            }
            .to_string();
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let expected = render_tool_block(block, mode);
                let expected_value = if block.kind == ToolBlockKind::Use {
                    expected.input.as_ref().unwrap()
                } else {
                    expected.result.as_ref().unwrap()
                };
                let projection = indexed
                    .structured_projection(fixture.open(), span, view, Some(0), mode)
                    .unwrap();
                assert_eq!(projection.characters, original.chars().count());
                let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
                let mut rendered = String::new();
                let (original_count, rendered_count, redacted_count) =
                    render_text_range(&mut bytes, mode, None, |chunk| {
                        rendered.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                assert_eq!(rendered, expected_value.to_string(), "mode={mode:?} view={view}");
                assert_eq!(redacted_count, expected.redacted_count);
                assert_eq!(original_count, original.chars().count());
                assert_eq!(rendered_count, rendered.chars().count());
                let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
                assert_eq!(parsed, *expected_value);
                if view == "tool_result" {
                    let inner: serde_json::Value =
                        serde_json::from_str(parsed["content"][2]["text"].as_str().unwrap()).unwrap();
                    assert_eq!(
                        inner["password"],
                        if mode.enabled() {
                            serde_json::json!("[redacted]")
                        } else {
                            serde_json::json!(0)
                        }
                    );
                    assert_eq!(
                        inner["nested"]["password"],
                        if mode.enabled() {
                            serde_json::json!("[redacted]")
                        } else {
                            serde_json::json!(true)
                        }
                    );
                    assert_eq!(inner["plain"], "visible");
                }
                if mode.enabled() && view == "tool_input" {
                    let start = original[..original.find("test-only-sensitive-value").unwrap()]
                        .chars()
                        .count()
                        + 2;
                    let mut ranged = String::new();
                    render_text_range(&mut bytes, mode, Some((start, start + 4)), |chunk| {
                        ranged.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    assert_eq!(ranged, "\"[redacted]\"");
                }
            }
        }
    }

    #[test]
    fn sshpass_projection_redacts_only_password_values_and_range_intersections() {
        use crate::utils::RedactionMode;
        let secret = "fixture_sshpass_NOT_A_REAL_CREDENTIAL";
        let input = serde_json::json!({"aaa":"前缀😀", "env":{"SSHPASS":secret,"LANG":"C","SSHPASS_FD":3}});
        let original = input.to_string();
        let line = serde_json::json!({
            "uuid": "fixture",
            "type": "assistant",
            "timestamp": "2026-10-01T00:00:00Z",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "fixture-call",
                        "name": "fixture",
                        "input": input
                    }
                ]
            }
        })
        .to_string();
        let fixture = Fixture::new(&line);
        let span = SourceSpan {
            start: 0,
            end: line.len() as u64,
        };
        let indexed = index_record(fixture.open(), span, true).unwrap();
        let start = original[..original.find(secret).unwrap()].chars().count();
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            let projection = indexed
                .structured_projection(fixture.open(), span, "tool_input", Some(0), mode)
                .unwrap();
            let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
            let mut rendered = String::new();
            render_text_range(&mut bytes, mode, None, |chunk| {
                rendered.push_str(std::str::from_utf8(chunk).unwrap());
                Ok(())
            })
            .unwrap();
            let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
            assert_eq!(
                value["env"]["SSHPASS"],
                if mode.enabled() { "[redacted]" } else { secret }
            );
            assert_eq!(value["env"]["LANG"], "C");
            assert_eq!(value["env"]["SSHPASS_FD"], 3);
            let mut ranged = String::new();
            render_text_range(&mut bytes, mode, Some((start + 3, start + 8)), |chunk| {
                ranged.push_str(std::str::from_utf8(chunk).unwrap());
                Ok(())
            })
            .unwrap();
            assert_eq!(
                ranged,
                if mode.enabled() {
                    "\"[redacted]\""
                } else {
                    &secret[3..8]
                }
            );
            if !mode.enabled() {
                assert_eq!(rendered, original);
            }
        }
    }

    #[test]
    fn npm_token_projection_crosses_reader_buffers_and_preserves_ranges() {
        use crate::utils::RedactionMode;
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let make_record = |padding: usize| {
            let text = format!("{} 前缀😀 [{secret}] 后缀", "x".repeat(padding));
            let input = serde_json::json!({"text":text,"note":"visible"});
            let line = serde_json::json!({
                "uuid": "fixture",
                "type": "assistant",
                "timestamp": "2026-10-01T00:00:00Z",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "fixture-call",
                            "name": "fixture",
                            "input": input
                        }
                    ]
                }
            })
            .to_string();
            (line, input)
        };
        let overhead = make_record(0).0.find(&secret).unwrap();
        for token_start in [BUFFER_BYTES - 12, BUFFER_BYTES * 4 - 12] {
            let (line, input) = make_record(token_start - overhead);
            assert_eq!(line.find(&secret).unwrap(), token_start);
            let original = input.to_string();
            let start = original[..original.find(&secret).unwrap()].chars().count();
            let mut expected = input.clone();
            expected["text"] =
                serde_json::Value::String(input["text"].as_str().unwrap().replace(&secret, "[redacted]"));
            let fixture = Fixture::new(&line);
            let span = SourceSpan {
                start: 0,
                end: line.len() as u64,
            };
            let indexed = index_record(fixture.open(), span, true).unwrap();
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let projection = indexed
                    .structured_projection(fixture.open(), span, "tool_input", Some(0), mode)
                    .unwrap();
                let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
                let mut rendered = String::new();
                let (original_count, rendered_count, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                    rendered.push_str(std::str::from_utf8(chunk).unwrap());
                    Ok(())
                })
                .unwrap();
                assert_eq!(original_count, original.chars().count());
                assert_eq!(rendered_count, rendered.chars().count());
                assert_eq!(count, usize::from(mode.enabled()));
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&rendered).unwrap(),
                    if mode.enabled() {
                        expected.clone()
                    } else {
                        input.clone()
                    }
                );
                for (from, to, expected_redacted) in [
                    (start + 4, start + 10, "[redacted]"),
                    (start, start + secret.len(), "[redacted]"),
                    (start - 1, start + secret.len() + 1, "[[redacted]]"),
                ] {
                    let mut ranged = String::new();
                    let (_, _, ranged_count) = render_text_range(&mut bytes, mode, Some((from, to)), |chunk| {
                        ranged.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    let raw: String = original.chars().skip(from).take(to - from).collect();
                    assert_eq!(
                        ranged,
                        if mode.enabled() {
                            expected_redacted
                        } else {
                            raw.as_str()
                        }
                    );
                    assert_eq!(ranged_count, usize::from(mode.enabled()));
                }
            }
        }
    }

    #[test]
    fn npm_token_streaming_matches_explicit_text_and_count_expectations() {
        use crate::utils::{RedactionMode, redact_text_with_mode};
        let secret = format!("npm_{}", "Aa0".repeat(12));
        let cases = [
            (secret.clone(), "[redacted]".to_string(), 1),
            (
                format!("prefix\\n{secret}\\nsuffix"),
                "prefix\\n[redacted]\\nsuffix".to_string(),
                1,
            ),
            (
                format!("prefix\\r{secret}\\rsuffix"),
                "prefix\\r[redacted]\\rsuffix".to_string(),
                1,
            ),
            (
                format!("prefix\\t{secret}\\tsuffix"),
                "prefix\\t[redacted]\\tsuffix".to_string(),
                1,
            ),
            (
                format!("printf '%s\\n' '{secret}' --visible"),
                "printf '%s\\n' '[redacted]' --visible".to_string(),
                1,
            ),
            (format!("NPM_TOKEN='{secret}'"), "NPM_TOKEN=[redacted]".to_string(), 1),
            (
                format!("Authorization: Bearer {secret}"),
                "Authorization: [redacted]".to_string(),
                1,
            ),
            (format!("npm_{}", "A".repeat(35)), format!("npm_{}", "A".repeat(35)), 0),
            (format!("npm_{}", "A".repeat(37)), format!("npm_{}", "A".repeat(37)), 0),
            (format!("{secret}字"), format!("{secret}字"), 0),
            (format!("prefix\\n{secret}字"), format!("prefix\\n{secret}字"), 0),
            (
                format!("prefix\\n{secret}\u{0301}"),
                format!("prefix\\n{secret}\u{0301}"),
                0,
            ),
            (format!("字{secret}"), format!("字{secret}"), 0),
            (format!("{secret}\u{0301}"), format!("{secret}\u{0301}"), 0),
            (format!("[{secret}]😀"), "[[redacted]]😀".to_string(), 1),
        ];
        for (text, expected, expected_count) in cases {
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let spans = redaction_spans(&mut SliceBytes(text.as_bytes()), mode).unwrap();
                let mut actual = String::new();
                let mut position = 0;
                for span in &spans {
                    actual.push_str(&text[position..span.start]);
                    actual.push_str(span.replacement);
                    position = span.end;
                }
                actual.push_str(&text[position..]);
                assert_eq!(
                    actual,
                    if mode.enabled() {
                        expected.as_str()
                    } else {
                        text.as_str()
                    }
                );
                assert_eq!(spans.len(), if mode.enabled() { expected_count } else { 0 });
                let ordinary = redact_text_with_mode(&text, mode);
                assert_eq!(actual, ordinary.text);
                assert_eq!(spans.len(), ordinary.count);
            }
        }
        let url = format!("https://example.com/{secret}");
        for mode in [RedactionMode::Auto, RedactionMode::Strict] {
            let spans = redaction_spans(&mut SliceBytes(url.as_bytes()), mode).unwrap();
            assert_eq!(spans.len(), 1);
            assert_eq!(
                spans[0].replacement,
                if mode == RedactionMode::Strict {
                    "[redacted-url]"
                } else {
                    "[redacted]"
                }
            );
        }
    }

    #[test]
    fn token_uuid_projection_preserves_identifiers_and_original_ranges() {
        use crate::utils::RedactionMode;
        let secret = "11111111-1111-4111-8111-111111111111";
        let identifier = "22222222-2222-4222-8222-222222222222";
        let statement = format!("前缀😀\ntoken created, returned a new UUID {secret}\nordinary suffix");
        let mut serialized = statement.clone();
        for _ in 0..=3 {
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let spans = redaction_spans(&mut SliceBytes(serialized.as_bytes()), mode).unwrap();
                let mut rendered = String::new();
                let mut position = 0;
                for span in &spans {
                    rendered.push_str(&serialized[position..span.start]);
                    rendered.push_str(span.replacement);
                    position = span.end;
                }
                rendered.push_str(&serialized[position..]);
                assert_eq!(spans.len(), usize::from(mode.enabled()));
                assert_eq!(
                    rendered,
                    if mode.enabled() {
                        serialized.replace(secret, "[redacted]")
                    } else {
                        serialized.clone()
                    }
                );
            }
            serialized = serde_json::to_string(&serialized).unwrap();
        }
        let input = serde_json::json!({"text":statement,"session":identifier,"ref":"fixture:12"});
        let original = input.to_string();
        let expected =
            serde_json::json!({"text":statement.replace(secret,"[redacted]"),"session":identifier,"ref":"fixture:12"});
        let line = serde_json::json!({
            "uuid": "fixture",
            "type": "assistant",
            "timestamp": "2026-10-01T00:00:00Z",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "fixture-call",
                        "name": "fixture",
                        "input": input
                    }
                ]
            }
        })
        .to_string();
        let fixture = Fixture::new(&line);
        let span = SourceSpan {
            start: 0,
            end: line.len() as u64,
        };
        let indexed = index_record(fixture.open(), span, true).unwrap();
        let start = original[..original.find(secret).unwrap()].chars().count();
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            let projection = indexed
                .structured_projection(fixture.open(), span, "tool_input", Some(0), mode)
                .unwrap();
            let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
            let mut rendered = String::new();
            let (_, _, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                rendered.push_str(std::str::from_utf8(chunk).unwrap());
                Ok(())
            })
            .unwrap();
            assert_eq!(
                rendered,
                if mode.enabled() {
                    expected.to_string()
                } else {
                    original.clone()
                }
            );
            assert_eq!(count, usize::from(mode.enabled()));
            let mut ranged = String::new();
            render_text_range(&mut bytes, mode, Some((start + 3, start + 8)), |chunk| {
                ranged.push_str(std::str::from_utf8(chunk).unwrap());
                Ok(())
            })
            .unwrap();
            assert_eq!(ranged, if mode.enabled() { "[redacted]" } else { &secret[3..8] });
        }
    }

    #[test]
    fn command_password_options_projection_preserves_non_sensitive_arguments_and_ranges() {
        use crate::utils::RedactionMode;
        let secret = "fixture.password,NOT_A_REAL_CREDENTIAL]tail}";
        for option in ["--password", "--http-password", "--ftp-password", "--proxy-password"] {
            for (separator, value) in [
                (" ", secret.to_string()),
                ("=", format!("'{secret} with spaces'")),
                (" ", format!("'{secret}'suffix")),
                (" ", format!("prefix'{secret}'")),
                (" ", format!("{secret}\\ with\\ spaces")),
                (" ", format!("\"{secret}\"suffix")),
                (" ", format!("prefix\"{secret} with spaces\"suffix")),
                (" ", format!("'{secret}\\ with spaces'suffix")),
                (" ", format!("{secret}\\\"suffix")),
                ("\t", format!("\"{secret} with spaces\"")),
                ("\n", secret.to_string()),
                ("\r", secret.to_string()),
            ] {
                let command = format!("wget --user fixture-user {option}{separator}{value} --preserve-permissions");
                let input =
                    serde_json::json!({"aaa":"前缀😀", "command":command, "env":{"LANG":"C"}, "note":"visible"});
                let original = input.to_string();
                let line = serde_json::json!({
                    "uuid": "fixture",
                    "type": "assistant",
                    "timestamp": "2026-10-01T00:00:00Z",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "fixture-call",
                                "name": "fixture",
                                "input": input
                            }
                        ]
                    }
                })
                .to_string();
                let fixture = Fixture::new(&line);
                let span = SourceSpan {
                    start: 0,
                    end: line.len() as u64,
                };
                let indexed = index_record(fixture.open(), span, true).unwrap();
                let start = original[..original.find(secret).unwrap()].chars().count();
                for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                    let projection = indexed
                        .structured_projection(fixture.open(), span, "tool_input", Some(0), mode)
                        .unwrap();
                    let mut bytes = TextBytes::new(projection.cursor(fixture.open(), span));
                    let mut rendered = String::new();
                    render_text_range(&mut bytes, mode, None, |chunk| {
                        rendered.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
                    let expected =
                        format!("wget --user fixture-user {option}{separator}[redacted] --preserve-permissions");
                    assert_eq!(
                        value["command"],
                        if mode.enabled() {
                            expected.as_str()
                        } else {
                            command.as_str()
                        }
                    );
                    assert_eq!(value["env"]["LANG"], "C");
                    assert_eq!(value["note"], "visible");
                    let mut ranged = String::new();
                    render_text_range(&mut bytes, mode, Some((start + 3, start + 8)), |chunk| {
                        ranged.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    assert_eq!(ranged, if mode.enabled() { "[redacted]" } else { &secret[3..8] });
                    if !mode.enabled() {
                        assert_eq!(rendered, original);
                    }
                }
            }
        }
    }

    #[test]
    fn mh_h01_authorization_keeps_json_scope_and_decoded_header_boundaries() {
        use crate::utils::{RedactionMode, redact_text_with_mode};
        for header in [
            "Authorization: Basic Zml4dHVyZTpwYXNz",
            "Authorization:\tBearer fixture.value",
            "Authorization: Digest username=\"fixture user\", response=\"fixture-secret\"",
            "Authorization: AWS EXAMPLEACCESS:fixture-signature=",
            "Authorization: AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                SignedHeaders=host;x-amz-date, \
                Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            let mut text = format!("note: visible\n{header}\nX-Diagnostic: visible");
            let mut expected = format!(
                "note: visible\nAuthorization:{}[redacted]\nX-Diagnostic: visible",
                if header.starts_with("Authorization:\t") {
                    "\t"
                } else {
                    " "
                }
            );
            for _ in 0..4 {
                for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                    let expected = if mode.enabled() { &expected } else { &text };
                    let plain = redact_text_with_mode(&text, mode);
                    assert_eq!(&plain.text, expected, "{mode:?} {text}");
                    let fixture = Fixture::new(&text);
                    let mut projection = TextProjection::default();
                    projection.literal(text.clone());
                    let mut bytes = TextBytes::new(projection.cursor(
                        fixture.open(),
                        SourceSpan {
                            start: 0,
                            end: text.len() as u64,
                        },
                    ));
                    let mut rendered = String::new();
                    let (_, _, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                        rendered.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    assert_eq!(&rendered, expected, "indexed {mode:?} {text}");
                    assert_eq!(count, plain.count);
                }
                text = serde_json::to_string(&text).unwrap();
                expected = serde_json::to_string(&expected).unwrap();
            }
        }
    }

    #[test]
    fn ql_h01_authorization_complete_values_and_decoded_syntax() {
        use crate::utils::{RedactionMode, redact_text_range_with_mode};
        let mut failures = Vec::new();
        for (text, redacted) in ql_h01_authorization_corpus() {
            let redacts = text != redacted;
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let expected = if mode.enabled() { &redacted } else { &text };
                let mut ranges = vec![None];
                for secret in [
                    "Zml4dHVyZTpwYXNz",
                    "fixture.value",
                    "EXAMPLEACCESS",
                    "fixture.signature",
                    "signature",
                ] {
                    if let Some(start) = text.find(secret) {
                        let start = text[..start].chars().count();
                        ranges.push(Some((start + 2, start + 5)));
                    }
                }
                for range in ranges {
                    let expected = if let Some((start, end)) = range {
                        if mode.enabled() && redacts {
                            "[redacted]".to_string()
                        } else {
                            text.chars().skip(start).take(end - start).collect()
                        }
                    } else {
                        expected.clone()
                    };
                    let plain = redact_text_range_with_mode(&text, mode, range);
                    if plain.text != expected || plain.count != usize::from(mode.enabled() && redacts) {
                        failures.push(format!("plain {mode:?} {range:?} {text:?}: {:?}", plain.text));
                    }
                    let fixture = Fixture::new(&text);
                    let mut projection = TextProjection::default();
                    projection.literal(text.clone());
                    let mut bytes = TextBytes::new(projection.cursor(
                        fixture.open(),
                        SourceSpan {
                            start: 0,
                            end: text.len() as u64,
                        },
                    ));
                    let mut actual = String::new();
                    let (_, _, count) = render_text_range(&mut bytes, mode, range, |chunk| {
                        actual.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    if actual != expected || count != usize::from(mode.enabled() && redacts) {
                        failures.push(format!("indexed {mode:?} {range:?} {text:?}: {actual:?}"));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn repair_h02_authorization_expected_corpus() {
        use crate::utils::{RedactionMode, redact_text_with_mode};
        for (text, expected) in [
            ("Authorization: Basic Zml4dHVyZTpwYXNz", "Authorization: [redacted]"),
            (
                "Authorization: Basic c3ludGhldGljOnBhc3M=, status=ok",
                "Authorization: [redacted], status=ok",
            ),
            (
                "Authorization: Digest username = \"fixture user\", response = \"fixture-secret\", X-Trace: visible",
                "Authorization: [redacted], X-Trace: visible",
            ),
            (
                "Authorization: Digest username=\"fixture user\", response=\"fixture-secret\", X-Trace: visible",
                "Authorization: [redacted], X-Trace: visible",
            ),
            (
                "Authorization: Custom fixture.value diagnostic tail",
                "Authorization: [redacted] diagnostic tail",
            ),
            (
                "Authorization: Bearer fixture.value visible-after",
                "Authorization: [redacted] visible-after",
            ),
            (
                "Authorization: Custom fixture.value; status=ok",
                "Authorization: [redacted]; status=ok",
            ),
            (
                "Authorization: Custom fixture.value:signature diagnostic tail",
                "Authorization: [redacted] diagnostic tail",
            ),
            (
                "Proxy-Authorization: Fixture fixture.value:signature; status=ok",
                "Proxy-Authorization: [redacted]; status=ok",
            ),
            (
                "Authorization: Basic Zml4dHVyZTpwYXNz, X-Trace: visible",
                "Authorization: [redacted], X-Trace: visible",
            ),
            (
                "Authorization: Bearer\nX-Trace: visible",
                "Authorization: [redacted]\nX-Trace: visible",
            ),
            (
                "Authorization: Basic Zml4dHVyZTpwYXNz\nX-Trace: visible",
                "Authorization: [redacted]\nX-Trace: visible",
            ),
            (
                "Authorization: AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                    SignedHeaders=host;x-amz-date, \
                    Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nX-Diagnostic: visible",
                "Authorization: [redacted]\nX-Diagnostic: visible",
            ),
            (
                "Authorization: AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                    SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fixture.signature, X-Trace: visible",
                "Authorization: [redacted], X-Trace: visible",
            ),
            (
                "Authorization: AWS4-HMAC-SHA256 Credential=EXAMPLEACCESS/20261027/us-east-1/s3/aws4_request, \
                    SignedHeaders=host;x-amz-date, Signature=fixture.signature; status=ok",
                "Authorization: [redacted]; status=ok",
            ),
            (
                "Authorization: AWS EXAMPLEACCESS:fixture-signature=\nX-Diagnostic: visible",
                "Authorization: [redacted]\nX-Diagnostic: visible",
            ),
            (
                "Authorization: AWS EXAMPLEACCESS:fixture-signature= diagnostic tail",
                "Authorization: [redacted] diagnostic tail",
            ),
            (
                "Authorization: AWS\nX-Trace: visible",
                "Authorization: [redacted]\nX-Trace: visible",
            ),
            (
                "Authorization: AWS4-HMAC-SHA256\r\nX-Trace: visible",
                "Authorization: [redacted]\r\nX-Trace: visible",
            ),
        ] {
            for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
                let expected = if mode.enabled() { expected } else { text };
                let plain = redact_text_with_mode(text, mode);
                assert_eq!(plain.text, expected, "plain {mode:?} {text:?}");
                assert_eq!(plain.count, usize::from(mode.enabled()));
                let fixture = Fixture::new(text);
                let mut projection = TextProjection::default();
                projection.literal(text.to_string());
                let mut bytes = TextBytes::new(projection.cursor(
                    fixture.open(),
                    SourceSpan {
                        start: 0,
                        end: text.len() as u64,
                    },
                ));
                let mut actual = String::new();
                let (_, _, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                    actual.push_str(std::str::from_utf8(chunk).unwrap());
                    Ok(())
                })
                .unwrap();
                assert_eq!(actual, expected, "indexed {mode:?} {text:?}");
                assert_eq!(count, plain.count);
                for start in [
                    "fixture.value",
                    "Zml4dHVyZTpwYXNz",
                    "EXAMPLEACCESS",
                    "fixture.signature",
                    "fixture-signature",
                    "0123456789abcdef",
                ]
                .into_iter()
                .filter_map(|needle| text.find(needle))
                {
                    let range = Some((start + 2, start + 5));
                    let plain = crate::utils::redact_text_range_with_mode(text, mode, range);
                    let expected = if mode.enabled() {
                        "[redacted]"
                    } else {
                        &text[start + 2..start + 5]
                    };
                    assert_eq!(plain.text, expected);
                    let mut actual = String::new();
                    render_text_range(&mut bytes, mode, range, |chunk| {
                        actual.push_str(std::str::from_utf8(chunk).unwrap());
                        Ok(())
                    })
                    .unwrap();
                    assert_eq!(actual, expected);
                }
            }
        }
    }

    #[test]
    fn streaming_redaction_matches_existing_text_rules() {
        use crate::utils::{RedactionMode, redact_text_with_mode};
        let values = [
            "password = value\ntoken = os.environ['TOKEN']\nsecret = config.get('KEY')",
            "token = secret.split(':', 1)[0]\ntoken = secret.split(':')[0]",
            "token = (lambda x: x)(os.environ['TOKEN'])\ntoken = call(value, password='literal')",
            "authorization: Bearer value\nCookie: a=1; b=2\nhttp://example.com/a 192.168.1.2",
            "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END EC PRIVATE KEY-----",
            "{\"token\": {\"nested\": [1, \"literal\"]}, \"text\":\"中文😀\"}",
            r#"{\"token\": \"literal\", \"name\": \"plain\"}"#,
            "ordinary quoted 'password=literal' and its tail",
            "Authorization = bare-value Cookie=x\nhttp://example.com/path\"tail",
            "Xauthorization:value notcookie:value 192.168.1.23x 192.168.1.23",
            "Authorization: Bearer\tvalue",
            "Authorization: Bearer \t  value",
            "Authorization:\u{2003}Bearer\u{2002}\u{2003}value",
            "Authorization: Bearer\n\tvalue",
            "Authorization: Bearer \t  ",
            "Cookie:     \n",
            "Cookie:\n \n",
            "Cookie:\r\n",
            "Cookie:\u{2028}",
            "ghost_appearance :: description",
            "host::method()",
            "url::parse()",
            "endpoint::status",
            "domain::lookup",
            "host: fixture-machine",
            "password::fixture-secret",
            "host:::1",
            r#""host":"::fixture-machine""#,
            "host::192.168.1.2",
            "url::https://example.com",
            "host::call(password=fixture-secret)",
        ];
        for mode in [RedactionMode::Auto, RedactionMode::Strict, RedactionMode::Off] {
            for text in values {
                let spans = redaction_spans(&mut SliceBytes(text.as_bytes()), mode).unwrap();
                let mut actual = String::new();
                let mut position = 0;
                for span in &spans {
                    actual.push_str(&text[position..span.start]);
                    actual.push_str(span.replacement);
                    position = span.end;
                }
                actual.push_str(&text[position..]);
                let expected = redact_text_with_mode(text, mode);
                assert_eq!(actual, expected.text, "mode={mode:?} text={text:?}");
                assert_eq!(spans.len(), expected.count, "mode={mode:?} text={text:?}");
            }
        }
    }

    #[test]
    fn long_field_candidates_match_text_redaction_without_allocating_whole_keys() {
        let prefix = "section".repeat(MAX_KEY_BYTES / 7 + 100);
        let mut samples = vec![
            format!("\"{prefix}\":\"visible\"; token='fixture-only-secret'"),
            format!("\"{prefix}password\":\"fixture-only-secret\"; visible"),
            format!("\"{prefix}key\":\"fixture-only-secret\"; visible"),
            format!("\"{prefix}key-middle\":\"visible\"; token='fixture-only-secret'"),
            format!("\"{prefix}\\u0074oken\":\"fixture-only-secret\"; visible"),
            format!("\"{prefix}\\qtoken\":\"fixture-only-secret\"; visible"),
            format!("\"{prefix}\\u0074oken\\q\":\"visible\"; token='fixture-only-secret'"),
            format!("\"{prefix}\\ud83d\\ude00TOKEN\":\"fixture-only-secret\"; visible"),
            format!("\"{prefix}\\ud800\\u0074oken\":\"visible\"; token='fixture-only-secret'"),
            format!("\"{prefix}pwd\":\"visible\"; token='fixture-only-secret'"),
            format!(
                "\"{prefix}key{}\":\"visible\"; token='fixture-only-secret'",
                "x".repeat(MAX_KEY_BYTES)
            ),
            format!("\"{prefix}中文😀url\":\"fixture-only-secret\"; visible"),
            format!("'{prefix}password'='fixture-only-secret'; visible"),
            format!("{prefix}password=fixture-only-secret; visible"),
        ];
        for keyword in [
            "password",
            "passwd",
            "secret",
            "token",
            "cookie",
            "authorization",
            "privatekey",
            "keypath",
            "key_path",
            "host",
            "url",
            "endpoint",
            "domain",
        ] {
            for offset in [MAX_KEY_BYTES - keyword.len() / 2, MAX_KEY_BYTES, MAX_KEY_BYTES + 1] {
                samples.push(format!(
                    "\"{}{keyword}-middle\":\"fixture-only-secret\"; visible",
                    "x".repeat(offset)
                ));
            }
        }
        let embedded = format!("{{\"{prefix}\\u0074oken\":\"fixture-only-secret\"}}");
        samples.push(serde_json::to_string(&embedded).unwrap());
        samples.push(serde_json::to_string(&serde_json::to_string(&embedded).unwrap()).unwrap());
        for mode in [crate::utils::RedactionMode::Auto, crate::utils::RedactionMode::Strict] {
            for text in &samples {
                let expected = crate::utils::redact_text_with_mode(text, mode);
                let fixture = Fixture::new(text);
                let mut projection = TextProjection::default();
                projection.literal(text.clone());
                let mut bytes = TextBytes::new(projection.cursor(
                    fixture.open(),
                    SourceSpan {
                        start: 0,
                        end: text.len() as u64,
                    },
                ));
                let mut actual = Vec::new();
                let (_, _, count) = render_text_range(&mut bytes, mode, None, |chunk| {
                    actual.extend_from_slice(chunk);
                    Ok(())
                })
                .unwrap();
                assert_eq!(String::from_utf8(actual).unwrap(), expected.text);
                assert_eq!(count, expected.count);
            }
        }
    }

    #[test]
    fn field_decoding_preserves_source_failures() {
        let source = b"\\\xfftoken";
        let error = field_key_sensitive(
            &mut SliceBytes(source),
            0,
            source.len(),
            1,
            crate::utils::RedactionMode::Strict,
        )
        .unwrap_err();
        assert_eq!(error.error, "parse_error");
    }

    #[test]
    fn json_object_keys_keep_the_bounded_index_limit() {
        let line = format!("{{\"{}\":0}}", "x".repeat(MAX_KEY_BYTES + 1));
        let fixture = Fixture::new(&line);
        let error = index_record(
            fixture.open(),
            SourceSpan {
                start: 0,
                end: line.len() as u64,
            },
            true,
        )
        .err()
        .expect("JSON 对象键仍须满足索引配额");
        assert_eq!(error.error, "record_index_limit");
    }

    #[test]
    fn resumable_index_projects_exactly_like_small_records() {
        let line = concat!(
            r#"{"uuid":"fixture","type":"assistant","timestamp":"2026-10-12T00:00:00Z","#,
            r#""message":{"content":[{"type":"text","text":"中文 😀\n\""},{"type":"tool_use","name":"fixture","#,
            r#""input":{"z":1.0,"a":"😀"}},{"type":"tool_result","content":[{"text":""},{"text":"结果"}]},"#,
            r#"{"type":"image","source":{"data":"YWJj","media_type":"image/png"}}]}}"#
        );
        let fixture = Fixture::new(line);
        let span = SourceSpan {
            start: 0,
            end: line.len() as u64,
        };
        let mut index = JsonIndex::new(fixture.open(), span);
        loop {
            let mut remaining = 7;
            if index
                .advance(&mut remaining, Instant::now() + Duration::from_secs(1))
                .unwrap()
            {
                break;
            }
        }
        let indexed = index.finish(true).unwrap();
        let projection = indexed.projection(fixture.open(), span, "content", None).unwrap();
        let expected = replace_images_with_placeholders(&parse_message_record(line).unwrap().unwrap());
        assert_eq!(
            projection.cursor(fixture.open(), span).read_text(1_000_000).unwrap(),
            expected
        );
        let input = indexed.projection(fixture.open(), span, "tool_input", Some(1)).unwrap();
        assert_eq!(
            input.cursor(fixture.open(), span).read_text(1000).unwrap(),
            "{\"a\":\"😀\",\"z\":1.0}"
        );
    }
}

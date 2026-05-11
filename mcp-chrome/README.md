# MCP-Chrome

English | [中文](README_zh.md)

Chrome browser automation MCP Server with dual-mode architecture: **Extension mode** (recommended) controls your
existing browser, **CDP mode** (fallback) launches a dedicated instance.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## Features

- **Dual Mode**: Extension mode shares your login sessions; CDP mode for headless/isolated scenarios
- **8 Unified Tools**: Action-based design covering browse, input, extract, wait, evaluate, manage, cookies, logs
- **Multi-Tab Parallel**: `tabId` parameter enables operations on any tab without switching focus
- **iframe Penetration**: `frame` parameter targets elements inside iframes (CSS selector or index, Extension mode)
- **Semantic Targeting**: 11 ways to locate elements (role, text, label, css, css+text combo, xpath, coordinates, etc.)
- **Auto-Wait**: Built-in clickability and input-ready detection with deadline-based timeout budget
- **Dual Input Mode**: `precise` (debugger API, bypasses CSP) or `stealth` (JS injection, no debug banner)
- **Smart Output**: Bare `return` auto-wrapped in IIFE; large results (>100KB) auto-saved to file; `output` writes raw
  text for strings
- **Multi-Server**: Extension auto-discovers and connects to multiple MCP Server instances simultaneously
- **Anti-Detection**: Optional fingerprint masking and behavior simulation
- **Structured Errors**: Every error includes code, message, suggestion, and context

## Compatible Clients

| Client                    | Status |
|---------------------------|--------|
| Claude Code               | ✅      |
| Claude Desktop            | ✅      |
| Cursor                    | ✅      |
| Windsurf                  | ✅      |
| Any MCP-compatible client | ✅      |

## Installation

```bash
npm install -g @pyrokine/mcp-chrome
```

Or from source:

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-chrome
npm install
npm run build
```

## Quick Start

### Mode 1: Extension Mode (Recommended)

Extension mode controls your existing Chrome — shares login sessions, cookies, and browsing context.

**Step 1: Install Chrome Extension**

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" → select `mcp-chrome/extension/dist/` directory
4. The MCP Chrome icon appears in the toolbar

**Step 2: Configure MCP Client**

```bash
# Claude Code
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

```json
// Claude Desktop / Other Clients
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/mcp-chrome/dist/index.js"
      ]
    }
  }
}
```

**Step 3: Connect**

The Extension auto-connects to the MCP Server via HTTP/WebSocket (port 19222-19299). Click the toolbar icon to verify
connection status.

```
browse(action="list")          // List all tabs
browse(action="open", url="https://example.com")
extract(type="screenshot")
```

### Mode 2: CDP Mode (Fallback)

CDP mode launches or connects to a dedicated Chrome instance. Used when the Extension is not installed, or for
headless/isolated scenarios.

```bash
# Start Chrome with remote debugging
google-chrome --remote-debugging-port=9222
```

```
browse(action="connect", port=9222)
browse(action="open", url="https://example.com")
```

> When the Extension is connected, all tools use Extension mode automatically. CDP mode activates only when the
> Extension is unavailable.

## Available Tools (8 Tools)

### browse - Browser Management & Navigation

| Action    | Description                           |
|-----------|---------------------------------------|
| `launch`  | Launch new Chrome instance (CDP mode) |
| `connect` | Connect to running Chrome (CDP mode)  |
| `list`    | List all pages/tabs                   |
| `attach`  | Attach to a specific page/tab         |
| `open`    | Navigate to URL                       |
| `back`    | Go back in history                    |
| `forward` | Go forward in history                 |
| `refresh` | Reload page                           |
| `close`   | Close browser connection              |

Extension-specific: `list` returns additional fields: `managed` (whether tab is in MCP Chrome group), `isActive`
(whether it's the current operation target), `windowId`, `index`, `pinned`, `incognito`, `status` (`loading`/
`complete`).
`open` auto-creates tab group (cyan color).

### input - Keyboard & Mouse Input

Event sequence model supporting arbitrary combinations:

| Event Type                              | Description                                                                       |
|-----------------------------------------|-----------------------------------------------------------------------------------|
| `keydown` / `keyup`                     | Key press/release                                                                 |
| `click`                                 | Click with actionability checks (visible, enabled, not-covered, auto-scroll)      |
| `mousedown` / `mouseup`                 | Mouse button press/release                                                        |
| `mousemove`                             | Mouse movement                                                                    |
| `wheel`                                 | Mouse wheel scroll                                                                |
| `touchstart` / `touchmove` / `touchend` | Touch events                                                                      |
| `type`                                  | Type text (with optional `delay`, `dispatch` for React/Vue)                       |
| `wait`                                  | Pause between events                                                              |
| `select`                                | Select text by content (mouse sim)                                                |
| `replace`                               | Find and replace text                                                             |
| `drag`                                  | HTML5 drag-and-drop (DragEvent in MAIN world, with `target` source + `to` target) |

Special-case parameters:

- `keydown` accepts `commands` (e.g. `["selectAll"]`, `["copy"]`, `["paste"]`, `["cut"]`, `["undo"]`, `["redo"]`) to
  trigger native browser editing commands. `commands` is precise-mode only — stealth mode will throw because the
  CDP commands API has no JS-event equivalent.
- `keydown` on a key already held emits `rawKeyDown` with `autoRepeat: true` (Puppeteer-compatible long-press).

Parameters: `humanize` enables Bézier curve movement and random delays. `tabId` targets a specific tab. `frame` targets
an iframe (CSS selector or index). Both Extension mode only.

**`click`-specific**: `force: true` skips actionability checks (useful for testing or hidden elements).
**`type`-specific**: `dispatch: true` sets `.value` directly and fires `input`/`change` events — use for React/Vue
controlled inputs where keyboard events don't update state. Requires a non-coordinate `target`. Extension mode only.

### extract - Content Extraction

| Type         | Description                                       |
|--------------|---------------------------------------------------|
| `text`       | Extract text content                              |
| `html`       | Extract HTML source                               |
| `attribute`  | Extract element attribute                         |
| `screenshot` | Take screenshot (supports `target` element crop)  |
| `state`      | Get page state (URL, title, interactive elements) |
| `metadata`   | Extract page metadata (title, OG, JSON-LD, etc.)  |

Parameters: `output` saves result to file (or directory for `images=data`). `images` (`info`/`data`) extracts image
metadata or data alongside HTML. `tabId` targets a specific tab. `frame` targets an iframe. Both Extension mode only.

**`attribute` special prefix**: `computed:<property>` returns the computed CSS style value (e.g. `computed:color`,
`computed:font-size`). Use `computed:*` to return all computed style properties as JSON (returns 300+ properties — use
`output` to save to file).

**`state`-specific**: `depth` controls DOM traversal depth (default 15). Reduce to limit response size on large pages.
`mode` selects the underlying source — `accessibility` (default, derived from the a11y tree) or `domsnapshot` (raw CDP
`DOMSnapshot.captureSnapshot`, CDP-only; returns a flat node array with computed styles for advanced post-processing).

### wait - Wait for Conditions

| For          | Description                                         |
|--------------|-----------------------------------------------------|
| `element`    | Wait for element (visible/hidden/attached/detached) |
| `navigation` | Wait for navigation complete                        |
| `time`       | Fixed delay                                         |
| `idle`       | Wait for page load + DOM mutation quiet period      |

Parameters: `tabId` targets a specific tab. `frame` targets an iframe. Both Extension mode only.

**`idle`-specific**: After `readyState === 'complete'`, injects a `MutationObserver` and waits for a quiet period with
no DOM changes. The `ms` parameter controls the quiet period duration (default 500ms). Returns `domStable: true` when
the DOM settled, `domStable: false` if still mutating when the budget ran out.

### evaluate - JavaScript Execution

Execute JavaScript in page context.

| Parameter    | Description                                                                                                                       |
|--------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `script`     | JavaScript code. Bare `return` statements auto-wrapped in IIFE                                                                    |
| `scriptFile` | Read script from a local file (alternative to `script`, relative paths default to controlled temp dir, use `cwd:` for repo files) |
| `args`       | Arguments passed to script (script must be a function expression)                                                                 |
| `mode`       | `precise` (default, debugger API) or `stealth` (JS injection)                                                                     |
| `output`     | Save result to file (relative paths default to controlled temp dir, use `cwd:` to persist in repo)                                |
| `tabId`      | Target a specific tab (Extension mode)                                                                                            |
| `frame`      | Target an iframe by CSS selector or index (Extension mode)                                                                        |
| `timeout`    | End-to-end budget (ms)                                                                                                            |

`script` and `scriptFile` are mutually exclusive; at least one must be provided. Relative `scriptFile` and `output`
paths default to the OS temp directory managed by `mcp-chrome`. Use `cwd:relative/path` when the file must live in the
current working directory. Relative paths reject `..`, and on Windows they also reject `:` to avoid NTFS alternate data
streams.

Results >100KB are auto-saved to the controlled OS temp directory with a structured hint returned.

### manage - Page & Environment Management

| Action       | Description                                               |
|--------------|-----------------------------------------------------------|
| `newPage`    | Create new page/tab                                       |
| `closePage`  | Close page                                                |
| `clearCache` | Clear cache/storage (use `cookies` tool to clear cookies) |
| `viewport`   | Set viewport size                                         |
| `userAgent`  | Set User-Agent                                            |
| `emulate`    | Device emulation (iPhone, iPad, etc.)                     |
| `inputMode`  | Query or set input mode (`precise` / `stealth`)           |
| `stealth`    | Inject anti-detection scripts                             |
| `cdp`        | Send raw CDP command (advanced, e.g. `Runtime.evaluate`)  |

**Stealth mode levels** (CDP launch parameter, set via `browse action=launch stealth=...`):

- `off` — no anti-detection (clean mode for tests/CI)
- `safe` (default) — minimal patches (remove `navigator.webdriver`, clean CDP traces)
- `aggressive` — adds a few WebGL/plugin/language fingerprint patches (does NOT equal full masking)

### logs - Browser Logs

| Type      | Description                            |
|-----------|----------------------------------------|
| `console` | Console logs (with level filter)       |
| `network` | Network request logs (with URL filter) |

Parameters: `output` saves result to file. `tabId` targets a specific tab (Extension mode). `frame` is not applicable
for logs.

### cookies - Cookie Management

| Action   | Description                                                   |
|----------|---------------------------------------------------------------|
| `get`    | Get cookies                                                   |
| `set`    | Set cookie                                                    |
| `delete` | Delete cookie                                                 |
| `clear`  | Delete cookies by filter (`name`/`domain`/`url`, ≥1 required) |

**Note**: `clear` requires at least one of `name`, `domain`, or `url` to filter — calling without any filter is rejected
to avoid wiping the user's login cookies.

## Target: Unified Element Locator

All tools use a unified `Target` type for element location:

```typescript
// By accessibility (recommended - most stable)
{ role: "button", name: "Submit" }

// By text content
{ text: "Click here", exact: true }

// By form label
{
    label: "Email"
}

// By placeholder
{
    placeholder: "Enter your name"
}

// By title attribute
{
    title: "Close dialog"
}

// By alt text (images)
{
    alt: "Profile picture"
}

// By test ID
{
    testId: "submit-button"
}

// By CSS selector
{
    css: "#login-form .submit-btn"
}

// Disambiguate multiple matches (0-based)
{ css: ".ant-select-input", nth: 1 }

// By CSS + text (filter by text content)
{ css: "button", text: "Submit", exact: true }

// By XPath
{
    xpath: "//button[@type='submit']"
}

// By coordinates
{ x: 100, y: 200 }
```

## Usage Examples

### Basic: List Tabs and Navigate

```
browse(action="list")
browse(action="open", url="https://example.com")
extract(type="state")
```

### Click a Button

```
input(events=[
  { type: "mousedown", target: { role: "button", name: "Submit" } },
  { type: "mouseup" }
])
```

### Type in Input Field

```
input(events=[
  { type: "mousedown", target: { label: "Email" } },
  { type: "mouseup" },
  { type: "type", text: "user@example.com" }
])
```

### Multi-Tab Operation (Extension Mode)

```
// Operate on a specific tab without switching focus
extract(type="screenshot", tabId="12345")
evaluate(script="document.title", tabId="12345")
```

### Screenshot

```
// Full page
extract(type="screenshot", fullPage=true)

// Element screenshot (any target type)
extract(type="screenshot", target={ role: "button", name: "Submit" })

// JPEG with quality (smaller file)
extract(type="screenshot", format="jpeg", quality=80, output="tmp:screenshot.jpg")

// Save to file
extract(type="screenshot", output="tmp:screenshot.png")
```

### Extract HTML with Images

```
// Get HTML + image metadata (src, alt, dimensions)
extract(type="html", target={ css: ".article" }, images="info")

// Get HTML + image data, save to directory
extract(type="html", images="data", output="tmp:page")
// Creates: <system-temp>/claude-tools/mcp-chrome/page/content.html, images/*, index.json

// Get HTML + image data inline (max 20 images)
extract(type="html", target={ css: ".card" }, images="data")
```

### Page Metadata

```
// Extract title, OG tags, JSON-LD, feeds, etc.
extract(type="metadata")
```

### iframe Operations (Extension Mode)

```
// Target iframe by CSS selector
evaluate(script="document.title", frame="iframe#main")

// Target iframe by index
extract(type="text", frame=0)

// Input inside iframe
input(events=[
  { type: "mousedown", target: { label: "Username" } },
  { type: "mouseup" },
  { type: "type", text: "admin" }
], frame="iframe.login-frame")
```

### Wait for Element

```
wait(for="element", target={ text: "Loading complete" }, state="visible")
```

## Architecture

```
┌───────────────────┐
│    MCP Client     │
│  (Claude, etc.)   │
└─────────┬─────────┘
          │ stdio (JSON-RPC)
          ▼
┌───────────────────┐
│    MCP-Chrome     │
│    (8 tools)      │
│  ├─ core/         │  UnifiedSession, Locator, AutoWait
│  ├─ cdp/          │  Native CDP client
│  ├─ extension/    │  Extension bridge (HTTP + WebSocket)
│  └─ tools/        │  Tool implementations
└────┬─────────┬────┘
     │         │
     │ HTTP/WS │ WebSocket (CDP)
     │         │
     ▼         ▼
┌──────────┐  ┌──────────────────┐
│ Extension│  │ Chrome (CDP)     │
│ (19222+) │  │ (port 9222)      │
│          │  │ Dedicated browser│
│ Controls │  └──────────────────┘
│ user's   │
│ browser  │
└──────────┘
```

## Project Structure

```
mcp-chrome/
├── src/
│   ├── index.ts              # MCP Server entry
│   ├── tools/                # 8 MCP tools
│   │   ├── browse.ts
│   │   ├── input.ts
│   │   ├── extract.ts
│   │   ├── wait.ts
│   │   ├── manage.ts
│   │   ├── logs.ts
│   │   ├── cookies.ts
│   │   ├── evaluate.ts
│   │   └── schema.ts         # Shared JSON Schema (Target oneOf)
│   ├── core/                 # Core abstractions
│   │   ├── unified-session.ts # Dual-mode session (Extension + CDP)
│   │   ├── browser-driver.ts # IBrowserDriver abstraction
│   │   ├── session.ts        # CDP session management
│   │   ├── locator.ts        # Element locator (deadline-based timeout)
│   │   ├── auto-wait.ts      # Auto-wait mechanism
│   │   ├── retry.ts          # Retry logic
│   │   ├── types.ts          # Type definitions
│   │   ├── utils.ts          # Shared helpers
│   │   ├── errors.ts         # Error types
│   │   └── index.ts          # Module entry
│   ├── extension/            # Extension bridge
│   │   ├── bridge.ts         # High-level Extension API
│   │   └── http-server.ts    # HTTP + WebSocket server
│   ├── cdp/                  # CDP layer
│   │   ├── client.ts         # WebSocket CDP client
│   │   └── launcher.ts       # Chrome launcher
│   └── anti-detection/       # Anti-detection (optional)
│       ├── injection.ts
│       └── behavior.ts
├── extension/                # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── src/
│   │   ├── background/       # Service Worker
│   │   ├── content/          # Content scripts
│   │   └── popup/            # Popup UI
│   └── dist/                 # Built extension (load this in Chrome)
├── scripts/
│   ├── start-chrome.sh
│   └── start-chrome-headless.sh
└── package.json
```

## Security Notes

- **Trust boundary**: This server has no application-layer authentication — it relies on `127.0.0.1` binding plus
  same-UID trust, matching the model used by Playwright, Puppeteer, and chrome-launcher. Do NOT run on multi-user
  systems, CI runners, or containers with `--net=host` where untrusted code can reach `127.0.0.1:19222-19299`. WebSocket
  upgrades require a `chrome-extension://` Origin header, which blocks browser pages and curl, but does not stop a
  malicious local process running as the same user.
- Extension mode: shares your browser sessions — only use on trusted machines
- CDP mode: provides full browser control via DevTools Protocol
- Default ports bind to 127.0.0.1 only (localhost)
- The `evaluate` tool can execute arbitrary JavaScript
- The `manage cdp` action can send arbitrary CDP commands
- Network logs may contain sensitive information

### Anti-detection (stealth) — what it actually does

The `stealth` mode (`safe` / `aggressive`) only patches a small set of fingerprinting surfaces:

- **Covers**: `navigator.webdriver`, `cdc_*` properties, User-Agent string, a few WebGL vendor/renderer values, Chrome
  runtime properties
- **Does NOT cover**: Canvas fingerprinting, AudioContext fingerprinting, Font enumeration, TLS-level fingerprints (
  JA3/JA4), CDP attach banner ("Chrome is being controlled by automated software"), Extension presence detection
- **Warning**: Do NOT rely on this to bypass commercial anti-bot services (Cloudflare Turnstile, Akamai, DataDome,
  PerimeterX). Real bot detection happens at multiple layers we cannot patch from inside the page

## Known Limitations

- **Chrome only**: Only supports Chrome/Chromium browsers (no Firefox/Safari)
- **Single CDP session**: CDP mode supports one browser session at a time
- **Extension mode requires Chrome**: Extension is Manifest V3, Chrome-specific
- **iframe**: Only single-level iframe targeting (no nested `>>` syntax); Extension mode only

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP documentation

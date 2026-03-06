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
git clone https://github.com/Pyrokine/claude-mcp-tools.git
cd claude-mcp-tools/mcp-chrome
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
      "args": ["/path/to/mcp-chrome/dist/index.js"]
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

Extension-specific: `list` returns `managed` field (whether tab is in MCP Chrome group) and `isActive` field (whether
it's the current operation target). `open` auto-creates tab group (cyan color).

### input - Keyboard & Mouse Input

Event sequence model supporting arbitrary combinations:

| Event Type                              | Description                |
|-----------------------------------------|----------------------------|
| `keydown` / `keyup`                     | Key press/release          |
| `click`                                 | Click (mousedown + mouseup)  |
| `mousedown` / `mouseup`                 | Mouse button press/release |
| `mousemove`                             | Mouse movement             |
| `wheel`                                 | Mouse wheel scroll         |
| `touchstart` / `touchmove` / `touchend` | Touch events               |
| `type`                                  | Type text                  |
| `wait`                                  | Pause between events       |

Parameters: `humanize` enables Bézier curve movement and random delays. `tabId` targets a specific tab. `frame` targets
an iframe (CSS selector or index). Both Extension mode only.

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

### wait - Wait for Conditions

| For          | Description                                         |
|--------------|-----------------------------------------------------|
| `element`    | Wait for element (visible/hidden/attached/detached) |
| `navigation` | Wait for navigation complete                        |
| `time`       | Fixed delay                                         |
| `idle`       | Wait for network idle                               |

Parameters: `tabId` targets a specific tab. `frame` targets an iframe. Both Extension mode only.

### evaluate - JavaScript Execution

Execute JavaScript in page context.

| Parameter | Description                                                               |
|-----------|---------------------------------------------------------------------------|
| `script`  | JavaScript code (required). Bare `return` statements auto-wrapped in IIFE |
| `args`    | Arguments passed to script (script must be a function expression)         |
| `mode`    | `precise` (default, debugger API) or `stealth` (JS injection)             |
| `output`  | Save result to file (strings written as raw text, others as JSON)         |
| `tabId`   | Target a specific tab (Extension mode)                                    |
| `frame`   | Target an iframe by CSS selector or index (Extension mode)                |
| `timeout` | End-to-end budget (ms)                                                    |

Results >100KB are auto-saved to `/tmp/` with a structured hint returned.

### manage - Page & Environment Management

| Action       | Description                                              |
|--------------|----------------------------------------------------------|
| `newPage`    | Create new page/tab                                      |
| `closePage`  | Close page                                               |
| `clearCache` | Clear cache/cookies/storage                              |
| `viewport`   | Set viewport size                                        |
| `userAgent`  | Set User-Agent                                           |
| `emulate`    | Device emulation (iPhone, iPad, etc.)                    |
| `inputMode`  | Query or set input mode (`precise` / `stealth`)          |
| `stealth`    | Inject anti-detection scripts                            |
| `cdp`        | Send raw CDP command (advanced, e.g. `Runtime.evaluate`) |

### logs - Browser Logs

| Type      | Description                            |
|-----------|----------------------------------------|
| `console` | Console logs (with level filter)       |
| `network` | Network request logs (with URL filter) |

Parameters: `output` saves result to file. `tabId` targets a specific tab (Extension mode). `frame` is not applicable
for logs.

### cookies - Cookie Management

| Action   | Description       |
|----------|-------------------|
| `get`    | Get cookies       |
| `set`    | Set cookie        |
| `delete` | Delete cookie     |
| `clear`  | Clear all cookies |

## Target: Unified Element Locator

All tools use a unified `Target` type for element location:

```typescript
// By accessibility (recommended - most stable)
{
    role: "button", name
:
    "Submit"
}

// By text content
{
    text: "Click here", exact
:
    true
}

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
{
    css: ".ant-select-input", nth
:
    1
}

// By CSS + text (filter by text content)
{
    css: "button", text
:
    "Submit", exact
:
    true
}

// By XPath
{
    xpath: "//button[@type='submit']"
}

// By coordinates
{
    x: 100, y
:
    200
}
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
extract(type="screenshot", format="jpeg", quality=80, output="/tmp/screenshot.jpg")

// Save to file
extract(type="screenshot", output="/tmp/screenshot.png")
```

### Extract HTML with Images

```
// Get HTML + image metadata (src, alt, dimensions)
extract(type="html", target={ css: ".article" }, images="info")

// Get HTML + image data, save to directory
extract(type="html", images="data", output="/tmp/page")
// Creates: /tmp/page/content.html, /tmp/page/images/*, /tmp/page/index.json

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
│   │   ├── session.ts        # CDP session management
│   │   ├── locator.ts        # Element locator (deadline-based timeout)
│   │   ├── auto-wait.ts      # Auto-wait mechanism
│   │   ├── retry.ts          # Retry logic
│   │   ├── types.ts          # Type definitions
│   │   └── errors.ts         # Error types
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

- Extension mode: shares your browser sessions — only use on trusted machines
- CDP mode: provides full browser control via DevTools Protocol
- Default ports bind to 127.0.0.1 only (localhost)
- The `evaluate` tool can execute arbitrary JavaScript
- The `manage cdp` action can send arbitrary CDP commands
- Network logs may contain sensitive information

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

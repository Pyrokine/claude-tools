# MCP-Chrome

English | [中文](README_zh.md)

Chrome browser automation MCP Server with dual-mode architecture: **Extension mode** (recommended) controls your
existing browser, **CDP mode** (fallback) launches a dedicated instance.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-green.svg)](https://nodejs.org/)
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

Requires Node.js 20.19 or newer.

### npm

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

For Extension mode, open `chrome://extensions/`, enable Developer mode, click "Load unpacked", and select `<npm-root>/@pyrokine/mcp-chrome/extension/dist`.

### From source

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-chrome
npm install
npm run build
npm --prefix extension install
npm --prefix extension run build
claude mcp add chrome -- node "$PWD/dist/index.js"
```

For Extension mode, load `extension/dist` in Chrome.

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
# npm installation
claude mcp add chrome -- mcp-chrome

# source build
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

Claude Desktop / Other Clients:

```json
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

**Pairing token**

Extension mode keeps zero-config local auto-connect by default. On shared machines, CI runners, or containers where
untrusted local processes can reach `127.0.0.1:19222-19299`, set `MCP_CHROME_PAIRING_TOKEN` on the MCP server and enter the
same token in the Extension popup:

```bash
MCP_CHROME_PAIRING_TOKEN="your-token" node /path/to/mcp-chrome/dist/index.js
```

To require a pairing token instead of zero-config local use, set `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0` on the server and
disable "Allow no-token local connection" in the Extension popup.

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

Extension-specific: `list` returns the flat `targets` array plus a `windows` tree. Each target includes `managed`
(whether tab is controlled by MCP Chrome), `isActive` (whether it's the current operation target), `windowId`, `index`,
`pinned`, `incognito`, and `status` (`loading`/`complete`). The tree includes `windowCount`, `focusedWindowId`,
`activeTargetId`, and each window's ordered `tabs` list, so callers can distinguish the active tab inside each window
from the page currently visible in the focused window.
`open` auto-creates tab group (cyan color). `open`, `back`, `forward`, and `refresh` accept `diagnostics=true` to return
new console warnings/errors and failed network requests observed during the action, including the first `open` that
creates a page automatically.

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
| `editorContext`                         | Read focused editor and selection context                                         |
| `editorInsert`                          | Insert text at the current editor selection                                       |
| `editorCommand`                         | Execute browser editing commands such as `bold` or `insertOrderedList`            |

Special-case parameters:

- `keydown` accepts `commands` (e.g. `["selectAll"]`, `["copy"]`, `["paste"]`, `["cut"]`, `["undo"]`, `["redo"]`) to
  trigger native browser editing commands. `commands` is precise-mode only — stealth mode will throw because the
  CDP commands API has no JS-event equivalent.
- `keydown` on a key already held emits `rawKeyDown` with `autoRepeat: true` (Puppeteer-compatible long-press).

Parameters: `humanize` enables Bézier curve movement and random delays. `diagnostics=true` returns new console
warnings/errors and failed network requests after the action. `postCondition` waits for a page state after the events so
callers can distinguish dispatched input from completed page behavior. `postCondition.timeout` defaults to 3000 ms and
is capped at 60000 ms; `postCondition.interval` defaults to 100 ms and accepts 50-5000 ms. `tabId` targets a specific
tab. `frame` targets an iframe (CSS selector or index). Both Extension mode only.

**`click`-specific**: `force: true` skips actionability checks (useful for testing or hidden elements). Actionability
failures return `ACTIONABILITY_FAILED` with `rect`, `clickPoint`, covering element details, candidate blockers, and
suggestions.
**`type`-specific**: `mode="controlled"` or `dispatch: true` sets `.value` directly and fires `input`/`change` events —
use for React/Vue controlled inputs where keyboard events don't update state. Requires a non-coordinate `target`.
Extension mode only. Controlled input and target lookup failures return structured context with `target`, `matchCount`,
`nth`, `activeElement`, `selection`, and candidate controls. For `select` and `replace`, event-level `nth` selects the Nth
text occurrence while nested `target.nth` selects the Nth matching element; both are zero-based and may be used together.

### extract - Content Extraction

| Type         | Description                                       |
|--------------|---------------------------------------------------|
| `text`       | Extract text content                              |
| `html`       | Extract HTML source                               |
| `frameHtml`  | Extract HTML from the selected iframe             |
| `attribute`  | Extract element attribute                         |
| `screenshot` | Take screenshot (supports `target` element crop)  |
| `state`      | Get page state (URL, title, interactive elements) |
| `metadata`   | Extract page metadata (title, OG, JSON-LD, etc.)  |

Parameters: `output` saves result to file (or directory for `images=data`). `images` (`info`/`data`) extracts image
metadata or data alongside HTML. `frameHtml` extracts the current iframe document after `frame` routing. Screenshot
accepts `clip` for coordinate-region capture, `compareWith` for PNG baseline comparison, and `diffOutput` for a PNG diff
image. Screenshot responses include `metadata.format`, `width`, `height`, `dimensionSource`, `byteSize`, `fullPage`,
`scale`, `clip`, and `capabilities`. PNG comparison is capped before decode at 25 MiB per PNG and 12,000,000 pixels; use
`clip` or `scale` for larger captures. Hidden Extension tabs return `HIDDEN_TAB_SCREENSHOT` instead of auto-focusing the
browser. If another debugger blocks the precise screenshot path, viewport fallback reports `degraded`, `fallback`, and
`limitations`; unsupported fallback options return structured `SCREENSHOT_FALLBACK_UNSUPPORTED` errors. `state` returns
`interactiveElements`; `metadata` returns `frames` in both Extension and CDP modes. `tabId` targets a specific tab.
`frame` targets an iframe. Both Extension mode only.

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

| Parameter       | Description                                                                                                                       |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `script`        | JavaScript code. Bare `return` statements auto-wrapped in IIFE                                                                    |
| `scriptFile`    | Read script from a local file (alternative to `script`, relative paths default to controlled temp dir, use `cwd:` for repo files) |
| `args`          | Arguments passed to script (script must be a function expression)                                                                 |
| `mode`          | `precise` (default, debugger API) or `stealth` (JS injection)                                                                     |
| `output`        | Save result to file (relative paths default to controlled temp dir, use `cwd:` to persist in repo)                                |
| `tabId`         | Target a specific tab (Extension mode)                                                                                            |
| `frame`         | Target an iframe by CSS selector or index (Extension mode)                                                                        |
| `timeout`       | End-to-end budget (ms)                                                                                                            |
| `diagnostics`   | Return new console warnings/errors and failed network requests after execution                                                    |
| `postCondition` | Wait for text, selector, URL fragment, or script result after execution                                                           |

`script` and `scriptFile` are mutually exclusive; at least one must be provided. Relative `scriptFile` and `output`
paths default to the OS temp directory managed by `mcp-chrome`. Use `cwd:relative/path` when the file must live in the
current working directory. Relative paths reject `..`, and on Windows they also reject `:` to avoid NTFS alternate data
streams.

Results >100KB are auto-saved to the controlled OS temp directory with a structured hint returned. DOM nodes,
`NodeList`, and `HTMLCollection` results return `NON_SERIALIZABLE_EVALUATE_RESULT` with a hint to return simple fields
such as `textContent` or `outerHTML`. Evaluate defaults to `precise` even when global `inputMode` is `stealth`, and its
`postCondition` checks use the same evaluate mode as the action. `postCondition` is optional; when it is not provided,
`success=true` only means the script executed and returned. When it is provided and does not match before timeout, the
tool returns `POST_CONDITION_FAILED` with the last observed checks.

### manage - Page & Environment Management

| Action         | Description                                                |
|----------------|------------------------------------------------------------|
| `newPage`      | Create new controlled page/tab                             |
| `closePage`    | Close controlled page and return `affected.before/after`   |
| `adoptPage`    | Mark an existing tab as controlled without focusing it     |
| `releasePage`  | Remove a controlled tab from management without closing it |
| `movePage`     | Move a controlled tab to another window or index           |
| `reorderPage`  | Reorder a controlled tab inside its window                 |
| `pinPage`      | Pin a controlled tab                                       |
| `unpinPage`    | Unpin a controlled tab                                     |
| `activatePage` | Activate a controlled tab and focus its window             |
| `focusWindow`  | Focus an explicit window                                   |
| `resizeWindow` | Resize or change state for an explicit window              |
| `newWindow`    | Create a new controlled window                             |
| `closeWindow`  | Close a window only when all tabs are managed              |
| `clearCache`   | Clear cache/storage (use `cookies` tool to clear cookies)  |
| `viewport`     | Set viewport size                                          |
| `userAgent`    | Set User-Agent                                             |
| `emulate`      | Device emulation (iPhone, iPad, etc.)                      |
| `inputMode`    | Query or set input mode (`precise` / `stealth`)            |
| `stealth`      | Inject anti-detection scripts                              |
| `cdp`          | Send raw CDP command (advanced, e.g. `Runtime.evaluate`)   |

Tab/window management actions are Extension-mode only. Actions that change visible browser state require explicit
`targetId` or `windowId` and return `affected.before/after`. `focusWindow` only returns success after the target window
is observed as focused; otherwise it returns `WINDOW_FOCUS_NOT_OBSERVED`. `closeWindow` refuses mixed windows with
unmanaged tabs and returns `WINDOW_HAS_UNMANAGED_TABS`.

**Stealth mode levels** (CDP launch parameter, set via `browse action=launch stealth=...`):

- `off` — no anti-detection (clean mode for tests/CI)
- `safe` (default) — minimal patches (remove `navigator.webdriver`, clean CDP traces)
- `aggressive` — adds a few WebGL/plugin/language fingerprint patches (does NOT equal full masking)

### logs - Browser Logs

| Type      | Description                            |
|-----------|----------------------------------------|
| `console` | Console logs (with level filter)       |
| `network` | Network request logs (with URL filter) |

Parameters: `output` saves result to file. Console entries use the public levels `error`, `warning`, `info`, and `debug`;
raw browser levels such as `warn` and `log` are normalized before filtering and return. Network logs include completed
requests, HTTP 4xx/5xx responses, and failed loads with `errorText`, `method`, `url`, `status`, `timestamp`, and `duration`
when available. Inline network results limit each URL to 2048 characters and add `urlLength` plus `urlTruncated: true`
when shortened; explicit `output` keeps the complete URL. `urlPattern` supports `*` for any number of characters and `?`
for one character. `tabId` targets a specific tab (Extension mode). `frame` is not applicable for logs.

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

// By accessibility with exact accessible name
{ role: "button", name: "Submit", exact: true }

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

- **Trust boundary**: Extension mode auto-connects to local MCP servers by default. Use `MCP_CHROME_PAIRING_TOKEN`, or set
  `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`, on multi-user systems, CI runners, or containers with `--net=host` where
  untrusted code can reach `127.0.0.1:19222-19299`. WebSocket upgrades require a `chrome-extension://` Origin header,
  which blocks browser pages and curl, but does not stop a malicious local process running as the same user.
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


## Operation status and diagnostics

Input and evaluate responses append `actionExecuted`, `actionStatus`, `verificationStatus`, `failureStage`, and `retryable`. Verification uses `matched`, `not_matched`, `unavailable`, or `error`; debugger timeouts report the action as `unknown` when completion cannot be proven. Diagnostics are best-effort and return `diagnosticsStatus` without replacing the main action result. Browse and wait errors also retain any diagnostics collected before the action failed.

`replace` uses text selection only for `textarea` and input types `text`, `search`, `tel`, `url`, and `password`. Other input types use a native full-value update and return the requested and actual browser-normalized values. A standalone `select` on unsupported types returns `UNSUPPORTED_SELECTION`. Target timeouts include bounded locator, tab, frame, match, and candidate context. Precise iframe evaluation retries one stale execution context once and refuses ambiguous same-URL frames. Its response includes `retryAttempted`, bounded `retryReason`, and the final `frameContext` with the Extension frame, parent frame, URL, CDP frame, and execution context IDs. Port scanning aggregates ordinary pre-open failures at debug level; authentication and protocol rejections from identified MCP servers produce one bounded warning when the rejection summary changes.

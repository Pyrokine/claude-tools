# MCP-Chrome

English | [中文](README_zh.md)

Chrome browser automation MCP Server using Chrome DevTools Protocol (CDP).

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## Features

- **Native CDP**: Direct Chrome DevTools Protocol communication, no Puppeteer/Playwright dependency
- **8 Unified Tools**: Reduced from 30+ granular tools to 8 action-based tools
- **Semantic Targeting**: 10 ways to locate elements (role, text, label, css, xpath, coordinates, etc.)
- **Auto-Wait**: Built-in clickability and input-ready detection
- **Structured Errors**: Every error includes code, message, suggestion, and context
- **Anti-Detection**: Optional fingerprint masking and behavior simulation

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

### 1. Start Chrome with Remote Debugging

```bash
# With UI
./scripts/start-chrome.sh

# Headless mode
./scripts/start-chrome-headless.sh

# Or manually:
google-chrome --remote-debugging-port=9222
```

### 2. Configure MCP Client

#### Claude Code

```bash
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

#### Claude Desktop / Other Clients

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/path/to/mcp-chrome/dist/index.js"]
    }
  }
}
```

## Available Tools (8 Tools)

### browse - Browser Management & Navigation

| Action    | Description                                                  |
|-----------|--------------------------------------------------------------|
| `launch`  | Launch new Chrome instance                                   |
| `connect` | Connect to running Chrome (requires --remote-debugging-port) |
| `list`    | List all available pages/targets                             |
| `attach`  | Attach to a specific page                                    |
| `open`    | Navigate to URL                                              |
| `back`    | Go back in history                                           |
| `forward` | Go forward in history                                        |
| `refresh` | Reload page                                                  |
| `close`   | Close browser                                                |

**Anti-detection modes** (for `launch`/`connect`):

| Mode         | Description                                                           |
|--------------|-----------------------------------------------------------------------|
| `off`        | Disabled - pure mode for testing/CI                                   |
| `safe`       | Minimal changes (default) - removes webdriver flag, cleans CDP traces |
| `aggressive` | Full masking - plugins, WebGL, languages (may have side effects)      |

### input - Keyboard & Mouse Input

Event sequence model supporting arbitrary combinations:

| Event Type                              | Description                |
|-----------------------------------------|----------------------------|
| `keydown` / `keyup`                     | Key press/release          |
| `mousedown` / `mouseup`                 | Mouse button press/release |
| `mousemove`                             | Mouse movement             |
| `wheel`                                 | Mouse wheel scroll         |
| `touchstart` / `touchmove` / `touchend` | Touch events               |
| `type`                                  | Type text                  |
| `wait`                                  | Pause between events       |

### extract - Content Extraction

| Type         | Description                                       |
|--------------|---------------------------------------------------|
| `text`       | Extract text content                              |
| `html`       | Extract HTML source                               |
| `attribute`  | Extract element attribute                         |
| `screenshot` | Take screenshot                                   |
| `state`      | Get page state (URL, title, interactive elements) |

### wait - Wait for Conditions

| For          | Description                                         |
|--------------|-----------------------------------------------------|
| `element`    | Wait for element (visible/hidden/attached/detached) |
| `navigation` | Wait for navigation complete                        |
| `time`       | Fixed delay                                         |
| `idle`       | Wait for network idle                               |

### manage - Page & Environment Management

| Action       | Description                           |
|--------------|---------------------------------------|
| `newPage`    | Create new page/tab                   |
| `closePage`  | Close page                            |
| `clearCache` | Clear cache/cookies/storage           |
| `viewport`   | Set viewport size                     |
| `userAgent`  | Set User-Agent                        |
| `emulate`    | Device emulation (iPhone, iPad, etc.) |

### logs - Browser Logs

| Type      | Description                            |
|-----------|----------------------------------------|
| `console` | Console logs (with level filter)       |
| `network` | Network request logs (with URL filter) |

### cookies - Cookie Management

| Action   | Description       |
|----------|-------------------|
| `get`    | Get cookies       |
| `set`    | Set cookie        |
| `delete` | Delete cookie     |
| `clear`  | Clear all cookies |

### evaluate - JavaScript Execution

Execute arbitrary JavaScript in page context.

## Target: Unified Element Locator

All tools use a unified `Target` type for element location:

```typescript
// By accessibility (recommended - most stable)
{ role: "button", name: "Submit" }

// By text content
{ text: "Click here", exact: true }

// By form label
{ label: "Email" }

// By placeholder
{ placeholder: "Enter your name" }

// By title attribute
{ title: "Close dialog" }

// By alt text (images)
{ alt: "Profile picture" }

// By test ID
{ testId: "submit-button" }

// By CSS selector
{ css: "#login-form .submit-btn" }

// By XPath
{ xpath: "//button[@type='submit']" }

// By coordinates
{ x: 100, y: 200 }
```

## Usage Examples

### Basic: Connect and Navigate

```
browse(action="connect", port=9222)
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

### Complex: Ctrl+Click with Human-like Movement

```
input(events=[
  { type: "keydown", key: "Control" },
  { type: "mousedown", target: { css: ".item" }, button: "left" },
  { type: "mouseup" },
  { type: "keyup", key: "Control" }
], humanize=true)
```

### Screenshot

```
// Full page
extract(type="screenshot", fullPage=true)

// Specific element
extract(type="screenshot", target={ css: "#chart" })
```

### Wait for Element

```
wait(for="element", target={ text: "Loading complete" }, state="visible")
```

## Architecture

```
┌─────────────────┐
│   MCP Client    │
│ (Claude, etc.)  │
└────────┬────────┘
         │ stdio (JSON-RPC)
         ▼
┌─────────────────┐
│   MCP-Chrome    │
│   (8 tools)     │
│  ├─ core/       │  Session, Locator, AutoWait
│  ├─ cdp/        │  Native CDP client
│  └─ tools/      │  Tool implementations
└────────┬────────┘
         │ WebSocket (CDP)
         ▼
┌─────────────────┐
│  Chrome Browser │
│  (port 9222)    │
└─────────────────┘
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
│   │   ├── session.ts        # Session management
│   │   ├── locator.ts        # Element locator
│   │   ├── auto-wait.ts      # Auto-wait mechanism
│   │   ├── retry.ts          # Retry logic
│   │   ├── types.ts          # Type definitions
│   │   └── errors.ts         # Error types
│   ├── cdp/                  # CDP layer
│   │   ├── client.ts         # WebSocket CDP client
│   │   └── launcher.ts       # Chrome launcher
│   └── anti-detection/       # Anti-detection (optional)
│       ├── injection.ts
│       └── behavior.ts
├── scripts/
│   ├── start-chrome.sh
│   └── start-chrome-headless.sh
└── package.json
```

## Security Notes

- CDP provides full browser control - use only on trusted machines
- Default debugging port binds to 127.0.0.1 only
- The `evaluate` tool can execute arbitrary JavaScript
- Network logs may contain sensitive information

## Known Limitations

- **Single session**: Currently supports one browser session at a time
- **Chrome only**: Only supports Chrome/Chromium browsers (no Firefox/Safari)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP documentation

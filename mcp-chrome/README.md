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
- **Multi-Page Targeting**: `targetId` selects a page in either backend without changing browser focus; `tabId` remains
  an alias
- **iframe Penetration**: `frame` parameter targets elements inside iframes (CSS selector or index, Extension mode)
- **Semantic Targeting**: 11 ways to locate elements (role, text, label, CSS, CSS+text combo, XPath, coordinates, etc.)
- **Auto-Wait**: Built-in clickability and input-ready detection with deadline-based timeout budget
- **Dual Input Mode**: `precise` (debugger API, bypasses CSP) or `stealth` (JS injection, no debug banner)
- **Smart Output**: Bare `return` auto-wrapped in IIFE; large results (>100KB) auto-saved to file; `output` writes raw
  text for strings
- **Multi-Server**: Extension auto-discovers and connects to multiple MCP Server instances simultaneously
- **Anti-Detection**: Optional fingerprint masking and behavior simulation
- **Structured Errors**: Every error includes code, message, suggestion, and context

## Migrating to 3.0

- `manage(action="closePage")` now requires an explicit `targetId`; it no longer closes an implicit default page.
- In Extension mode, `adoptPage` marks a page as managed but grants no content-reading, script or write permission.
  Obtain a single-page ordinary-read grant in the popup, or create a test page with `newPage`.
- A single-page ordinary-read grant covers text, HTML, attributes, computed styles and state. It does not enable
  arbitrary JavaScript, CDP/debugger commands, input or screenshots.
- `tmp:` files belong to the current MCP server session. After a restart, regenerate them or retain needed files under
  `cwd:` before stopping the server.

Local zero-config auto-connect is unchanged. Reloading the Extension or restarting the MCP client does not require a
manual Connect click.

## Compatible Clients

| Client                    | Status |
| ------------------------- | ------ |
| Claude Code               | ✅     |
| Claude Desktop            | ✅     |
| Cursor                    | ✅     |
| Windsurf                  | ✅     |
| Any MCP-compatible client | ✅     |

## Installation

Requires Node.js 20.19 or newer.

### npm

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

For Extension mode, open `chrome://extensions/`, enable Developer mode, click "Load unpacked", and select
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`.

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

### Windows CDP launch

Chrome discovery checks Windows App Paths, `PATH`, installed Chrome channels, Chromium, Chrome for Testing, and
`MCP_CHROME_PORTABLE_DIR` (or `%USERPROFILE%\\.mcp-chrome\\portable`). To start a separate CDP browser from PowerShell:

```powershell
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222
# Or specify a portable executable and profile explicitly:
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222 -ExecutablePath 'C:\Browsers\chrome.exe' -ProfileDir 'C:\Temp\mcp-chrome-profile'
```

Then call `browse(action="connect", port=9222)`. The script keeps its Chrome process in the foreground; Chrome exit
codes are reported by the script. Use a separate profile so an existing Chrome process cannot silently absorb the
launch.

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
            "args": ["/path/to/mcp-chrome/dist/index.js"]
        }
    }
}
```

**Step 3: Connect**

The Extension auto-connects to the MCP Server via HTTP/WebSocket (port 19222-19299). Click the toolbar icon to verify
connection status. `browse(action="connect")` and the local `/api/info` endpoint report the active Extension background
bundle hash and compare it with the bundle shipped beside the server. `bundleStatus="stale"` means Chrome is still
running an older unpacked Extension bundle; reload the Extension in `chrome://extensions/`. A legacy Extension that
lacks `network_challenge_state` falls back to tab-title and DOM challenge detection. Bundle identity never disables
zero-config auto-connect.

```
browse(action="list")          // List all tabs
browse(action="open", url="https://example.com")
extract(type="screenshot")
```

**Pairing token**

Extension mode keeps zero-config local auto-connect by default. On shared machines, CI runners, or containers where
untrusted local processes can reach `127.0.0.1:19222-19299`, set `MCP_CHROME_PAIRING_TOKEN` on the MCP server and enter
the same token in the Extension popup:

```bash
MCP_CHROME_PAIRING_TOKEN="your-token" node /path/to/mcp-chrome/dist/index.js
```

To require a pairing token instead of zero-config local use, set `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0` on the server
and disable "Allow no-token local connection" in the Extension popup. Disabling that policy immediately cancels pending
health checks, WebSocket handshakes, and scheduled reconnects, so an older no-token attempt cannot connect afterward.

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

> A connected Extension is the default for every tool. CDP is used only while the Extension is unavailable. A
> `browse(action="connect", port=9222)` call explicitly selects CDP for later tools; use `browse(action="connect")` to
> return to Extension mode. A CDP connection created only as fallback yields to Extension after the Extension
> reconnects.

## Available Tools (8 Tools)

### browse - Browser Management & Navigation

| Action    | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `launch`  | Create a managed Extension tab, or launch CDP when Extension is unavailable |
| `connect` | Confirm Extension by default; `port` explicitly selects CDP                 |
| `list`    | List all pages/tabs                                                         |
| `attach`  | Attach to a specific page/tab                                               |
| `open`    | Navigate to URL                                                             |
| `back`    | Go back in history                                                          |
| `forward` | Go forward in history                                                       |
| `refresh` | Reload page                                                                 |
| `close`   | Close the page specified by `targetId`                                      |

Extension-specific: `list` returns the flat `targets` array plus a `windows` tree. Each target includes `managed`
(whether the tab is controlled by MCP Chrome), `isActive` (Chrome's active tab within its window), `windowId`, `index`,
`pinned`, `incognito`, and `status` (`loading`/`complete`). The tree includes `windowCount`, `focusedWindowId`,
`activeTargetId`, and each window's ordered `tabs` list. `defaultTargetId` identifies the selected operation target; CDP
does not infer Chrome's foreground tab from this selection. `open` auto-creates tab group (cyan color). `open`, `back`,
`forward`, and `refresh` accept `diagnostics=true` to return new console warnings/errors and failed network requests
observed during the action, including the first `open` that creates a page automatically. `open` and `refresh` honor
`wait="load"`, `wait="domcontentloaded"`, and `wait="networkidle"` in both drivers. The wait is registered before the
command and bound to the new main document, so late lifecycle events from an earlier navigation are ignored. CDP
`networkidle` waits for the current main-frame loader's `networkIdle` event. Extension `networkidle` waits for the
current document to complete, all tracked response bodies to finish, and a 500 ms quiet period. Lost request tracking
causes a timeout instead of a false idle result. `close` requires `targetId` and closes only that page. It never closes
the entire CDP connection.

In Extension mode, `back` and `forward` use native browser history first. Only a native no-history error permits a
script fallback, and only on a scriptable document; restricted URLs and browser error pages are not injected. With no
available history they return `navigated=false`. Other native failures are preserved. A destroyed execution context or a
browser refusing injection into an error page still returns an operation failure, recorded as a warning in the Extension
rather than a program error. Arbitrary debugger commands are never automatically replayed.

Page tools accept `targetId` in either backend; the older `tabId` alias is still accepted. If both are supplied, they
must match. An explicit target changes only the operation scope and restores the previous default afterward.
`browse.close` and `manage.closePage` require an explicit ID. Page responses, including action failures, include
`pageContext` with the effective target and its source (`explicit`, `default`, `created`, `reused`, or `unconfirmed`),
before/after URL and revision, default target before/after, and Chrome's active target when Extension reports it.
`unconfirmed` means a page-creation action failed without returning a created target ID. CDP reports browser activity as
unavailable rather than treating the selected operation target as foreground.

Temporary target restoration is reported separately in `pageContext.targetRestoration`: `restored` selects the previous
default, `cleared` leaves no default when none existed, `previous_target_closed` clears a closed default, and `failed`
reports restoration or cleanup errors while clearing the temporary selection. `error` and `cleanupError` retain the
respective failure messages. The primary action result or original error is preserved; completed input is not replayed
or reported as unexecuted. `browse attach` and `manage adoptPage` keep their persistent-default behavior. Concurrent
page responses describe the page actually used by each action.

`browse.list` returns each page's revision and metadata. Revisions combine a backend epoch with a per-page counter.
Extension counts main-frame navigations and MCP actions; CDP counts observed navigation for the attached page and
conservatively counts sent mutating commands, including evaluations. Neither driver tracks arbitrary DOM changes made by
the page itself; re-read URL and revision before a conditional action. `browse` navigation/close, `input`, `evaluate`,
and eligible `manage` page actions accept `expectedUrl` and `expectedRevision`. A mismatch at the backend returns
`ACTION_PRECONDITION_FAILED` before that page action is sent. A multi-event action checks conditions before its first
modifying command, not before every event. A failed or timed-out action can still change the revision when it may have
had partial effects.

For `browse`, only `open`, `back`, `forward`, `refresh`, and `close` accept these conditions. Other actions, including
`attach`, reject them with `INVALID_ARGUMENT` before changing any target.

The Extension popup can grant ordinary reads for one non-created page to one connected server instance. A grant survives
a Service Worker restart only while that connection and the approved document remain unchanged. Navigation, tab closure,
or connection closure revokes it. A target ID or `adoptPage` is not reading consent. The grant covers ordinary content
reads, including targeted text, HTML, attributes, computed styles, and page state. Scripts, debugger operations,
screenshots, input, and cookie access do not inherit it; existing cookie operations have separate URL/name filter rules.
`manage(action="pageMetadata", targetId=...)` reads or updates `taskHint` and `note`, and list results show creation and
last-use timestamps. This metadata is process-local and is removed when a page is closed; it never authorizes content
access.

### Access challenges

After `open`, `back`, `forward`, `refresh`, `input`, and `evaluate`, MCP Chrome waits for a Cloudflare JS Challenge or
Turnstile checkbox. When Extension mode is active, navigation starts without debugger logging and reads the live tab
title passively for eight seconds. If the interstitial persists, MCP Chrome checks for a visible Turnstile control and
clicks it only when it finds one. Extension inspect uses an isolated world and detaches the debugger first. Same-page
fixture buttons use the existing page click. If a Cloudflare Turnstile iframe is present, inspect CSS coordinates are
converted to screen coordinates and the OS mouse moves along a path, hovers, then presses and releases: `xdotool` on
Linux uses the focused Chrome window origin plus window chrome insets only when that window title matches the test page,
rather than Chrome `screenX` or `outerHeight - innerHeight`; `cliclick` or System Events on macOS; and PowerShell
`mouse_event` on Windows. Widget clicks target the checkbox on the left of the compact Turnstile card, including when
the host wrapper is wider than the card, not the label. If a Cloudflare iframe is already in the DOM, the OS mouse is
used even when that iframe reports a zero-size rect, including the later host `Verify you are human` / `请验证您是真人`
button. The OS click runs only when the managed test tab is already the active tab in an already-focused window; mixed
windows are not focused. Debugger is detached and the viewport is read again before the OS click. Missing OS mouse tools
or an unfocused window return a visible error instead of a silent CDP click. A Turnstile widget is clicked only after
two inspections report the same click point. Distant OS-mouse paths start near the control instead of flying across the
screen. The same checkbox or compact widget is clicked at most once; if Cloudflare then shows a visible
`Verify you are human` or `请验证您是真人` button, that button is inspected as `verify` and clicked at most once in the
same wait. Use the default `diagnostics=false` for challenge-protected pages because diagnostics starts debugger console
and network collection.

Detection covers titles such as `Just a moment...` and `请稍候…`, challenge DOM or body-text markers, and
`Verify you are human` / `请验证您是真人` controls. CDP reads live titles with `Target.getTargetInfo`. A leftover
Cloudflare iframe on a recovered page is not pending. Cached titles do not decide the result. MCP Chrome does not call a
CAPTCHA solver, retry navigation, or export `cf_clearance` values. A CDP timeout does not prove that the site fails in a
user Chrome session; check the returned `mode` before diagnosing the site.

A resolved challenge returns `challengeResolved=true`, `challengeKind`, `waitedMs`, `clickedTurnstile`, and
`clearanceCookiePresent` (name presence only). If the visible page text says verification succeeded and Cloudflare is
waiting for the origin, the result also has `originResponsePending=true`; verification passed, but the destination page
is not loaded yet. Hidden template text such as a `display:none` success heading does not count, and a visible Turnstile
checkbox still counts as pending. Challenge results and errors include `mode`. Timeout returns `CHALLENGE_TIMEOUT` with
`retryable=true`, `clickedTurnstile`, and the observed `challengeKind` (a Turnstile click is not reported as `js`).
Cloudflare Access denied returns `CHALLENGE_DENIED`. Interactive CAPTCHAs, Bot Fight Mode, and IP reputation checks
cannot be completed by waiting or clicking a checkbox. A later normal main-document response clears the header flag;
ordinary iframe document responses and clearing network logs do not.

### input - Keyboard & Mouse Input

Event sequence model supporting arbitrary combinations:

| Event Type                              | Description                                                            |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `keydown` / `keyup`                     | Key press/release                                                      |
| `click`                                 | Click after visibility, enabled, coverage, and scroll checks           |
| `mousedown` / `mouseup`                 | Mouse button press/release                                             |
| `mousemove`                             | Mouse movement                                                         |
| `wheel`                                 | Mouse wheel scroll                                                     |
| `touchstart` / `touchmove` / `touchend` | Touch events                                                           |
| `type`                                  | Type text (with optional `delay`, `dispatch` for React/Vue)            |
| `wait`                                  | Pause between events                                                   |
| `select`                                | Select text by content (mouse sim)                                     |
| `replace`                               | Find and replace text                                                  |
| `drag`                                  | HTML5 drag-and-drop (`target` source and `to` destination)             |
| `editorContext`                         | Read focused editor and selection context                              |
| `editorInsert`                          | Insert text at the current editor selection                            |
| `editorCommand`                         | Execute browser editing commands such as `bold` or `insertOrderedList` |

Special-case parameters:

- `keydown` accepts `commands` (e.g. `["selectAll"]`, `["copy"]`, `["paste"]`, `["cut"]`, `["undo"]`, `["redo"]`) to
  trigger native browser editing commands. A successful response means the browser accepted the command dispatch; use
  `postCondition` or `extract` to verify the page result. `commands` is precise-mode only; stealth mode throws because
  the CDP commands API has no JS-event equivalent.
- `keydown` on a key already held emits `rawKeyDown` with `autoRepeat: true` (Puppeteer-compatible long-press).

`events` must contain at least one event. Parameters: `humanize` enables Bézier curve movement and random delays.
`diagnostics=true` returns new console warnings/errors and failed network requests after the action. `postCondition`
waits for a page state after the events so callers can distinguish dispatched input from completed page behavior.
`postCondition.timeout` defaults to 3000 ms and is capped at 60000 ms; `postCondition.interval` defaults to 100 ms and
accepts 50-5000 ms. A `postCondition.script` may be an expression, function, async function, or Promise expression;
functions are invoked and the final Promise value is awaited before matching, while thrown or rejected errors fail the
check. `targetId` (or legacy `tabId`) selects a page in either backend; `frame` selects an iframe (CSS selector or
index) in Extension mode. When either scope is provided, the action, diagnostics, and post-condition use the backend
selected for that target scope.

**`click`-specific**: `force: true` requires `forceReason` and a non-coordinate element `target`, and skips
actionability checks (useful for testing or hidden elements), but still dispatches the standard DOM mouse-event sequence
and does not call framework-private handlers. The same checks apply to middle/right clicks and multiple clicks. Missing
targets and coordinate targets cannot use `force`. Actionability failures return `ACTIONABILITY_FAILED` with `rect`,
`clickPoint`, covering element details, candidate blockers, and suggestions. **`type`-specific**: `mode="controlled"` or
`dispatch: true` sets `.value` directly and fires `input`/ `change` events — use for React/Vue controlled inputs where
keyboard events don't update state. Requires a non-coordinate `target`. Extension mode only. Controlled input and target
lookup failures return structured context with `locator`, `matchCount`, `nth`, and bounded `candidates`;
selection-specific errors also report editor and selection state. Password input values are omitted from failure
diagnostics, and input `find` or replacement `text` values are redacted from failed responses. For `select` and
`replace`, event-level `nth` selects the Nth text occurrence while nested `target.nth` selects the Nth matching element;
both are zero-based and may be used together. Locator targets for `select` and `replace` work in CDP mode without
Extension ref IDs.

### extract - Content Extraction

| Type         | Description                                       |
| ------------ | ------------------------------------------------- |
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
image. `diffOutput` requires `compareWith`. A `target` screenshot that has no match, whose `nth` is out of range, or
whose box has zero size returns a target error rather than silently returning a viewport screenshot. Screenshot
responses include `metadata.format`, `width`, `height`, `dimensionSource`, `byteSize`, `fullPage`, `scale`, `clip`, and
`capabilities`. Capture is limited to 16,384 pixels per side, 12,000,000 pixels total, 48 MiB estimated RGBA memory and
25 MiB encoded data. PNG baselines are checked before reading; comparison is capped at 25 MiB per PNG and 12,000,000
pixels, and decompressed scanlines must exactly match the validated dimensions and are bounded during inflate. Malformed
or expansion-heavy PNGs are rejected. Use `clip` or `scale` for larger captures. Hidden Extension tabs return
`HIDDEN_TAB_SCREENSHOT` instead of automatically focusing the browser. If another debugger blocks the precise screenshot
path, viewport fallback reports `degraded`, `fallback`, and `limitations`; unsupported fallback options return
structured `SCREENSHOT_FALLBACK_UNSUPPORTED` errors. `state` returns `interactiveElements`; `metadata` returns `frames`
in both Extension and CDP modes. `targetId` (or `tabId`) selects a page in either backend; `frame` is Extension-only.

**`attribute` special prefix**: `computed:<property>` returns the computed CSS style value (e.g. `computed:color`,
`computed:font-size`). Use `computed:*` to return all computed style properties as JSON (returns 300+ properties — use
`output` to save to file).

**`state`-specific**: `depth` controls DOM traversal depth (default 15). Reduce to limit response size on large pages.
`mode` selects the underlying source — `accessibility` (default, derived from the a11y tree) or `domsnapshot` (raw CDP
`DOMSnapshot.captureSnapshot`, CDP-only; returns a flat node array with computed styles for advanced post-processing).

### wait - Wait for Conditions

| For          | Description                                         |
| ------------ | --------------------------------------------------- |
| `element`    | Wait for element (visible/hidden/attached/detached) |
| `navigation` | Wait for navigation complete                        |
| `time`       | Fixed delay                                         |
| `idle`       | Wait for DOM or network quiet period                |

Parameters: `targetId` (or `tabId`) selects a page in either backend; `frame` selects an iframe in Extension mode.

In CDP mode, `visible` requires a nonzero DOM rectangle and CSS that does not hide the element (`display:none` or
`visibility:hidden/collapse`). `hidden` accepts these hidden states or a missing element; `attached` and `detached` only
check whether the element exists.

**`idle`-specific**: In Extension mode, after `readyState === 'complete'`, it injects a `MutationObserver` and waits for
a quiet period with no DOM changes. In CDP mode, it waits for network quiet instead. `ms` controls the relevant quiet
period (default 500ms). The response returns `idleKind` and `idlePeriodMs`; Extension responses also return `domStable`.

### evaluate - JavaScript Execution

Execute JavaScript in page context.

| Parameter            | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `script`             | JavaScript code. Bare `return` statements are wrapped in IIFE           |
| `scriptFile`         | Read code from a local file instead of `script`                         |
| `args`               | Arguments passed to a script written as a function expression           |
| `mode`               | `precise` (default, debugger API) or `stealth` (JS injection)           |
| `staleContextRetry`  | iframe stale-context policy: `never` (default) or `readOnly`            |
| `output`             | Save the result to a file                                               |
| `targetId` / `tabId` | Select a page in either backend (`tabId` is an alias)                   |
| `frame`              | Target an iframe by CSS selector or index (Extension mode)              |
| `timeout`            | End-to-end budget (ms)                                                  |
| `diagnostics`        | Return new console warnings/errors and failed requests after execution  |
| `postCondition`      | Wait for text, selector, URL fragment, or script result after execution |

`script` and `scriptFile` are mutually exclusive; at least one must be provided. Relative `scriptFile` and `output`
paths default to the OS temp directory managed by `mcp-chrome`. Use `cwd:relative/path` when the file must live in the
current working directory. Relative paths reject `..`, and on Windows they also reject `:` to avoid NTFS alternate data
streams.

Results >100KB are auto-saved to the controlled OS temp directory with a structured hint returned. DOM nodes,
`NodeList`, and `HTMLCollection` results return `NON_SERIALIZABLE_EVALUATE_RESULT` with a hint to return simple fields
such as `textContent` or `outerHTML`. Result materialization and serialization failures report `actionExecuted=true`,
`actionStatus="completed"`, and `failureStage="output"` because the page script has already finished. Evaluate defaults
to `precise` even when global `inputMode` is `stealth`, and its `postCondition` checks use the same evaluate mode as the
action. `postCondition` is optional; when it is not provided, `success=true` only means the script executed and
returned. When it is provided and does not match before timeout, the tool returns `POST_CONDITION_FAILED` with the last
observed checks. Precise iframe evaluation does not replay a script after a stale execution context by default. Set
`staleContextRetry="readOnly"` only when the script has no side effects; the Extension may then resolve a new context
and replay it once within the remaining timeout budget. A stale-context error after `Runtime.evaluate` reports
`actionExecuted=true` and `actionStatus="unknown"`, because earlier side effects may already have happened even though
the final result is unavailable.

### manage - Page & Environment Management

| Action         | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `newPage`      | Create new controlled page/tab                             |
| `pageMetadata` | Read or update per-page `taskHint` and `note`              |
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
`targetId` or `windowId` and return `affected.before/after`. `clearCache` is unavailable in Extension mode and returns
`UNSUPPORTED_MODE` without clearing anything. Use scoped `cookies(action="clear")` for cookies or CDP mode for storage
and cache. `focusWindow` only returns success after the target window is observed as focused; otherwise it returns
`WINDOW_FOCUS_NOT_OBSERVED`. `closeWindow` refuses mixed windows with unmanaged tabs and returns
`WINDOW_HAS_UNMANAGED_TABS`. Persistent `adoptPage` and `releasePage` target changes are serialized with scoped tab
operations, so a concurrent multi-event input remains on its requested tab and the persistent target is applied
afterward.

`emulate` applies the device viewport, pixel density, touch support, and User-Agent in both backends. `viewport`
restores desktop metrics, page scale, and disabled touch emulation; restore the User-Agent separately with `userAgent`.

**Stealth mode levels** (CDP launch parameter, set via `browse action=launch stealth=...`):

- `off` — no anti-detection (clean mode for tests/CI)
- `safe` (default) — minimal patches (remove `navigator.webdriver`, clean CDP traces)
- `aggressive` — adds a few WebGL/plugin/language fingerprint patches (does NOT equal full masking)

### logs - Browser Logs

| Type      | Description                            |
| --------- | -------------------------------------- |
| `console` | Console logs (with level filter)       |
| `network` | Network request logs (with URL filter) |

Parameters: `output` saves result to file. Console entries use the public levels `error`, `warning`, `info`, and
`debug`; raw browser levels such as `warn` and `log` are normalized before filtering and return. Clearing fallback
console logs keeps the hook active. When debugger collection becomes available, fallback capture is disabled. Console
methods still pointing to the MCP wrapper are restored, while wrappers installed later by the page are preserved.
Network logs are finalized on `loadingFinished` or `loadingFailed`, not when headers arrive, so body failures retain
both the HTTP status and `errorText`, and in-flight bodies continue to count against `networkidle`. Entries include
`method`, `url`, `status`, `timestamp`, and `duration` when available. URL query parameters commonly used for
credentials, signatures, passwords, and tokens are replaced with `[REDACTED]` in inline responses, diagnostics, and
explicit `output` files. Redacted entries include `urlRedacted`, `urlOriginalLength`, and `redactedQueryParameters`.
Inline network results limit each sanitized URL to 2048 characters and add `urlLength` plus `urlTruncated: true` when
shortened. `urlPattern` supports `*` for any number of characters and `?` for one character. `tabId` targets a specific
tab (Extension mode). `frame` is not applicable for logs.

### cookies - Cookie Management

| Action   | Description                                                            |
| -------- | ---------------------------------------------------------------------- |
| `get`    | Get cookies                                                            |
| `set`    | Set cookie                                                             |
| `delete` | Delete cookie                                                          |
| `clear`  | Delete cookies in a URL or domain scope, optionally narrowed by `name` |

**Note**: `clear` requires `url` or `domain`. `name` can only further narrow that scope, so a same-named cookie on
another site cannot be removed accidentally. The returned `count` includes only cookies for which Chrome confirms a
removal; cookies that disappear between listing and removal are not counted.

## Target: Unified Element Locator

All tools use a unified `Target` type for element location:

```typescript
// By accessibility (recommended - most stable)
const byRole = { role: 'button', name: 'Submit' }

// By accessibility with exact accessible name
const byExactRole = { role: 'button', name: 'Submit', exact: true }

// By text content
const byText = { text: 'Click here', exact: true }

// By form label
const byLabel = { label: 'Email' }

// By placeholder
const byPlaceholder = { placeholder: 'Enter your name' }

// By title attribute
const byTitle = { title: 'Close dialog' }

// By alt text (images)
const byAlt = { alt: 'Profile picture' }

// By test ID
const byTestId = { testId: 'submit-button' }

// By CSS selector
const byCss = { css: '#login-form .submit-btn' }

// Disambiguate multiple matches (0-based)
const secondMatch = { css: '.ant-select-input', nth: 1 }

// By CSS + text (filter by text content)
const byCssText = { css: 'button', text: 'Submit', exact: true }

// By XPath
const byXPath = { xpath: "//button[@type='submit']" }

// By coordinates
const byCoordinates = { x: 100, y: 200 }
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
// Creates: <system-temp>/claude-tools/mcp-chrome/session-<id>/page/content.html, images/*, index.json

// Get HTML + image data inline (max 20 images)
extract(type="html", target={ css: ".card" }, images="data")
```

`tmp:` paths belong to the current server session. Temporary output has a 256-entry and 128 MiB session limit; on
startup, marked sessions older than 24 hours are removed only after their process exits. Use `cwd:` for files that must
remain accessible after restarting the server. Successful responses that save a `tmp:` file or directory include a
`retention` field describing the cleanup condition; `cwd:` responses omit it. Output paths reject Windows reserved
device names, alternate data streams, invalid characters, and trailing spaces or dots. On Windows, private file
permissions must be verified before writing sensitive content.

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

Selectors and numeric indices follow the parent document's DOM iframe order. Subframes absent from that DOM, including
frames added by other extensions, cannot shift the index or become fallback targets. If the selected element cannot be
tied to exactly one Chrome frame, the operation returns `FRAME_IDENTITY_UNAVAILABLE` instead of choosing another frame.

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

- **Trust boundary**: Extension mode auto-connects to local MCP servers by default. Use `MCP_CHROME_PAIRING_TOKEN`, or
  set `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`, on multi-user systems, CI runners, or containers with `--net=host` where
  untrusted code can reach `127.0.0.1:19222-19299`. WebSocket upgrades require a `chrome-extension://` Origin header,
  which blocks browser pages and curl, but does not stop a malicious local process running as the same user.
- Extension mode: shares your browser sessions — only use on trusted machines
- CDP mode: provides full browser control via DevTools Protocol
- Default ports bind to 127.0.0.1 only (localhost)
- The `evaluate` tool can execute arbitrary JavaScript
- The `manage cdp` action can send arbitrary CDP commands
- Network URL credential parameters are redacted by default, but console text and nonstandard parameter names may still
  contain sensitive information

### Anti-detection (stealth) — what it actually does

The `stealth` mode (`safe` / `aggressive`) only patches a small set of fingerprinting surfaces:

- **Covers**: `navigator.webdriver`, `cdc_*` properties, User-Agent string, a few WebGL vendor/renderer values, Chrome
  runtime properties
- **Does NOT cover**: Canvas fingerprinting, AudioContext fingerprinting, Font enumeration, TLS-level fingerprints
  (JA3/JA4), CDP attach banner ("Chrome is being controlled by automated software"), Extension presence detection
- **Warning**: These patches do not pass Cloudflare. JS Challenge and Turnstile checkbox handling is a separate wait in
  the real browser after navigation, input, or evaluate. It does not cover Akamai, DataDome, PerimeterX, interactive
  CAPTCHAs, or IP reputation

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

Input and evaluate responses append `actionExecuted`, `actionStatus`, `verificationStatus`, `failureStage`, and
`retryable`. Verification uses `matched`, `not_matched`, `unavailable`, or `error`; debugger timeouts report the action
as `unknown` when completion cannot be proven. Page-thrown exceptions report `actionExecuted=true` with
`actionStatus="failed"`; result materialization or serialization errors report `actionStatus="completed"` and
`failureStage="output"`. Diagnostics are best-effort and return `diagnosticsStatus` without replacing the main action
result. On a page precondition mismatch, input and evaluate report `actionExecuted=false` and
`actionStatus="not_started"`. Browse and wait errors also retain any diagnostics collected before the action failed.
Target diagnostics query the current tab state instead of relying on cached attach metadata.

`replace` uses text selection only for `textarea` and input types `text`, `search`, `tel`, `url`, and `password`. Other
input types use a native full-value update and return the requested and actual browser-normalized values. A standalone
`select` on unsupported types returns `UNSUPPORTED_SELECTION`. CDP locator targets for `select` and `replace` are
focused through the CDP locator instead of Extension-only ref IDs. Password values are omitted from input failure
context and text post-condition observations; failed input responses also redact supplied `find` and replacement `text`
values. Target timeouts include bounded locator, tab, frame, match, and candidate context. Explicit `tabId` and `frame`
scopes resolve the active backend before input, wait, logs, or extract work begins, so actions and verification use the
same target backend. Precise iframe evaluation defaults to `staleContextRetry="never"` and does not replay stale
scripts. `readOnly` permits one replay after the Extension verifies the frame identity and resolves a new execution
context. Responses include the policy, `retryAttempted`, bounded `retryReason`, and the final `frameContext` with the
Extension frame, parent frame, URL, CDP frame, and execution context IDs. Ambiguous same-URL frames are rejected. Port
scanning aggregates ordinary pre-open failures at debug level; authentication and protocol rejections from identified
MCP servers produce one bounded warning when the rejection summary changes.

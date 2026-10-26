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
- In Extension mode, explicit `adoptPage` grants an existing tab the same managed reading, input, script, screenshot,
  debugger, and log capabilities as a newly created page. No popup read grant is required for managed pages.
- A single-page ordinary-read grant covers text, HTML, attributes, computed styles and state. It does not enable
  arbitrary JavaScript, CDP/debugger commands, input or screenshots.
- `tmp:` files belong to the current MCP server session. After a restart, regenerate them or retain needed files under
  `cwd:` before stopping the server.

Local zero-config auto-connect is unchanged. Reloading the Extension or restarting the MCP client does not require a
manual Connect click.

## Request scope and failure handling

An input sequence keeps its selected backend and page until the sequence and target restoration finish. Concurrent
`browse(action="connect")` waits for that scope. A CDP request with `frame` returns a capability error before resolving
or operating on an Extension page. Extension frame resolution checks the selected document and probes the native iframe
owner, so reordering same-URL frames cannot redirect execution by a stale DOM index.

Explicit `wait="networkidle"` enables Network observation before navigation and waits for requests to finish followed by
500 ms of quiet. Missing or interrupted observation returns an error; the default `load` path does not attach a debugger
for network-idle tracking. CDP network logs retain the HTTP status when a response body fails and record one terminal
entry per request. Temporary CDP page selection preserves separate log buffers for each target.

Input `timeout` includes page selection, preparation and key RPCs. An acknowledgement that arrives after the deadline
cannot produce success; uncertain execution is reported as `actionStatus="unknown"` with `retryable=false`. Read the
current page state before deciding the next action.

Group operations serialize with page release and recheck membership and managed authority while holding the affected
page locks. For page creation, use `active`; `activate` is accepted only by `movePage`. Popup settings report failed
storage writes, and delayed stored values cannot override a newer setting. Default local auto-connect remains enabled
without a manual pairing or connection step.

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

For `open`, `back`, `forward`, and `refresh`, `timeout` starts at request entry. Target preparation, queueing, protocol
calls, page loading, Challenge inspection and clicks, diagnostics, and target restoration share the remaining budget;
navigation RPCs do not add transport time. An expired queued action is not dispatched, and later requests still wait for
an earlier in-flight action to settle. Explicit `timeout=0` rejects before navigation dispatch. Page creation retains
its separate load-wait and transport-time contract.

A timeout does not undo a Chrome operation already dispatched. When its result is unknown, the response reports
`TIMEOUT`, `actionExecuted="unknown"`, `actionStatus="unknown"`, and `retryable=false`; read the actual page state
instead of replaying navigation. `pageContext.after` uses a fresh snapshot when available; otherwise it is null with
`contextError`. Exhausted restoration is reported separately without replacing the primary action result. CDP history
waits accept a main-frame BFCache restore or same-document event from the current session, not an ordinary frame commit,
a child-frame event, or an event from another session.

Challenge click, detach, and inspection RPCs carry the remaining deadline and reject dispatch after queueing or page
validation exhausts it. OS mouse movement and fallback processes use the same deadline. A CDP press that has started
always attempts release on the original connection and session; release cleanup waits at most one second and never uses
a newly selected target. Read-only Challenge checks that expire return `CHALLENGE_TIMEOUT` with the known primary action
status. An uncertain click returns `TIMEOUT` with that primary status, `verificationStatus="unknown"`,
`verificationActionExecuted`, and `retryable=false`; neither navigation nor the click is automatically replayed.

Evaluate retains Challenge result fields on success, action failure, verification mismatch, and output failure.
`originResponsePending=true` means verification succeeded but the origin server has not responded; it does not mean the
destination content has loaded.

Page tools accept `targetId` in either backend; the older `tabId` alias is still accepted. If both are supplied, they
must match. An explicit target changes only the operation scope and restores the previous default afterward.
`browse.close` and `manage.closePage` require an explicit ID. Page responses, including action failures, include
`pageContext` with the effective target and its source (`explicit`, `default`, `created`, `reused`, or `unconfirmed`),
before/after URL and revision, default target before/after, and Chrome's active target when Extension reports it.
`unconfirmed` means a page-creation action failed without returning a created target ID. CDP reports browser activity as
unavailable rather than treating the selected operation target as foreground.

When an older Extension lacks `page_snapshot`, unconditional page actions can still use a fresh page-list URL. Their
`pageContext.before` and `after` snapshots report `revision=null` with a `warning` about the unavailable revision and
atomic conditions. Requests with `expectedUrl` or `expectedRevision` return `DRIVER_CAPABILITY_ERROR`,
`actionExecuted=false`, and `actionStatus="not_started"` before dispatch; update the Extension to use these conditions.
Evaluate and input retain `failureStage="precondition"`, with matching top-level and error-context status and no script
or input events dispatched. Other snapshot errors still stop the action, and compatibility reads share the original
timeout budget.

In Extension mode, a page snapshot that reports the requested tab is missing returns `TARGET_NOT_FOUND` with
`context.targetId` and the original `context.nativeMessage`. Input rejected before dispatch retains `eventsExecuted=0`
and `actionExecuted=false`. The failed request is not redirected to another page or replayed. User-script exceptions
with the same text are not classified as missing pages.

Creation failures retain `error.context.createdTargetId`, window ID, actual `managed`, `actionExecuted`,
`actionStatus="partial"` and `failureStage` when Chrome has returned the identity. If an RPC response is unknown,
`actionStatus` and `actionExecuted` are `"unknown"`; `pageContext.targetId` is null unless the created identity is
known, never the previous default page. Failed creation is not automatically repeated or undone.

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

Explicit `manage(action="adoptPage", targetId=...)` makes an existing page fully managed without focusing or navigating
it. `browse attach` only selects a target. Creation provenance, group membership, and group color do not authorize a
page. `releasePage` revokes full managed access without closing the tab or changing its window or group; it clears MCP
log state and removes debugging and console capture resources. If Chrome prevents resource cleanup, the response
includes `warnings` while managed access is still revoked.

Managed access survives a Service Worker restart. Reloading the Extension also restores access to surviving managed
tabs whose original document identity still matches, without refreshing or adopting them again. Tabs with unavailable
document identity require explicit `adoptPage` after an Extension reload; ordinary navigation keeps managed access,
and `releasePage` remains revoked after a restart or reload. A reused tab ID does not authorize a different document.
A managed tab can keep using this Extension's existing debugger session after a Service Worker restart. Sessions owned
by other debuggers still return `DEBUGGER_BLOCKED`.

Use `manage(action="grantReadAccess", targetId=...)` to grant ordinary reads and `revokeReadAccess` to revoke them; no
popup click is required. Both require an explicit target and accept `expectedUrl`/`expectedRevision`. Grants belong to
the calling server instance and the current document identity, URL and revision. Storage failure is an error, not
successful authorization. The popup remains an optional control. A grant survives a Service Worker restart only while
that connection and the approved document remain unchanged. Navigation, tab closure, or connection closure revokes it. A
target ID alone does not authorize reading. The grant covers ordinary content reads, including targeted text, HTML,
attributes, computed styles, and page state. Scripts, debugger operations, screenshots, input, and cookie access do not
inherit it; existing cookie operations have separate URL/name filter rules. When page management or navigation is
refused for lack of managed access, the revision and any valid ordinary-read grant remain unchanged.
`manage(action="pageMetadata", targetId=...)` reads or updates `taskHint` and `note`, and list results show creation and
last-use timestamps. Reads and updates accept `expectedUrl`/`expectedRevision`; a mismatch returns
`ACTION_PRECONDITION_FAILED` without reading or updating notes. This metadata is process-local and is removed when a
page is closed; it never authorizes content access.

### Access challenges

After `open`, `back`, `forward`, `refresh`, `input`, and `evaluate`, MCP Chrome waits for a Cloudflare JS Challenge or
Turnstile checkbox. When Extension mode is active, navigation starts without debugger logging. While a Challenge title
persists, MCP Chrome reads the live tab title passively for the first eight seconds. If the interstitial persists, it checks for a visible Turnstile control and
clicks it only when it finds one. Extension inspect uses an isolated world. Challenge titles detach the debugger before
inspection; ordinary-page checks retain an existing connection unless a visible verification control or unresolved
challenge content is found. Same-page
fixture buttons use the existing page click. If a Cloudflare Turnstile iframe is present, inspect CSS coordinates are
converted to screen coordinates and the OS mouse moves along a path, hovers, then presses and releases: `xdotool` on
Linux uses the focused Chrome client-window geometry and `xprop` GTK frame extents only when that window title matches
the test page. Missing tools, invalid geometry, or a viewport mismatch stop the click instead of guessing the content
origin from Chrome `screenX` or `outerHeight - innerHeight`; `cliclick` or System Events on macOS; and PowerShell
`mouse_event` on Windows. Widget clicks target the checkbox on the left of the compact Turnstile card, including when
the host wrapper is wider than the card, not the label. If a Cloudflare iframe is already in the DOM, the OS mouse is
used even when that iframe reports a zero-size rect, including the later host `Verify you are human` / `请验证您是真人`
button. The OS click runs only when the managed test tab is already the active tab in an already-focused window; mixed
windows are not focused. Debugger is detached and the viewport is read again before the OS click. Missing OS mouse tools
or an unfocused window return a visible error instead of a silent CDP click. A Turnstile widget is clicked only after
two inspections report the same click point; unrelated elements do not become widgets just because their sizes match.
Distant OS-mouse paths start near the control instead of flying across the screen. The same checkbox or compact widget
is clicked at most once; if Cloudflare then shows a visible `Verify you are human` or `请验证您是真人` button, that
button is inspected as `verify` and clicked at most once in the same wait. Use the default `diagnostics=false` for
challenge-protected pages because diagnostics starts debugger console and network collection.

Detection covers titles such as `Just a moment...` and `请稍候…`, visible challenge DOM or body-text markers, and
`Verify you are human` / `请验证您是真人` controls, including visible `button` elements with that exact text. A normal
title still requires a bounded check of visible content: visible `正在进行安全验证` blocks the action, while hidden
markers do not. Pages without challenge evidence continue without a fixed eight-second wait. Same-page buttons use
page input when no Cloudflare iframe is present. CDP reads live titles with `Target.getTargetInfo`. A leftover
Cloudflare iframe or an old pending header alone does not keep a recovered page pending or trigger scrolling or a
click. Cached titles do not decide the result. MCP Chrome does not call a CAPTCHA solver, retry navigation, or export
`cf_clearance` values. A CDP timeout does not prove that the site fails in a user Chrome session; check the returned
`mode` before diagnosing the site.

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
  the CDP commands API has no JS-event equivalent. An element or coordinate `target` is focused without mouse events
  before command dispatch. Coordinate focus does not toggle checkboxes, follow links, or invoke click listeners. A
  missing or unfocusable target returns an error before commands are sent. Extension `frame` coordinates are local to
  that frame.
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

If the frame, execution context, or debugger becomes unavailable during verification, the check returns
`verificationStatus="unavailable"`. A script that throws or rejects, even with the same error text, returns `error`.
An already completed action keeps `actionStatus="completed"` and `failureStage="verification"`; verification does not
replay the action.

For keyboard `type`, `timeout` includes Challenge waiting, focus preparation, character input, and `delay`/`humanize`
delays. Extension precise/stealth and CDP use the remaining budget. An explicit budget such as `timeout=45000` allows
valid input to take longer than the default 30000 ms. When the budget expires, subsequent characters and events stop.
Already dispatched input cannot be undone, so a timeout may leave partial input. A response with `actionExecuted=true`,
`actionStatus="unknown"`, and `retryable=false` requires an independent page read to check the actual value; do not
replay the whole event sequence.

Mouse target lookup, stepped movement, and `humanize` delays also share the remaining input budget. Each movement and
the subsequent click check the deadline; expiry stops further movement and clicking. Already dispatched native events
cannot be undone. Read the page independently after an unknown result instead of replaying the action.

Command focus, text selection, and replacement share the remaining event budget. Expiry stops subsequent actions; Shift
release is still attempted without hiding an earlier action error. Stepped CDP touch movement also stops at the
deadline.

Stealth left clicks emit `click`, middle clicks emit `auxclick`, and right clicks emit `contextmenu`. Each press/release
pair carries its click `detail`; only left multiple clicks emit `dblclick` at `detail=2`. Separate stealth `mouseup`
events follow the same button mapping.

In stealth mode, `delay` separates characters; the first character has no initial wait. Background page timer throttling
can lengthen subsequent intervals, but the same deadline still stops further input.

Precise Extension and CDP keyboard input use the current caret and selection. A `target` is clicked before typing and
can change the insertion point. To append to a contenteditable element, focus it, place the caret at its end, then send
`type` without a `target` so that it does not click again.

CDP clicks and keyboard input also wait for stable element position and size in background pages without activating
them. Visibility, enabled-state, viewport, and click coverage checks still apply. Target lookup, actionability checks,
and the final coordinate read share the remaining event budget. If any of these stages exhausts it, no mouse or keyboard
event is dispatched.

**`click`-specific**: `force: true` requires `forceReason` and a non-coordinate element `target`, and skips
actionability checks (useful for testing or hidden elements), but still dispatches the standard DOM mouse-event sequence
and does not call framework-private handlers. The same checks apply to middle/right clicks and multiple clicks. Missing
targets and coordinate targets cannot use `force`. Actionability failures return `ACTIONABILITY_FAILED` with `rect`,
`clickPoint`, covering element details, candidate blockers, and suggestions. **`type`-specific**: `mode="controlled"` or
`dispatch: true` sets `.value` directly and fires `input`/ `change` events — use for React/Vue controlled inputs where
keyboard events don't update state. Requires a non-coordinate `target`. Extension mode only. Controlled input and target
lookup failures return structured context with `locator`, `matchCount`, `nth`, bounded `candidates`, and an
`activeElement` summary without input values. The focus summary is `null` when unavailable; a failed DOM query also
returns `diagnosticError`. Selection-specific errors also report editor and selection state. Password input values are
omitted from failure diagnostics, and input `find` or replacement `text` values are redacted from failed responses. For
`select` and `replace`, event-level `nth` selects the Nth text occurrence while nested `target.nth` selects the Nth
matching element; both are zero-based and may be used together. Locator targets for `select` and `replace` work in CDP
mode without Extension ref IDs.

In both backends, target lookup failures from `input`, `extract`, and `wait` report the failed locator, zero-based `nth`,
URL, tab/frame scope, managed state, last locator state, and at most 10 candidate summaries within the request budget.
`matchCount` is the observed total, not the candidate limit; an out-of-range `nth` does not turn 15 matches into zero.
Unknown counts or managed state are `null`, and unavailable diagnostics include `diagnosticError`. CDP retains
`ELEMENT_NOT_FOUND` for lookup failures and `TIMEOUT` for element waits, together with existing URL and log fields.
Diagnostics read the failed target before its scope is restored and never replay input.

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

Text extraction uses the browser's `innerText` for HTML pages and selected elements. Rendered regions omit nested
`style`/`script` source and hidden descendants. Explicitly selected non-rendered HTML follows the browser's `innerText`
rules; SVG/XML nodes use `textContent`. Use `html` for source markup.

Parameters: `output` saves result to file (or directory for `images=data`). `images` (`info`/`data`) extracts image
metadata or data alongside HTML. `frameHtml` extracts the current iframe document after `frame` routing. Screenshot
accepts `clip` for coordinate-region capture, `compareWith` for PNG baseline comparison, and `diffOutput` for a PNG diff
image. `diffOutput` requires `compareWith`. A `target` screenshot that has no match, whose `nth` is out of range, or
whose box has zero size returns a target error rather than silently returning a viewport screenshot. Screenshot
responses include `metadata.format`, `width`, `height`, `dimensionSource`, `byteSize`, `fullPage`, `scale`, `clip`, and
`capabilities`. Capture is limited to 16,384 pixels per side, 12,000,000 pixels total, 48 MiB estimated RGBA memory and
25 MiB encoded data. PNG baselines are checked before reading; comparison is capped at 25 MiB per PNG and 12,000,000
pixels, and decompressed scanlines must exactly match the validated dimensions and are bounded during inflate. Malformed
or expansion-heavy PNGs are rejected. Use `clip` or `scale` for larger captures. Screenshot and diagnostic bundle
capabilities report `hiddenTabScreenshot: false` in both Extension and CDP modes. Hidden Extension tabs return
`HIDDEN_TAB_SCREENSHOT` without automatic activation. If another debugger blocks the precise screenshot path, viewport
fallback reports `degraded`, `fallback`, and `limitations`; unsupported fallback options return structured
`SCREENSHOT_FALLBACK_UNSUPPORTED` errors. `state` returns `interactiveElements`; `metadata` returns `frames` in both
Extension and CDP modes. The document `url` is returned in both backends; Extension `frame` routing returns that iframe
document's URL. CDP frame entries retain declared fields as `null` when unavailable, including DOM selectors and owner
rectangles; frame-tree order and IDs are preserved. Metadata also returns the page's current `managed` state and a
`metadata` object with `createdBy`, `createdAt`, `lastUsedAt`, `taskHint`, and `note`, matching `browse list` and
`manage pageMetadata`. These notes describe the page even when `frame` selects an iframe document. They are local to the
current Server process; unknown creation provenance stays `unknown`, and another Server does not inherit the notes. They
are not cross-session ownership or permission evidence. Inline and file outputs include the same fields. `managed`
describes Extension page management; CDP returns false without restricting normal operations through the CDP connection.
`targetId` (or `tabId`) selects a page in either backend; `frame` is Extension-only.

**`attribute` special prefix**: `computed:<property>` returns the computed CSS style value (e.g. `computed:color`,
`computed:font-size`). Use `computed:*` to return all computed style properties as JSON (returns 300+ properties — use
`output` to save to file).

**`state`-specific**: `depth` controls accessibility-tree traversal depth (default 15). Reduce it to limit response size
on large pages. `mode` selects `accessibility` (default, derived from the a11y tree) or `domsnapshot` (raw
`DOMSnapshot.captureSnapshot`, available through CDP or a managed Extension page). DOMSnapshot captures the whole page
and rejects `target`, `frame`, and `depth` instead of ignoring those limits. Ordinary read grants do not grant debugger
access. Unavailable sibling iframe probes are listed in metadata as `unavailableFrames` and per-frame
`unavailableReason`; a uniquely verified selected iframe remains usable.

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

| Parameter            | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `script`             | JavaScript code. Bare `return` statements are wrapped in IIFE                                       |
| `scriptFile`         | Read code from a local file instead of `script`                                                     |
| `args`               | Function arguments; `[]` invokes a zero-argument function, omission evaluates the script as written |
| `mode`               | `precise` (default, debugger API) or `stealth` (JS injection)                                       |
| `staleContextRetry`  | iframe stale-context policy: `never` (default) or `readOnly`                                        |
| `output`             | Save the result to a file                                                                           |
| `targetId` / `tabId` | Select a page in either backend (`tabId` is an alias)                                               |
| `frame`              | Target an iframe by CSS selector or index (Extension mode)                                          |
| `timeout`            | End-to-end budget (ms)                                                                              |
| `diagnostics`        | Return new console warnings/errors and failed requests after execution                              |
| `postCondition`      | Wait for text, selector, URL fragment, or script result after execution                             |

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
and replay it once within the remaining timeout budget. If Chrome still reports the removed document while resolving
that retry, the Extension waits for the current document within the same budget; this does not add script executions.
Permission failures stop immediately. A stale-context error after `Runtime.evaluate` reports `actionExecuted=true` and
`actionStatus="unknown"`, because earlier side effects may already have happened even though the final result is
unavailable.

For object results in the main frame with Extension precise mode, an explicit `output` uses a 16 Mi (16777216) character
budget. Without `output`, the 1000000-character budget still applies, including automatic saving. Both paths retain the
depth limit of 8, the 2000-node budget, and non-serializable result rejection. The character budget counts UTF-16 code
units, not the output file's UTF-8 bytes; `tmp:` files also remain subject to the temporary output quota. Exceeding a
result limit reports the current limit and the completed script's output failure without replaying it.

### manage - Page & Environment Management

| Action             | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `newPage`          | Create new controlled page/tab                                    |
| `pageMetadata`     | Read or update per-page `taskHint` and `note`                     |
| `closePage`        | Close controlled page and return `affected.before/after`          |
| `adoptPage`        | Grant full controlled-page access without focusing it             |
| `releasePage`      | Remove a controlled tab from management without closing it        |
| `grantReadAccess`  | Grant ordinary reads for an explicit page to the calling instance |
| `revokeReadAccess` | Revoke that instance's ordinary read grant                        |
| `updatePage`       | Update native tab properties and return actual state              |
| `movePage`         | Move a controlled tab to another window or index                  |
| `reorderPage`      | Reorder a controlled tab inside its window                        |
| `pinPage`          | Pin a controlled tab                                              |
| `unpinPage`        | Unpin a controlled tab                                            |
| `activatePage`     | Activate an explicit page; Extension requires a controlled tab    |
| `focusWindow`      | Focus an explicit window                                          |
| `resizeWindow`     | Resize or change state for an explicit window                     |
| `newWindow`        | Create a new controlled window                                    |
| `closeWindow`      | Close a window only when all tabs are managed                     |
| `updateWindow`     | Update native window position, state, focus or attention          |
| `groupPages`       | Create a group or add controlled tabs to an existing group        |
| `ungroupPages`     | Remove controlled tabs from groups without releasing them         |
| `updateGroup`      | Update group title, color and collapsed state                     |
| `moveGroup`        | Move a group and its tabs to a window or index                    |
| `clearCache`       | Clear cache/storage (use `cookies` tool to clear cookies)         |
| `viewport`         | Set viewport size                                                 |
| `userAgent`        | Set User-Agent                                                    |
| `emulate`          | Device emulation (iPhone, iPad, etc.)                             |
| `inputMode`        | Query or set input mode (`precise` / `stealth`)                   |
| `stealth`          | Inject anti-detection scripts                                     |
| `cdp`              | Send raw CDP command (advanced, e.g. `Runtime.evaluate`)          |

Native tab/window/group configuration uses Extension mode; `activatePage` also supports CDP. Mutations identify their
existing targets with `targetId`, `targetIds`, `windowId`, or `groupId` and return `affected.before/after`. Group
results also include `tabsBefore/tabsAfter`; `ungroupPages` removes an empty group through Chrome without revoking the
tabs' managed state. Window display changes and group title/color/collapse updates use the explicit `windowId` or
`groupId`, including containers with unmanaged members. They do not grant page permissions. Group moves and window
closure still require every affected member to be managed. Grouping or ungrouping selected pages checks those pages;
unrelated sibling changes do not invalidate a valid selection. Default page creation reuses a valid cached MCP window
even when it contains unmanaged tabs. `clearCache` is unavailable in Extension mode and returns `UNSUPPORTED_MODE`
without clearing anything. Use scoped `cookies(action="clear")` for cookies or CDP mode for storage and cache.
`focusWindow` only returns success after the target window is observed as focused; otherwise it returns
`WINDOW_FOCUS_NOT_OBSERVED`. `closeWindow` refuses mixed windows with unmanaged tabs and returns
`WINDOW_HAS_UNMANAGED_TABS`. Persistent `adoptPage` and `releasePage` target changes are serialized with scoped tab
operations, so a concurrent multi-event input remains on its requested tab and the persistent target is applied
afterward.

CDP `activatePage` retains the default operation target and reports the fields available from that backend, without
inventing an `active` value or system-window focus. In Extension mode, `viewport`, `userAgent`, `emulate`, raw `cdp`,
and precise `evaluate` support controlled `about:blank` pages. Chrome-internal and Extension pages retain their access
restrictions. Querying `manage(action="emulate")` without `device` returns the local device catalogue without a live
page; page conditions are rejected for this query. Setting a device continues to validate the selected page and
conditions.

| Action                          | Native parameters                                                                                                                     | Behavior                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `newPage`                       | `url`, `windowId`, `index`, `active`, `pinned`, `openerTabId`, `groupId`, `timeout`                                                   | `active` defaults to false; `groupId=-1` disables grouping; explicit placement is not changed by the default visual group                                    |
| `updatePage`                    | `url`, `active`, `pinned`, `highlighted`, `muted`, `autoDiscardable`, `openerTabId`                                                   | Requires `targetId`; only `active=true` is supported and does not focus the window; `active=false` is rejected before any update                             |
| `groupPages`                    | `targetIds`, `groupId`, `windowId`, `title`, `color`, `collapsed`                                                                     | Omit `groupId` to create a group in the members' window; mixed-window members require `windowId`; joining an existing group accepts only `targetIds/groupId` |
| `ungroupPages`                  | `targetIds`                                                                                                                           | Removes group membership and retains controlled-page access                                                                                                  |
| `updateGroup`                   | `groupId`, `title`, `color`, `collapsed`                                                                                              | An empty title and false collapsed value are applied as supplied                                                                                             |
| `moveGroup`                     | `groupId`, `windowId`, `index`                                                                                                        | Moves all members; `index=-1` means the end of the window                                                                                                    |
| `newWindow`                     | `url` or `urls`, `targetId`, `windowType`, `focused`, `incognito`, `left`, `top`, `width`, `height`, `windowState`, `setSelfAsOpener` | `normal` supports multiple URL tabs and an existing controlled tab; `popup` accepts only one page; created tabs are managed with distinct provenance         |
| `updateWindow` / `resizeWindow` | `windowId`, `left`, `top`, `width`, `height`, `windowState`, `focused`, `drawAttention`                                               | Applies supported Chrome window properties and returns observed state                                                                                        |

`updateWindow` and `resizeWindow` wait for a stable browser observation when changing state or geometry. Restoring a
non-normal window with `windowState="normal"` and bounds completes the state transition before applying bounds once.
OS-adjusted geometry is returned as observed. If observation does not stabilize within the bounded wait,
`WINDOW_UPDATE_NOT_OBSERVED` reports partial execution and the last observed window state; inspect `browse list` before
another update.

`browse list` defaults to `details="summary"`, returning target identity, URL/title, placement, managed/revision and
metadata. Set `details="full"` for highlighted/muted/discardable state, opener IDs and available native readonly
properties. False values are preserved. `targetIds` and `managedOnly=true` filter pages and their window/group
relations; `totalTargetCount`, `totalWindowCount` and `totalTabCount` distinguish inventory totals from selected counts.
Window objects reference pages through `targetIds` rather than repeating full targets. Inline favicon data URLs are
omitted; full details use `favIconInline=true` to indicate one exists. Groups retain title, color, collapsed/shared
state, window, first-member index and member IDs. Color belongs to a group, not a tab. Readonly properties are returned
when Chrome supplies them, not accepted as configuration writes. Listing does not read page content, navigate or focus.

Older Extensions that return group summaries without member arrays use the same response's window/tab membership to
populate group members and first-member index. Summary/full details and filters remain available without another RPC.
If group information is absent entirely, `groups` is omitted with a warning that it is unavailable. A supplied
`groups: []` means no groups. Malformed group data, including only one member array, returns an error.

Moving tabs/groups accepts `index=-1`; page creation requires a nonnegative index. Opener and explicit group/window
options must identify the same window. Pinned tabs cannot be created inside a group. Window state/bounds conflicts and
action-inappropriate fields are rejected before mutation. CDP rejects unsupported Chrome UI options rather than ignoring
them. `url` and `urls` are alternative inputs for `newWindow`; either can accompany `targetId` in a `normal` window. A
`popup` accepts a single URL or one existing tab, without additional URLs. Known preflight rejections retain
`actionExecuted=false`, `actionStatus="not_started"`, and `failureStage="preflight"`; rejected updates preserve the page
revision. Once a native update has been dispatched, a failure still invalidates that revision.

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

When the Extension debugger is unavailable, network reads refresh performance entries and mark them with
`source="performance"`. Status uses the browser's `responseStatus` when available, or `0` otherwise; unknown request
methods remain empty. Repeated reads preserve record sequences. `clear` clears MCP records and advances the current
document's read boundary without clearing the page's shared performance timeline. A new document starts a new boundary.
Read failures return an error rather than an empty log.

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

Invalid path syntax returns `INVALID_ARGUMENT`; `.` components are accepted and `..` components remain rejected. Paths
outside an allowed root, including symlink escapes, return `PATH_NOT_ALLOWED`. Both errors include the server's actual
working directory as `error.context.cwd`; scope rejections also include `allowedRoots`. Use `cwd:` with a path relative
to that directory, or `tmp:` for session output. These checks also apply to `scriptFile` and `compareWith`.

Quota rejection returns `TEMP_OUTPUT_QUOTA_EXCEEDED` with `limits`, `usage`, `remaining`, `requested`, and `projected`
in `error.context`. If `usage.complete` is false, usage is an observed lower bound and `remaining`/`projected` are null.
Existing output is preserved. An evaluate output failure retains `actionExecuted=true`, `actionStatus=completed`,
`failureStage=output`, and `retryable=false`; the script is not replayed. Use a repository-relative `cwd:` path for
subsequent output.

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
Precise evaluation matches the complete iframe URL, including query strings and fragments, and uses the selected DOM
iframe to distinguish frames with the same URL, including `about:srcdoc`. It rejects the operation when that identity
cannot be confirmed.

Frame selection failures return `INVALID_FRAME_SELECTOR`, `FRAME_NOT_IFRAME`, or `FRAME_NOT_FOUND`. Read injections
report `INVALID_SELECTOR`, `FRAME_STALE_CONTEXT`, `FRAME_INJECTION_DENIED`, `FRAME_SCRIPT_FAILED`,
`FRAME_INJECTION_FAILED`, or `FRAME_SCRIPT_NO_RESULT`, with the injection or script-result phase. A missing result does
not establish that the selector is invalid. Empty text, empty element arrays, null attribute values, and void script
calls keep their existing meaning; errors do not replay the script. When a read fails after resolving a frame,
`pageContext.frameContext` retains its selected DOM index, Chrome frame ID, and available document identity. Frame URL
diagnostics remove credentials, query strings, and fragments and are limited to 500 characters. `data:` and
`javascript:` URLs expose only the protocol; an unparseable URL reports `url=null` and `urlStatus="unavailable"`.

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
`actionStatus="failed"`. Once native execution returns a result, local materialization or serialization failures report
`actionStatus="completed"` and `failureStage="output"`. Diagnostics are best-effort and return `diagnosticsStatus` without replacing the main action
result. On a page precondition mismatch, input and evaluate report `actionExecuted=false` and
`actionStatus="not_started"`. Browse and wait errors also retain any diagnostics collected before the action failed.
Target diagnostics query the current tab state instead of relying on cached attach metadata.

Native script termination, `Internal error`, `Object couldn't be returned by value`, and `Object reference chain is too long`
responses from CDP `Runtime` script commands preserve the original error code. evaluate and `manage cdp` return `actionExecuted=true`,
`actionStatus="unknown"`, and `retryable=false` without replaying the command. evaluate also returns `retryable=false`
when an in-flight RPC timeout or stale execution context leaves the result unknown; timeouts before execution starts
remain retryable. Page-thrown exceptions with the same text remain non-retryable action failures.

Recognized Extension CDP rejections return `CDP_ERROR` with the method, target, native message and available protocol
code. The context distinguishes a disabled Debugger domain, stale script ID, browser-level command restriction, missing
method, command permission refusal (`Not allowed`), and native result serialization failure. A resource or method lookup failure does not imply that the entire
domain is unsupported. These remain failed calls with warning diagnostics; unknown errors retain error-level reporting.
A closed tab found during a native snapshot or permission check remains a target failure, separate from page-thrown
exceptions with matching text.

Extension accessibility state never reads `input[type=hidden]` or `input[type=password]` value getters for element names
or state text. This applies to the default `all` filter, target subtrees, and file output. Hidden controls may still
appear with `visible=false`; labels, placeholders, titles, and ordinary input values remain available. Explicit script,
HTML, and attribute reads retain their existing behavior.

`replace` uses text selection only for `textarea` and input types `text`, `search`, `tel`, `url`, and `password`. Other
input types use a native full-value update and return the requested and actual browser-normalized values. A standalone
`select` on unsupported types returns `UNSUPPORTED_SELECTION`. CDP locator targets for `select` and `replace` are
focused through the CDP locator instead of Extension-only ref IDs. Password values are omitted from input failure
context and text post-condition observations; failed input responses also redact supplied `find` and replacement `text`
values. Password `select`/`replace` responses hide console and network diagnostic bodies on success and failure,
returning `diagnostics.redacted=true` with `reason="sensitive_input_or_unresolved_target"`. This also applies when a
selection target cannot be identified safely. Ordinary input retains its diagnostics; password protection lasts for the
current input request. Target timeouts include bounded locator, tab, frame, match, and candidate context. Explicit
`tabId` and `frame` scopes resolve the active backend before input, wait, logs, or extract work begins, so actions and
verification use the same target backend. Precise iframe evaluation defaults to `staleContextRetry="never"` and does not
replay stale scripts. `readOnly` permits one replay after the Extension verifies the frame identity and resolves a new
execution context. Responses include the policy, `retryAttempted`, bounded `retryReason`, and the final `frameContext`
with the Extension frame, parent frame, URL, CDP frame, and execution context IDs. Same-URL frames are rejected only
when the selected DOM iframe cannot identify one target. Existing iframe targets remain usable after an Extension reload
without refreshing or navigating the page. Invalidated probe contexts produce a warning and stop listening instead of
throwing an uncaught messaging error. Discovery reports the initial port set and subsequent changes, including transitions
to no servers; unchanged scans and automatic reconnects do not repeat that summary. Each scan still checks the entire
port range. Explicit disconnect starts a new reporting cycle. Ordinary pre-open failures remain debug-level;
authentication and protocol rejections from identified MCP servers produce one bounded warning when the rejection
summary changes.

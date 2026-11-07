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
- **Frames and Shadow DOM**: `frame` selects a child frame or a nested selector/index path in either backend;
  CSS, text and semantic queries enter open shadow roots
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
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222 `
    -ExecutablePath 'C:\Browsers\chrome.exe' -ProfileDir 'C:\Temp\mcp-chrome-profile'
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

Token connections require authentication protocol v2 on both sides. Each command, response, cancellation and heartbeat
is authenticated with direction-separated session keys and an increasing sequence number. Health proofs bind the nonces,
server instance and port. The Extension waits for an authenticated ready message; the server waits for an authenticated
hello. Older strict-token peers are rejected with a protocol diagnostic. Default no-token discovery and automatic
reconnection retain their existing behavior.

The popup Disconnect action pauses connections for the current Extension session, including Service Worker recovery.
Connect resumes discovery. Reloading the Extension or restarting Chrome clears the pause and restores auto-connect.
When one MCP Server restarts, the Extension retries that server with the existing backoff while keeping other server connections active. Explicit Disconnect cancels these retries.

Discovery reports the initial server-port set and changes, including an empty set. Unchanged scans and automatic reconnects do not repeat that summary; each scan still checks the full port range. Explicit disconnect starts a new reporting cycle. Ordinary pre-open failures remain debug-level. Authentication or protocol rejections from identified MCP servers produce one bounded warning when their summary changes.

Popup settings report storage failures, and delayed old values cannot overwrite a newer choice. A temporary saved-pause read failure can recover on a later connection attempt in the same Worker. Explicit Disconnect stops local connections immediately; a pause-write failure remains visible. Default local auto-connect needs no manual pairing or Connect click.

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

## Target: Unified Element Locator

All tools use a unified `Target` type for element location. CSS, text, role and label queries traverse open shadow
roots in stable order; XPath retains native document-tree semantics. `aria-labelledby` uses IDs from the element's own
tree, preserves multiple-reference order and takes precedence over `aria-label`. Content-named roles such as `tab`,
`checkbox` and `menuitem` include visible descendant text, including nested spans. State names use the same rules;
ordinary inputs retain their current values in `value` and `pageContent`, separately from their names. Password,
hidden and file input values are not read by state extraction. Closed shadow roots remain outside Extension DOM queries.

Examples:

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

Text-only targets choose the innermost complete-text match, including nested text nodes. Explicit XPath preserves document order. Both backends use display, visibility and nonzero dimensions for visibility; an initially absent hidden/detached target succeeds on its first query.

In both backends, target lookup failures from `input`, `extract`, and `wait` report the failed locator, zero-based
`nth`, URL, tab/frame scope, managed state, last locator state, and at most 10 candidate summaries within the request
budget. `matchCount` is the observed total, not the candidate limit; an out-of-range `nth` does not turn 15 matches into
zero. Unknown counts or managed state are `null`, and unavailable diagnostics include `diagnosticError`. CDP retains
`ELEMENT_NOT_FOUND` for lookup failures and `TIMEOUT` for element waits, together with existing URL and log fields.
Diagnostics read the failed target before its scope is restored and never replay input.

Targeted operations resolve `target.nth` directly in both backends, including indices beyond the default 50-result
candidate list and pure-text indices beyond 200. A single-target result does not report a total; its diagnostic
`matchCount` is `null` unless a separate lookup measured the total. Element waits check that selected target, so an
existing high-index element cannot satisfy `hidden` or `detached` merely because candidate output is bounded.

Page tools accept `targetId` in either backend; the older `tabId` alias is still accepted. If both are supplied, they
must match. An explicit target changes only the operation scope and restores the previous default afterward.
`browse.close` and `manage.closePage` require an explicit ID. Page responses, including action failures, include
`pageContext` with the effective target and its source (`explicit`, `default`, `created`, `reused`, or `unconfirmed`),
before/after URL and revision, default target before/after, and Chrome's active target when Extension reports it.
`unconfirmed` means a page-creation action failed without returning a created target ID. CDP reports browser activity as
unavailable rather than treating the selected operation target as foreground.

Page URL fields in these snapshots, browse results, page/window management, state, metadata, and diagnostic bundles
redact credential query parameters, including `ticket`, and report `urlRedacted`, `urlOriginalLength`, and
`redactedQueryParameters`. Native `pendingUrl` and `favIconUrl` fields use equivalent field-prefixed markers.
Navigation waits and navigation error messages use the same display redaction. Navigation
and `expectedUrl` comparisons use the original URL; page content and user-script results retain their requested content.
Use `expectedRevision` or an original URL you hold for conditions; a redacted display URL cannot serve as `expectedUrl`.

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

## Request scope and failure handling

An input sequence keeps its backend and page through execution and target restoration. CDP binds frame execution to its context and OOPIF session; Extension checks the document and native iframe owner, so same-URL iframe reordering preserves the selected identity. Concurrent `browse(action="connect")` waits for that request scope.

Input and evaluate share one budget across queueing, page selection, preparation, dispatch and verification. Cancellation or budget settlement stops queued scripts, remaining events and later context or diagnostic reads. Keys newly held by that request are released with a separate bounded cleanup budget. Confirmed final events retain `actionStatus="completed"` if later response handling exceeds the deadline; dispatched actions without confirmation retain `unknown` and `retryable=false`. Read the current page before deciding on another action.

Coordinate input waits for synchronous scroll cascades, including open Shadow roots created during preparation, then reads the current frame-local rectangle. Unrelated requestAnimationFrame scrolling does not keep a stable target waiting. Continuous synchronous self-scrolling is bounded by the request deadline, even when the target stays still.

MCP cancellation also stops queued window and group changes. The Extension checks the request after asynchronous preflight and before native changes or uncommitted ownership, read-grant and metadata updates. A successful storage commit is synchronized to memory; required registration after creation and cleanup after closing still finish. Event-ref controls remain available while another page action is waiting.

Extract uses the same signal for queueing, page reads and exports. Cookie, log, event, evaluate and extract outputs check the signal and deadline during preparation and before publication. Cancellation stops later reads, unpublished files and later log manifests; published files remain available and temporary-file cleanup finishes. A completed script retains its execution state if its output is stopped.

## Operation status and diagnostics

Input and evaluate expose execution and verification separately:

| Field                | Values                                                       | Meaning                                                                       |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `actionExecuted`     | `false`, `true`, `"unknown"`                                 | Known principal-action execution fact                                         |
| `actionStatus`       | `not_started`, `completed`, `failed`, `unknown`              | Principal-action outcome                                                      |
| `verificationStatus` | `matched`, `not_matched`, `unavailable`, `error`             | Post-condition observation                                                    |
| `failureStage`       | Context, precondition, queue, action, verification or output | Stage that failed                                                             |
| `retryable`          | Boolean                                                      | Whether the principal action can be retried                                   |
| `diagnosticsStatus`  | Status of supplemental diagnostics                           | Diagnostics keep the primary result and observations collected before failure |

Page-thrown exceptions retain their message text, including empty strings, JSON-shaped text and primitive values, with `actionExecuted=true` and `actionStatus="failed"`. Existing exception descriptions and stacks are preserved. Once the script's result has resolved, failures during type inspection, diagnostic summaries, or JSON encoding and decoding of results and error details report `actionExecuted=true`, `actionStatus="completed"`, `failureStage="output"` and `retryable=false`, including in stealth mode. Promise rejection while adopting the return value remains an action failure. If an encoded error summary cannot be decoded, `error.context.originalOutputError` retains the first output diagnostic.

An initial snapshot failure reports `false/not_started`, `failureStage="context"` and `pageContext.contextPhase="before"`. A snapshot checking `expectedUrl` or `expectedRevision` uses `precondition` for both stage fields. If a target, frame, Challenge, argument or per-event preparation RPC has an unknown receipt or an internal evaluate output failure before the principal action is dispatched, the top-level action remains `false/not_started/context`; the auxiliary operation keeps its own facts in the error context. Confirmed earlier input events remain counted. Late replies do not dispatch or replay the principal action.

A page precondition mismatch reports `false/not_started/precondition`. Target diagnostics read the current tab instead of cached attach metadata.

### Native failures and diagnostics

Native script termination, `Internal error`, `Object couldn't be returned by value`, and
`Object reference chain is too long` responses from CDP `Runtime` script commands preserve the original error code.
evaluate and `manage cdp` return `actionExecuted=true`, `actionStatus="unknown"`, and `retryable=false` without
replaying the command. evaluate also returns `retryable=false` when an in-flight RPC timeout or stale execution context
leaves the result unknown; failures before dispatch use their reported `retryable` field. Page-thrown exceptions with the same text
remain non-retryable action failures.

Recognized Extension CDP rejections return `CDP_ERROR` with the method, target, native message and available protocol
code. The context distinguishes a disabled Debugger domain, stale script ID, browser-level command restriction, missing
method, command permission refusal (`Not allowed`), and native result serialization failure. A resource or method lookup
failure does not imply that the entire domain is unsupported. These remain failed calls with warning diagnostics;
unknown errors retain error-level reporting. A closed tab found during a native snapshot or permission check remains a
target failure, separate from page-thrown exceptions with matching text.

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

A default `launch` uses a connected Extension. Explicit `headless`, `incognito`, `userDataDir`, `executablePath`, or
`port` selects a new CDP browser and returns `mode="cdp"`. An existing CDP connection is reported as a conflict before
creating or closing a browser; supplied launch settings are applied or rejected.

Extension-specific: `list` returns the flat `targets` array plus a `windows` tree. Each target includes `managed`
(whether the tab is controlled by MCP Chrome), `isActive` (Chrome's active tab within its window), `windowId`, `index`,
`pinned`, `incognito`, and `status` (`loading`/`complete`). Summary mode returns `windowCount` and each window's ordered
`targetIds`; `details="full"` includes the full native target and window properties. When Chrome has a focused window, `focusedWindowId`
identifies it and `activeTargetId` identifies its active tab. With no focused Chrome window, both fields are omitted;
each window still reports its own `activeTabId`. `defaultTargetId` identifies the selected operation target; CDP
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
available history they return `navigated=false` without consuming the navigation wait budget. The page fallback checks `history.length` and, when available, the Navigation API's direction flag before dispatch. Other native failures are preserved. A destroyed execution context or a
browser refusing injection into an error page still returns an operation failure, recorded as a warning in the Extension
rather than a program error. Arbitrary debugger commands are never automatically replayed.

If a CDP history-navigation command is rejected, the original error is returned and that navigation wait ends immediately, keeping later requests available.

For `open`, `back`, `forward`, and `refresh`, `timeout` starts at request entry. Target preparation, queueing, protocol
calls, page loading, Challenge inspection and clicks, diagnostics, and target restoration share the remaining budget;
navigation RPCs do not add transport time. An expired queued action is not dispatched, and later requests still wait for
an earlier in-flight action to settle. Explicit `timeout=0` rejects before navigation dispatch. Page creation retains
its separate load-wait and transport-time contract. When the navigation wait exhausts the request deadline, later metadata and diagnostic reads stop. A shorter wait timeout leaves the enclosing request's remaining budget available.

MCP cancellation stops queued browse actions before dispatch and ends active navigation or Challenge waits. The same signal stops later OS mouse commands and CDP launch steps after an interrupted wait; launch cleanup terminates only a process created by that request and not yet delivered.

If a mouse button was already pressed, the request retains the tab lock until its necessary release completes or the independent 5000 ms cleanup budget ends. Subsequent navigation and input remain queued during release. A failed or timed-out release reports `releaseStatus="unknown"` with an explicit error; check and release the mouse button before continuing.

A confirmed navigation keeps `actionExecuted=true` and `actionStatus="completed"` when its later state read fails, with `failureStage="metadata"` and `retryable=false`; page verification retains its own result.

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

For `browse`, only `open`, `back`, `forward`, `refresh`, and `close` accept these conditions. Other actions, including
`attach`, reject them with `INVALID_ARGUMENT` before changing any target.

Explicit `manage(action="adoptPage", targetId=...)` makes an existing page fully managed without focusing or navigating
it. `browse attach` only selects a target. Creation provenance, group membership, and group color do not authorize a
page. `releasePage` revokes full managed access without closing the tab or changing its window or group; it clears MCP
log state and removes debugging and console capture resources. If Chrome prevents resource cleanup, the response
includes `warnings` while managed access is still revoked.

Managed access survives a Service Worker restart. Reloading the Extension also restores access to surviving managed tabs
whose original document identity still matches, without refreshing or adopting them again. Tabs with unavailable
document identity require explicit `adoptPage` after an Extension reload; ordinary navigation keeps managed access, and
`releasePage` remains revoked after a restart or reload. A reused tab ID does not authorize a different document. A
managed tab can keep using this Extension's existing debugger session after a Service Worker restart. Sessions owned by
other debuggers still return `DEBUGGER_BLOCKED`.

Use `manage(action="grantReadAccess", targetId=...)` to grant ordinary reads and `revokeReadAccess` to revoke them; no
popup click is required. Both require an explicit target and accept `expectedUrl`/`expectedRevision`. Grants belong to
the calling server instance and the current document identity, URL and revision. Storage failure is an error, not
successful authorization. The popup remains an optional control. A grant survives a Service Worker restart only while
that connection and the approved document remain unchanged. Navigation, tab closure, or connection closure revokes it. A
target ID alone does not authorize reading. The grant covers ordinary content reads, including targeted text, HTML,
attributes, computed styles, and page state. Scripts, debugger operations, screenshots, input, and cookie access do not
inherit it; existing cookie operations have separate URL/name filter rules. When page management or navigation is
refused for lack of managed access, the revision and any valid ordinary-read grant remain unchanged.
`manage(action="pageMetadata", targetId=...)` reads or updates `taskHint` and `note`, with
`expectedUrl`/`expectedRevision` conditions. A mismatch returns `ACTION_PRECONDITION_FAILED` before reading or updating
notes. Extension persists `origin=created/adopted/unknown`, creation time and task notes. Existing v1 pages migrate to
unknown and remain managed. Extension metadata is authoritative after Server restart; storage failures return errors.
CDP metadata remains local to the Server process. Origin, document identity and trusted native relationships
are maintained
by Extension; notes never grant content access.

Start each task with `browse list`, select a suitable page by task name and notes, and attach in the
background to reuse it.
Call `newPage` only when no suitable page exists, supplying `taskHint` and a `note` that identifies temporary, output or
reusable use. `newPage` always creates a new page. By default, it uses an existing normal window containing a trusted
created page, then another existing normal window. With no normal window it returns an error; lost caches never create a
window. Task groups are reused only through trusted creation records and current native membership, never their name.
Mixed user groups and same-name user groups remain untouched. Renaming a task updates the native group title when all
trusted members share that task. Native moves, closure and membership changes clear invalid relationships.

At task completion, use the existing close/release actions on an explicit page set. Default cleanup closes only pages
created for this task whose notes explicitly identify temporary use. Preserve adopted/unknown pages, outputs, reusable
test pages and mixed user groups; release unused temporary permissions through existing actions. Explicitly authorized
closure retains the existing managed-page contract. Disconnects and idle periods never close pages. Native
groups require
Extension; CDP accepts metadata-only `taskHint/note` options.

Explicit `networkidle` starts Network observation before navigation and requires 500 ms of quiet after tracked requests finish. Missing or interrupted observation returns an error. The default `load` path does not attach a debugger for network-idle tracking.

### Access challenges

After `open`, `back`, `forward`, `refresh`, `input`, and `evaluate`, MCP Chrome waits for a Cloudflare JS Challenge or
Turnstile checkbox. When Extension mode is active, navigation starts without debugger logging. While a Challenge title
persists, MCP Chrome reads the live tab title passively for the first eight seconds. If the interstitial persists, it
checks for a visible Turnstile control and clicks it only when it finds one. Extension inspect uses an isolated world.
Challenge titles detach the debugger before inspection; ordinary-page checks retain an existing connection unless a
visible verification control or unresolved challenge content is found. Same-page fixture buttons use the existing page
click. If a Cloudflare Turnstile iframe is present, inspect CSS coordinates are converted to screen coordinates and the
OS mouse moves along a path, hovers, then presses and releases: `xdotool` on Linux uses the focused Chrome client-window
geometry and `xprop` GTK frame extents only when that window title matches the test page. Missing tools, invalid
geometry, or a viewport mismatch stop the click instead of guessing the content origin from Chrome `screenX` or
`outerHeight - innerHeight`; `cliclick` or System Events on macOS; and PowerShell `mouse_event` on Windows. Widget
clicks target the checkbox on the left of the compact Turnstile card, including when the host wrapper is wider than the
card, not the label. If a Cloudflare iframe is already in the DOM, the OS mouse is used even when that iframe reports a
zero-size rect, including the later host `Verify you are human` / `请验证您是真人` button. The OS click runs only when
the managed test tab is already the active tab in an already-focused window; mixed windows are not focused. Debugger is
detached before the OS click. After movement and hover, the control position, viewport and active window are checked again
before pressing. On Linux, a 1 px native round trip calibrates the current content origin while the debugger banner
animates. If the control moves, the mouse repeats the path, hover and calibration within the original timeout. A changed
page, control stage or focus stops the click. Missing OS mouse tools or an unfocused window return a visible error instead
of a silent CDP click. A Turnstile widget is clicked only after two inspections report the same
click point; unrelated elements do not become widgets just because their sizes match. Distant OS-mouse paths start near
the control instead of flying across the screen. The same checkbox or compact widget is clicked at most once; if
Cloudflare then shows a visible `Verify you are human` or `请验证您是真人` button, that button is inspected as `verify`
and clicked at most once in the same wait. Use the default `diagnostics=false` for challenge-protected pages because
diagnostics starts debugger console and network collection.

Detection covers titles such as `Just a moment...` and `请稍候…`, visible challenge DOM or body-text markers, and
`Verify you are human` / `请验证您是真人` controls, including visible `button` elements with that exact text. A normal
title still requires a bounded check of visible content: visible `正在进行安全验证` blocks the action, while hidden
markers do not. Pages without challenge evidence continue without a fixed eight-second wait. Same-page buttons use page
input when no Cloudflare iframe is present. CDP reads live titles with `Target.getTargetInfo`. A leftover Cloudflare
iframe or an old pending header alone does not keep a recovered page pending or trigger scrolling or a click. Cached
titles do not decide the result. MCP Chrome does not call a CAPTCHA solver, retry navigation, or export `cf_clearance`
values. A CDP timeout does not prove that the site fails in a user Chrome session; check the returned `mode` before
diagnosing the site.

A completed embedded widget can retain its container. An associated nonempty response marks that widget complete;
reset or expiry returns it to pending. Each widget is checked separately, and a response in another form cannot complete
it. Detection returns completion state without returning the response value.

Input and evaluate check for a new challenge after the action returns, using the remaining budget. A verification
failure retains the action's completed state and never replays it. If the confirmed final event exhausts the budget,
`challengeVerificationStatus="unavailable"` explains that no post-action challenge check could run. A post-action timeout
returns `retryable=false` and `nextAction="wait_and_verify"`; wait for verification and inspect the business result.

A resolved challenge returns `challengeResolved=true`, `challengeKind`, `waitedMs`, `clickedTurnstile`, and
`clearanceCookiePresent` (name presence only). If the visible page text says verification succeeded and Cloudflare is
waiting for the origin, the result also has `originResponsePending=true`; verification passed, but the destination page
is not loaded yet. Hidden template text such as a `display:none` success heading does not count, and a visible Turnstile
checkbox still counts as pending. Challenge results and errors include `mode`. Before-action timeout returns
`CHALLENGE_TIMEOUT` with `retryable=true`, `clickedTurnstile`, and the observed `challengeKind` (a Turnstile click is not reported as `js`).
Cloudflare Access denied returns `CHALLENGE_DENIED`. Interactive CAPTCHAs, Bot Fight Mode, and IP reputation checks
cannot be completed by waiting or clicking a checkbox. A later normal main-document response clears the header flag;
ordinary iframe document responses and clearing network logs do not.

### input - Keyboard, Mouse & File Input

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
| `upload`                                | Select local files in a file input; `files:[]` clears the selection    |
| `wait`                                  | Pause between events                                                   |
| `select`                                | Select text by content (mouse sim)                                     |
| `replace`                               | Find and replace text                                                  |
| `drag`                                  | HTML5 drag-and-drop (`target` source and `to` destination)             |
| `editorContext`                         | Read focused editor and selection context                              |
| `editorInsert`                          | Insert text at the current editor selection                            |
| `editorCommand`                         | Execute browser editing commands such as `bold` or `insertOrderedList` |

On background Extension tabs, a default unmodified left click on an element uses checked synthetic events and returns a
`warnings` entry with `isTrusted=false`, without selecting the tab. On a rendered active tab, precise mode uses native input.
Background coordinate clicks, movement, or modified/multiple clicks require explicit
`manage(action="inputMode",inputMode="stealth")`; mouse-button cleanup remains available.

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
index or a nested path) in either backend. When either scope is provided, the action, diagnostics, and post-condition use the backend
selected for that target scope.

Text, selector and URL checks recover a transient lost context within the remaining input and verification deadlines. A context that stays unavailable, a closed native connection, or an exhausted read budget returns `verificationStatus="unavailable"`. Script checks report native context failures immediately. Native execution termination and engine execution timeouts during verification return `unavailable` in both Extension and CDP. Selector syntax errors and page-thrown or rejected errors return `error`, including when an exception's string conversion also throws. Error text mentioning a frame or timeout does not change the source. A completed input keeps `actionStatus="completed"`, `failureStage="verification"` and top-level `retryable=false`. Use `postCondition.retryable` to retry the check on its own. Verification shares the action's total deadline; an exhausted total budget starts no new check.

Cancellation interrupts verification reads and polling waits. Input then attempts a bounded release of keys newly pressed by that request before the next queued action starts. Keys held before the request remain held; release failures retain a diagnostic.

Text checks match rendered page text and visible, non-password form values. The bounded `actual` excerpt includes the matched text. Clicks on a Shadow host accept its own shadow descendants; synthetic click, key and input events reach host and document listeners, while mouseenter and change retain their local event semantics.

Coordinate targets use the selected frame's viewport coordinates. Native precise input accounts for the frame's content boundary, scaling, rotation, skew and nested placement; input whose coordinates cannot be mapped reliably fails before the affected event. Earlier completed events retain their progress. Stealth events keep frame-local coordinates.

Target-based coordinate preparation follows assigned slots and Shadow hosts to the actual scroll container. On visible pages, it checks the target rectangle and ancestor scroll positions across consecutive renders, including cascades triggered by page listeners that stop event propagation. A stable target remains actionable beside a looping, unrelated scroller. A page hidden during this wait uses its current layout without waiting for paused animation frames; a page that becomes visible resumes render checks. Continuous target motion or ancestor scrolling can exhaust the shared request deadline, leaving that event undispatched.

An omitted wheel target keeps the current mouse position. Extension wheel helper setup and input target the same resolved documentId; replacement or removal before input returns not_started without selecting the new document.

Wheel and mouse events carry the currently held Ctrl, Shift, Alt and Meta fields, including combined modifiers and precise right-click events that use synthetic dispatch. Synthetic events retain `isTrusted=false`; application listeners can inspect the modifier fields and cancel their default scroll.

Extension coordinate wheel follows each axis's effective scroll range, including reverse Flex layouts and vertical writing modes. Fractional deltas accumulate across consecutive inputs to the same scroll container, including changes to the hit descendant and scrolling performed by that wheel listener. Position changes between inputs reset that container's pending fraction; another container or document starts its own sequence. Native scroll progress identifies fractional endpoints under CSS zoom. When native progress is unavailable, a console warning identifies the CSSOM-bounds compatibility path. Element scroll distances account for effective CSS zoom; ordinary transform scale keeps its existing wheel-distance semantics. Viewport scrolling uses its own units.

Scroll-container eligibility accounts for the namespace, principal box and text-editing controls. MathML math layouts, flow-root and inline flow-root list items, block ruby and Chrome-supported `-webkit-box`/`-webkit-inline-box` layouts retain their scrolling and boundary behavior. A text input can scroll its internal text even when Chrome reports computed overflow as clip. A block SVG viewport does not become a CSS scroll boundary from hidden/contain declarations; a foreignObject with a scrolling box retains its own auto scrolling and hidden contain/none boundary, and embedded HTML retains its own scrolling behavior. At a real container boundary, `overscroll-behavior-x/y: contain` or `none` stops that axis, including zero-range containers; `auto` lets an unconsumed axis continue along the original chain. A nested `overflow:hidden` container keeps its boundary policy without scrolling itself; ordinary clip/visible, non-atomic inline and display:contents nodes do not add that boundary.

The viewport follows root/body overflow propagation. A body with no principal box, including display:contents, does not supply its overflow. Effective containment on html/body, including content-visibility or container-type, keeps the body independent. A body supplying viewport overflow is not a separate boundary, and hidden/clip viewport axes do not scroll. A scrollable target consumes its own input first. Absolute/fixed targets then follow the nearest applicable positioning containing block through the composed tree, including slots and foreignObject content. Transform, filter, containment, 3D/motion conditions and applicable will-change names keep their own box-eligibility rules.

The composed, cancelable wheel event reaches Shadow host and document listeners. Effective `preventDefault()` suppresses the simulated default scroll; the event still reports `actionStatus="completed"` and counts as one executed input. Each axis selects its scroll route from the boundary at input start. A listener that resizes or repositions a scroll container retains its own changes; the default action uses the resulting position on the selected route. A container that loses its scroll range lets unconsumed input continue along the original chain under its overscroll policy. Removing or moving the hit element does not redirect that wheel to a newly inserted ancestor or an unrelated viewport.

Extension wheel uses programmatic scrolling for its default action. Scroll snapping follows that programmatic endpoint, which can differ from native wheel intent. Mandatory and proximity snap layouts retain their declared snapping; native wheel endpoint differences are an accepted compatibility behavior.

For keyboard `type`, `timeout` includes Challenge waiting, focus preparation, character input, and `delay`/`humanize`
delays. Extension precise/stealth and CDP use the remaining budget. An explicit budget such as `timeout=45000` allows
valid input to take longer than the default 30,000 milliseconds. When the budget expires, subsequent characters and
events stop. Already dispatched input cannot be undone, so a timeout may leave partial input. A response with
`actionExecuted=true`, `actionStatus="unknown"`, and `retryable=false` requires an independent page read to check the
actual value; do not replay the whole event sequence.

Mouse target lookup, stepped movement, and `humanize` delays also share the remaining input budget. Each movement and
the subsequent click check the deadline; expiry stops further movement and clicking. Already dispatched native events
cannot be undone. Read the page independently after an unknown result instead of replaying the action.

Explicit Extension precise `keydown`/`keyup` events use native keyboard input. Focus preparation shares the remaining request budget. When focus emulation is needed, response `warnings` explains that the document temporarily reports `visible`; the actual tab and window focus stay unchanged. The original setting is restored before `postCondition` runs.

A recovered debugger session with an unknown original focus setting on a background tab returns `KEYBOARD_FOCUS_STATE_UNKNOWN` and `not_started`, preserving that setting. Explicit stealth or an independent CDP session remain available. Restoration failures return `keyboardFocusCleanup`; completed events retain `completed`, and unconfirmed dispatch retains `unknown`. Failure, cancellation or expiry attempts to release keys newly pressed by this request. Successful requests preserve intentionally held keys.

Command focus, text selection, and replacement share the remaining event budget. Expiry stops subsequent actions; Shift
release is still attempted without hiding an earlier action error. Stepped CDP touch movement also stops at the
deadline.

Stealth left clicks emit `click`, middle clicks emit `auxclick`, and right clicks emit `contextmenu`. Each press/release
pair carries its click `detail`; only left multiple clicks emit `dblclick` at `detail=2`. Separate stealth `mouseup`
events follow the same button mapping.

In stealth mode, `delay` separates characters; the first character has no initial wait. Background page timer throttling
can lengthen subsequent intervals, but the same deadline still stops further input.

Default precise keyboard `type` in Extension and CDP mode dispatches Enter for each newline (CRLF is normalized).
An editor that submits on Enter can therefore submit part of a multiline input. For multiline replacement in Extension
mode, use `mode="controlled"` (or `dispatch=true`) with a `target`: it replaces the complete value or contenteditable
text and dispatches input/change without Enter. Form controls keep their native value setters.

Keyboard input and `editorInsert` use the current caret and selection. Keyboard `type` with a `target` clicks it first
and can change the insertion point; `editorInsert` focuses its target without clicking and inserts through the browser
editing API without Enter. To append multiline text, place the caret at the end and send `editorInsert` without a
`target`. A nonempty selection is replaced, not appended. Read the resulting value to verify the editor accepted it.

CDP clicks and keyboard input also wait for stable element position and size in background pages without activating
them. Visibility, enabled-state, viewport, and click coverage checks still apply. Target lookup, actionability checks,
and the final coordinate read share the remaining event budget. If any of these stages exhausts it, no mouse or keyboard
event is dispatched.

**`click`-specific**: `force: true` requires `forceReason` and a non-coordinate element `target`. It skips actionability checks while dispatching standard DOM mouse events. Middle/right and multiple clicks use the same rules; a coordinate or omitted target cannot use force. Failures return `ACTIONABILITY_FAILED` with `rect`, `clickPoint`, covering elements, candidate blockers and suggestions.

**`type`-specific**: `mode="controlled"` or `dispatch:true` replaces the value or contenteditable text and sends `input`/`change` without Enter. It requires a non-coordinate `target` and Extension mode. Targets must be HTML `input`, `textarea`, `select` or contenteditable; effectively disabled controls, readonly controls, unsupported containers and file inputs are rejected before focus or input events. Disabled fieldsets follow HTML rules, including the first-legend exception. Use `upload` for a file input. Ordinary controls, customized built-ins and same-origin controls adopted from another document use the native value setter for their actual form interface; an unavailable setter returns an error before focus.

Controlled input and target-lookup failures return `locator`, `matchCount`, `nth`, bounded `candidates` and an `activeElement` summary without input values. Unavailable focus is `null`; a failed DOM query adds `diagnosticError`.

Cancellation or expiry after a confirmed Extension precise character or Enter event preserves executed progress and invalidates the old page revision. Cancellation before the first dispatch keeps the not-started state. Read the current value and revision before another action.

For a tag field that commits on Enter, send the text and explicit Enter events, then check the created tag. This `input` example uses `#tag-entry` for the field and `#tags` for its tag list; use the selectors from the page:

```json
{
  "events": [
    { "type": "type", "target": { "css": "#tag-entry" }, "text": "12345" },
    { "type": "keydown", "key": "Enter" },
    { "type": "keyup", "key": "Enter" }
  ],
  "postCondition": { "selector": "#tags [data-value=\"12345\"]" }
}
```

#### Text selection and sensitive input

`replace` uses text selection for `textarea` and input types `text`, `search`, `tel`, `url` and `password`. Other input types use a native full-value update and return requested and actual browser-normalized values. Standalone `select` on an unsupported type returns `UNSUPPORTED_SELECTION`. CDP locator targets are focused through CDP rather than Extension ref IDs.

Event-level `nth` selects a text occurrence; nested `target.nth` selects a matching element. Both are zero-based and can be combined. Selection errors include editor and selection state.

Password values are omitted from failure context and text post-condition observations; failed input responses also redact supplied `find` and replacement `text`, including locator details in `error.logs`. Password `select`/`replace` hides console and network diagnostic bodies on success and failure, returning `diagnostics.redacted=true` and `reason="sensitive_input_or_unresolved_target"`. An unresolved selection target receives the same protection. Ordinary input keeps its diagnostics, and password protection ends with the current input request.

#### Upload local files

Prefer mcp-chrome for browsing, page interaction, and file uploads. Uploads reuse the current page and Extension/CDP
connection. Use Chrome DevTools for browser or extension diagnostics and specific tasks that mcp-chrome does not cover.

Select a file at its original path, including files in Downloads, through the `input` tool's `upload` event:

```json
{
  "events": [
    {
      "type": "upload",
      "target": { "css": "input[type=file]" },
      "files": ["./review.zip"]
    }
  ]
}
```

`files` is required. Paths refer to readable regular files on the MCP Server machine. Relative paths use the Server's
working directory; absolute paths and `~/` paths are supported. The Server transfers file bytes, so the browser may run
on another machine. The selected files' combined size must be below 50 MiB; a total at or above that limit fails before
changing the file input.

Use multiple paths for an input with the `multiple` attribute. Use `files:[]` to clear it:

```json
{"events":[{"type":"upload","target":{"css":"#attachments"},"files":[]}]}
```

The target must be an `input[type=file]`. Hidden file inputs work without clicking or opening a system file chooser.
Existing element locators and `target.nth` select the input; `frame` selects a child or nested iframe in either backend. Uploads use the current
Extension or CDP connection and the selected input mode. Default precise mode supports strict CSP pages; stealth keeps
the page's CSP restrictions. Extension upload requires managed-page access, checked before any local file read.

The result summarizes the selected file names, sizes, MIME types, and dispatched events. The input receives `input`
followed by `change`, using synthetic events. Sites requiring trusted events need site-specific verification. A page
that clears the input in its `change` handler still receives the file selection; the result describes the assignment
before those handlers run.

Use `postCondition` for the site's attachment-ready or upload-complete state, and submit separately when the site
requires it. A failed post-condition preserves the completed input action. File reads, transfer, and assignment share
the input timeout and cancellation. A failure before assignment leaves the selection unchanged. An unconfirmed
assignment returns `actionStatus="unknown"` and `retryable=false`; inspect the page before deciding what to do next.

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

#### HTML and images

`output` saves to a file, or a directory for `images=data`. `images=info|data` includes image metadata or bytes with HTML. Image data is limited to 2 MiB per image and 8 MiB per request. Directory export reads and writes one image at a time; each index entry records an `omitted` reason for unavailable or over-budget data. Inline output keeps the first 20 images with the same reasons and byte budgets. `frameHtml` reads the current document after `frame` routing.

#### Screenshots

Use `clip` for a coordinate region, `compareWith` for a PNG baseline and `diffOutput` for a PNG difference image. `diffOutput` requires `compareWith`. An unmatched, out-of-range or zero-sized target returns a target error. Responses contain `metadata.format`, `width`, `height`, `dimensionSource`, `byteSize`, `fullPage`, `scale`, `clip` and `capabilities`.

Capture limits are 16,384 pixels per side, 12,000,000 pixels total, 48 MiB estimated RGBA memory and 25 MiB encoded data. PNG baselines are checked before reading. Comparison limits each PNG to 25 MiB and 12,000,000 pixels; inflate output and scanline lengths must match the validated dimensions. Malformed or expansion-heavy PNGs are rejected. Use `clip` or `scale` for larger captures.

Screenshot and diagnostic-bundle capabilities report `hiddenTabScreenshot=false` in both backends. A hidden Extension tab returns `HIDDEN_TAB_SCREENSHOT`. Full-page capture preserves viewport and device emulation. If another debugger blocks precise capture, viewport fallback reports `metadata.degraded`, `metadata.fallback` and `metadata.limitations` in inline and file output. A window-level capture is discarded when the active tab changes, including A-to-B-to-A. Unsupported fallback options return `SCREENSHOT_FALLBACK_UNSUPPORTED`.

#### State and metadata

`state` returns `interactiveElements`. Both backends return metadata `frames` and the actual document `url`; Extension `frame` routing returns the selected document's URL. Unavailable declared CDP frame fields remain `null`, including DOM selectors and owner rectangles. Frame-tree order and IDs are preserved.

Metadata includes current `managed` state and `createdBy`, `createdAt`, `lastUsedAt`, `taskHint` and `note`, matching `browse list` and `manage pageMetadata` in both inline and file output. Notes belong to the page even when `frame` selects an iframe document. Extension preserves creation records, notes and trusted group relationships across Server and Extension reloads, checking live identity during restoration. CDP notes belong to the current Server process. Unknown provenance stays `unknown`; notes grant no access or cross-session ownership. CDP returns `managed=false` while retaining normal operations through its connection.

Page selection uses `targetId` or legacy `tabId`; `frame` selects a child or nested document in either backend.

**`attribute` special prefix**: `computed:<property>` returns the computed CSS style value (e.g. `computed:color`,
`computed:font-size`). Use `computed:*` to return all computed style properties as JSON (returns 300+ properties — use
`output` to save to file).

`extract.timeout` is the overall browser-operation budget in milliseconds (default 30000), including queueing,
page/frame preparation, target waiting, content reads, and page-context metadata. Each RPC uses the remaining budget;
`state` does not start a separate 30-second wait. An unconfirmed dispatched request returns unknown and is not replayed.

**`state`-specific**: `depth` controls accessibility-tree traversal depth (default 15). Reduce it to limit response size
on large pages. `mode` selects `accessibility` (default, derived from the a11y tree) or `domsnapshot` (raw
`DOMSnapshot.captureSnapshot`, available through CDP or a managed Extension page). DOMSnapshot captures the whole page
and rejects `target`, `frame`, and `depth`. Ordinary read grants cover accessibility state; Extension DOMSnapshot requires full managed access to use the debugger.
Unavailable sibling iframe probes are listed in metadata as `unavailableFrames` and per-frame
`unavailableReason`; a uniquely verified selected iframe remains usable.

`target` restricts accessibility state to the selected element and its descendants in both backends. `depth` is relative to that subtree.

Accessibility state does not read hidden/password/file input value getters for element names or state text, including default `all`, subtrees and file output. Hidden controls retain their labels and `visible=false`. Labels, placeholders and titles provide names; ordinary inputs retain current values separately in `value` and `pageContent`, including named inputs. Submit labels retain their full text. Explicit script, HTML and attribute reads keep their existing behavior.

### wait - Wait for Conditions

| For          | Description                                         |
| ------------ | --------------------------------------------------- |
| `element`    | Wait for element (visible/hidden/attached/detached) |
| `navigation` | Wait for navigation complete                        |
| `time`       | Fixed delay                                         |
| `idle`       | Wait for DOM or network quiet period                |

Parameters: `targetId` (or `tabId`) selects a page in either backend; `frame` selects a child document or nested path in either backend.

In CDP mode, `visible` requires a nonzero DOM rectangle and CSS that does not hide the element (`display:none` or
`visibility:hidden/collapse`). `hidden` accepts these hidden states or a missing element; `attached` and `detached` only
check whether the element exists.

**`idle`-specific**: In Extension mode, after `readyState === 'complete'`, it injects a `MutationObserver` and waits for
a quiet period with no DOM changes. In CDP mode, it waits for network quiet instead. `ms` controls the relevant quiet
period (default 500ms). The response returns `idleKind` and `idlePeriodMs`; Extension responses also return `domStable`.

CDP idle includes requests already in flight. Independent idle and same-document `networkidle` exclude Worker requests with an empty `loaderId`, whose terminal events can be absent from the page session; page Fetch and Script requests remain pending until completion.

### evaluate - JavaScript Execution

Execute JavaScript in page context.

- `script`: JavaScript code. Bare `return` statements are wrapped in IIFE
- `scriptFile`: Read code from a local file instead of `script`
- `args`: Function arguments; `[]` invokes a zero-argument function, omission evaluates the script as written
- `mode`: `precise` (default, debugger API) or `stealth` (JS injection)
- `staleContextRetry`: iframe stale-context policy: `never` (default) or `readOnly`
- `output`: Save the result to a file
- `targetId` / `tabId`: Select a page in either backend (`tabId` is an alias)
- `frame`: Target a child iframe by CSS selector/index, or use a nested path such as `["#outer", 0]` in either backend
- `timeout`: End-to-end budget (ms)
- `diagnostics`: Return new console warnings/errors and failed requests after execution
- `postCondition`: Wait for text, selector, URL fragment, or script result after execution

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
returned. With a post-condition, `verificationStatus` distinguishes `matched`, `not_matched`, `unavailable` and `error`, with the last observed checks. A completed script keeps `actionStatus="completed"` and top-level `retryable=false`; `postCondition.retryable` applies only to an independent verification read. Precise iframe evaluation does not replay a script after a stale execution context by default. Set
`staleContextRetry="readOnly"` only when the script has no side effects; the Extension may then resolve a new context
and replay it once within the remaining timeout budget. If Chrome still reports the removed document while resolving
that retry, the Extension waits for the current document within the same budget; this does not add script executions.
Permission failures stop immediately. CDP iframe execution supports `never`; requesting `readOnly` returns
`DRIVER_CAPABILITY_ERROR` with `actionExecuted=false` and `actionStatus="not_started"` before script dispatch.
A stale-context error after `Runtime.evaluate` reports `actionExecuted=true`, `actionStatus="unknown"` and
`retryable=false` in both backends, because earlier side effects may already have happened even though the final
result is unavailable. CDP preserves its native `CDP_ERROR`.

The total evaluate timeout also limits post-condition checks. If it expires after the action completes, the action stays completed and verification returns unavailable. A queue timeout before script dispatch preserves `actionExecuted=false` and the queue stage; a dispatched script with an unknown acknowledgement stays unknown. Read the page independently to determine its effects.

For object results in the main frame with Extension precise mode, an explicit `output` uses a 16 Mi (16777216) character
budget. Without `output`, the 1000000-character budget still applies, including automatic saving. Both paths retain the
depth limit of 8, the 2000-node budget, and non-serializable result rejection. The character budget counts UTF-16 code
units, not the output file's UTF-8 bytes; `tmp:` files also remain subject to the temporary output quota. Exceeding a
result limit reports the current limit and the completed script's output failure without replaying it.

Absolute `scriptFile` and `output` paths must resolve inside the Server working directory or this Server session's controlled temporary directory. The operating system's whole temp directory and Downloads are not automatic allowed roots. `PATH_NOT_ALLOWED` reports the actual `error.context.allowedRoots`; use `cwd:` or `tmp:` paths within them.

Responses include the stale-context policy, `retryAttempted`, bounded `retryReason` and the final `frameContext`: Extension frame, parent frame, URL, CDP frame and execution-context IDs. Same-URL frames are rejected only when the selected DOM iframe cannot identify one target. Existing iframe targets remain usable after an Extension reload without refreshing or navigating the page. Invalidated probe contexts report a warning and stop listening.

Sibling frames still loading do not delay selection of an available iframe. Background-page timer throttling does not extend the frame-probe wait. Cancellation or timeout before script dispatch releases the probes and leaves that script unexecuted.

A trusted Function-compilation policy rejection reports `CSP_BLOCKED` with the script not executed. Page `throw` or Promise rejection keeps its original error and executed state even when the text contains `CSP`, `Content Security Policy` or `unsafe-eval`.

### manage - Page & Environment Management

| Action             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `newPage`          | Create new controlled page/tab                                           |
| `pageMetadata`     | Read or update per-page `taskHint` and `note`                            |
| `closePage`        | Close page and return `affected.before/after` in Extension and CDP modes |
| `adoptPage`        | Grant full controlled-page access without focusing it                    |
| `releasePage`      | Remove a controlled tab from management without closing it               |
| `grantReadAccess`  | Grant ordinary reads for an explicit page to the calling instance        |
| `revokeReadAccess` | Revoke that instance's ordinary read grant                               |
| `updatePage`       | Update native tab properties and return actual state                     |
| `movePage`         | Move a controlled tab to another window or index                         |
| `reorderPage`      | Reorder a controlled tab inside its window                               |
| `pinPage`          | Pin a controlled tab                                                     |
| `unpinPage`        | Unpin a controlled tab                                                   |
| `activatePage`     | Activate an explicit page; Extension requires a controlled tab           |
| `focusWindow`      | Focus an explicit window                                                 |
| `resizeWindow`     | Resize or change state for an explicit window                            |
| `newWindow`        | Create a new controlled window                                           |
| `closeWindow`      | Close a window only when all tabs are managed                            |
| `updateWindow`     | Update native window position, state, focus or attention                 |
| `groupPages`       | Create a group or add controlled tabs to an existing group               |
| `ungroupPages`     | Remove controlled tabs from groups without releasing them                |
| `updateGroup`      | Update group title, color and collapsed state                            |
| `moveGroup`        | Move a group and its tabs to a window or index                           |
| `clearCache`       | Clear cache/storage (use `cookies` tool to clear cookies)                |
| `viewport`         | Set viewport size                                                        |
| `userAgent`        | Set User-Agent                                                           |
| `emulate`          | Device emulation (iPhone, iPad, etc.)                                    |
| `inputMode`        | Query or set input mode (`precise` / `stealth`)                          |
| `stealth`          | Inject anti-detection scripts                                            |
| `cdp`              | Send raw CDP command (advanced, e.g. `Runtime.evaluate`)                 |
| `dialog`           | Observe or handle dialogs                                                |
| `networkCapture`   | Start or stop original request/body/stream collection                    |
| `route`            | Match and resolve paused requests                                        |
| `httpAuth`         | Set or clear scoped HTTP challenge credentials                           |
| `download`         | Observe, wait for, and save an original download                         |

Native tab/window/group configuration uses Extension mode; `activatePage` also supports CDP. Mutations identify their
existing targets with `targetId`, `targetIds`, `windowId`, or `groupId` and return `affected.before/after`. Group
results also include `tabsBefore/tabsAfter`; `ungroupPages` removes an empty group through Chrome without revoking the
tabs' managed state. Window display changes and group title/color/collapse updates use the explicit `windowId` or
`groupId`, including containers with unmanaged members. They do not grant page permissions. Group moves and window
closure still require every affected member to be managed. Grouping or ungrouping selected pages checks those pages;
unrelated sibling changes do not invalidate a valid selection. Default page creation uses an existing normal
window in the background, including windows with unmanaged tabs. `clearCache` is unavailable in Extension mode
and returns `UNSUPPORTED_MODE`
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

#### `newPage`

Parameters: `url`, `windowId`, `index`, `active`, `pinned`, `openerTabId`, `groupId`, `timeout`, `taskHint`,
`note`

`active` defaults to false; `groupId=-1` disables grouping; explicit placement is not changed by the default
visual group

#### `updatePage`

Parameters: `url`, `active`, `pinned`, `highlighted`, `muted`, `autoDiscardable`, `openerTabId`

Requires `targetId`; only `active=true` is supported and does not focus the window; `active=false` is rejected
before any update

#### `groupPages`

Parameters: `targetIds`, `groupId`, `windowId`, `title`, `color`, `collapsed`

Omit `groupId` to create a group in the members' window; mixed-window members require `windowId`; joining an
existing group accepts only `targetIds/groupId`

#### `ungroupPages`

Parameters: `targetIds`

Removes group membership and retains controlled-page access

#### `updateGroup`

Parameters: `groupId`, `title`, `color`, `collapsed`

An empty title and false collapsed value are applied as supplied

#### `moveGroup`

Parameters: `groupId`, `windowId`, `index`

Moves all members; `index=-1` means the end of the window

#### `newWindow`

Parameters: `url` or `urls`, `targetId`, `windowType`, `focused`, `incognito`, `left`, `top`, `width`,
`height`, `windowState`, `setSelfAsOpener`

`normal` supports multiple URL tabs and an existing controlled tab; `popup` accepts only one page; created
tabs are managed with distinct provenance

#### `updateWindow` / `resizeWindow`

Parameters: `windowId`, `left`, `top`, `width`, `height`, `windowState`, `focused`, `drawAttention`

Applies supported Chrome window properties and returns observed state

`updateWindow` and `resizeWindow` wait for a stable browser observation when changing state or geometry. Restoring a
non-normal window with `windowState="normal"` and bounds completes the state transition before applying bounds once.
OS-adjusted geometry is returned as observed. If observation does not stabilize within the bounded wait,
`WINDOW_UPDATE_NOT_OBSERVED` reports partial execution and the last observed window state; inspect `browse list` before
another update. If Chrome rejects bounds outside visible screen space, use coordinates and dimensions within the
screen's available area; the response preserves the bounds error without page-activation guidance.

`browse list` defaults to `details="summary"`, returning target identity, URL/title, placement, managed/revision and
metadata. Set `details="full"` for highlighted/muted/discardable state, opener IDs and available native readonly
properties. False values are preserved. `targetIds` and `managedOnly=true` filter pages and their window/group
relations; `totalTargetCount`, `totalWindowCount` and `totalTabCount` distinguish inventory totals from selected counts.
Window objects reference pages through `targetIds` rather than repeating full targets. Inline favicon data URLs are
omitted; full details use `favIconInline=true` to indicate one exists. Groups retain title, color, collapsed/shared
state, window, first-member index and member IDs. Color belongs to a group, not a tab. Readonly properties are returned
when Chrome supplies them, not accepted as configuration writes. Listing does not read page content, navigate or focus.

Older Extensions that return group summaries without member arrays use the same response's window/tab membership to
populate group members and first-member index. Summary/full details and filters remain available without another RPC. If
group information is absent entirely, `groups` is omitted with a warning that it is unavailable. A supplied `groups: []`
means no groups. Malformed group data, including only one member array, returns an error.

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

Management operations share a 30000 ms request deadline; `newPage` uses a supplied `timeout`. An expired queued change is rejected before dispatch. Unconditional `pageMetadata` reads, updates and clears use the explicit target independently of a long page action, including on the same page. Each request keeps its own URL/revision conditions. URL/revision-conditioned metadata keeps serialized condition checking.

Group operations serialize with page release and recheck native membership and managed authority under the affected page locks. Page creation uses `active`; `activate` is accepted only by `movePage`.

### Browser events and original files

Prepare observation before clicking a download link, opening a dialog, or making a request. Use the returned `ref` to
read or handle that exact event. These actions use the controlled page selected by `targetId` or the current default.
A reference retains its original page even after the default target changes.

| `manage` action  | Nested command                                                  | Result                                                                            |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `dialog`         | `dialog:{op:"watch"\|"stop"\|"accept"\|"dismiss",ref?,text?}`   | Observe dialogs or handle one observed dialog; `text` supplies a prompt answer    |
| `networkCapture` | `capture:{op:"start"\|"stop",include?:["body","stream"]}`       | Record original requests, optional bodies, and WebSocket/SSE messages             |
| `route`          | `route:{op:"add"\|"remove"\|"continue"\|"fulfill"\|"fail",...}` | Match page requests or handle an observed paused request                          |
| `httpAuth`       | `auth:{op:"set"\|"clear",...}`                                  | Configure credentials for an explicit Server/Proxy challenge scope                |
| `download`       | `download:{op:"watch"\|"stop"\|"wait"\|"save",...}`             | Identify a download, wait for its native state, and save available original bytes |

#### Handle a dialog

```text
manage(action="dialog", targetId="PAGE_ID", dialog={op:"watch"})
input(targetId="PAGE_ID", events=[{type:"click", target:{css:"#show-prompt"}}])
logs(type="dialog", targetId="PAGE_ID")
manage(action="dialog", dialog={op:"accept", ref:"DIALOG_REF", text:"Answer"})
```

A blocking dialog returns `DIALOG_OPEN` and its reference. Handle it, then check the original action's result. Dialog
reads and handling remain available while that original request is blocked. `dismiss` omits `text`; `stop` ends
observation. Log reads leave the dialog unchanged.

#### Read the original response

```text
manage(action="networkCapture", targetId="PAGE_ID", capture={op:"start", include:["body","stream"]})
logs(type="network", targetId="PAGE_ID", view="details")
logs(type="network", view="responseBody", ref="REQUEST_REF", output="tmp:response.bin")
```

`details` retains request identity, redirect hop, base headers, ExtraInfo headers, and their completeness.
`requestBody` reads original POST data; `responseBody` reads the protocol-provided entity body. An explicit `output`
saves decoded bytes. Inline bodies use `{encoding:"utf8"|"base64",data}`. Unavailable or evicted bodies return an
error; multipart file parts and redirect bodies depend on native protocol availability. A body must be below 16 MiB.
Headers, Cookie metadata copies such as `cookieLine`, and credential URL fields are redacted. URL-bearing headers such as `Location`, `Content-Location` and `Referer` also redact user information and sensitive query values in structured metadata and raw handshake header text; explicitly requested body content retains its bytes.

`view="stream"` returns WebSocket directions/opcodes and SSE messages in observed order. Inspect truncation, `dropped`
and `evicted` fields when consuming bounded buffers. Use `capture:{op:"stop"}` to end collection.

#### Continue or mock a matched request

Add a route with `urlPattern` and optional `stage:"Request"|"Response"`. Read `logs(type="network",view="paused")`,
then handle the returned paused-request reference:

```text
manage(action="route", targetId="PAGE_ID", route={op:"add", urlPattern:"https://example.com/api/*"})
logs(type="network", targetId="PAGE_ID", view="paused")
manage(action="route", route={op:"fulfill", ref:"PAUSED_REF", response:{status:200, body:{encoding:"utf8",data:"mock"}}})
```

`continue` accepts optional `request:{url?,method?,headers?,body?}`; headers are `{name,value}` arrays. `fulfill`
requires `response:{status,statusText?,headers?,body?}`. `fail` accepts a native `errorReason`, defaulting to `Aborted`.
Remove a rule with `op:"remove"` and its rule reference. Unmatched requests continue immediately. Matched pauses expire
after 30 seconds; cancellation, navigation, release or owner disconnection aborts unresolved requests. A native
acknowledgement loss retains an unknown result and is not automatically resent. `clear` clears readable records while
active pauses and dialogs keep their handling references. Raw `manage cdp` Fetch commands share this ownership and cleanup.

For HTTP authentication, set `auth:{op:"set",scope:{source:"Server"|"Proxy",origin,realm?},username,password}`.
Credentials stay in memory for that page and exact challenge scope. Failed repeat challenges are canceled. Read
`logs(type="network",view="auth")` for redacted status, and use `auth:{op:"clear"}` to remove credentials.

#### Save a download

```text
manage(action="download", targetId="PAGE_ID", download={op:"watch",urlPattern:"https://example.com/files/*"})
input(targetId="PAGE_ID", events=[{type:"click",target:{css:"a.download"}}])
logs(type="download", targetId="PAGE_ID")
manage(action="download", download={op:"wait",ref:"DOWNLOAD_REF",timeout:30000})
manage(action="download", download={op:"save",ref:"DOWNLOAD_REF",output:"tmp:attachment.bin"})
```

The native download GUID and state distinguish completion from file availability. `save` requires a completed download
with `artifact="available"`; it writes the captured original response without making another HTTP request. Native Save
As, blob downloads or browser security restrictions can leave the file unavailable, with the reason reported.
Shared-browser download policy remains unchanged. This capture path uses the same below-16-MiB body budget.
`download:{op:"stop"}` ends observation and releases its interception.

References are bound to the server instance, page and connection generation. Stale or foreign references are rejected.
Cloudflare handling ends current Fetch control and suspends these observations before detaching the debugger; inspect
the returned `browserEvents` status and explicitly start observation again after verification. New event actions require
matching Server and Extension builds; missing native capabilities are reported before enabling interception.
CDP authentication and response capture remain active after the connection request finishes. Each later tool call uses its own timeout and cancellation signal.

`cleanupFailures` retains the existing string array. The parallel `cleanupFailureDetails` records timestamp, phase, observed ref or request ID, target, owner and session generation. Each controller retains at most 20 failures and clears them when disposed. A new controller starts empty; details already returned retain their original ownership.

### logs - Browser Logs

| Type       | Description                                                                |
| ---------- | -------------------------------------------------------------------------- |
| `console`  | Console logs (with level filter)                                           |
| `network`  | Request summary, details, bodies, paused requests, auth or stream messages |
| `dialog`   | Observed dialog references and pending/closed state                        |
| `download` | Native download state and original-file availability                       |

Parameters: `output` saves result to file. Console entries use the public levels `error`, `warning`, `info`, and
`debug`; raw browser levels such as `warn` and `log` are normalized before filtering and return. Clearing fallback
console logs keeps the hook active. When debugger collection becomes available, fallback capture is disabled. Console
methods still pointing to the MCP wrapper are restored, while wrappers installed later by the page are preserved.
Independent fallback console calls retain their levels and frequency even when their timestamp and text are identical;
reading the same drained batch again does not append it again. Switching to debugger collection preserves pending calls once, without adding their Runtime history replay a second time or restoring cleared fallback calls. The buffer retains the latest 1000 entries.
Network logs are finalized on `loadingFinished` or `loadingFailed`, not when headers arrive, so body failures retain
both the HTTP status and `errorText`, and in-flight bodies continue to count against `networkidle`. Entries include
`method`, `url`, `status`, `timestamp`, and `duration` when available. URL query parameters commonly used for
credentials, signatures, passwords, and tokens are replaced with `[REDACTED]` in inline responses, diagnostics, and
explicit `output` files. Redacted entries include `urlRedacted`, `urlOriginalLength`, and `redactedQueryParameters`.
Inline network results limit each sanitized URL to 2048 characters and add `urlLength` plus `urlTruncated: true` when
shortened. `urlPattern` supports `*` for any number of characters and `?` for one character. `tabId` targets a specific
tab (Extension mode). `frame` is not applicable for logs.
In network views, `urlPattern` filters each request's URL, including paused requests and authentication events, before applying `limit`. `clear` preserves requests that still need handling.

When the Extension debugger is unavailable, network reads refresh performance entries and mark them with
`source="performance"`. Status uses the browser's `responseStatus` when available, or `0` otherwise; unknown request
methods remain empty. Repeated reads preserve record sequences. `clear` clears MCP records and advances the current
document's read boundary without clearing the page's shared performance timeline. A new document starts a new boundary.
Read failures return an error rather than an empty log.

CDP network logs keep the HTTP status when a response body fails and record one terminal entry per request. Temporary page selection preserves each target's log buffer. Clearing logs removes buffered entries while keeping in-flight requests until their final event, so a request completed after clearing appears in the new log.

### cookies - Cookie Management

| Action   | Description                                                            |
| -------- | ---------------------------------------------------------------------- |
| `get`    | Get cookies                                                            |
| `set`    | Set cookie                                                             |
| `delete` | Delete cookie                                                          |
| `clear`  | Delete cookies in a URL or domain scope, optionally narrowed by `name` |

All actions accept `targetId`, `partitionKey:{topLevelSite?,hasCrossSiteAncestor?}`, and a backend-specific store scope:
`storeId` for Extension or `browserContextId` for CDP. Extension resolves a supplied target to its native CookieStore
and rejects a conflicting store. Unsupported backend scope fields return an error. Without these fields, existing
URL/domain behavior remains unchanged. `get` requires at least one nonblank `name`, `domain`, or `url`; storage scopes and flags only narrow that explicit filter, including when exporting to a file.

URL path matching uses Cookie path boundaries in target and browser-context scopes too: a Cookie at `/app` matches `/app/info` and is excluded for `/apple/info`.

`clear` requires `url` or `domain`, with optional `name` to narrow the range. CDP preserves each selected Cookie's exact name, raw domain, path, partition and browser context for deletion. An omitted target is fixed to the current page's storage context when clear starts. An unserializable partition identity is rejected before deletion.

For CDP clear, `count` records identities present at the immediate precheck and absent after an acknowledged deletion request; `countSemantics="observed_present_then_absent"` identifies this state comparison. `acknowledged` counts native ACKs, `alreadyAbsent` counts identities missing at the precheck, and `matched` and `attempted` describe the selected candidates and started deletion steps. Concurrent page changes can occur between observations. Extension retains its native removal-confirmation count.

CDP stops at the first deletion, verification or cleanup failure and returns `COOKIE_CLEAR_PARTIAL` with the known count, ACKs, failed or unknown steps, unprocessed candidates, phase and original cause. Its action state preserves earlier changes and `retryable=false`; a session-detach failure retains the preceding ACK and any verified disappearance.

A delete sent without an ACK counts as `unknown` when the connection closes, is explicitly closed, times out or is cancelled. The first unknown step reports `actionStatus="unknown"`; earlier ACKs keep the action `partial`. `failed` counts explicitly rejected or undispatched deletion steps and identities still present after an ACK. Unclassified errors after a deletion attempt remain unknown, and later deletions stop.

MCP cancellation stops queued Cookie actions, connection waits and later deletions in both backends. CDP retains prior confirmed progress and an unacknowledged deletion's unknown result. A cancelled or timed-out temporary attach retains responsibility for its native response: a late successful session is detached with an independent 1000 ms budget. Cleanup failure is logged with the command and session identity and remains tracked until the connection closes; no deletion is replayed. An Extension RPC cancelled before its reply reports an unknown RPC result; the Extension stops its remaining native removals once the in-flight call settles.

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

### Nested frame operations

Both backends resolve iframe selectors and indices through open ShadowRoots. Cross-origin and OOPIF frame preparation uses the original request deadline; a timeout before script dispatch reports `actionExecuted=false` and `actionStatus="not_started"` and attempts to restore the previous target.

```
// Target iframe by CSS selector
evaluate(script="document.title", frame="iframe#main")

// Target iframe by index
extract(type="text", frame=0)

// Resolve each step relative to the selected parent, including OOPIFs in CDP
evaluate(script="document.title", frame=["iframe#outer", "iframe#inner"])

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
- **iframe**: Nested selection uses a selector/index array; XPath keeps its native document scope

## Compatible Clients

| Client                    | Status |
| ------------------------- | ------ |
| Claude Code               | ✅     |
| Claude Desktop            | ✅     |
| Cursor                    | ✅     |
| Windsurf                  | ✅     |
| Any MCP-compatible client | ✅     |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP documentation

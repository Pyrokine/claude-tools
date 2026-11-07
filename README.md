# claude-tools

[中文](./README_zh.md)

MCP servers and skills for Claude Code.

## Tools

| Tool                   | Type       | Description                                                                   |
| ---------------------- | ---------- | ----------------------------------------------------------------------------- |
| [mcp-claude-history]   | MCP Server | Search, inspect, and export conversation history                              |
| [mcp-chrome]           | MCP Server | Chrome browser automation through Extension or CDP                            |
| [mcp-ssh]              | MCP Server | SSH connections, command execution, and file transfers                        |
| [skill-cc-session-fix] | Skill      | Diagnose and repair session JSONL files for resume failures and wrong anchors |
| [skill-elenchus]       | Skill      | Evidence-led diff, snapshot and design review; bounded independent analysis   |

[mcp-claude-history]: ./mcp-claude-history
[mcp-chrome]: ./mcp-chrome
[mcp-ssh]: ./mcp-ssh
[skill-cc-session-fix]: ./skill-cc-session-fix
[skill-elenchus]: ./skill-elenchus

## Installation

The TypeScript MCP servers require Node.js 20.19 or newer. Build the history server with Rust 1.88 or newer, or use a
prebuilt release binary.

### mcp-ssh

```bash
npm install -g @pyrokine/mcp-ssh
claude mcp add ssh -- mcp-ssh
```

### mcp-chrome

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

For Extension mode, open `chrome://extensions/`, enable Developer mode, click "Load unpacked", and select
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`.

### mcp-claude-history

Download a binary from [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases), place it on `PATH`, and
configure Claude Code:

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

Each subdirectory README includes source build instructions and client-specific JSON configuration.

## Module versions

- mcp-claude-history 2.2.0: Session titles, exact large-history search, paged source catalogs, full-content exports,
  precise source recovery, and private output bundles

- mcp-chrome 3.1.0: Local file uploads, hidden-field value protection, middle-button events, focus-only editing
  commands, task page controls, Cloudflare completion checks, open Shadow DOM and nested frames, browser dialogs,
  original response/download capture, request routing, scoped HTTP authentication, and WebSocket/SSE observation

- mcp-ssh 3.2.0: Interpreter arguments and transfer progress, with OpenSSH master reuse, explicit file verification,
  filtered directory pages, and SFTP/output corrections

- skill-elenchus 1.2.0: Diff, snapshot and design scopes, evidence levels, and shared review budgets

Use `taskHint` and `note` when creating a Chrome task page. Extension task groups retain their names and creation
records across reloads; list existing pages before creating another. Default page creation uses an existing window in
the background. At task end, close only pages created for that task and explicitly intended to be temporary; retain
user pages and reusable output.

Use `input` with `{type:"upload", target:{css:"input[type=file]"}, files:["./review.zip"]}` to select local files in
Extension or CDP mode. Paths belong to the MCP Server machine; `files:[]` clears the selection. The combined file
size must be below 50 MiB. See the [upload examples](./mcp-chrome/README.md#upload-local-files) for site verification.

Use `manage` to prepare dialog, download or network observation, then use the references returned by `logs` to handle
that dialog, save the original attachment, or read the same request's body. Request routing and HTTP authentication
stay scoped to the controlled page. See [browser events](./mcp-chrome/README.md#browser-events-and-original-files).

OpenSSH reuse is opt-in with `ssh_connect(backend="openssh", configHost="myserver")`. The default ssh2 backend uses
known-host records: an unknown host is recorded before authentication, while a changed or revoked key is rejected.
Pre-provision a trusted record when the first connection requires an independently verified identity.
`ssh_sync(verify={sha256: true})` verifies a regular file as well as a directory, with separate transfer and
verification results. `ssh_list_dir` supports name/time filters and explicit item/byte budgets, without truncating
internal synchronization listings. Use `history_search(mode="sources")` to page source groups before scanning, and
`output_content="full"` to export text independently of response previews. See the module READMEs for limits and failure
behavior.

## Major-version migration

Module versions are independent of the repository release tag.

- **mcp-chrome 3.0**: `manage(action="closePage")` requires `targetId`. Use `grantReadAccess` for ordinary reads of user
  pages, or `adoptPage` for authorized changes; explicit adopt grants full managed access, while `targetId` alone does
  not. Native page/window/group
  configuration and group membership/state are available through `manage` and `browse list`. Relative output paths use
  session-owned `tmp:` storage; use `cwd:` for persistent output.
- **mcp-ssh 3.0**: `maxOutputSize` and PTY `bufferSize` measure raw UTF-8 bytes. Apply byte budgets when consuming
  output and inspect truncation metadata. PTY raw reads report counters before clearing the buffer.
- **mcp-claude-history 2.0**: Exports use unique bundle directories and manifest v2. Read the actual paths returned by
  the tool instead of assuming that `output` is a single file. `max_total` limits the UTF-8 bytes of the final compact
  JSON response. Use `history_search(mode="scan")` and its process-bound `next_query` to traverse full source sets, then
  read and release `history_scan_metadata`. Normal search retains sorting, UUID de-duplication, regex, and slice. Exact
  `source` disambiguates duplicates; legal oversized records use indexed search, while regex bodies exceeding the limit
  explicitly report incomplete coverage.

See the module READMEs for parameter contracts and migration examples.

## Review and validation

`/elenchus mode=full .` reviews the repository snapshot even when there is no diff; `mode=diff` retains change review,
and `mode=design` assesses a proposal. Reports distinguish runtime evidence, source support and conditions needing
validation. See [Elenchus](./skill-elenchus) for coverage records and shared review budgets.

The [cross-platform workflow](./.github/workflows/windows-tests.yml) checks Ubuntu, Windows and macOS, including Node.js
20.19.0, Rust 1.88 and the Python session-repair fixtures. Release and npm authentication jobs require these checks for
the same workflow commit. This automated gate complements the module regression guides and current release
authorization.

## npm publishing for maintainers

The default npm release path is the [npm Trusted Publishing workflow](./.github/workflows/npm-publish.yml) on GitHub
Actions. GitHub obtains short-lived npm credentials through OIDC for each run, so this path requires no manual creation,
renewal, or pasting of npm tokens. Expiry of a local npm token does not affect it.

Trusted Publisher connections are already configured separately for `@pyrokine/mcp-chrome` and `@pyrokine/mcp-ssh`,
using GitHub owner `Pyrokine`, repository `claude-tools`, workflow filename `npm-publish.yml`, and environment
`npm-publish`. The connections and environment binding are one-time setup; maintain them only when their configuration
changes. Allow direct publishing; separate dist-tag management permission is not required. The GitHub environment must
restrict deployments to the `main` branch.

Run the workflow from `main` and set `expected_commit` to its approved full commit SHA. Both `publish_chrome` and
`publish_ssh` default to `false`: this builds and checks both packages and verifies their GitHub-to-npm OIDC token
exchange without publishing a version. No `NPM_TOKEN` secret is required. Build jobs have no OIDC publishing permission;
authentication jobs verify the packaged artifacts and do not run package lifecycle scripts.

To validate without publishing, replace `APPROVED_FULL_SHA` with the approved full SHA and run:

```bash
gh workflow run npm-publish.yml \
  --repo Pyrokine/claude-tools \
  --ref main \
  -f expected_commit=APPROVED_FULL_SHA \
  -f publish_chrome=false \
  -f publish_ssh=false
```

Publishing directly with a local `npm publish` is a separate operation requiring explicit authorization and local npm
authentication.

For a release, complete the module regression guides, package review, and the current release authorization first. Then
enable only the publishing switches for the approved packages. The workflow publishes the checked tarballs, verifies
registry `gitHead`, integrity, and `latest`, and does not create a repository tag or GitHub Release. Create the
repository release tag only after npm publishing and its verification have completed. If publishing or registry
verification fails, inspect the existing registry version before retrying; a failed workflow does not prove that nothing
was published.

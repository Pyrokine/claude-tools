# claude-tools

[中文](./README_zh.md)

MCP servers and skills for Claude Code.

## Tools

| Tool                                           | Type       | Description                                                                   |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| [mcp-claude-history](./mcp-claude-history)     | MCP Server | Search, inspect, and export conversation history                              |
| [mcp-chrome](./mcp-chrome)                     | MCP Server | Chrome browser automation through Extension or CDP                            |
| [mcp-ssh](./mcp-ssh)                           | MCP Server | SSH connections, command execution, and file transfers                        |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill      | Diagnose and repair session JSONL files for resume failures and wrong anchors |
| [skill-elenchus](./skill-elenchus)             | Skill      | Multi-perspective dialectical analysis for code review and reasoning          |

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

| Module             | Version | Changes                                                                                                                                                                                |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mcp-claude-history | 2.1.1   | Indexed large-record search, paged source catalogs, full-content exports, precise source recovery, and Windows history-path/private-export fixes                                                                                  |
| mcp-chrome         | 3.0.1   | Hidden-field value protection, middle-button events, focus-only editing commands, target/frame/deadline corrections, action-scoped window/group controls, and backend capability fixes |
| mcp-ssh            | 3.1.0   | Existing OpenSSH master reuse, explicit file verification, filtered directory pages, and SFTP/output corrections                                                                       |

OpenSSH reuse is opt-in with `ssh_connect(backend="openssh", configHost="myserver")`; default ssh2 behavior remains.
`ssh_sync(verify={sha256: true})` verifies a regular file as well as a directory, with separate transfer and
verification results. `ssh_list_dir` supports name/time filters and explicit item/byte budgets, without truncating
internal synchronization listings. Use `history_search(mode="sources")` to page source groups before scanning, and
`output_content="full"` to export text independently of response previews. See the module READMEs for limits and failure
behavior.

## Major-version migration

Module versions are independent of the repository release tag.

- **mcp-chrome 3.0**: `manage(action="closePage")` requires `targetId`. Adopt existing browser tabs before operating on
  them; explicit adopt grants full managed access, while `targetId` alone does not. Native page/window/group
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

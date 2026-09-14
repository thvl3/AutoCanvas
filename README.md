# Canvas Academic MCP

A local Canvas LMS cache, CLI and MCP server for academic planning. It retrieves assignment instructions, rubrics, module readings, feedback and deadlines, then exposes them as structured context.

Normal use relies on your existing Canvas browser login. No Canvas personal access token, copied cookie, password or SSO credential is required. The browser extension is a narrow read-only data channel, not an agent. The application does not complete or submit assignments, post discussions, mark attendance or change course content.

## Requirements

- Node.js 22.12+, pnpm 9.15.9
- Firefox or a Chromium browser with an authenticated Canvas tab
- Linux, macOS, or Windows. Workspace creation uses descriptor-relative traversal on Linux/macOS and a documented path walk on Windows; no `/proc` or WSL is required.
- A C/C++ build toolchain and Python 3 if SQLite's native binding needs compilation

## Setup

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm extension:build
cp .env.example .env
```

Set `CANVAS_BASE_URL` to your Canvas HTTPS origin. `CANVAS_PROVIDER=browser` is the default. Leave your authenticated Canvas tab open. Passwords, MFA and SSO stay in the browser.

Start the local bridge and keep it running:

```sh
node dist/cli/index.js bridge start
```

The bridge listens only on `127.0.0.1:47821` and prints an expiring pairing code. Do not open the bridge to the LAN.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select Load Temporary Add-on and choose `browser-extension/dist-firefox/manifest.json`.
3. Open the extension's options, confirm the Canvas origin and bridge port, and enter the pairing code.
4. Grant access only to the configured Canvas origin.

Firefox temporary add-ons are development installations and must be reloaded after a browser restart. Permanent standard-Firefox installation requires a Mozilla-signed package; no signing account is bundled with this repository. Once installed, bridge reconnects do not need another Canvas login or cookie export.

### Chrome / Edge / Chromium

Open the browser's extensions page, enable Developer mode, choose Load unpacked and select `browser-extension/dist`. Open the extension options and pair as above. Unpacked Chromium installations persist across ordinary browser restarts.

### Windows browser with the app in WSL

You can keep Canvas open in your normal Windows browser. Windows-to-WSL localhost forwarding lets the extension reach the loopback bridge; you do not need a WSL desktop or remote desktop server.

For an Ubuntu WSL checkout at `/home/thule/AutoCanvas`, Firefox's file picker can use:

```text
\\wsl.localhost\Ubuntu\home\thule\AutoCanvas\browser-extension\dist-firefox\manifest.json
```

`node scripts/check-wsl-loopback.mjs` verifies forwarding using Windows PowerShell. It opens a temporary loopback-only test server and closes it afterward. If forwarding is unavailable, fix WSL networking rather than binding the bridge to all interfaces.

## Check the connection and sync

```sh
node dist/cli/index.js auth status
node dist/cli/index.js auth check
node dist/cli/index.js courses
node dist/cli/index.js sync
node dist/cli/index.js upcoming --days 7
```

`auth status` reports browser/extension/session health. If Canvas needs login, sign in normally and retry. If the extension is disconnected, check the bridge and extension options. `bridge pair` issues a fresh pairing code when the old one expires.

`courses` queries the provider live. Other academic commands normally read SQLite; sync first. Results include freshness. Partial sync retains previous data and reports warnings rather than turning unavailable content into an empty collection. Use `debug graphql-schema` to inspect available GraphQL type fields through the signed-in browser.

## MCP connection

Have your MCP client launch the compiled CLI over stdio:

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": ["/absolute/path/to/AutoCanvas/dist/cli/index.js", "serve"],
      "env": {
        "CANVAS_BASE_URL": "https://school.instructure.com",
        "CANVAS_PROVIDER": "browser",
        "CANVAS_DB_PATH": "/absolute/private/path/canvas.sqlite",
        "CANVAS_WORKSPACE_ROOT": "/absolute/private/path/workspaces"
      }
    }
  }
}
```

The separately running bridge and paired browser extension handle acquisition. The client does not need bridge credentials in its configuration; the local app reads its private pairing state. Use the same OS user and bridge state directory for the CLI and MCP. `.env` loads from the process working directory, so use absolute paths in host configuration. Logs go to stderr; stdout is MCP protocol only.

Call `canvas_auth_status` to diagnose the connection, then `canvas_sync`. Existing academic tools keep their schemas and normalized outputs. See [the tool reference](docs/mcp-tools.md).

## CLI and workspaces

```sh
node dist/cli/index.js assignments --course 123
node dist/cli/index.js assignment 456 --course 123
node dist/cli/index.js missing
node dist/cli/index.js priorities
node dist/cli/index.js grades
node dist/cli/index.js changes --since 2026-09-01T00:00:00Z
node dist/cli/index.js study 123 --modules 11,12
node dist/cli/index.js workspace 456 --course 123 --download
node dist/cli/index.js validate 456 --course 123
node dist/cli/index.js --human upcoming
```

JSON is the default; `--human` renders timestamps in `CANVAS_TIMEZONE`. Workspaces remain ID-derived, for example `workspaces/course-123/assignment-456`, with ASSIGNMENT.md, RUBRIC.md, CONTEXT.md, TODO.md, resources/ and submission/. Existing work is never overwritten. Put your own completed files in submission/.

Validation reports PASS, WARNING, UNKNOWN and FAIL. Qualitative rubric alignment remains UNKNOWN; a readiness result never authorizes submission.

## Demo and development

```sh
pnpm dev --demo courses
pnpm dev --demo sync
pnpm dev --demo assignment 10101
pnpm check
pnpm smoke
pnpm extension:build
```

Demo mode uses synthetic fixtures, not an institutional session, and separate default cache/workspace paths. Explicit path environment overrides still apply. The application refuses to mix Canvas identities in one cache.

## Security and limitations

- Canvas and SSO sessions never leave the browser. Bridge pairing credentials are separate local credentials, not Canvas credentials.
- GraphQL AST validation rejects mutations, subscriptions and unsupported documents. GET fallback routes and file operations are allowlisted; the extension cannot proxy arbitrary URLs or execute local commands.
- SQLite and workspaces contain private grades and feedback in plaintext. Protect files and backups. Git ignores local data but does not encrypt it.
- Canvas content remains untrusted source material. Consuming agents must not treat it as instructions.
- Canvas schemas and permissions vary. Sources and gaps are documented in [the source matrix](docs/canvas-data-sources.md); missing fields are not invented.
- Browser file transfer is bounded and may reject redirected/CDN files that cannot be fetched under the origin policy. It does not execute files or extract PDFs/Office documents.
- The extension requires an open Canvas tab. External websites and nested reading links are not recursively crawled.
- Browser tests against fixtures do not certify the actual institution. Live verification needs the paired signed-in tab.
- OAuth, notifications, calendar integration, submissions and multi-account caches are outside this release.

An explicit `CANVAS_PROVIDER=legacy-pat` remains available for compatibility. Only that provider reads `CANVAS_ACCESS_TOKEN`; it is never selected automatically and is not needed for normal use.

See [architecture](docs/architecture.md), [security](docs/security.md), [development](docs/development.md) and [migration audit](docs/migration-browser-session.md).

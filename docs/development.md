# Development

## Commands

Use Node 22.12+ and pnpm 9.15.9. The lockfile is authoritative.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm dev --demo sync
```

`pnpm check` runs strict production type checking, the Vitest suite and the build. `pnpm smoke` drives the compiled CLI and an official MCP client over stdio in a disposable directory. No Canvas credentials are needed. BrowserSessionProvider is the production default; `--demo` selects MockCanvasProvider, and the original bearer client is reachable only through explicit `legacy-pat` configuration. Demo fixtures live in `src/demo/fixtures.ts` and include paginated courses, overdue and upcoming work, rubric criteria, containing modules, page bodies, file bytes, announcements and submission feedback. Unknown mock routes fail rather than returning invented empty success.

Tests inject fetch at the HTTP boundary and exercise the real normalization, SQLite and services. MCP tests negotiate a connection using the official SDK client, inspect registered schemas, call tools and read resources. Workspace tests check traversal, symlinks, overwrite refusal, download limits and credential separation. Sync tests cover changes, removals, partial failures, identity binding and unchanged page reuse.

## Code boundaries

Do not put fetch calls into MCP handlers or CLI actions. Endpoint wrappers own Canvas-specific query parameters. Services operate on normalized records, and transport adapters use the shared tool schemas. Keep raw payload compatibility separate from concise public output.

Write a failing behavior test before implementing a change. Use primary Canvas docs for endpoint behavior and the upstream MCP README to identify the stable package line. The old `@modelcontextprotocol/sdk` latest tag alone does not identify the current stable generation.

## Adding a cache entity

Add its kind and normalization, then a versioned database migration and endpoint mapping. Define whether an endpoint response is authoritative enough to reconcile deletions. A permission failure, malformed response or incomplete pagination must never be treated as an empty collection. Preserve unavailable-state warnings in sync metadata.

## Packaging and portability

This is a local source release, not a published npm package. `package.json` provides the `canvas-mcp` bin entry; `node dist/cli/index.js` works without a global link. Use absolute paths in MCP host configuration. On WSL, keep databases/workspaces in a private Linux directory when possible rather than relying on Windows mount permission emulation.

better-sqlite3 is native. If installation cannot find a compatible binary, install your platform's C/C++ build tools and Python 3, then reinstall from the lockfile. Never replace a failed SQLite binding with an in-memory imitation in production.

## Live acceptance

Automated fixture acceptance does not prove the user's institution permits each endpoint. After loading and pairing the extension with a normally signed-in Canvas tab, run `auth status`, `auth check`, `courses`, and `sync`; inspect every warning before using cached results. Live acceptance is intentionally not part of CI.

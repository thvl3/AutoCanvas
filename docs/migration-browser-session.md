# Browser-session migration plan

## Audit baseline

The existing project has 180 passing tests, a passing strict build, and a compiled CLI/official MCP stdio smoke test. The interrupted review fixes remain in the working tree and pass their regressions. Preserve them. No database migration is needed for the authentication change.

PAT entry points are `config.ts`, `app.ts`, `canvas/client.ts`, and the download transport. Sync depends on a small subset of CanvasApi. Academic services, MCP resources and planning already consume normalized entities from SQLite.

## Migration

1. Formalize the existing normalized CanvasApi surface as CanvasDataProvider; retain explicit legacy PAT and mock implementations. Prove existing tests still pass.
2. Add a versioned, Zod-validated loopback bridge with separate local-client and extension credentials. Pair using an expiring one-time code. Reject webpage origins on local-client endpoints and require an extension-origin plus pairing credential on the browser connection.
3. Build a Chromium-first extension. It requests permission for one configured Canvas origin. Execute narrowly scoped read operations inside an existing Canvas tab through the scripting API; do not expose local bridge credentials or commands to page JavaScript.
4. Prefer verified Canvas GraphQL queries. Isolate session-authenticated GET and semantic page extractors for missing fields. Normalize every adapter back to existing Entity records. Never erase cache collections because a GraphQL field is unsupported.
5. Route sync and file download through the chosen provider, default browser. Keep CLI/MCP academic interfaces stable; add auth/bridge status and schema diagnostics.
6. Exercise a real extension against a synthetic authenticated Canvas-like origin, then the compiled CLI/MCP through the bridge. Attempt institution checks only with an available signed-in Canvas tab; never request or export cookies, login credentials or headers.

## Constraints

No Canvas origin or signed-in Canvas tab was found in the accessible browser during the audit. Actual institutional GraphQL schema and live acceptance therefore require the user's Canvas URL and browser session. Synthetic tests must be labeled as such. The browser-session implementation must work without CANVAS_ACCESS_TOKEN; an optional legacy provider is never selected implicitly from a token.

The bridge binds 127.0.0.1, default port 47821. The extension and local app hold separate random bridge credentials; these are not Canvas credentials. Only extension storage and a private local state file retain them. Read-only GraphQL is enforced by parsing the AST, not string prefixes. No arbitrary URL/method proxy exists.

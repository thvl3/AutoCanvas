# Security model

## Browser-owned authentication

BrowserSessionProvider is the default. The user signs in normally to Canvas/SSO in a browser tab. No Canvas password, MFA code, session cookie, copied Authorization header or browser cookie database is exported to the local app. The extension does not request cookie-reading permission.

Canvas GraphQL POST requests may need Canvas's CSRF protection. The fixed page-context executor can read the page's CSRF material solely to attach it to the same-origin request; it never returns that value, any cookie string or request headers to the extension or bridge. The browser owns the authenticated session throughout.

LegacyPatProvider remains explicitly selectable for compatibility. Only it reads CANVAS_ACCESS_TOKEN; merely setting that variable cannot switch the normal provider.

## Local pairing boundary

The bridge binds only 127.0.0.1. Localhost is not implicitly trusted: local clients authenticate using a private random credential, while the extension has a separate credential established with an expiring, one-time pairing code. Persistent bridge state is private to the OS account. Pairing codes are displayed only for the user's pairing action; credential values are never logged or shown by status commands.

HTTP local-client endpoints reject webpage Origin headers and require the client credential. Pairing validates extension origins and the one-time code. WebSocket extension connections require the paired extension origin and a credential handshake. Only responses correlated with pending requests are accepted. A Canvas page cannot send local commands through that connection.

The threat model trusts the OS account, the installed extension code and the configured institution. Another process with access to the same user's private files can act as that user; this is not an OS sandbox.

## Read-only operations

The versioned protocol has a fixed operation union, not URL/method/body proxy arguments. GraphQL uses a real parser to reject mutations, subscriptions, multiple/unknown operations and unsupported documents. Canvas GET paths and query parameters are allowlisted; traversal, credential query parameters, other-user impersonation and external origins are rejected.

The extension repeats validation before invoking its fixed page-context executor. Script execution receives an operation and the Canvas origin, never bridge secrets. The browser scripting API returns the result directly; there is no window.postMessage channel granting Canvas arbitrary extension access.

Only selected response headers and bounded structured bodies leave the browser. Semantic page fallback parses a detached document and selects known academic content, never the full page's environment/CSRF state. HTML scripts are never executed. File bytes are bounded and never executed or unpacked.

## Data and filesystem

SQLite stores private educational records in plaintext. Restrict permissions, protect backups and use disk encryption when appropriate. Cache identity binds the origin and authenticated Canvas user. Use separate cache/workspace paths for separate users. Permission failures retain old data marked stale; cached data is not a current access grant.

MCP accepts IDs, not filesystem paths. Workspace creation retains the existing Linux/WSL descriptor-anchored directory handling, exclusive writes, filename sanitization, symlink/hardlink checks and safe rollback. Browser file acquisition feeds those same controls. Explicit locked-for-user files are refused. The browser channel has a smaller transfer limit than arbitrary local file storage; unsupported CDN redirects fail closed.

Validation reads only bounded direct regular files within the ID-derived submission directory. PASS describes one mechanical check; UNKNOWN is not approval. Ambiguous explicit word constraints cannot establish readiness. Qualitative rubric quality always requires human review, and there is no submission tool.

## Observability and recovery

Logs contain provider/operation names, timing, retry and sync metadata, not credentials, raw headers or student bodies. Keep debug output private regardless. Source provenance identifies GraphQL versus fallback without logging full payloads.

If Canvas expires, open the same site and sign in normally. The extension and provider can resume without replacing the MCP process. A bridge restart reuses the paired local credentials; extension reconnects do not require copying cookies. Firefox temporary add-ons are a development mechanism and must be reloaded after browser restart; permanent Firefox deployment requires normal signed-extension distribution.

Revoke the bridge pairing by removing its local pairing state and clearing extension settings while the bridge is stopped. This does not alter Canvas authentication. Do not share the SQLite database or workspaces in bug reports; use synthetic reproductions.

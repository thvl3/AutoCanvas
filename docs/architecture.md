# Architecture

AutoCanvas preserves its existing domain models, SQLite tables, academic workflows, CLI and MCP interfaces. Acquisition sits behind `CanvasDataProvider`; sync consumes its normalized Entity records, not browser, GraphQL or REST response shapes.

```text
Canvas tab (ordinary user login / SSO)
  -> extension Canvas-origin executor
  -> paired loopback bridge
  -> BrowserSessionProvider / source adapters
  -> existing normalization
  -> existing SQLite repository and sync
  -> academic services
  -> CLI and MCP stdio
```

## Provider boundary

`src/providers/types.ts` formalizes the existing acquisition surface: current user, courses, collections, assignments, module items, pages, files, self submissions, health and optional file acquisition/schema diagnostics. BrowserSessionProvider is the default. MockCanvasProvider preserves fixture development. LegacyPatProvider wraps the original client only when explicitly selected.

GraphQL is preferred where verified fields provide the required semantics. Relay IDs are not Canvas IDs; adapters use `_id`. Cursor pagination must be complete before reconciling collections. Isolated session GET and semantic page fallbacks cover gaps. Provenance identifies the source without spreading GraphQL shapes into services.

## Browser and bridge

The extension has no planning logic or database. It finds a tab at the exact configured HTTPS origin and invokes a fixed read-only executor through the browser scripting API. Only a validated operation enters Canvas MAIN world; local bridge credentials never do. No page-to-local command channel exists.

The Node bridge binds 127.0.0.1. Versioned messages use Zod validation and UUID request correlation. An expiring one-time pairing code establishes a separate random extension credential. Local CLI clients use a different credential from a private local state file. Extension responses can resolve only pending requests; they cannot issue local actions.

GraphQL documents are parsed and checked for read-only query operations. Session GET targets have a narrow route/query allowlist. Arbitrary method/URL requests are not part of the protocol. Session health and disconnection errors are actionable and retryable. The bridge is a separate process so CLI and MCP restarts do not require replacing the browser login.

## Preserved data and workflows

Normalized records keep string Canvas IDs, course relationships, nullable fields and raw payload compatibility. SQLite uses per-entity tables, indexes, migrations, identity guards and transactional reconciliation. No destructive database migration is part of the provider change.

Sync retains failed collections with stale metadata, compares canonical content, reuses unchanged page bodies, and refreshes submissions independently of assignment timestamps. Module item traversal remains explicit. Collection failures are never interpreted as empty success.

Academic services compute upcoming/missing/prioritized work, aggregate assignment and study sources, show Canvas grades and prepare ID-derived workspaces. File acquisition can come from the browser provider while existing descriptor-anchored filesystem protections remain intact. Validation is mechanical and advisory, not grading or submission.

## Runtime

Strict TypeScript, Node 22.12+, pnpm lockfile, SQLite, Zod, Vitest, and official MCP v2 split server/client packages. MCP uses registerTool/registerResource and stdio. Pino logs metadata to stderr, never Canvas credentials or bridge secrets.

Workspace operations require Linux/WSL `/proc` handles. Browser acquisition may run in a Windows browser connected through WSL localhost forwarding. Chromium and Firefox builds isolate manifest/runtime differences; Firefox temporary development add-ons need reloading after a browser restart unless distributed as a signed permanent add-on.

## Verification

Keep the original suite and compiled CLI/MCP smoke test. Add protocol safety, pairing, real-socket mock extension, GraphQL adapters, fallback fixtures, expiry and reconnect tests. Browser-session fixture tests prove the migrated path, not institution permissions. Record live Canvas checks separately and never export cookies to make tests pass.

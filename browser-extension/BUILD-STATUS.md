# Extension build handoff

- **Ready:** `browser-extension/dist-firefox/manifest.json` (Firefox 128+ temporary add-on) and `browser-extension/dist` (Chrome/Edge 116+ unpacked extension).
- **Windows Firefox path:** `\\wsl.localhost\Ubuntu\home\thule\AutoCanvas\browser-extension\dist-firefox\manifest.json`.
- **Verified:** extension TypeScript check; 68 extension tests in 9 files; actual esbuild output for both targets; isolated Chromium + real synthetic HTTPS session/GraphQL/DOM fixture. No live Firefox or authenticated Canvas claim.
- **Defaults:** editable `https://byui.instructure.com`; loopback `127.0.0.1:47821`.
- **Harness API:** named export `executeInCanvas(origin, operation)` in `browser-extension/src/executor.ts`, returning `{ok:true,result}` or `{ok:false,error}`. Compile with esbuild and serialize into the synthetic HTTPS page; do not pass bridge secrets into it. `tests/extension-browser.test.ts` is a working harness example.

## Bridge-owner integration blocker

The extension sends strict `{protocolVersion:1,type:'ping'}` every 20 seconds after ready. The bridge must accept that authenticated frame and return `{protocolVersion:1,type:'pong'}`. The last inspected `src/bridge/server.ts` still validated every post-hello message as a request response and thus rejected heartbeat ping. **Add ping/pong handling before claiming a stable live connection.** The bridge code is outside this extension agent's ownership.

Pairing sends the browser-controlled Origin header and body `{protocolVersion:1,code,extensionOrigin:location.origin}`. Both `chrome-extension://ID` and `moz-extension://UUID` are validated. Do not forge Origin from extension JS. If the live browser omits it, coordinate a deliberately reviewed bridge-side policy rather than silently weakening origin checks.

The final options UI supports pairing, Refresh status, Reconnect, and safe actionable last-Canvas-error status. Source research and security/known limitations are in `browser-extension/README.md`. External CDN downloads fail closed; client-rendered wiki shells return explicit missing-content errors rather than exporting page globals.

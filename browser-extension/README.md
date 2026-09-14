# AutoCanvas browser session extension

Read-only Canvas operations in a tab that you have already signed into. No login automation, Canvas credentials, session-cookie export, browser downloads, arbitrary scripts, unrestricted DOM selectors, external runtime connections, or page `postMessage` command channel.

## Build and load

```sh
node scripts/build-extension.mjs
pnpm exec tsc -p browser-extension/tsconfig.json
pnpm exec vitest run tests/extension*.test.ts
# Rebuild JS as you edit; reload the add-on after rebuilding:
node scripts/build-extension.mjs --watch
```

The build produces both targets:

- **Firefox 128+**: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `browser-extension/dist-firefox/manifest.json`. On Windows with this WSL checkout: `\\wsl.localhost\Ubuntu\home\thule\AutoCanvas\browser-extension\dist-firefox\manifest.json`. Temporary add-ons are removed on browser restart; reloading/re-adding may require permissions and pairing again. A distributable Firefox add-on requires Mozilla signing; this is a development build.
- **Chromium / Chrome / Edge 116+**: enable Developer mode in the extensions page, then **Load unpacked** `browser-extension/dist`.

Start the local bridge using the root project's CLI instructions. Open extension options from its toolbar button. The editable default origin is `https://byui.instructure.com`, the default bridge port is `47821`, and the only bridge host is `127.0.0.1`. Enter the current one-time bridge pairing code and approve access to that exact Canvas site. Keep a signed-in Canvas tab open in the same browser. Use **Refresh status** or **Reconnect** when needed. The latest failed Canvas read can show sign-in, missing-tab, or site-permission guidance.

The generic `https://*/*` optional-host template allows asking for a user-selected site; it is not granted wholesale. Required permissions are exactly `storage`, `scripting`, `alarms`, and the loopback HTTP host. Firefox uses the Promise-based `browser` namespace; Chromium uses `chrome`. Firefox's manifest has `background.scripts` and Gecko ID `autocanvas-session@local`; Chromium has a service worker.

## Security and protocol boundaries

- Pair with `POST http://127.0.0.1:PORT/pair`, body `{protocolVersion:1,code,extensionOrigin:location.origin}`. The browser supplies its own Origin header. The reply's protocol, secret format, and Canvas origin are checked before storing `{origin,port,extensionSecret}` exclusively in extension `storage.local`. The pairing code is not persisted and is cleared from the form immediately.
- Connect native WebSocket `ws://127.0.0.1:PORT/extension`; send `hello` with the extension secret. Require matching `ready` before accepting requests. Send `{protocolVersion:1,type:'ping'}` every 20 seconds; accept `{protocolVersion:1,type:'pong'}`. The bridge must support these strict heartbeat frames. Retry disconnected sockets with 1–30 second exponential backoff; a one-minute alarm reawakens suspended background contexts. Handshake timeout is 10 seconds.
- Background validation imports the shared `src/bridge/protocol.ts`: GraphQL is parsed, query-only, bounded, and rejects mutation/subscription/multiple-operation documents. REST paths are allowlisted. Responses are schema checked and remain correlated to the original request ID, not IDs supplied by a page.
- `scripting.executeScript` selects an existing exact-origin tab and its top frame in `MAIN`. Only the origin and typed operation are passed; never bridge secrets, pairing codes, ports, extension objects, or credentials. Canvas and each fetch target's origins are checked inside the serialized function. Requests use `credentials:'same-origin'` and `redirect:'manual'`. Opaque redirects fail closed.
- Canvas's own Apollo implementation reads `_csrf_token` for `X-CSRF-Token` on `/api/graphql`. This executor extracts only that anti-CSRF cookie inside Canvas MAIN and uses it solely in the same-origin request. No token/cookie value is returned to the extension, stored, or logged; no browser cookies API exists here. The actual session cookie can remain HttpOnly and is managed by the browser.
- API/HTML responses are bounded to 8 MiB, downloads additionally obey the requested smaller limit, transport responses are limited to 12 MiB, and Canvas operations have a 25-second abort deadline. Only status, body, Link, content type, and approved file bytes are returned—not arbitrary headers.
- Page fallback parses detached HTML and returns only known wiki/assignment content and title fields, removing scripts, frames, forms, hidden inputs, and active attributes. Canvas's modern wiki HTML can be an empty client-rendered shell; missing content yields an error, never fabricated instructions or a dump of `ENV`/full-page HTML. GraphQL/REST remain preferred.
- Downloads resolve files by Canvas course/file IDs, deny `locked_for_user`, and accept only same-origin HTTPS metadata URLs. External CDN URLs and opaque redirects are deliberately unsupported: they fail before following a redirect. No host is silently trusted, and no browser downloads permission is used. Use Canvas normally for those files.

## Test scope / harness

Tests use mocked extension APIs/storage/WebSockets plus real `Response` streams. `tests/extension-browser.test.ts` launches an isolated headless Chromium against a disposable synthetic HTTPS server, exercising real browser-managed fixture session cookies, GraphQL anti-CSRF, health JSON, and detached DOM extraction without contacting Canvas. It requires the project's Playwright Chromium installation and `openssl`; install Chromium with `pnpm exec playwright install chromium` if needed. These are fixture tests, not authenticated institution verification or live Firefox proof.

The fixture harness imports named `executeInCanvas(origin, operation)` from `browser-extension/src/executor.ts`, bundles it with esbuild, and runs it in the synthetic page. It returns `{ok:true,result}` or `{ok:false,error:{code,message,retryable}}`. Every runtime dependency is inside that function so browser scripting can serialize it. Production background entry points expose no harness/global command API.

## Primary-source checks

- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting): host permission plus scripting; `MAIN` shares page context; injected functions lose lexical scope and Promise results are awaited.
- [Chrome WebSocket service-worker lifetime](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets): Chrome 116+, exchange messages within the 30-second idle window; official example uses 20 seconds.
- [MDN scripting compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/scripting.json): Firefox `MAIN` execution requires version 128.
- [MDN background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background): Firefox background scripts versus Chromium service workers; MV3 background pages are nonpersistent.
- [Canvas Apollo source](https://github.com/instructure/canvas-lms/blob/master/ui/shared/apollo-v3/index.js): `/api/graphql`, same-origin credentials, and `_csrf_token` → `X-CSRF-Token`.
- [Canvas assignment template](https://github.com/instructure/canvas-lms/blob/master/app/views/assignments/show.html.erb): `#assignment_show`, `h1.title`, `.description.user_content`.
- [Canvas wiki template](https://github.com/instructure/canvas-lms/blob/master/app/views/wiki_pages/show.html.erb): client-rendered `#wiki_page_show` shell.

Official content was retrieved directly after the configured extraction service returned 403. No authenticated Canvas pages were used in development fixtures.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";

export interface DashboardApi {
  status(): Promise<Record<string, unknown>>;
  pair(): Promise<{ pairingCode: string; expires_at: string }>;
  mcp(): Record<string, unknown>;
  configure(baseUrl: string): Promise<{ ok: boolean; error?: string }>;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && aa.every((byte, i) => byte === bb[i]);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AutoCanvas</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
         background: #111418; color: #e6e8eb; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a9199; margin: 0 0 24px; }
  section { background: #1a1e24; border: 1px solid #2a2f37; border-radius: 10px;
            padding: 18px; margin-bottom: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
       color: #8a9199; margin: 0 0 12px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0;
         border-bottom: 1px solid #232830; }
  .row:last-child { border-bottom: 0; }
  .row .k { color: #8a9199; }
  .row .v { font-weight: 600; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px;
          font-size: 12px; font-weight: 600; }
  .ok { background: #16331f; color: #5ee08a; }
  .bad { background: #3a1d1d; color: #ff7b7b; }
  .warn { background: #3a3315; color: #f5d25e; }
  button { background: #2f6fed; color: #fff; border: 0; border-radius: 8px;
           padding: 9px 14px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #2a2f37; }
  button:hover { filter: brightness(1.1); }
  input { width: 100%; background: #0d1014; border: 1px solid #2a2f37; color: #e6e8eb;
          border-radius: 8px; padding: 10px 12px; font-size: 14px; margin: 8px 0 12px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #0d1014; border: 1px solid #2a2f37; border-radius: 8px;
        padding: 12px; overflow: auto; font-size: 12.5px; white-space: pre; }
  .code { font-size: 22px; letter-spacing: .12em; font-weight: 700; color: #7ab8ff; }
  .muted { color: #8a9199; font-size: 13px; }
  .hint { margin-top: 8px; }
  .err { color: #ff7b7b; font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
<main>
  <h1>AutoCanvas</h1>
  <p class="sub">Local Canvas bridge dashboard</p>

  <section id="setup" style="display:none">
    <h2>Setup</h2>
    <p class="muted">Enter your Canvas URL to get started. It is the HTTPS origin
      of your school's Canvas site (for example
      <code>https://byui.instructure.com</code>).</p>
    <input id="baseurl" placeholder="https://your-school.instructure.com" />
    <button id="save">Save and connect</button>
    <p class="err" id="setuperr"></p>
  </section>

  <section id="status">
    <h2>Connection</h2>
    <div class="row"><span class="k">Bridge</span><span id="bridge" class="v">—</span></div>
    <div class="row"><span class="k">Extension</span><span id="extension" class="v">—</span></div>
    <div class="row"><span class="k">Canvas session</span><span id="session" class="v">—</span></div>
    <div class="row"><span class="k">Origin</span><span id="origin" class="v">—</span></div>
  </section>

  <section id="pair">
    <h2>Pairing code</h2>
    <p>Enter this in the browser extension to pair it with the bridge.</p>
    <p class="code" id="pairing">—</p>
    <p class="muted" id="expiry"></p>
    <button id="newpair" class="secondary">Generate new code</button>
  </section>

  <section id="mcpsec">
    <h2>MCP setup</h2>
    <p class="muted">Register the server with your MCP client using this entry
      (the exact file location depends on the client).</p>
    <pre id="mcp">Loading…</pre>
    <button id="copy">Copy</button>
    <p class="muted hint" id="files"></p>
  </section>
</main>
<script>
  const q = new URLSearchParams(location.search);
  const t = q.get("t") ?? "";
  const api = (path, opts) => fetch(path + "?t=" + t, opts);
  const $ = (id) => document.getElementById(id);

  function pill(text, cls) { return '<span class="pill ' + cls + '">' + text + "</span>"; }

  async function refresh() {
    let d;
    try {
      d = await (await api("/api/status")).json();
    } catch (e) {
      d = { configured: true, bridge: {}, health: { state: "error" } };
    }
    const configured = d.configured !== false;
    $("setup").style.display = configured ? "none" : "block";
    $("status").style.display = configured ? "block" : "none";
    $("pair").style.display = configured ? "block" : "none";
    $("mcpsec").style.display = configured ? "block" : "none";
    if (!configured) return;
    const b = d.bridge ?? {};
    $("bridge").innerHTML = b.port ? pill("running :" + b.port, "ok") : pill("not running", "bad");
    $("extension").innerHTML = b.connected ? pill("connected", "ok") : pill("disconnected", "bad");
    $("origin").textContent = b.origin ?? "—";
    const h = d.health ?? {};
    const state = h.state ?? "unknown";
    $("session").innerHTML = state === "connected" || state === "healthy"
      ? pill(state, "ok")
      : state === "authentication_required"
        ? pill("sign in required", "warn")
        : pill(String(state), "warn");
  }

  async function pair() {
    const r = await api("/api/pair", { method: "POST" });
    const d = await r.json();
    if (d.pairingCode) {
      $("pairing").textContent = d.pairingCode;
      $("expiry").textContent = "Expires " + new Date(d.expires_at).toLocaleTimeString();
    } else {
      $("pairing").textContent = "unavailable: " + (d.error ?? "error");
    }
  }

  async function mcp() {
    try {
      const r = await api("/api/mcp");
      const d = await r.json();
      $("mcp").textContent = d.snippet
        ? JSON.stringify(d.snippet, null, 2)
        : "unavailable";
      $("files").textContent = (d.files ?? []).map((f) => f.tool + ": " + f.file).join("  |  ");
    } catch (e) {
      $("mcp").textContent = "unavailable";
    }
  }

  async function configure() {
    const baseUrl = $("baseurl").value.trim();
    $("setuperr").textContent = "";
    try {
      const r = await api("/api/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const d = await r.json();
      if (d.ok) {
        refresh();
        pair();
        mcp();
      } else {
        $("setuperr").textContent = d.error ?? "Configuration failed";
      }
    } catch (e) {
      $("setuperr").textContent = "Configuration failed";
    }
  }

  $("newpair").onclick = pair;
  $("save").onclick = configure;
  $("copy").onclick = () => {
    navigator.clipboard.writeText($("mcp").textContent);
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1200);
  };

  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>
`;

export async function startDashboard(
  api: DashboardApi,
): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomBytes(24).toString("base64url");
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!safeEqual(url.searchParams.get("t") ?? "", token)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      try {
        if (url.pathname === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(HTML);
        } else if (url.pathname === "/api/status") {
          json(res, await api.status());
        } else if (url.pathname === "/api/pair" && req.method === "POST") {
          json(res, await api.pair());
        } else if (url.pathname === "/api/mcp") {
          json(res, api.mcp());
        } else if (url.pathname === "/api/configure" && req.method === "POST") {
          const body = (await readJson(req)) as { baseUrl?: unknown };
          if (typeof body?.baseUrl !== "string") {
            json(res, { ok: false, error: "Canvas URL is required." }, 400);
            return;
          }
          json(res, await api.configure(body.baseUrl));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      } catch (error) {
        json(
          res,
          { error: error instanceof Error ? error.message : "error" },
          500,
        );
      }
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

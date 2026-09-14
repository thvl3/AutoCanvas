import { afterEach, describe, expect, it } from "vitest";
import { startDashboard } from "../src/ui/dashboard.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("dashboard", () => {
  it("serves an authenticated dashboard and proxies status/pair/mcp/configure", async () => {
    let configured = true;
    const dashboard = await startDashboard({
      status: async () => ({
        configured,
        bridge: {
          connected: true,
          port: 47821,
          origin: "https://school.example",
        },
        health: { state: "connected" },
      }),
      pair: async () => ({
        pairingCode: "ABC123",
        expires_at: "2026-01-01T00:00:00Z",
      }),
      mcp: () => ({
        configured,
        snippet: { command: "node", args: ["serve"] },
        files: [],
      }),
      configure: async (baseUrl) => {
        configured = true;
        return { ok: baseUrl === "https://school.example" };
      },
    });
    cleanups.push(() => dashboard.close());
    const url = new URL(dashboard.url);
    const token = url.searchParams.get("t");
    expect(token).toBeTruthy();
    const base = `http://127.0.0.1:${url.port}`;

    // No token → forbidden.
    expect((await fetch(`${base}/`)).status).toBe(403);

    // Token → HTML dashboard (includes the setup form).
    const html = await (await fetch(`${base}/?t=${token}`)).text();
    expect(html).toContain("AutoCanvas");
    expect(html).toContain("Pairing code");
    expect(html).toContain("Save and connect");

    // Status.
    const status = await (await fetch(`${base}/api/status?t=${token}`)).json();
    expect(status.configured).toBe(true);
    expect(status.bridge.connected).toBe(true);
    expect(status.health.state).toBe("connected");

    // Pair.
    const pair = await (
      await fetch(`${base}/api/pair?t=${token}`, { method: "POST" })
    ).json();
    expect(pair.pairingCode).toBe("ABC123");

    // MCP config.
    const mcp = await (await fetch(`${base}/api/mcp?t=${token}`)).json();
    expect(mcp.snippet).toEqual({ command: "node", args: ["serve"] });

    // Configure.
    const ok = await (
      await fetch(`${base}/api/configure?t=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://school.example" }),
      })
    ).json();
    expect(ok).toEqual({ ok: true });

    // Configure with a missing URL is rejected.
    const bad = await fetch(`${base}/api/configure?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    // A wrong token is rejected even for a known path.
    expect((await fetch(`${base}/api/status?t=wrong`)).status).toBe(403);
  });
});

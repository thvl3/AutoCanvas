import { afterEach, describe, expect, it } from "vitest";
import { startDashboard } from "../src/ui/dashboard.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("dashboard", () => {
  it("serves an authenticated dashboard and proxies status/pair/mcp", async () => {
    const dashboard = await startDashboard({
      status: async () => ({
        connected: true,
        port: 47821,
        origin: "https://school.example",
      }),
      health: async () => ({ state: "connected" }),
      pair: async () => ({
        pairingCode: "ABC123",
        expires_at: "2026-01-01T00:00:00Z",
      }),
      mcp: () => ({ snippet: { command: "node", args: ["serve"] }, files: [] }),
    });
    cleanups.push(() => dashboard.close());
    const url = new URL(dashboard.url);
    const token = url.searchParams.get("t");
    expect(token).toBeTruthy();
    const base = `http://127.0.0.1:${url.port}`;

    // No token → forbidden.
    expect((await fetch(`${base}/`)).status).toBe(403);

    // Token → HTML dashboard.
    const html = await (await fetch(`${base}/?t=${token}`)).text();
    expect(html).toContain("AutoCanvas");
    expect(html).toContain("Pairing code");

    // Status.
    const status = await (await fetch(`${base}/api/status?t=${token}`)).json();
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

    // A wrong token is rejected even for a known path.
    expect((await fetch(`${base}/api/status?t=wrong`)).status).toBe(403);
  });
});

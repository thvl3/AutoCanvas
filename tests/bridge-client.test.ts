import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeClient } from "../src/bridge/client.js";
import { startBridge } from "../src/bridge/server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
it("bounds and validates HTTP response bodies in the Node client", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-client-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const bridge = await startBridge({
    stateDir,
    origin: "https://canvas.example.edu",
    port: 0,
  });
  await bridge.close();
  let body = JSON.stringify({
    status: 200,
    body: "x".repeat(13 * 1024 * 1024),
  });
  const http = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) =>
    http.listen(bridge.port, "127.0.0.1", resolve),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  );
  const client = new BridgeClient({
    stateDir,
    origin: "https://canvas.example.edu",
    port: bridge.port,
  });
  await expect(
    client.request({ type: "session-health" }),
  ).rejects.toMatchObject({
    code: "bridge_response_too_large",
    retryable: false,
  });
  body = JSON.stringify({ status: "wrong", body: {} });
  await expect(
    client.request({ type: "session-health" }),
  ).rejects.toMatchObject({ code: "bridge_protocol_error", retryable: false });
  body = JSON.stringify({ connected: "yes" });
  await expect(client.status()).rejects.toMatchObject({
    code: "bridge_protocol_error",
    retryable: false,
  });
  body = JSON.stringify({ pairingCode: "short", expires_at: "bad" });
  await expect(client.pair()).rejects.toMatchObject({
    code: "bridge_protocol_error",
    retryable: false,
  });
});

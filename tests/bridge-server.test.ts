import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type BridgeServer } from "../src/bridge/server.js";
import { BridgeClient } from "../src/bridge/client.js";
import type { BridgeSettings } from "../src/bridge/protocol.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(timeoutMs = 300) {
  const stateDir = await mkdtemp(join(tmpdir(), "canvas-bridge-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const settings: BridgeSettings = {
    origin: "https://canvas.example.edu",
    stateDir,
    port: 0,
    timeoutMs,
  };
  const server = await startBridge(settings);
  cleanups.push(() => server.close());
  settings.port = server.port;
  return {
    server,
    settings,
    client: new BridgeClient(settings),
    base: `http://127.0.0.1:${server.port}`,
  };
}

const extensionOrigin = "chrome-extension://" + "a".repeat(32);
async function pairExtension(base: string, code: string): Promise<string> {
  const response = await fetch(base + "/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: extensionOrigin },
    body: JSON.stringify({ protocolVersion: 1, code, extensionOrigin }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).extensionSecret;
}
async function connectExtension(
  base: string,
  extensionSecret: string,
  autoPong = true,
): Promise<WebSocket> {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/extension", {
    origin: extensionOrigin,
    autoPong,
  });
  cleanups.push(async () => {
    socket.terminate();
  });
  await once(socket, "open");
  const ready = once(socket, "message");
  socket.send(
    JSON.stringify({ protocolVersion: 1, type: "hello", extensionSecret }),
  );
  expect(JSON.parse((await ready)[0].toString())).toEqual({
    protocolVersion: 1,
    type: "ready",
    origin: "https://canvas.example.edu",
  });
  return socket;
}

describe("secure loopback bridge", () => {
  it("pins the configured Canvas origin against later caller mutation", async () => {
    const { server, settings, client } = await setup();
    settings.origin = "https://other.example.edu";
    expect(server.status().origin).toBe("https://canvas.example.edu");
    expect((await client.status()).origin).toBe("https://canvas.example.edu");
  });
  it("releases pending work when the local HTTP caller aborts", async () => {
    const { server, base, settings } = await setup(1000);
    const socket = await connectExtension(
      base,
      await pairExtension(base, server.pairingCode),
    );
    const state = JSON.parse(
      await readFile(
        join(settings.stateDir, "bridge-credentials.json"),
        "utf8",
      ),
    );
    const controller = new AbortController();
    const received = once(socket, "message");
    const response = fetch(base + "/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Bridge-Key": state.clientSecret,
      },
      body: JSON.stringify({ type: "session-health" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await received;
    controller.abort();
    await response;
    await vi.waitFor(
      () => expect(server.status()).toMatchObject({ pending: 0 }),
      { timeout: 200 },
    );
  });
  it("honors request timeouts longer than the HTTP idle timeout", async () => {
    const { server, base, client } = await setup(15500);
    await connectExtension(base, await pairExtension(base, server.pairingCode));
    await expect(
      client.request({ type: "session-health" }),
    ).rejects.toMatchObject({ code: "bridge_timeout", retryable: true });
  }, 20000);
  it("rejects websites, unauthenticated local requests and invalid WS authentication", async () => {
    const { server, client, base, settings } = await setup();
    const secret = await pairExtension(base, server.pairingCode);
    const credentials = JSON.parse(
      await readFile(
        join(settings.stateDir, "bridge-credentials.json"),
        "utf8",
      ),
    );
    const operation = JSON.stringify({ type: "session-health" });
    for (const headers of [
      {},
      { "X-Canvas-Bridge-Key": secret },
      {
        "X-Canvas-Bridge-Key": credentials.clientSecret,
        Origin: "https://evil.test",
      },
      {
        "X-Canvas-Bridge-Key": credentials.clientSecret,
        Origin: extensionOrigin,
      },
    ]) {
      const response = await fetch(base + "/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: operation,
      });
      expect([401, 403]).toContain(response.status);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const origin of [
      undefined,
      "https://evil.test",
      "chrome-extension://" + "b".repeat(32),
    ]) {
      const socket = new WebSocket(
        base.replace("http:", "ws:") + "/extension",
        origin ? { origin } : {},
      );
      const error = await once(socket, "error");
      expect(error[0].message).toContain("403");
    }
    for (const extensionSecret of ["wrong", credentials.clientSecret]) {
      const socket = new WebSocket(
        base.replace("http:", "ws:") + "/extension",
        { origin: extensionOrigin },
      );
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify({ protocolVersion: 1, type: "hello", extensionSecret }),
      );
      await closed;
      expect(await client.status()).toMatchObject({ connected: false });
    }
    const socket = await connectExtension(base, secret);
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        requestId: randomUUID(),
        operation: { type: "session-health" },
      }),
    );
    await closed;
    expect(await client.status()).toMatchObject({ connected: false });
    const headers = {
      "X-Canvas-Bridge-Key": credentials.clientSecret,
      "Content-Type": "application/json",
    };
    for (const body of [
      { type: "graphql-query", query: "mutation { write }" },
      { type: "canvas-get", path: "/api/v1/courses", method: "POST" },
      { type: "canvas-get", path: "/api/v1/users/123/profile" },
    ]) {
      const response = await fetch(base + "/request", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_operation");
    }
  });
  it("requires HELLO within three seconds and caps WebSocket payloads at twelve MiB", async () => {
    const { server, base, client } = await setup();
    const secret = await pairExtension(base, server.pairingCode);
    const idle = new WebSocket(base.replace("http:", "ws:") + "/extension", {
      origin: extensionOrigin,
    });
    await once(idle, "open");
    await once(idle, "close");
    expect(await client.status()).toMatchObject({ connected: false });
    const socket = await connectExtension(base, secret);
    const closed = once(socket, "close");
    socket.send("x".repeat(12 * 1024 * 1024 + 1));
    await closed;
    expect(await client.status()).toMatchObject({ connected: false });
  }, 5000);
  it("revokes an existing extension connection when pairing is replaced", async () => {
    const { server, client, base } = await setup();
    const oldSecret = await pairExtension(base, server.pairingCode);
    const socket = await connectExtension(base, oldSecret);
    const closed = once(socket, "close");
    const { pairingCode } = await client.pair();
    const nextSecret = await pairExtension(base, pairingCode);
    expect(nextSecret).not.toBe(oldSecret);
    expect(await client.status()).toMatchObject({ connected: false });
    await closed;
    await connectExtension(base, nextSecret);
  });
  it("heartbeats every twenty seconds and disconnects unresponsive extensions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { server, base } = await setup();
    try {
      const socket = await connectExtension(
        base,
        await pairExtension(base, server.pairingCode),
        false,
      );
      const ping = once(socket, "ping");
      await vi.advanceTimersByTimeAsync(20000);
      await Promise.race([
        ping,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Heartbeat missing")), 100),
        ),
      ]);
      const closed = once(socket, "close");
      await vi.advanceTimersByTimeAsync(20000);
      await closed;
      expect(server.status()).toMatchObject({ connected: false });
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });
  it("bounds HTTP bodies and outstanding requests", async () => {
    const { server, client, base, settings } = await setup(250);
    const secret = await pairExtension(base, server.pairingCode);
    await connectExtension(base, secret);
    const credentials = JSON.parse(
      await readFile(
        join(settings.stateDir, "bridge-credentials.json"),
        "utf8",
      ),
    );
    const headers = {
      "X-Canvas-Bridge-Key": credentials.clientSecret,
      "Content-Type": "application/json",
    };
    const oversized = await fetch(base + "/request", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "session-health",
        extra: "x".repeat(300000),
      }),
    });
    expect(oversized.status).toBe(413);
    const requests = Array.from({ length: 33 }, () =>
      client.request({ type: "session-health" }),
    );
    const results = await Promise.allSettled(requests);
    expect(
      results.filter(
        (r) => r.status === "rejected" && r.reason.code === "bridge_busy",
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === "rejected" && r.reason.code === "bridge_timeout",
      ),
    ).toHaveLength(32);
    expect(server.status()).toMatchObject({ pending: 0 });
  });
  it("returns actionable Canvas errors with authentication status for sync abort", async () => {
    const { server, client, base } = await setup();
    const socket = await connectExtension(
      base,
      await pairExtension(base, server.pairingCode),
    );
    for (const [status, code, retryable] of [
      [401, "canvas_authentication_required", false],
      [403, "canvas_permission_denied", false],
      [429, "canvas_rate_limited", true],
      [503, "canvas_unavailable", true],
    ] as const) {
      socket.once("message", (raw) => {
        const { requestId } = JSON.parse(raw.toString());
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            requestId,
            ok: true,
            result: { status, body: "never expose response body" },
          }),
        );
      });
      await expect(
        client.request({ type: "session-health" }),
      ).rejects.toMatchObject({ code, retryable, status });
    }
    for (const [code, retryable, status] of [
      ["canvas_not_open", true, 503],
      ["canvas_authentication_required", false, 401],
      ["canvas_permission_denied", false, 403],
    ] as const) {
      socket.once("message", (raw) => {
        const { requestId } = JSON.parse(raw.toString());
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            requestId,
            ok: false,
            error: { code, retryable, message: "Open Canvas and sign in." },
          }),
        );
      });
      await expect(
        client.request({ type: "session-health" }),
      ).rejects.toMatchObject({ code, retryable, status });
    }
  });
  it("fails pending work on disconnect and reconnects with persisted secrets after restart", async () => {
    const { server, client, base, settings } = await setup(80);
    await expect(
      client.request({ type: "session-health" }),
    ).rejects.toMatchObject({
      code: "extension_disconnected",
      retryable: true,
    });
    const secret = await pairExtension(base, server.pairingCode);
    const socket = await connectExtension(base, secret);
    socket.once("message", () => socket.close());
    await expect(
      client.request({ type: "session-health" }),
    ).rejects.toMatchObject({
      code: "extension_disconnected",
      retryable: true,
    });
    expect(await client.status()).toMatchObject({
      connected: false,
      pending: 0,
    });
    const reconnected = await connectExtension(base, secret);
    await expect(
      client.request({ type: "session-health" }),
    ).rejects.toMatchObject({ code: "bridge_timeout", retryable: true });
    expect(await client.status()).toMatchObject({ pending: 0 });
    reconnected.once("message", (data) => {
      const { requestId } = JSON.parse(data.toString());
      reconnected.send(
        JSON.stringify({
          protocolVersion: 1,
          requestId,
          ok: true,
          result: { status: 200, body: "reconnected" },
        }),
      );
    });
    expect((await client.request({ type: "session-health" })).body).toBe(
      "reconnected",
    );
    await server.close();
    await expect(client.status()).rejects.toMatchObject({
      code: "bridge_disconnected",
    });
    const restarted = await startBridge(settings);
    cleanups.push(() => restarted.close());
    expect(restarted.pairingCode).not.toBe(server.pairingCode);
    const again = await connectExtension(base, secret);
    again.once("message", (data) => {
      const { requestId } = JSON.parse(data.toString());
      again.send(
        JSON.stringify({
          protocolVersion: 1,
          requestId,
          ok: true,
          result: { status: 200, body: "restarted" },
        }),
      );
    });
    expect((await client.request({ type: "session-health" })).body).toBe(
      "restarted",
    );
  });
  it("correlates concurrent requests over an authenticated extension socket", async () => {
    const { server, client, base } = await setup();
    const secret = await pairExtension(base, server.pairingCode);
    const socket = await connectExtension(base, secret);
    expect(await client.status()).toMatchObject({ connected: true });
    const received: any[] = [];
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      received.push(request);
      if (received.length === 2) {
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            requestId: randomUUID(),
            ok: true,
            result: { status: 200, body: "unsolicited" },
          }),
        );
        for (const item of [...received].reverse())
          socket.send(
            JSON.stringify({
              protocolVersion: 1,
              requestId: item.requestId,
              ok: true,
              result: { status: 200, body: item.operation.type },
            }),
          );
      }
    });
    const results = await Promise.all([
      client.request({ type: "session-health" }),
      client.request({ type: "graphql-query", query: "{ __typename }" }),
    ]);
    expect(results.map((r) => r.body)).toEqual([
      "session-health",
      "graphql-query",
    ]);
    expect(received[0]).toMatchObject({
      protocolVersion: 1,
      requestId: expect.any(String),
    });
    expect(received[0].requestId).not.toBe(received[1].requestId);
    await expect(
      client.request({ type: "graphql-query", query: "mutation { delete }" }),
    ).rejects.toMatchObject({ code: "invalid_operation", retryable: false });
    expect(received).toHaveLength(2);
  });
  it("pairs only a real extension origin using expiring one-time rate-limited codes", async () => {
    const { server, client, base, settings } = await setup();
    const extensionOrigin = "chrome-extension://" + "a".repeat(32);
    const pair = (
      code: string,
      origin: string | undefined = extensionOrigin,
      bodyOrigin = extensionOrigin,
    ) =>
      fetch(base + "/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({
          protocolVersion: 1,
          code,
          extensionOrigin: bodyOrigin,
        }),
      });
    expect((await pair(server.pairingCode, "")).status).toBe(403);
    expect((await pair(server.pairingCode, "https://evil.test")).status).toBe(
      403,
    );
    expect(
      (
        await pair(
          server.pairingCode,
          extensionOrigin,
          "chrome-extension://" + "b".repeat(32),
        )
      ).status,
    ).toBe(403);
    expect((await pair("wrong")).status).toBe(401);
    const preflight = await fetch(base + "/pair", {
      method: "OPTIONS",
      headers: {
        Origin: extensionOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      extensionOrigin,
    );
    const response = await pair(server.pairingCode);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      extensionOrigin,
    );
    const paired = await response.json();
    expect(paired).toEqual({
      protocolVersion: 1,
      origin: settings.origin,
      extensionSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect((await pair(server.pairingCode)).status).toBe(401);
    const previousCode = server.pairingCode;
    const rotated = await client.pair();
    expect(rotated.pairingCode).not.toBe(previousCode);
    expect(Date.parse(rotated.expires_at) - Date.now()).toBeGreaterThan(290000);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300001);
    try {
      expect((await pair(rotated.pairingCode)).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
    await client.pair();
    for (let n = 0; n < 5; n++) expect((await pair("wrong")).status).toBe(401);
    expect((await pair("wrong")).status).toBe(429);
    expect(
      (await fetch(base + "/pairing", { method: "POST", body: "{}" })).status,
    ).toBe(401);
  });
  it("serves authenticated status with private, origin-bound persistent credentials", async () => {
    const { server, settings, client, base } = await setup();
    expect(server.port).toBeGreaterThan(0);
    expect(server.pairingCode).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    expect(await client.status()).toMatchObject({
      connected: false,
      origin: settings.origin,
      protocolVersion: 1,
    });
    expect((await fetch(base + "/status")).status).toBe(401);
    const file = (await readdir(settings.stateDir)).find((name) =>
      name.endsWith(".json"),
    )!;
    const state = JSON.parse(
      await readFile(join(settings.stateDir, file), "utf8"),
    );
    expect(state.clientSecret).toHaveLength(43);
    expect(state.extensionSecret).toHaveLength(43);
    expect(state.clientSecret).not.toBe(state.extensionSecret);
    expect(state.origin).toBe(settings.origin);
    expect((await stat(settings.stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(settings.stateDir, file))).mode & 0o777).toBe(
      0o600,
    );
    expect(JSON.stringify(server.status())).not.toContain(state.clientSecret);
    expect(JSON.stringify(await client.status())).not.toContain(
      state.extensionSecret,
    );
    for (const origin of [
      "https://evil.test",
      "chrome-extension://" + "a".repeat(32),
      "null",
    ]) {
      expect(
        (
          await fetch(base + "/status", {
            headers: {
              Origin: origin,
              "X-Canvas-Bridge-Key": state.clientSecret,
            },
          })
        ).status,
      ).toBe(403);
    }
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        base + "/status",
        {
          headers: {
            Host: "evil.test",
            "X-Canvas-Bridge-Key": state.clientSecret,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(rebound).toBe(403);
    await expect(
      startBridge({ ...settings, port: 0, host: "0.0.0.0" }),
    ).rejects.toMatchObject({ code: "invalid_settings" });
    await server.close();
    await expect(
      startBridge({
        ...settings,
        port: 0,
        origin: "https://other.example.edu",
      }),
    ).rejects.toMatchObject({ code: "origin_mismatch" });
    await expect(client.status()).rejects.toMatchObject({
      code: "bridge_disconnected",
      retryable: true,
    });
  });
});

import { afterEach, expect, it, vi } from "vitest";
const origin = "https://byui.instructure.com";
const pairing = { origin, port: 47821, extensionSecret: "s".repeat(43) };
class Socket {
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => Promise<void>;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    return this.onmessage?.({ data: JSON.stringify(data) });
  }
}
async function setup() {
  const module = await import("../browser-extension/src/connection.js").catch(
    () => ({}) as any,
  );
  expect(
    module.BridgeConnection,
    "background websocket connection exists",
  ).toBeTypeOf("function");
  const api = {
    storage: { local: { get: vi.fn().mockResolvedValue({ pairing }) } },
    alarms: { create: vi.fn() },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 9, url: `${origin}/courses` }]),
    },
    scripting: {
      executeScript: vi
        .fn()
        .mockResolvedValue([
          {
            frameId: 0,
            result: { ok: true, result: { status: 200, body: { id: "7" } } },
          },
        ]),
    },
  };
  const sockets: Socket[] = [];
  const createSocket = vi.fn(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const connection = new module.BridgeConnection(api, createSocket);
  return { connection, api, sockets, createSocket };
}
afterEach(() => vi.useRealTimers());
it("reconnects with exponential backoff and an alarm fallback without duplicate sockets", async () => {
  vi.useFakeTimers();
  const { connection, sockets, createSocket, api } = await setup();
  await Promise.all([connection.start(), connection.start()]);
  expect(createSocket).toHaveBeenCalledTimes(1);
  sockets[0]!.onclose?.({ code: 1006 });
  expect(connection.status().state).toBe("disconnected");
  expect(api.alarms.create).toHaveBeenCalledWith("canvas-bridge-reconnect", {
    periodInMinutes: 1,
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(createSocket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(createSocket).toHaveBeenCalledTimes(2);
  sockets[1]!.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(1999);
  expect(createSocket).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(createSocket).toHaveBeenCalledTimes(3);
  connection.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(createSocket).toHaveBeenCalledTimes(3);
});
it("executes validated requests only after a matching ready message and sends correlated results", async () => {
  const { connection, sockets, api } = await setup();
  await connection.start();
  const socket = sockets[0]!;
  socket.open();
  await socket.message({ protocolVersion: 1, type: "ready", origin });
  const requestId = "11111111-1111-4111-8111-111111111111";
  await socket.message({
    protocolVersion: 1,
    requestId,
    operation: { type: "session-health" },
  });
  expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({
      protocolVersion: 1,
      requestId,
      ok: true,
      result: { status: 200, body: { id: "7" } },
    }),
  );
  connection.stop();
});
it.each([
  {
    protocolVersion: 1,
    type: "ready",
    origin: "https://other.instructure.com",
  },
  { protocolVersion: 2, type: "ready", origin },
  {
    protocolVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    operation: { type: "session-health" },
  },
])(
  "closes a socket whose first message is not matching ready %#",
  async (message) => {
    const { connection, sockets, api } = await setup();
    await connection.start();
    sockets[0]!.open();
    await sockets[0]!.message(message);
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(connection.status().state).toBe("pairing_required");
    connection.stop();
  },
);
it("maintains the MV3 worker with 20-second protocol ping messages", async () => {
  vi.useFakeTimers();
  const { connection, sockets } = await setup();
  await connection.start();
  sockets[0]!.open();
  await sockets[0]!.message({ protocolVersion: 1, type: "ready", origin });
  await vi.advanceTimersByTimeAsync(20000);
  expect(sockets[0]!.send).toHaveBeenLastCalledWith(
    JSON.stringify({ protocolVersion: 1, type: "ping" }),
  );
  await sockets[0]!.message({ protocolVersion: 1, type: "pong" });
  expect(connection.status().state).toBe("connected");
  connection.stop();
  const calls = sockets[0]!.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(sockets[0]!.send.mock.calls).toHaveLength(calls);
});
it("closes malformed messages without unhandled rejections or Canvas access", async () => {
  const { connection, sockets, api } = await setup();
  await connection.start();
  sockets[0]!.open();
  await expect(
    sockets[0]!.onmessage?.({ data: "{invalid secret-payload" }),
  ).resolves.toBeUndefined();
  expect(sockets[0]!.close).toHaveBeenCalled();
  expect(api.scripting.executeScript).not.toHaveBeenCalled();
  connection.stop();
});
it("bounds outbound frames after page execution", async () => {
  const { connection, sockets, api } = await setup();
  await connection.start();
  sockets[0]!.open();
  await sockets[0]!.message({ protocolVersion: 1, type: "ready", origin });
  api.scripting.executeScript.mockResolvedValueOnce([
    {
      frameId: 0,
      result: {
        ok: true,
        result: { status: 200, body: "x".repeat(12 * 1024 * 1024) },
      },
    },
  ]);
  await sockets[0]!.message({
    protocolVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    operation: { type: "session-health" },
  });
  expect(JSON.parse(sockets[0]!.send.mock.lastCall![0])).toMatchObject({
    ok: false,
    error: { code: "canvas_response_too_large" },
  });
  connection.stop();
});
it("does not resurrect a connection after stop while storage is still loading", async () => {
  const { connection, api, createSocket } = await setup();
  let resolve!: (value: unknown) => void;
  api.storage.local.get.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const starting = connection.start();
  connection.stop();
  resolve({ pairing });
  await starting;
  expect(createSocket).not.toHaveBeenCalled();
});
it("times out a websocket that never sends ready", async () => {
  vi.useFakeTimers();
  const { connection, sockets } = await setup();
  await connection.start();
  sockets[0]!.open();
  await vi.advanceTimersByTimeAsync(10000);
  expect(sockets[0]!.close).toHaveBeenCalled();
  expect(connection.status().state).toBe("disconnected");
  connection.stop();
});
it("exposes a safe last Canvas failure code for actionable options status", async () => {
  const { connection, sockets, api } = await setup();
  await connection.start();
  sockets[0]!.open();
  await sockets[0]!.message({ protocolVersion: 1, type: "ready", origin });
  api.tabs.query.mockResolvedValueOnce([]);
  await sockets[0]!.message({
    protocolVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    operation: { type: "session-health" },
  });
  expect(connection.status()).toMatchObject({
    state: "connected",
    lastError: "canvas_not_open",
  });
  connection.stop();
});
it("recovers on a later wake after a transient storage failure during reconnect", async () => {
  vi.useFakeTimers();
  const { connection, sockets, api, createSocket } = await setup();
  await connection.start();
  api.storage.local.get.mockRejectedValueOnce(
    new Error("storage temporarily unavailable"),
  );
  sockets[0]!.onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(1000);
  await connection.start();
  expect(createSocket).toHaveBeenCalledTimes(2);
  connection.stop();
});
it("authenticates the loopback websocket without exposing its secret in public status", async () => {
  const { connection, sockets, createSocket } = await setup();
  await connection.start();
  expect(createSocket).toHaveBeenCalledWith("ws://127.0.0.1:47821/extension");
  sockets[0]!.open();
  expect(sockets[0]!.send).toHaveBeenCalledWith(
    JSON.stringify({
      protocolVersion: 1,
      type: "hello",
      extensionSecret: pairing.extensionSecret,
    }),
  );
  await sockets[0]!.message({ protocolVersion: 1, type: "ready", origin });
  expect(connection.status()).toMatchObject({ state: "connected", origin });
  expect(JSON.stringify(connection.status())).not.toContain(
    pairing.extensionSecret,
  );
  connection.stop();
});

import { afterEach, expect, it, vi } from "vitest";
function event() {
  return { addListener: vi.fn() };
}
it("wires trusted options messages, startup, alarms and Firefox action using Promise APIs", async () => {
  const module = await import("../browser-extension/src/runtime.js").catch(
    () => ({}) as any,
  );
  expect(module.installBackground, "background event wiring exists").toBeTypeOf(
    "function",
  );
  const runtime = {
    id: "autocanvas-session@local",
    getURL: (p: string) => `moz-extension://uuid/${p}`,
    onStartup: event(),
    onInstalled: event(),
    onMessage: event(),
    openOptionsPage: vi.fn(),
  };
  const api = {
    runtime,
    alarms: { onAlarm: event(), create: vi.fn() },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: event(),
    },
    action: { onClicked: event() },
  };
  const connection = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    status: vi.fn().mockReturnValue({ state: "unpaired" }),
  };
  module.installBackground(api, connection);
  expect(connection.start).toHaveBeenCalled();
  expect(api.alarms.create).toHaveBeenCalledWith("canvas-bridge-reconnect", {
    periodInMinutes: 1,
  });
  const listener = runtime.onMessage.addListener.mock.calls[0][0];
  const reply = vi.fn();
  expect(
    listener(
      { type: "status" },
      { id: "other", url: runtime.getURL("options.html") },
      reply,
    ),
  ).toBe(false);
  expect(reply).not.toHaveBeenCalled();
  listener(
    { type: "status" },
    { id: runtime.id, url: runtime.getURL("options.html") },
    reply,
  );
  expect(reply).toHaveBeenCalledWith({ state: "unpaired" });
  api.alarms.onAlarm.addListener.mock.calls[0][0]({
    name: "canvas-bridge-reconnect",
  });
  expect(connection.start).toHaveBeenCalledTimes(2);
  api.action.onClicked.addListener.mock.calls[0][0]();
  expect(runtime.openOptionsPage).toHaveBeenCalled();
  api.storage.onChanged.addListener.mock.calls[0][0](
    { pairing: { newValue: {} } },
    "local",
  );
  expect(connection.stop).toHaveBeenCalledTimes(1);
  expect(connection.start).toHaveBeenCalledTimes(3);
  listener(
    { type: "reconnect" },
    { id: runtime.id, url: runtime.getURL("options.html") },
    reply,
  );
  expect(connection.stop).toHaveBeenCalledTimes(2);
  expect(connection.start).toHaveBeenCalledTimes(4);
});
afterEach(() => vi.unstubAllGlobals());

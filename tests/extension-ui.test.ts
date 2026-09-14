import { expect, it, vi } from "vitest";
it("renders Firefox pairing controls, clears the code and never renders the stored secret", async () => {
  const module = await import("../browser-extension/src/options-ui.js").catch(
    () => ({}) as any,
  );
  expect(module.installOptions, "options UI exists").toBeTypeOf("function");
  const node = () => ({
    value: "",
    textContent: "",
    disabled: false,
    addEventListener: vi.fn(),
  });
  const nodes = {
    origin: node(),
    port: node(),
    code: node(),
    status: node(),
    pair: node(),
    "pair-form": node(),
    refresh: node(),
    reconnect: node(),
  };
  const document = { getElementById: (id: keyof typeof nodes) => nodes[id] };
  const origin = "https://byui.instructure.com";
  const api = {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue({ state: "connected", origin }),
    },
    permissions: { request: vi.fn().mockResolvedValue(true) },
    storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          origin,
          extensionSecret: "s".repeat(43),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  await module.installOptions(
    document,
    api,
    fetch,
    "moz-extension://11111111-1111-4111-8111-111111111111",
  );
  expect(nodes.origin.value).toBe(origin);
  expect(nodes.port.value).toBe("47821");
  nodes.code.value = "123456";
  const submit = nodes["pair-form"].addEventListener.mock.calls.find(
    (c) => c[0] === "submit",
  )![1];
  await submit({ preventDefault: vi.fn() });
  expect(api.storage.local.set).toHaveBeenCalled();
  expect(nodes.code.value).toBe("");
  expect(nodes.status.textContent).toMatch(/Paired/);
  expect(nodes.status.textContent).not.toContain("s".repeat(43));
  await nodes.refresh.addEventListener.mock.calls[0][1]();
  expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "status" });
  expect(nodes.status.textContent).toContain("Connected");
  await nodes.reconnect.addEventListener.mock.calls[0][1]();
  expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: "reconnect" });
  api.runtime.sendMessage.mockResolvedValueOnce({
    state: "connected",
    lastError: "canvas_not_open",
  });
  await nodes.refresh.addEventListener.mock.calls[0][1]();
  expect(nodes.status.textContent).toContain("Open");
  api.runtime.sendMessage.mockResolvedValueOnce({
    state: "connected",
    lastError: "canvas_authentication_required",
  });
  await nodes.refresh.addEventListener.mock.calls[0][1]();
  expect(nodes.status.textContent).toContain("Sign in");
});

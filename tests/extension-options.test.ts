import { expect, it, vi } from "vitest";
async function options() {
  const module = await import("../browser-extension/src/settings.js").catch(
    () => ({}) as any,
  );
  expect(module.pairCanvas, "pairing settings handler exists").toBeTypeOf(
    "function",
  );
  return module;
}
const origin = "https://byui.instructure.com";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
it.each([
  { origin: "https://byui.instructure.com/courses" },
  { origin: "https://*.instructure.com" },
  { origin: "http://byui.instructure.com" },
  { origin: "https://user:secret@byui.instructure.com" },
  { port: 0 },
  { port: 65536 },
  { code: "" },
  { extensionOrigin: "https://webpage.example" },
])(
  "rejects malformed pairing settings before asking for permissions %#",
  async (invalid) => {
    const { pairCanvas } = await options();
    const api = {
      permissions: { request: vi.fn() },
      storage: { local: { set: vi.fn() } },
    };
    const fetch = vi.fn();
    await expect(
      pairCanvas(api, fetch, {
        origin,
        port: 47821,
        code: "123456",
        extensionOrigin,
        ...invalid,
      }),
    ).rejects.toThrow("Invalid pairing settings");
    expect(api.permissions.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  {
    protocolVersion: 1,
    origin: "https://other.instructure.com",
    extensionSecret: "s".repeat(43),
  },
  { protocolVersion: 2, origin, extensionSecret: "s".repeat(43) },
  { protocolVersion: 1, origin, extensionSecret: "short" },
])(
  "rejects mismatched or malformed pairing responses without persisting secrets %#",
  async (reply) => {
    const { pairCanvas } = await options();
    const api = {
      permissions: { request: vi.fn().mockResolvedValue(true) },
      storage: { local: { set: vi.fn() } },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(reply), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    await expect(
      pairCanvas(api, fetch, {
        origin,
        port: 47821,
        code: "123456",
        extensionOrigin,
      }),
    ).rejects.toThrow("Pairing response");
    expect(api.storage.local.set).not.toHaveBeenCalled();
  },
);
it("stops pairing if the user denies host permission", async () => {
  const { pairCanvas } = await options();
  const api = {
    permissions: { request: vi.fn().mockResolvedValue(false) },
    storage: { local: { set: vi.fn() } },
  };
  const fetch = vi.fn();
  await expect(
    pairCanvas(api, fetch, {
      origin,
      port: 47821,
      code: "123456",
      extensionOrigin,
    }),
  ).rejects.toThrow("Permission");
  expect(fetch).not.toHaveBeenCalled();
});
it.each([401, 403, 429, 500])(
  "turns failed pairing HTTP %i into safe actionable errors",
  async (status) => {
    const { pairCanvas } = await options();
    const api = {
      permissions: { request: vi.fn().mockResolvedValue(true) },
      storage: { local: { set: vi.fn() } },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("secret-payload", { status }));
    await expect(
      pairCanvas(api, fetch, {
        origin,
        port: 47821,
        code: "123456",
        extensionOrigin,
      }),
    ).rejects.toThrow("Pairing was rejected");
    expect(api.storage.local.set).not.toHaveBeenCalled();
  },
);
it("does not expose malformed pairing JSON in errors", async () => {
  const { pairCanvas } = await options();
  const api = {
    permissions: { request: vi.fn().mockResolvedValue(true) },
    storage: { local: { set: vi.fn() } },
  };
  const fetch = vi.fn().mockResolvedValue(new Response("SECRET-FROM-BRIDGE"));
  await expect(
    pairCanvas(api, fetch, {
      origin,
      port: 47821,
      code: "123456",
      extensionOrigin,
    }),
  ).rejects.toThrow("Pairing response is invalid");
  expect(api.storage.local.set).not.toHaveBeenCalled();
});
it.each([
  extensionOrigin,
  "moz-extension://11111111-1111-4111-8111-111111111111",
])(
  "requests only the exact selected origin and saves only the returned local pairing secret (%s)",
  async (extensionOrigin) => {
    const { pairCanvas } = await options();
    const api = {
      permissions: { request: vi.fn().mockResolvedValue(true) },
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
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
    expect(
      await pairCanvas(api, fetch, {
        origin,
        port: 47821,
        code: "123456",
        extensionOrigin,
      }),
    ).toEqual({ origin, port: 47821 });
    expect(api.permissions.request).toHaveBeenCalledWith({
      origins: [`${origin}/*`],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47821/pair",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        redirect: "error",
        body: JSON.stringify({
          protocolVersion: 1,
          code: "123456",
          extensionOrigin,
        }),
      }),
    );
    expect(api.storage.local.set).toHaveBeenCalledWith({
      pairing: { origin, port: 47821, extensionSecret: "s".repeat(43) },
    });
    expect(JSON.stringify(api.storage.local.set.mock.calls)).not.toContain(
      "123456",
    );
  },
);

import { afterEach, expect, it, vi } from "vitest";
const origin = "https://school.instructure.com";
const requestId = "11111111-1111-4111-8111-111111111111";
async function background() {
  const module = await import("../browser-extension/src/controller.js").catch(
    () => ({}) as any,
  );
  expect(
    module.executeRequest,
    "validated request controller exists",
  ).toBeTypeOf("function");
  return module;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([
  { type: "graphql-query", query: "mutation { submitAssignment { id } }" },
  { type: "graphql-query", query: "query A { a } query B { b }" },
  { type: "graphql-query", query: "subscription { grades { id } }" },
  { type: "canvas-get", path: "/api/v1/users/7/profile" },
  { type: "canvas-get", path: "/api/v1/courses?as_user_id=7" },
  { type: "canvas-get", path: "https://evil.example/api/v1/courses" },
  { type: "evaluate", script: "document.cookie" },
])("rejects unapproved operations before tab lookup %#", async (operation) => {
  const { executeRequest } = await background();
  const api = {
    tabs: { query: vi.fn() },
    scripting: { executeScript: vi.fn() },
  };
  await expect(
    executeRequest(api, origin, { protocolVersion: 1, requestId, operation }),
  ).rejects.toThrow(
    "Only bounded, typed Canvas read operations are permitted.",
  );
  expect(api.tabs.query).not.toHaveBeenCalled();
});
it("reports an actionable Canvas-not-open error without navigating or creating tabs", async () => {
  const { executeRequest } = await background();
  const api = {
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 1, url: "https://evil.example" }]),
    },
    scripting: { executeScript: vi.fn() },
  };
  expect(
    await executeRequest(api, origin, {
      protocolVersion: 1,
      requestId,
      operation: { type: "session-health" },
    }),
  ).toMatchObject({
    protocolVersion: 1,
    requestId,
    ok: false,
    error: { code: "canvas_not_open", retryable: false },
  });
  expect(api.scripting.executeScript).not.toHaveBeenCalled();
});
it.each([
  [
    {
      frameId: 0,
      result: {
        ok: true,
        result: { status: 200, body: null },
        requestId: "22222222-2222-4222-8222-222222222222",
      },
    },
  ],
  [{ frameId: 3, result: { ok: true, result: { status: 200, body: null } } }],
  [{ frameId: 0, result: { ok: true, result: { status: 0, body: null } } }],
])(
  "rejects untrusted executor output without losing request correlation %#",
  async (...frames) => {
    const { executeRequest } = await background();
    const api = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 9, url: origin }]) },
      scripting: { executeScript: vi.fn().mockResolvedValue(frames) },
    };
    expect(
      await executeRequest(api, origin, {
        protocolVersion: 1,
        requestId,
        operation: { type: "session-health" },
      }),
    ).toMatchObject({
      protocolVersion: 1,
      requestId,
      ok: false,
      error: { code: "canvas_invalid_response" },
    });
  },
);
it("returns a correlated actionable injection failure without exposing browser exception details", async () => {
  const { executeRequest } = await background();
  const api = {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 9, url: origin }]) },
    scripting: {
      executeScript: vi
        .fn()
        .mockRejectedValue(new Error("private browser details")),
    },
  };
  const result = await executeRequest(api, origin, {
    protocolVersion: 1,
    requestId,
    operation: { type: "session-health" },
  });
  expect(result).toMatchObject({
    protocolVersion: 1,
    requestId,
    ok: false,
    error: { code: "canvas_execution_failed", retryable: true },
  });
  expect(JSON.stringify(result)).not.toContain("private browser details");
});
it("injects only origin and validated operation into one matched MAIN-world top frame", async () => {
  const { executeRequest } = await background();
  const operation = { type: "session-health" };
  const scripting = {
    executeScript: vi
      .fn()
      .mockResolvedValue([
        {
          frameId: 0,
          result: { ok: true, result: { status: 200, body: { id: "7" } } },
        },
      ]),
  };
  const api = {
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([{ id: 9, url: `${origin}/courses`, active: true }]),
    },
    scripting,
  };
  expect(
    await executeRequest(api, origin, {
      protocolVersion: 1,
      requestId,
      operation,
    }),
  ).toEqual({
    protocolVersion: 1,
    requestId,
    ok: true,
    result: { status: 200, body: { id: "7" } },
  });
  expect(api.tabs.query).toHaveBeenCalledWith({ url: `${origin}/*` });
  expect(scripting.executeScript).toHaveBeenCalledWith({
    target: { tabId: 9, frameIds: [0] },
    world: "MAIN",
    func: expect.any(Function),
    args: [origin, operation],
  });
});

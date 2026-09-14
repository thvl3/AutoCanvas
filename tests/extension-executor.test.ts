import { afterEach, describe, expect, it, vi } from "vitest";

const origin = "https://school.instructure.com";
async function executor() {
  const module = await import("../browser-extension/src/executor.js").catch(
    () => ({}) as any,
  );
  expect(
    module.executeInCanvas,
    "self-contained Canvas executor exists",
  ).toBeTypeOf("function");
  return module.executeInCanvas;
}
afterEach(() => vi.unstubAllGlobals());

describe("Canvas MAIN-world executor", () => {
  it("refuses a tab that navigated away before fetching", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin: "https://attacker.example" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await execute(origin, { type: "session-health" })).toMatchObject({
      ok: false,
      error: { code: "canvas_origin_changed", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [
      new Response("<form>login token-secret</form>", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      }),
      "canvas_authentication_required",
    ],
    [
      new Response("<html>login token-secret</html>", {
        headers: { "Content-Type": "text/html" },
      }),
      "canvas_authentication_required",
    ],
    [
      new Response(null, {
        status: 302,
        headers: { Location: "https://sso.example" },
      }),
      "canvas_authentication_required",
    ],
    [
      new Response("<html>Access denied</html>", {
        status: 403,
        headers: { "Content-Type": "text/html" },
      }),
      "canvas_permission_denied",
    ],
    [
      new Response("not json token-secret", {
        headers: { "Content-Type": "application/json" },
      }),
      "canvas_invalid_response",
    ],
  ])(
    "returns safe error for unusable session response %#",
    async (response, code) => {
      const execute = await executor();
      vi.stubGlobal("location", { origin });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const outcome = await execute(origin, { type: "session-health" });
      expect(outcome).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(outcome)).not.toContain("token-secret");
    },
  );
  it("executes query POST with the page-local CSRF token but never returns it", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    vi.stubGlobal("document", {
      cookie: "session=DO-NOT-EXPORT; _csrf_token=csrf%2Fvalue",
      querySelector: () => null,
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response('{"data":{"allCourses":[]}}', {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const operation = {
      type: "graphql-query",
      query: "query Courses { allCourses { id } }",
      variables: { limit: 3 },
    };
    const outcome = await execute(origin, operation);
    expect(outcome).toMatchObject({
      ok: true,
      result: { body: { data: { allCourses: [] } } },
    });
    expect(fetch).toHaveBeenCalledWith(
      `${origin}/api/graphql`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        body: JSON.stringify({
          query: operation.query,
          variables: operation.variables,
        }),
        headers: expect.objectContaining({
          "X-CSRF-Token": "csrf/value",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(JSON.stringify(outcome)).not.toMatch(/csrf|DO-NOT-EXPORT/);
  });
  it("gets a validated Canvas REST collection and preserves only pagination/content-type headers", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const link = `<${origin}/api/v1/courses?page=2>; rel="next"`;
    const fetch = vi.fn().mockResolvedValue(
      new Response('[{"id":"3"}]', {
        headers: {
          "Content-Type": "application/json",
          Link: link,
          "X-Secret": "never-return",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(
      await execute(origin, {
        type: "canvas-get",
        path: "/api/v1/courses?per_page=100",
      }),
    ).toEqual({
      ok: true,
      result: {
        status: 200,
        body: [{ id: "3" }],
        contentType: "application/json",
        link,
      },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `${origin}/api/v1/courses?per_page=100`,
    );
  });
  it("bounds streamed JSON even without Content-Length", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(await execute(origin, { type: "session-health" })).toMatchObject({
      ok: false,
      error: { code: "canvas_response_too_large" },
    });
    expect(cancel).toHaveBeenCalled();
  });
  it("downloads ID-resolved same-origin bytes under the explicit byte limit", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "7",
            url: `${origin}/files/7/download?verifier=SIGNED`,
            size: 3,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 255, 2]), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(
      await execute(origin, {
        type: "download-file",
        courseId: "3",
        fileId: "7",
        maxBytes: 3,
      }),
    ).toEqual({
      ok: true,
      result: {
        status: 200,
        body: { id: "7", size: 3 },
        contentType: "application/octet-stream",
        bytesBase64: "AP8C",
      },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/v1/courses/3/files/7`);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
    });
  });
  it.each([
    [
      { url: "https://unapproved.example/file" },
      "canvas_download_origin_denied",
    ],
    [
      { url: `${origin}/files/7/download`, locked_for_user: true },
      "canvas_permission_denied",
    ],
    [
      { url: `${origin}/files/7/download`, size: 4 },
      "canvas_response_too_large",
    ],
  ])(
    "denies unsafe metadata before fetching file bytes %#",
    async (metadata, code) => {
      const execute = await executor();
      vi.stubGlobal("location", { origin });
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(metadata), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      expect(
        await execute(origin, {
          type: "download-file",
          courseId: "3",
          fileId: "7",
          maxBytes: 3,
        }),
      ).toMatchObject({ ok: false, error: { code } });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["page", "assignment"] as const)(
    "extracts only semantic %s content from detached HTML",
    async (kind) => {
      const execute = await executor();
      vi.stubGlobal("location", { origin, pathname: "/dashboard" });
      const content = {
        innerHTML: "<p>Read chapter 1</p>",
        querySelectorAll: () => [],
      };
      const selectors: string[] = [];
      const parsed = {
        querySelector(selector: string) {
          selectors.push(selector);
          return selector.includes("h1")
            ? { textContent: "Week 1" }
            : selector.includes("show-content") ||
                selector.includes("description")
              ? content
              : null;
        },
      };
      const parseFromString = vi.fn().mockReturnValue(parsed);
      vi.stubGlobal(
        "DOMParser",
        class {
          parseFromString = parseFromString;
        },
      );
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            '<html><script>ENV.secret="private"</script><main>fixture</main></html>',
            { headers: { "Content-Type": "text/html" } },
          ),
        );
      vi.stubGlobal("fetch", fetch);
      const outcome = await execute(origin, {
        type: "canvas-page",
        kind,
        courseId: "3",
        id: "7",
      });
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          status: 200,
          body:
            kind === "page"
              ? {
                  page_id: "7",
                  id: "7",
                  title: "Week 1",
                  body: "<p>Read chapter 1</p>",
                  source: "canvas-page",
                }
              : {
                  id: "7",
                  name: "Week 1",
                  description: "<p>Read chapter 1</p>",
                  source: "canvas-page",
                },
        },
      });
      expect(fetch.mock.calls[0]?.[0]).toBe(
        `${origin}/courses/3/${kind === "page" ? "pages/page_id:7" : "assignments/7"}`,
      );
      expect(parseFromString).toHaveBeenCalledWith(
        expect.any(String),
        "text/html",
      );
      expect(JSON.stringify(outcome)).not.toContain("ENV");
      expect(
        selectors.some((s) =>
          s.includes(kind === "page" ? "#wiki_page_show" : "#assignment_show"),
        ),
      ).toBe(true);
    },
  );
  it("times out a stalled Canvas request with a safe retryable error", async () => {
    vi.useFakeTimers();
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("fixture secret", "AbortError")),
            ),
          ),
      ),
    );
    const pending = execute(origin, { type: "session-health" });
    await vi.advanceTimersByTimeAsync(25000);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "canvas_timeout", retryable: true },
    });
    vi.useRealTimers();
  });
  it("rejects a cross-origin target even if invoked directly with a malformed operation", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await execute(origin, {
        type: "canvas-get",
        path: "https://unapproved.example/api/v1/courses",
      }),
    ).toMatchObject({ ok: false, error: { code: "canvas_origin_changed" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports opaque file redirects as unsupported rather than pretending the user signed out", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const redirect = new Response(null);
    Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ url: `${origin}/files/7/download` }), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(redirect),
    );
    expect(
      await execute(origin, {
        type: "download-file",
        courseId: "3",
        fileId: "7",
        maxBytes: 3,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "canvas_download_redirect_denied" },
    });
  });
  it("checks session using an existing origin and returns only profile JSON", async () => {
    const execute = await executor();
    vi.stubGlobal("location", { origin });
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "10", name: "Student" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await execute(origin, { type: "session-health" })).toEqual({
      ok: true,
      result: {
        status: 200,
        body: { id: "10", name: "Student" },
        contentType: "application/json",
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      `${origin}/api/v1/users/self/profile`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
      }),
    );
  });
});

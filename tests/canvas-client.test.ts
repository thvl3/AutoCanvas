import { describe, it, expect, vi } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";

const config = {
  baseUrl: "https://canvas.example",
  accessToken: "private-token",
  timeoutMs: 100,
  maxRetries: 0,
};
const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("CanvasClient", () => {
  it("requests string IDs to avoid silent precision loss of Canvas 64-bit IDs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ id: "9007199254740993" }));
    const entity = await new CanvasClient(config, { fetch: fetcher }).get<{
      id: string;
    }>("/api/v1/courses/9007199254740993");
    expect(entity.id).toBe("9007199254740993");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("accept")).toBe(
      "application/json+canvas-string-ids",
    );
  });
  it("rejects invalid direct runtime limits instead of silently disabling retries or timers", () => {
    for (const extra of [
      { timeoutMs: 0 },
      { timeoutMs: NaN },
      { maxRetries: NaN },
      { maxRetries: Infinity },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
    ]) {
      expect(() => new CanvasClient({ ...config, ...extra })).toThrow(
        /Invalid Canvas client limits/,
      );
    }
  });
  it("stops endless distinct pagination cursors at a configured safety limit", async () => {
    let page = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (page >= 2) throw new Error("test sentinel: exceeded bounded fixture");
      return json([], {
        headers: {
          link: `<https://canvas.example/api/v1/courses?page=${++page}>; rel="next"`,
        },
      });
    });
    const consume = async () => {
      for await (const _ of new CanvasClient(config, {
        fetch: fetcher,
        maxPages: 2,
      }).paginate("/api/v1/courses")) {
      }
    };
    await expect(consume()).rejects.toThrow(/pagination page limit/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("follows opaque next links verbatim without reconstructing parameters or requiring last", async () => {
    const next = "https://canvas.example/api/v1/courses?opaque=a%2Bb,c&x=%20";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json([{ id: 1 }], {
          headers: {
            link: `<${next}>; title="a,b"; rel="next", <https://canvas.example/api/v1/courses>; rel="current"`,
          },
        }),
      )
      .mockResolvedValueOnce(json([{ id: 2 }]));
    const results = [];
    for await (const row of new CanvasClient(config, {
      fetch: fetcher,
    }).paginate("/api/v1/courses", { per_page: 1 }))
      results.push(row);
    expect(results).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetcher.mock.calls[1]![0]).toBe(next);
  });
  it("rejects pagination loops, cross-origin next links and non-array collection bodies", async () => {
    for (const link of [
      '<https://canvas.example/api/v1/courses>; rel="next"',
      '<https://evil.example/api/v1/courses>; rel="next"',
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => json([], { headers: { link } }));
      const consume = async () => {
        for await (const _row of new CanvasClient(config, {
          fetch: fetcher,
        }).paginate("/api/v1/courses")) {
          /* consume */
        }
      };
      await expect(consume()).rejects.toThrow(
        /pagination loop|Unsafe Canvas URL/,
      );
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ unexpected: [] }));
    const consume = async () => {
      for await (const _row of new CanvasClient(config, {
        fetch: fetcher,
      }).paginate("/api/v1/courses")) {
        /* consume */
      }
    };
    await expect(consume()).rejects.toThrow(/Expected Canvas collection array/);
  });
  it("handles HTTP-date Retry-After without unbounded sleeping", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          {},
          {
            status: 429,
            headers: { "retry-after": "Wed, 01 Jan 2098 00:00:00 GMT" },
          },
        ),
      )
      .mockResolvedValueOnce(json([]));
    const sleep = vi.fn(async (_ms: number) => {});
    await new CanvasClient(
      { ...config, maxRetries: 1 },
      { fetch: fetcher, sleep },
    ).get("/api/v1/courses");
    expect(sleep).toHaveBeenCalledWith(60000);
  });
  it("retries only transient HTTP/network failures and caps Retry-After", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          { secret: "private-token" },
          { status: 429, headers: { "retry-after": "99999999" } },
        ),
      )
      .mockResolvedValueOnce(json({}, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("private-token network URL"))
      .mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn(async (_ms: number) => {});
    expect(
      await new CanvasClient(
        { ...config, maxRetries: 3 },
        { fetch: fetcher, sleep },
      ).get("/api/v1/courses"),
    ).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([60000, 1000, 2000]);
  });
  it("returns sanitized HTTP failures without retrying forbidden/not-found/redirect responses", async () => {
    for (const status of [302, 401, 403, 404, 422]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json({ message: "private-token secret content" }, { status }),
        );
      const client = new CanvasClient(
        { ...config, maxRetries: 3 },
        { fetch: fetcher },
      );
      await expect(client.get("/api/v1/courses")).rejects.toMatchObject({
        status,
        message: `Canvas HTTP ${status}`,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("limits retries and never leaks network error details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private-token request to secret URL"));
    const sleep = vi.fn(async () => {});
    await expect(
      new CanvasClient(
        { ...config, maxRetries: 1 },
        { fetch: fetcher, sleep },
      ).get("/api/v1/courses"),
    ).rejects.toThrow(/^Canvas network request failed$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("enforces timeout through response body consumption and aborts fetch", async () => {
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      });
    };
    await expect(
      new CanvasClient({ ...config, timeoutMs: 10 }, { fetch: fetcher }).get(
        "/api/v1/courses",
      ),
    ).rejects.toThrow(/^Canvas request timed out$/);
    expect(signal?.aborted).toBe(true);
  });
  it("rejects malformed JSON without returning response content", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("private-token not json"));
    await expect(
      new CanvasClient(config, { fetch: fetcher }).get("/api/v1/courses"),
    ).rejects.toThrow(/^Invalid Canvas JSON response$/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("logs only numeric request metadata, never URLs, bodies or authorization", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(
          { secret: "private-token" },
          {
            headers: {
              "x-request-cost": "0.1",
              "x-rate-limit-remaining": "12",
            },
          },
        ),
      );
    await new CanvasClient(config, { fetch: fetcher, logger }).get(
      "/api/v1/pages/private-slug",
      { search_term: "private-search" },
    );
    const output = JSON.stringify(logger.debug.mock.calls);
    expect(output).toContain("rateLimitRemaining");
    expect(output).not.toMatch(
      /private-token|private-slug|private-search|Bearer/,
    );
    expect(logger.debug.mock.calls[0]![0]).toMatchObject({
      status: 200,
      requestCost: 0.1,
      rateLimitRemaining: 12,
    });
  });
  it("rejects hostile URLs and query auth before sending any credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({}));
    const client = new CanvasClient(config, { fetch: fetcher });
    for (const path of [
      "https://evil.example/api/v1/courses",
      "//evil.example/api/v1/courses",
      "http://canvas.example/api/v1/courses",
      "/api/v10/courses",
      "/api/v1/../../logout",
      "/api/v1/%2e%2e/logout",
      "/api/v1/courses/%252e%252e/%252e%252e/logout",
      "/api/v1/courses%2f..%2f..%2flogout",
      "/api/v1/courses\\..\\..\\logout",
      "/api/v1/courses#token",
      "https://user:password@canvas.example/api/v1/courses",
      "/api/v1/courses?access_token=private-token",
      "/api/v1/courses?as_user_id=123",
    ]) {
      await expect(client.get(path)).rejects.toThrow(/Unsafe Canvas URL/);
    }
    await expect(
      client.get("/api/v1/courses", { access_token: "private-token" }),
    ).rejects.toThrow(/Unsafe Canvas URL/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () =>
        new CanvasClient(
          { ...config, baseUrl: "http://canvas.example" },
          { fetch: fetcher },
        ),
    ).toThrow(/HTTPS/);
  });
  it("supports an injected authorization provider without exposing a token getter", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const authorization = vi.fn(async () => "Bearer ephemeral");
    const client = new CanvasClient(config, {
      fetch: fetcher,
      auth: { authorization },
    });
    await client.get("/api/v1/users/self");
    expect(authorization).toHaveBeenCalledOnce();
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe("Bearer ephemeral");
  });
  it("uses native fetch GET with header-only bearer auth and array parameters", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "1" }));
    const client = new CanvasClient(config, { fetch: fetcher });
    expect(
      await client.get("/api/v1/courses", {
        "state[]": ["available"],
        "include[]": ["syllabus_body", "term"],
        per_page: 100,
      }),
    ).toEqual({ id: "1" });
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin).toBe(config.baseUrl);
    expect(url.searchParams.getAll("include[]")).toEqual([
      "syllabus_body",
      "term",
    ]);
    expect(url.search).not.toContain(config.accessToken);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private-token",
    );
    expect(new Headers(init?.headers).get("accept")).toContain(
      "application/json",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

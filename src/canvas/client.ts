import { validateBaseUrl, type Config } from "../config.js";
import { BearerTokenAuth, type AuthProvider } from "./auth.js";

export type Query = Record<string, string | number | boolean | string[]>;
export interface MetadataLogger {
  debug(metadata: Record<string, unknown>, message?: string): void;
  warn(metadata: Record<string, unknown>, message?: string): void;
}
export interface CanvasClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  auth?: AuthProvider;
  logger?: MetadataLogger;
  maxPages?: number;
}

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  // Commas inside URI references and quoted parameters are not separators.
  const entries = header.match(/<[^>]*>(?:[^,"<]|"(?:\\.|[^"\\])*")*/g) ?? [];
  for (const entry of entries) {
    const target = /^<([^>]*)>/.exec(entry)?.[1];
    const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(entry);
    if ((relation?.[1] ?? relation?.[2] ?? "").split(/\s+/).includes("next"))
      return target;
  }
  return undefined;
}

const MAX_RETRY_DELAY_MS = 60000;
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds)
    ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds))
    : undefined;
}
function numericHeader(headers: Headers, key: string): number | undefined {
  const value = headers.get(key);
  return value !== null && value.trim() !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
}

export class CanvasClient {
  private readonly fetcher: typeof fetch;
  readonly #auth: AuthProvider;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: MetadataLogger;

  constructor(
    config: Pick<
      Config,
      "baseUrl" | "accessToken" | "timeoutMs" | "maxRetries"
    >,
    options: CanvasClientOptions = {},
  ) {
    this.baseUrl = validateBaseUrl(config.baseUrl);
    this.#auth = options.auth ?? new BearerTokenAuth(config.accessToken);
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    this.maxPages = options.maxPages ?? 10000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 300000 ||
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > 10 ||
      !Number.isSafeInteger(this.maxPages) ||
      this.maxPages < 1
    )
      throw new Error("Invalid Canvas client limits");
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private url(path: string, query?: Query): URL {
    try {
      if (path !== path.trim() || /[\\\x00-\x20\x7f]/.test(path))
        throw new Error();
      const url = new URL(path, this.baseUrl);
      // Check the decoded path as well as the URL parser's normalized path. Do
      // not permit ambiguous separators/double-encoding to reach a proxy/router.
      if (/%(?:2f|5c|25)/i.test(url.pathname)) throw new Error();
      const decoded = decodeURIComponent(url.pathname);
      if (
        url.origin !== this.baseUrl ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !decoded.startsWith("/api/v1/")
      )
        throw new Error();
      for (const [key, value] of Object.entries(query ?? {})) {
        for (const item of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, String(item));
      }
      for (const key of url.searchParams.keys()) {
        if (/^(access_token|authorization|as_user_id)(?:\[.*\])?$/i.test(key))
          throw new Error();
      }
      return url;
    } catch {
      throw new Error("Unsafe Canvas URL");
    }
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const url = this.url(path, query);
    return (await this.request<T>(url)).data;
  }

  async *paginate<T>(path: string, query?: Query): AsyncIterable<T> {
    let url: URL | undefined = this.url(path, query);
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url.href))
        throw new CanvasError("Canvas pagination loop detected");
      if (seen.size >= this.maxPages)
        throw new CanvasError("Canvas pagination page limit exceeded");
      seen.add(url.href);
      const { data, headers } = await this.request<unknown>(url);
      if (!Array.isArray(data))
        throw new CanvasError("Expected Canvas collection array");
      for (const item of data) yield item as T;
      const link = nextLink(headers.get("link"));
      url = link === undefined ? undefined : this.url(link);
    }
  }

  private async request<T>(url: URL): Promise<{ data: T; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = Date.now();
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new CanvasError("Canvas request timed out", undefined, true),
            );
          }, this.timeoutMs);
        });
        const work = async () => {
          const response = await this.fetcher(url.href, {
            method: "GET",
            redirect: "error",
            credentials: "omit",
            headers: {
              Authorization: await this.#auth.authorization(),
              Accept: "application/json+canvas-string-ids",
            },
            signal: controller.signal,
          });
          this.logger?.debug(
            {
              status: response.status,
              attempt,
              durationMs: Date.now() - start,
              requestCost: numericHeader(response.headers, "x-request-cost"),
              rateLimitRemaining: numericHeader(
                response.headers,
                "x-rate-limit-remaining",
              ),
            },
            "Canvas response",
          );
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw new CanvasError(
              `Canvas HTTP ${response.status}`,
              response.status,
              response.status === 429 || response.status >= 500,
              retryAfter(response.headers.get("retry-after")),
            );
          }
          try {
            return {
              data: (await response.json()) as T,
              headers: response.headers,
            };
          } catch (error) {
            if (error instanceof SyntaxError)
              throw new CanvasError("Invalid Canvas JSON response");
            throw error;
          }
        };
        return await Promise.race([work(), timeout]);
      } catch (error) {
        const safeError =
          error instanceof CanvasError
            ? error
            : new CanvasError(
                controller.signal.aborted
                  ? "Canvas request timed out"
                  : "Canvas network request failed",
                undefined,
                true,
              );
        if (!safeError.retryable || attempt >= this.maxRetries) throw safeError;
        const delayMs =
          safeError.retryAfterMs ??
          Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
        this.logger?.warn(
          { status: safeError.status, attempt, delayMs },
          "Canvas retry",
        );
        clearTimeout(timer);
        await this.sleep(delayMs);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

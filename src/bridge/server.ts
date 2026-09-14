import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import {
  BridgeError,
  responseSchema,
  validateOperation,
  type BridgeSettings,
  type BrowserResult,
  type BridgeOperation,
} from "./protocol.js";
import { checkSettings, loadCredentials, saveCredentials } from "./state.js";

export interface BridgeServer {
  port: number;
  readonly pairingCode: string;
  close(): Promise<void>;
  status(): Record<string, unknown>;
}
const extensionOriginSchema = z
  .string()
  .regex(
    /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
const pairSchema = z
  .object({
    protocolVersion: z.literal(1),
    code: z.string().max(128),
    extensionOrigin: extensionOriginSchema,
  })
  .strict();
function equalSecret(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
async function readJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new BridgeError(
      "invalid_request",
      "Send application/json.",
      false,
      415,
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new BridgeError(
        "request_too_large",
        "Bridge request exceeds the size limit.",
        false,
        413,
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError(
      "invalid_request",
      "Send a valid JSON object.",
      false,
      400,
    );
  }
}
export async function startBridge(
  settings: BridgeSettings,
): Promise<BridgeServer> {
  settings = { ...settings };
  checkSettings(settings);
  let credentials = await loadCredentials(settings);
  let pairingCode = "";
  let expires = 0;
  let consumed = false;
  let attempts = 0;
  let attemptWindow = 0;
  function rotate(): { pairingCode: string; expires_at: string } {
    pairingCode = randomBytes(9).toString("base64url");
    expires = Date.now() + 300000;
    consumed = false;
    attempts = 0;
    attemptWindow = Date.now();
    return { pairingCode, expires_at: new Date(expires).toISOString() };
  }
  rotate();
  let port = 0;
  let extension: WebSocket | undefined;
  const pending = new Map<
    string,
    {
      resolve: (result: BrowserResult) => void;
      reject: (error: BridgeError) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const status = (): Record<string, unknown> => ({
    protocolVersion: 1,
    origin: settings.origin,
    connected: extension?.readyState === WebSocket.OPEN,
    port,
    pending: pending.size,
  });
  function disconnect(): void {
    extension = undefined;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new BridgeError(
          "extension_disconnected",
          "Canvas extension disconnected; reconnect it and retry.",
          true,
          503,
        ),
      );
    }
    pending.clear();
  }
  function request(
    operation: BridgeOperation,
    response: ServerResponse,
  ): Promise<BrowserResult> {
    const socket = extension;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new BridgeError(
          "extension_disconnected",
          "Open the Canvas browser extension and connect it to the bridge.",
          true,
          503,
        ),
      );
    if (pending.size >= 32 || socket.bufferedAmount > 1024 * 1024)
      return Promise.reject(
        new BridgeError(
          "bridge_busy",
          "Bridge is at its request limit; retry after pending requests finish.",
          true,
          429,
        ),
      );
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const cleanup = () => {
        pending.delete(requestId);
        clearTimeout(timer);
        response.removeListener("close", aborted);
      };
      const fail = (error: BridgeError) => {
        cleanup();
        reject(error);
      };
      const aborted = () =>
        fail(
          new BridgeError(
            "client_disconnected",
            "Local bridge caller disconnected.",
            false,
          ),
        );
      const timer = setTimeout(
        () =>
          fail(
            new BridgeError(
              "bridge_timeout",
              "Canvas extension did not respond in time; check the Canvas tab and retry.",
              true,
              504,
            ),
          ),
        settings.timeoutMs ?? 30000,
      );
      pending.set(requestId, {
        resolve(result) {
          cleanup();
          resolve(result);
        },
        reject: fail,
        timer,
      });
      response.once("close", aborted);
      socket.send(
        JSON.stringify({ protocolVersion: 1, requestId, operation }),
        (error) => {
          if (error)
            fail(
              new BridgeError(
                "extension_disconnected",
                "Canvas extension disconnected; reconnect and retry.",
                true,
              ),
            );
        },
      );
    });
  }
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.headers.host !== `127.0.0.1:${port}`)
      throw new BridgeError("forbidden", "Invalid loopback Host.", false, 403);
    if (req.url === "/pair") {
      const origin = extensionOriginSchema.safeParse(req.headers.origin);
      if (!origin.success)
        throw new BridgeError(
          "forbidden",
          "Pair from a browser extension origin.",
          false,
          403,
        );
      res.setHeader("Access-Control-Allow-Origin", origin.data);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        if (
          req.headers["access-control-request-method"] !== "POST" ||
          (req.headers["access-control-request-headers"] ?? "")
            .toString()
            .toLowerCase()
            .split(",")
            .some((h) => h.trim() && h.trim() !== "content-type")
        )
          throw new BridgeError(
            "forbidden",
            "Unsupported preflight.",
            false,
            403,
          );
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST")
        throw new BridgeError(
          "invalid_request",
          "Use POST to pair.",
          false,
          405,
        );
      const input = pairSchema.safeParse(await readJson(req, 4096));
      if (!input.success || input.data.extensionOrigin !== origin.data)
        throw new BridgeError(
          "forbidden",
          "Pairing origin mismatch.",
          false,
          403,
        );
      if (Date.now() - attemptWindow >= 60000) {
        attempts = 0;
        attemptWindow = Date.now();
      }
      if (++attempts > 5)
        throw new BridgeError(
          "pairing_rate_limited",
          "Too many pairing attempts; wait a minute or rotate from the CLI.",
          true,
          429,
        );
      if (
        consumed ||
        Date.now() >= expires ||
        !equalSecret(input.data.code, pairingCode)
      )
        throw new BridgeError(
          "pairing_invalid",
          "Pairing code is invalid, expired or already used; generate a new code from the CLI.",
          false,
          401,
        );
      consumed = true;
      const next = {
        ...credentials,
        extensionOrigin: origin.data,
        extensionSecret: randomBytes(32).toString("base64url"),
      };
      await saveCredentials(settings, next);
      credentials = next;
      for (const socket of ws.clients) socket.terminate();
      disconnect();
      send(res, 200, {
        protocolVersion: 1,
        extensionSecret: credentials.extensionSecret,
        origin: settings.origin,
      });
      return;
    }
    if (req.headers.origin !== undefined)
      throw new BridgeError(
        "forbidden",
        "Browser origins cannot use CLI endpoints.",
        false,
        403,
      );
    if (
      !equalSecret(req.headers["x-canvas-bridge-key"], credentials.clientSecret)
    )
      throw new BridgeError(
        "bridge_unauthorized",
        "Use the private bridge state credentials.",
        false,
        401,
      );
    if (req.method === "GET" && req.url === "/status") send(res, 200, status());
    else if (req.method === "POST" && req.url === "/pairing")
      send(res, 200, rotate());
    else if (req.method === "POST" && req.url === "/request")
      send(
        res,
        200,
        await request(validateOperation(await readJson(req, 256 * 1024)), res),
      );
    else
      throw new BridgeError(
        "not_found",
        "Unknown bridge endpoint.",
        false,
        404,
      );
  }
  const http = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const safe =
        error instanceof BridgeError
          ? error
          : new BridgeError(
              "bridge_error",
              "Bridge request failed.",
              false,
              500,
            );
      if (!res.destroyed && !res.headersSent)
        send(res, safe.status ?? 400, {
          error: {
            code: safe.code,
            message: safe.message,
            retryable: safe.retryable,
          },
        });
    });
  });
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: 12 * 1024 * 1024,
    perMessageDeflate: false,
  });
  http.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/extension" ||
      req.headers.host !== `127.0.0.1:${port}` ||
      !credentials.extensionOrigin ||
      req.headers.origin !== credentials.extensionOrigin
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    ws.handleUpgrade(req, socket, head, (connection) =>
      ws.emit("connection", connection),
    );
  });
  const helloSchema = z
    .object({
      protocolVersion: z.literal(1),
      type: z.literal("hello"),
      extensionSecret: z.string().max(128),
    })
    .strict();
  const pingSchema = z
    .object({
      protocolVersion: z.literal(1),
      type: z.literal("ping"),
    })
    .strict();
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const socket of ws.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, 20000);
  heartbeat.unref();
  ws.on("connection", (socket: WebSocket) => {
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    let authenticated = false;
    const helloTimer = setTimeout(() => socket.terminate(), 3000);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (extension === socket) disconnect();
    });
    socket.on("message", (raw, binary) => {
      let input: unknown;
      try {
        if (binary) throw new Error("binary");
        input = JSON.parse(raw.toString());
      } catch {
        socket.terminate();
        return;
      }
      if (!authenticated) {
        const hello = helloSchema.safeParse(input);
        if (
          !hello.success ||
          !equalSecret(hello.data.extensionSecret, credentials.extensionSecret)
        ) {
          socket.terminate();
          return;
        }
        authenticated = true;
        clearTimeout(helloTimer);
        if (extension) {
          extension.terminate();
          disconnect();
        }
        extension = socket;
        socket.send(
          JSON.stringify({
            protocolVersion: 1,
            type: "ready",
            origin: settings.origin,
          }),
        );
        return;
      }
      // The extension sends a JSON keep-alive ping every twenty seconds so the
      // MV3 service worker stays awake. Answer it with a JSON pong instead of
      // failing responseSchema validation and terminating a healthy socket.
      if (pingSchema.safeParse(input).success) {
        socket.send(JSON.stringify({ protocolVersion: 1, type: "pong" }));
        return;
      }
      const parsed = responseSchema.safeParse(input);
      if (!parsed.success) {
        socket.terminate();
        return;
      }
      const response = parsed.data;
      const entry = pending.get(response.requestId);
      if (!entry || extension !== socket) return;
      pending.delete(response.requestId);
      clearTimeout(entry.timer);
      if (response.ok) {
        const { status } = response.result;
        if (status === 401)
          entry.reject(
            new BridgeError(
              "canvas_authentication_required",
              "Sign in to Canvas in your browser, then retry.",
              false,
              status,
            ),
          );
        else if (status === 403)
          entry.reject(
            new BridgeError(
              "canvas_permission_denied",
              "Canvas denied permission to read this resource.",
              false,
              status,
            ),
          );
        else if (status === 429)
          entry.reject(
            new BridgeError(
              "canvas_rate_limited",
              "Canvas is rate limiting requests; retry later.",
              true,
              status,
            ),
          );
        else if (status >= 500)
          entry.reject(
            new BridgeError(
              "canvas_unavailable",
              "Canvas is temporarily unavailable; retry later.",
              true,
              status,
            ),
          );
        else if (status >= 400)
          entry.reject(
            new BridgeError(
              "canvas_http_error",
              "Canvas could not return this resource.",
              false,
              status,
            ),
          );
        else entry.resolve(response.result);
      } else
        entry.reject(
          new BridgeError(
            response.error.code,
            response.error.message,
            response.error.retryable,
          ),
        );
    });
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  http.timeout = (settings.timeoutMs ?? 30000) + 5000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(settings.port ?? 47821, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new BridgeError(
      "bridge_disconnected",
      "Bridge could not listen.",
      true,
    );
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    port,
    get pairingCode() {
      return pairingCode;
    },
    status,
    close() {
      return (closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        disconnect();
        for (const socket of ws.clients) socket.terminate();
        ws.close();
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }));
    },
  };
}

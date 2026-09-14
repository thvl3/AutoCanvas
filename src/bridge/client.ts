import { z } from "zod";
import {
  BridgeError,
  browserResultSchema,
  validateOperation,
  type BridgeSettings,
  type BridgeOperation,
  type BrowserResult,
} from "./protocol.js";
import { checkSettings, readCredentials } from "./state.js";

const statusSchema = z
  .object({
    protocolVersion: z.literal(1),
    origin: z.string(),
    connected: z.boolean(),
    port: z.number().int(),
    pending: z.number().int().optional(),
  })
  .strict();
const pairingSchema = z
  .object({
    pairingCode: z.string().regex(/^[A-Za-z0-9_-]{12,}$/),
    expires_at: z.iso.datetime(),
  })
  .strict();
const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string().max(100),
        message: z.string().max(1024),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
function protocolError(): BridgeError {
  return new BridgeError(
    "bridge_protocol_error",
    "Local bridge returned an invalid response.",
    false,
  );
}

export class BridgeClient {
  readonly #settings: BridgeSettings;
  constructor(settings: BridgeSettings) {
    checkSettings(settings);
    this.#settings = { ...settings };
  }
  async #call(path: string, body?: unknown): Promise<unknown> {
    try {
      // Do not cache credentials: a daemon restart or re-pair may replace private state.
      const credentials = await readCredentials(this.#settings);
      const response = await fetch(
        `http://127.0.0.1:${this.#settings.port ?? 47821}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "X-Canvas-Bridge-Key": credentials.clientSecret,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(
            (this.#settings.timeoutMs ?? 30000) + 1000,
          ),
          redirect: "error",
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw protocolError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 12 * 1024 * 1024) {
            await reader.cancel();
            throw new BridgeError(
              "bridge_response_too_large",
              "Local bridge response exceeds the size limit.",
              false,
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw protocolError();
      }
      if (!response.ok) {
        const parsed = errorSchema.safeParse(data);
        if (!parsed.success) throw protocolError();
        const { error } = parsed.data;
        throw new BridgeError(
          error.code,
          error.message,
          error.retryable,
          response.status,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        "bridge_disconnected",
        "Start the local Canvas bridge and retry.",
        true,
      );
    }
  }
  async request(operation: BridgeOperation): Promise<BrowserResult> {
    const parsed = browserResultSchema.safeParse(
      await this.#call("/request", validateOperation(operation)),
    );
    if (!parsed.success) throw protocolError();
    return parsed.data;
  }
  async pair(): Promise<{ pairingCode: string; expires_at: string }> {
    const parsed = pairingSchema.safeParse(await this.#call("/pairing", {}));
    if (!parsed.success) throw protocolError();
    return parsed.data;
  }
  async status(): Promise<Record<string, unknown>> {
    const parsed = statusSchema.safeParse(await this.#call("/status"));
    if (!parsed.success || parsed.data.origin !== this.#settings.origin)
      throw protocolError();
    return parsed.data;
  }
}

import {
  BridgeError,
  requestSchema,
  responseSchema,
  validateOperation,
  type BridgeResponse,
} from "../../src/bridge/protocol.js";
import { executeInCanvas } from "./executor.js";

export type ExecutionApi = Pick<typeof chrome, "tabs" | "scripting">;
export async function executeRequest(
  api: ExecutionApi,
  origin: string,
  input: unknown,
): Promise<BridgeResponse> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw new BridgeError(
      "invalid_operation",
      "Only bounded, typed Canvas read operations are permitted.",
    );
  const request = parsed.data;
  const operation = validateOperation(request.operation);
  try {
    const tabs = await api.tabs.query({ url: `${origin}/*` });
    const tab = tabs
      .filter((tab) => {
        try {
          return (
            tab.id !== undefined && new URL(tab.url ?? "").origin === origin
          );
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(b.active) - Number(a.active))[0];
    if (!tab)
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        ok: false,
        error: {
          code: "canvas_not_open",
          message:
            "Open the configured Canvas site in a tab and sign in normally.",
          retryable: false,
        },
      };
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      world: "MAIN",
      func: executeInCanvas,
      args: [origin, operation],
    });
    const raw =
      results.length === 1 && results[0]?.frameId === 0
        ? results[0].result
        : undefined;
    if (
      raw &&
      typeof raw === "object" &&
      !("requestId" in raw) &&
      !("protocolVersion" in raw)
    ) {
      const parsed = responseSchema.safeParse({
        ...raw,
        protocolVersion: 1,
        requestId: request.requestId,
      });
      if (parsed.success) return parsed.data;
    }
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "canvas_invalid_response",
        message: "Canvas returned an invalid result. Reload the tab and retry.",
        retryable: false,
      },
    };
  } catch {
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "canvas_execution_failed",
        message:
          "Cannot read the Canvas tab. Check extension site permission, reload the tab, and retry.",
        retryable: true,
      },
    };
  }
}

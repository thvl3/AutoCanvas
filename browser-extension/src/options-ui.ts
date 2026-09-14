import {
  DEFAULT_ORIGIN,
  DEFAULT_PORT,
  pairCanvas,
  pairingSchema,
} from "./settings.js";
import { getExtensionApi } from "./platform.js";

export async function installOptions(
  doc: Document = document,
  api = getExtensionApi(),
  fetcher = fetch,
  extensionOrigin = location.origin,
): Promise<void> {
  const origin = doc.getElementById("origin") as HTMLInputElement;
  const port = doc.getElementById("port") as HTMLInputElement;
  const code = doc.getElementById("code") as HTMLInputElement;
  const status = doc.getElementById("status")!;
  const pair = doc.getElementById("pair") as HTMLButtonElement;
  origin.value = DEFAULT_ORIGIN;
  port.value = String(DEFAULT_PORT);
  const stored = pairingSchema.safeParse(
    (await api.storage.local.get("pairing")).pairing,
  );
  if (stored.success) {
    origin.value = stored.data.origin;
    port.value = String(stored.data.port);
  }
  const statuses: Record<string, string> = {
    canvas_not_open:
      "Open the configured Canvas site in this browser, sign in normally, and retry your Canvas command.",
    canvas_authentication_required:
      "Sign in normally in the Canvas tab, then retry your Canvas command.",
    canvas_permission_denied:
      "Canvas denied access to this resource. Check course access in Canvas.",
    canvas_execution_failed:
      "Check the extension site permission, reload the Canvas tab, and retry.",
    connected:
      "Connected to the local bridge. Keep your signed-in Canvas tab open.",
    connecting: "Connecting to the local bridge…",
    disconnected:
      "Disconnected. Start the local bridge, verify its port, then reconnect.",
    unpaired:
      "Not paired. Start the local bridge and enter its current pairing code.",
    pairing_required:
      "Pairing does not match. Generate a fresh bridge code and pair again.",
    protocol_error:
      "Bridge protocol mismatch. Update both the local bridge and extension, then reconnect.",
  };
  async function showStatus(type: "status" | "reconnect"): Promise<void> {
    try {
      const reply = (await api.runtime.sendMessage({ type })) as {
        state?: string;
        lastError?: string;
      };
      status.textContent =
        (reply?.state === "connected" && reply.lastError
          ? statuses[reply.lastError]
          : undefined) ??
        statuses[reply?.state ?? ""] ??
        "Bridge status unavailable. Reload the extension.";
    } catch {
      status.textContent =
        "Background unavailable. Reload the extension and retry.";
    }
  }
  doc
    .getElementById("refresh")!
    .addEventListener("click", () => showStatus("status"));
  doc
    .getElementById("reconnect")!
    .addEventListener("click", () => showStatus("reconnect"));
  doc.getElementById("pair-form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    pair.disabled = true;
    const input = {
      origin: origin.value,
      port: Number(port.value),
      code: code.value,
      extensionOrigin,
    };
    code.value = "";
    try {
      await pairCanvas(api, fetcher, input);
      status.textContent =
        "Paired. Keep your signed-in Canvas tab open. Use Refresh status to check the connection.";
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Pairing failed. Check the bridge and generate a new pairing code.";
    } finally {
      pair.disabled = false;
    }
  });
}

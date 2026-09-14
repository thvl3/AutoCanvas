import { pairingSchema } from "./settings.js";
import { executeRequest, type ExecutionApi } from "./controller.js";
export type ConnectionApi = ExecutionApi &
  Pick<typeof chrome, "storage" | "alarms">;

export class BridgeConnection {
  private socket?: WebSocket;
  private generation = 0;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private retry = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private state = "unpaired";
  private origin?: string;
  private lastError?: string;
  constructor(
    private api: ConnectionApi,
    private createSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
  ) {}
  status(): { state: string; origin?: string; lastError?: string } {
    return {
      state: this.state,
      ...(this.origin ? { origin: this.origin } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  async start(): Promise<void> {
    if (this.connecting || this.socket) return;
    this.connecting = true;
    const generation = this.generation;
    const stored = await this.api.storage.local.get("pairing");
    if (generation !== this.generation) return;
    const parsed = pairingSchema.safeParse(stored.pairing);
    this.connecting = false;
    if (!parsed.success) {
      this.state = "unpaired";
      return;
    }
    const pairing = parsed.data;
    this.origin = pairing.origin;
    this.state = "connecting";
    const socket = this.createSocket(
      `ws://127.0.0.1:${pairing.port}/extension`,
    );
    this.socket = socket;
    this.helloTimer = setTimeout(() => {
      if (this.socket === socket && this.state !== "connected") socket.close();
    }, 10000);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      clearInterval(this.heartbeat);
      clearTimeout(this.helloTimer);
      this.state = "disconnected";
      void this.api.alarms.create("canvas-bridge-reconnect", {
        periodInMinutes: 1,
      });
      this.retryTimer = setTimeout(
        () => {
          void this.start().catch(() => this.stop());
        },
        Math.min(30000, 1000 * 2 ** this.retry++),
      );
    };
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          type: "hello",
          extensionSecret: pairing.extensionSecret,
        }),
      );
    socket.onmessage = async (event) => {
      if (this.socket !== socket) return;
      try {
        if (
          typeof event.data !== "string" ||
          new TextEncoder().encode(event.data).length > 256 * 1024
        )
          throw new Error("invalid_frame");
        const message = JSON.parse(event.data as string) as {
          protocolVersion?: number;
          type?: string;
          origin?: string;
        };
        if (this.state !== "connected") {
          if (
            message.protocolVersion !== 1 ||
            message.type !== "ready" ||
            message.origin !== pairing.origin
          ) {
            this.stop();
            this.state = "pairing_required";
            return;
          }
          clearTimeout(this.helloTimer);
          this.state = "connected";
          this.retry = 0;
          this.heartbeat = setInterval(() => {
            if (this.socket === socket && socket.readyState === 1)
              socket.send(JSON.stringify({ protocolVersion: 1, type: "ping" }));
          }, 20000);
          return;
        }
        if (message.protocolVersion === 1 && message.type === "pong") return;
        if (this.state === "connected") {
          const response = await executeRequest(
            this.api,
            pairing.origin,
            message,
          );
          this.lastError = response.ok ? undefined : response.error.code;
          let frame = JSON.stringify(response);
          if (new TextEncoder().encode(frame).length > 12 * 1024 * 1024)
            frame = JSON.stringify({
              protocolVersion: 1,
              requestId: response.requestId,
              ok: false,
              error: {
                code: "canvas_response_too_large",
                message: "Canvas result exceeds the 12 MiB transport limit.",
                retryable: false,
              },
            });
          if (this.socket === socket && socket.readyState === 1)
            socket.send(frame);
        }
      } catch {
        if (this.socket === socket) {
          this.stop();
          this.state = "protocol_error";
        }
      }
    };
  }
  stop(): void {
    this.generation++;
    this.connecting = false;
    clearTimeout(this.helloTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.state = "disconnected";
  }
}

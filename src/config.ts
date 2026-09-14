import { resolve } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.js";

export interface Config {
  baseUrl: string;
  /** Only populated by explicit legacy-pat configuration. */
  accessToken: string;
  provider?: "browser" | "mock" | "legacy-pat";
  bridgeHost?: "127.0.0.1";
  bridgePort?: number;
  bridgeStateDir?: string;
  dbPath: string;
  workspaceRoot: string;
  timezone: string;
  timeoutMs: number;
  maxRetries: number;
  maxDownloadBytes: number;
  downloadHosts: string[];
  logLevel: string;
  syncConcurrency: number;
}

export function validateBaseUrl(value: unknown): string {
  try {
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      /[\\\r\n\t]/.test(value)
    )
      throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      "Invalid configuration: CANVAS_BASE_URL must be an HTTPS origin",
    );
  }
}

export function validateAccessToken(value: unknown): string {
  if (typeof value !== "string" || !value.length || /\s/.test(value)) {
    throw new Error(
      "Invalid configuration: CANVAS_ACCESS_TOKEN is required and must not contain whitespace",
    );
  }
  return value;
}

const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const settingsSchema = z.object({
  CANVAS_PROVIDER: z.enum(["browser", "mock", "legacy-pat"]).default("browser"),
  CANVAS_BRIDGE_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  CANVAS_BRIDGE_PORT: integer(47821, 1, 65535),
  CANVAS_BRIDGE_STATE_DIR: z
    .string()
    .min(1)
    .default(resolve(dataDir(), "bridge")),
  CANVAS_DB_PATH: z
    .string()
    .min(1)
    .default(resolve(dataDir(), "canvas.sqlite")),
  CANVAS_WORKSPACE_ROOT: z
    .string()
    .min(1)
    .default(resolve(dataDir(), "workspaces")),
  CANVAS_TIMEZONE: z
    .string()
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    })
    .default("UTC"),
  CANVAS_TIMEOUT_MS: integer(30000, 1, 300000),
  CANVAS_MAX_RETRIES: integer(3, 0, 10),
  CANVAS_MAX_DOWNLOAD_BYTES: integer(52428800, 1, Number.MAX_SAFE_INTEGER),
  CANVAS_SYNC_CONCURRENCY: integer(4, 1, 32),
  CANVAS_DOWNLOAD_HOSTS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    )
    .refine((hosts) =>
      hosts.every(
        (host) =>
          /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) &&
          !host.includes(".."),
      ),
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = validateBaseUrl(env.CANVAS_BASE_URL);
  const result = settingsSchema.safeParse(env);
  if (!result.success) {
    // Never propagate Zod input/issues: an invalid value may itself be a secret.
    throw new Error(
      `Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path[0]))].join(", ")}`,
    );
  }
  const settings = result.data;
  return {
    baseUrl,
    accessToken:
      settings.CANVAS_PROVIDER === "legacy-pat"
        ? validateAccessToken(env.CANVAS_ACCESS_TOKEN)
        : "",
    provider: settings.CANVAS_PROVIDER,
    bridgeHost: settings.CANVAS_BRIDGE_HOST,
    bridgePort: settings.CANVAS_BRIDGE_PORT,
    bridgeStateDir: resolve(settings.CANVAS_BRIDGE_STATE_DIR),
    dbPath: resolve(settings.CANVAS_DB_PATH),
    workspaceRoot: resolve(settings.CANVAS_WORKSPACE_ROOT),
    timezone: settings.CANVAS_TIMEZONE,
    timeoutMs: settings.CANVAS_TIMEOUT_MS,
    maxRetries: settings.CANVAS_MAX_RETRIES,
    maxDownloadBytes: settings.CANVAS_MAX_DOWNLOAD_BYTES,
    downloadHosts: settings.CANVAS_DOWNLOAD_HOSTS.map((host) =>
      host.toLowerCase(),
    ),
    logLevel: settings.LOG_LEVEL,
    syncConcurrency: settings.CANVAS_SYNC_CONCURRENCY,
  };
}

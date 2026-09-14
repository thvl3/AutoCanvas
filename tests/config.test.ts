import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("rejects insecure or credential-bearing origins and invalid settings without echoing secrets", () => {
    for (const baseUrl of [
      "http://canvas.example",
      "https://user:password@canvas.example",
      "https://canvas.example/path",
      "https://canvas.example?secret=private-token",
      "bad-private-token",
    ]) {
      expect(() =>
        loadConfig({
          CANVAS_BASE_URL: baseUrl,
          CANVAS_ACCESS_TOKEN: "private-token",
        }),
      ).toThrow(/CANVAS_BASE_URL/);
      try {
        loadConfig({
          CANVAS_BASE_URL: baseUrl,
          CANVAS_ACCESS_TOKEN: "private-token",
        });
      } catch (error) {
        expect(String(error)).not.toMatch(/private-token|password/);
      }
    }
    expect(() => loadConfig({})).toThrow(/CANVAS_BASE_URL/);
    expect(() =>
      loadConfig({
        CANVAS_BASE_URL: "https://canvas.example",
        CANVAS_ACCESS_TOKEN: "token\nsecret",
        CANVAS_PROVIDER: "legacy-pat",
      }),
    ).toThrow(/CANVAS_ACCESS_TOKEN/);
    for (const extra of [
      { CANVAS_TIMEOUT_MS: "0" },
      { CANVAS_MAX_RETRIES: "-1" },
      { CANVAS_MAX_RETRIES: "50" },
      { CANVAS_SYNC_CONCURRENCY: "1.5" },
      { CANVAS_MAX_DOWNLOAD_BYTES: "NaN" },
      { CANVAS_TIMEZONE: "Unknown/Zone" },
      { LOG_LEVEL: "garbage" },
      { CANVAS_DOWNLOAD_HOSTS: "*.evil.com" },
    ]) {
      expect(() =>
        loadConfig({
          CANVAS_BASE_URL: "https://canvas.example",
          CANVAS_ACCESS_TOKEN: "token",
          ...extra,
        }),
      ).toThrow(/Invalid configuration/);
    }
  });
  it("loads explicit runtime limits and paths", () => {
    expect(
      loadConfig({
        CANVAS_BASE_URL: "https://canvas.example",
        CANVAS_ACCESS_TOKEN: "token",
        CANVAS_TIMEOUT_MS: "50",
        CANVAS_MAX_RETRIES: "0",
        CANVAS_MAX_DOWNLOAD_BYTES: "1024",
        CANVAS_DOWNLOAD_HOSTS: "cdn.example, files.example",
        CANVAS_SYNC_CONCURRENCY: "2",
        CANVAS_DB_PATH: "./custom.sqlite",
        CANVAS_WORKSPACE_ROOT: "./custom-work",
        CANVAS_TIMEZONE: "America/Denver",
        LOG_LEVEL: "debug",
      }),
    ).toMatchObject({
      timeoutMs: 50,
      maxRetries: 0,
      maxDownloadBytes: 1024,
      downloadHosts: ["cdn.example", "files.example"],
      syncConcurrency: 2,
      dbPath: resolve("custom.sqlite"),
      workspaceRoot: resolve("custom-work"),
      timezone: "America/Denver",
      logLevel: "debug",
    });
  });
  it("loads explicit legacy secrets with safe defaults", () => {
    const config = loadConfig({
      CANVAS_BASE_URL: "https://canvas.example/",
      CANVAS_PROVIDER: "legacy-pat",
      CANVAS_ACCESS_TOKEN: "private-token",
    });
    expect(config).toMatchObject({
      baseUrl: "https://canvas.example",
      accessToken: "private-token",
      dbPath: resolve("data/canvas.sqlite"),
      workspaceRoot: resolve("workspaces"),
      timezone: "UTC",
      timeoutMs: 30000,
      maxRetries: 3,
      maxDownloadBytes: 52428800,
      downloadHosts: [],
      logLevel: "info",
      syncConcurrency: 4,
    });
  });
});

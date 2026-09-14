import { describe, expect, it } from "vitest";
import {
  configPaths,
  mcpServerEntry,
  mergeMcpConfig,
} from "../scripts/install.mjs";

describe("installer MCP registration", () => {
  it("builds a stdio entry with absolute paths and browser provider", () => {
    const entry = mcpServerEntry("https://byui.instructure.com", "/app");
    expect(entry.command).toBe("node");
    expect(entry.args[0]).toContain("/app/dist/cli/index.js");
    expect(entry.args[1]).toBe("serve");
    expect(entry.env).toMatchObject({
      CANVAS_BASE_URL: "https://byui.instructure.com",
      CANVAS_PROVIDER: "browser",
    });
    expect(entry.env.CANVAS_DB_PATH).toContain("/app/data");
    expect(entry.env.CANVAS_WORKSPACE_ROOT).toContain("/app/workspaces");
  });
  it("merges without clobbering other servers and is idempotent", () => {
    const entry = mcpServerEntry("https://byui.instructure.com", "/app");
    const merged = mergeMcpConfig(
      { mcpServers: { other: { command: "x", args: [] } } },
      entry,
    );
    expect(merged.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(merged.mcpServers.canvas).toEqual(entry);
    expect(mergeMcpConfig(merged, entry)).toBeNull();
  });
  it("overwrites a stale canvas entry with the fresh one", () => {
    const entry = mcpServerEntry("https://new.instructure.com", "/app");
    const merged = mergeMcpConfig(
      { mcpServers: { canvas: { stale: true } } },
      entry,
    );
    expect(merged.mcpServers.canvas).toEqual(entry);
  });
  it("uses platform-specific Claude Desktop and Cursor paths", () => {
    expect(
      configPaths("win32", "C:/Users/u", "C:/Users/u/AppData/Roaming")[0][1],
    ).toContain("AppData/Roaming/Claude/claude_desktop_config.json");
    expect(configPaths("darwin", "/Users/u")[0][1]).toContain(
      "Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(configPaths("linux", "/home/u")[0][1]).toContain(
      ".config/Claude/claude_desktop_config.json",
    );
    for (const platformName of ["win32", "darwin", "linux"])
      expect(configPaths(platformName, "/home/u")[1][1]).toContain(
        ".cursor/mcp.json",
      );
  });
});

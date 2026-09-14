import { afterEach, describe, expect, it, vi } from "vitest";
import { assetName, checkForUpdates, newer } from "../src/services/updates.js";

afterEach(() => vi.unstubAllGlobals());

describe("updates", () => {
  it("compares x.y.z versions numerically", () => {
    expect(newer("0.1.1", "0.1.0")).toBe(true);
    expect(newer("0.2.0", "0.1.9")).toBe(true);
    expect(newer("1.0.0", "0.9.9")).toBe(true);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
    expect(newer("0.1.0", "0.1.1")).toBe(false);
    expect(newer("0.0.9", "0.0.10")).toBe(false);
  });

  it("names the release asset for this platform", () => {
    expect(assetName()).toMatch(
      /^canvas-mcp-(windows|macos|linux)-[a-z0-9_]+(\.exe)?$/,
    );
  });

  it("reports an available update from the latest GitHub release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.1.1",
          body: "release notes",
          assets: [
            {
              name: assetName(),
              browser_download_url: "https://example.com/x",
            },
          ],
        }),
      })),
    );
    const info = await checkForUpdates();
    expect(info.available).toBe(true);
    expect(info.latestVersion).toBe("0.1.1");
    expect(info.downloadUrl).toBe("https://example.com/x");
  });

  it("reports no update when the latest release has no asset for this platform", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          tag_name: "v0.1.1",
          assets: [
            { name: "canvas-mcp-other-arch", browser_download_url: "x" },
          ],
        }),
      })),
    );
    const info = await checkForUpdates();
    expect(info.available).toBe(false);
  });

  it("surfaces an error instead of throwing when GitHub is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const info = await checkForUpdates();
    expect(info.available).toBe(false);
    expect(info.error).toBe("network down");
  });
});

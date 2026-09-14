import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("../", import.meta.url));
it("builds Firefox event-page and Chromium MV3 bundles with narrow permissions", () => {
  expect(
    existsSync(`${root}scripts/build-extension.mjs`),
    "extension build script exists",
  ).toBe(true);
  execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
  for (const target of ["dist", "dist-firefox"]) {
    const directory = `${root}browser-extension/${target}`;
    const manifest = JSON.parse(
      readFileSync(`${directory}/manifest.json`, "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "scripting", "alarms"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*"]);
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(readFileSync(`${directory}/options.html`, "utf8")).toContain(
      "pair-form",
    );
    expect(readFileSync(`${directory}/background.js`, "utf8")).toContain(
      "ws://127.0.0.1:",
    );
    expect(readFileSync(`${directory}/options.js`, "utf8")).toContain(
      "https://byui.instructure.com",
    );
    if (target === "dist-firefox") {
      expect(manifest.background).toEqual({ scripts: ["background.js"] });
      expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe(
        "142.0",
      );
      expect(manifest.browser_specific_settings.gecko.id).toBe(
        "autocanvas-session@thvl3.github.io",
      );
      expect(
        manifest.browser_specific_settings.gecko.data_collection_permissions,
      ).toEqual({ required: ["none"], technicalData: false });
    } else {
      expect(manifest.background).toEqual({ service_worker: "background.js" });
      expect(manifest.minimum_chrome_version).toBe("116");
    }
  }
}, 30000);

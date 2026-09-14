import { afterEach, expect, it, vi } from "vitest";
async function platform() {
  const module = await import("../browser-extension/src/platform.js").catch(
    () => ({}) as any,
  );
  expect(
    module.getExtensionApi,
    "cross-browser Promise API selection exists",
  ).toBeTypeOf("function");
  return module;
}
afterEach(() => vi.unstubAllGlobals());
it("prefers Firefox browser namespace over callback-style chrome alias", async () => {
  const { getExtensionApi } = await platform();
  const firefox = { runtime: { id: "autocanvas-session@local" } };
  const chrome = { runtime: { id: "chromium" } };
  expect(getExtensionApi({ browser: firefox, chrome })).toBe(firefox);
  expect(getExtensionApi({ chrome })).toBe(chrome);
});

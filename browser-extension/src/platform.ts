export function getExtensionApi(
  scope: {
    browser?: typeof chrome;
    chrome?: typeof chrome;
  } = globalThis as typeof globalThis & { browser?: typeof chrome },
): typeof chrome {
  const api = scope.browser ?? scope.chrome;
  if (!api)
    throw new Error("This page must run inside the Canvas browser extension.");
  return api;
}

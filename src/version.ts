// The running application version. In the standalone executable this is
// injected at bundle time (scripts/build-release.mjs esbuild `define`); the
// source build reports a dev placeholder.
export const APP_VERSION: string =
  typeof __AUTOCANVAS_VERSION__ === "string"
    ? __AUTOCANVAS_VERSION__
    : "0.0.0-dev";

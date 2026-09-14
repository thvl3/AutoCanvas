#!/usr/bin/env node
// Build a single-file executable for the current platform using Node SEA.
// The app is pure JS (node:sqlite is built in), so the installed Node binary
// is copied and the bundled CLI is injected as the SEA blob.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const os = platform();
const arch = process.arch;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const exeName =
  os === "win32"
    ? `canvas-mcp-windows-${arch}.exe`
    : os === "darwin"
      ? `canvas-mcp-macos-${arch}`
      : `canvas-mcp-linux-${arch}`;
const outDir = join(ROOT, "dist", "sea");
const releaseDir = join(ROOT, "release");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(releaseDir, { recursive: true });

// 1. Bundle the CLI (and everything it imports) into a single CJS file.
await build({
  entryPoints: [join(ROOT, "src", "cli", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: join(outDir, "cli.cjs"),
  logLevel: "warning",
});

// 2. Generate the SEA blob.
const seaConfig = join(outDir, "sea-config.json");
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: join(outDir, "cli.cjs"),
      output: join(outDir, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], {
  stdio: "inherit",
});

// 3. Copy the Node binary and inject the blob.
const exe = join(releaseDir, exeName);
copyFileSync(process.execPath, exe);
if (os !== "win32") chmodSync(exe, 0o755);
execFileSync(
  join(
    ROOT,
    "node_modules",
    ".bin",
    os === "win32" ? "postject.cmd" : "postject",
  ),
  [
    exe,
    "NODE_SEA_BLOB",
    join(outDir, "sea-prep.blob"),
    "--sentinel-fuse",
    SEA_FUSE,
  ],
  { stdio: "inherit" },
);

console.log(`Built ${exe}`);

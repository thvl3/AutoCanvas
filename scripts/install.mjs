#!/usr/bin/env node
// Cross-platform installer for AutoCanvas.
//
//   node scripts/install.mjs --base-url https://your.instructure.com
//
// Bootstraps dependencies, builds the app + browser extension, writes .env,
// registers the MCP server with Claude Desktop and Cursor, and prints the
// remaining manual steps (load the extension, pair, keep a Canvas tab open).
//
// Pure Node (no project dependencies), so it runs before `pnpm install`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function mcpServerEntry(baseUrl, root = ROOT) {
  return {
    command: "node",
    args: [join(root, "dist", "cli", "index.js"), "serve"],
    env: {
      CANVAS_BASE_URL: baseUrl,
      CANVAS_PROVIDER: "browser",
      CANVAS_DB_PATH: join(root, "data", "canvas.sqlite"),
      CANVAS_WORKSPACE_ROOT: join(root, "workspaces"),
    },
  };
}

/** Merge the canvas server into an existing JSON config document, preserving
 * every other key. Returns the new document, or null when already identical. */
export function mergeMcpConfig(existing, entry) {
  const config =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  const servers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? { ...config.mcpServers }
      : {};
  if (JSON.stringify(servers.canvas) === JSON.stringify(entry)) return null;
  servers.canvas = entry;
  config.mcpServers = servers;
  return config;
}

export function configPaths(platformName, home, appdata) {
  if (platformName === "win32")
    return [
      [
        "Claude Desktop",
        join(
          appdata ?? join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        ),
      ],
      ["Cursor", join(home, ".cursor", "mcp.json")],
    ];
  if (platformName === "darwin")
    return [
      [
        "Claude Desktop",
        join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        ),
      ],
      ["Cursor", join(home, ".cursor", "mcp.json")],
    ];
  return [
    [
      "Claude Desktop",
      join(home, ".config", "Claude", "claude_desktop_config.json"),
    ],
    ["Cursor", join(home, ".cursor", "mcp.json")],
  ];
}

export function readExistingBaseUrl(root) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, "utf8").match(/^CANVAS_BASE_URL=(.+)$/m);
  return match?.[1]?.trim();
}

function main() {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const flag = (name) => argv.includes(name);
  const dryRun = flag("--dry-run");
  const skipBuild = flag("--skip-build");
  const skipMcp = flag("--skip-mcp");
  const os = platform();
  const baseUrl =
    value("--base-url") ??
    process.env.CANVAS_BASE_URL ??
    readExistingBaseUrl(ROOT);

  const log = (heading, ...lines) =>
    console.log(
      `\n== ${heading} ==${lines.length ? "\n" + lines.join("\n") : ""}`,
    );
  const fail = (message) => {
    console.error(`\nInstall failed: ${message}`);
    process.exit(1);
  };
  const run = (command, args) => {
    if (dryRun) {
      console.log(`(dry-run) ${command} ${args.join(" ")}`);
      return true;
    }
    return (
      spawnSync(command, args, {
        stdio: "inherit",
        cwd: ROOT,
        shell: os === "win32",
      }).status === 0
    );
  };

  if (flag("--help")) {
    console.log(
      [
        "AutoCanvas installer",
        "",
        "Usage: node scripts/install.mjs [options]",
        "  --base-url <https origin>   Canvas origin (or set CANVAS_BASE_URL)",
        "  --skip-build                Skip dependency install and build",
        "  --skip-mcp                  Skip MCP registration",
        "  --dry-run                   Print actions without writing",
        "",
      ].join("\n"),
    );
    return;
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22)
    console.warn(
      `WARNING: Node ${process.versions.node} is below the required 22.12+; install Node 22+ first.`,
    );
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
  } catch {
    fail(
      "pnpm not found. Install it (https://pnpm.io/installation), e.g. `corepack enable`, then re-run.",
    );
  }
  if (!baseUrl)
    fail(
      "Canvas origin required: pass --base-url https://your.instructure.com (or set CANVAS_BASE_URL).",
    );

  if (!skipBuild) {
    log("Installing dependencies", "pnpm install --frozen-lockfile");
    if (!run("pnpm", ["install", "--frozen-lockfile"]))
      fail("pnpm install failed");
    log("Building app and extension", "pnpm build", "pnpm extension:build");
    if (!run("pnpm", ["build"])) fail("pnpm build failed");
    if (!run("pnpm", ["extension:build"])) fail("extension build failed");
  }

  log("Configuration", `Canvas origin: ${baseUrl}`);
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath) && !dryRun)
    writeFileSync(
      envPath,
      `CANVAS_BASE_URL=${baseUrl}\nCANVAS_PROVIDER=browser\n`,
    );
  else if (!existsSync(envPath)) console.log("(dry-run) write .env");

  if (!skipMcp) {
    const entry = mcpServerEntry(baseUrl);
    log("Registering MCP server");
    for (const [name, path] of configPaths(
      os,
      homedir(),
      process.env.APPDATA,
    )) {
      let existing = {};
      if (!dryRun) {
        try {
          existing = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          /* absent or invalid: start fresh */
        }
      }
      const merged = mergeMcpConfig(existing, entry);
      if (merged === null) {
        console.log(`${name}: already registered (${path})`);
        continue;
      }
      if (dryRun) {
        console.log(`(dry-run) register canvas in ${name} at ${path}`);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
      console.log(`Registered "canvas" in ${name}: ${path}`);
    }
    console.log("Restart Claude Desktop / Cursor to pick up the new server.");
  }

  const extension = join(ROOT, "browser-extension");
  log(
    "Next steps",
    "1. Start the bridge and keep it running:",
    "   node dist/cli/index.js bridge start",
    "   (prints a pairing code, expires in 5 minutes)",
    "2. Load the extension:",
    "   Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> " +
      join(extension, "dist-firefox", "manifest.json"),
    "   Chromium: chrome://extensions -> Developer mode -> Load unpacked -> " +
      join(extension, "dist"),
    "3. Open the extension options, paste the pairing code, grant access to your Canvas origin.",
    "4. Keep a signed-in Canvas tab open, then verify:",
    "   node dist/cli/index.js auth status",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

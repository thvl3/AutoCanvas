#!/usr/bin/env node
import "../prelude.js";
import { Command } from "commander";
import { config as dotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createApp, bridgeSettings } from "../app.js";
import { loadConfig, validateBaseUrl, type Config } from "../config.js";
import { startBridge } from "../bridge/server.js";
import { BridgeClient } from "../bridge/client.js";
import { createServer } from "../mcp/server.js";
import { parseTool } from "../services/tools.js";
import { publicData } from "../services/academic.js";
import { startDashboard } from "../ui/dashboard.js";
import { selfInstall, installDirPath } from "../services/install.js";
import { checkForUpdates, applyUpdate } from "../services/updates.js";
import { APP_VERSION } from "../version.js";
import { configFilePath, isSeaExecutable } from "../paths.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
// Load the per-user config file first, then fall back to a CWD `.env` (the
// source-dev convention). dotenv never overrides real environment variables,
// so an explicit env var always wins over both.
dotenv({ path: configFilePath(), quiet: true });
dotenv({ quiet: true });
const program = new Command()
  .name("canvas-mcp")
  .description(
    "Canvas academic context, planning and MCP. No submission actions.",
  )
  .version(APP_VERSION)
  .option("--demo", "Use synthetic fixtures, never a live institution")
  .option(
    "--human",
    "Display timestamps in CANVAS_TIMEZONE (JSON is the default)",
  );
function human(value: unknown, timezone: string): unknown {
  if (Array.isArray(value)) return value.map((v) => human(v, timezone));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, human(v, timezone)]),
    );
  if (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return (
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(new Date(value)) + ` (${timezone})`
    );
  return value;
}
async function run(
  action: (app: ReturnType<typeof createApp>) => Promise<unknown>,
) {
  const app = createApp(process.env, program.opts().demo === true);
  try {
    const output = publicData(await action(app));
    console.log(
      JSON.stringify(
        program.opts().human ? human(output, app.config.timezone) : output,
        null,
        2,
      ),
    );
  } finally {
    app.close();
  }
}
const query = (name: string, args: Record<string, unknown>) =>
  run((app) => app.service.invoke(name, parseTool(name, args)));
const auth = program
  .command("auth")
  .description("Check the Canvas browser connection");
auth.command("check").action(() => run((app) => app.api.authCheck()));
auth.command("status").action(() => run((app) => app.provider.healthCheck()));
const bridgeCommand = program
  .command("bridge")
  .description("Pair the read-only Canvas extension over loopback");
bridgeCommand.command("start").action(async () => {
  const settings = bridgeSettings(loadConfig(process.env));
  const bridge = await startBridge(settings);
  console.log(
    `Canvas Bridge listening on 127.0.0.1:${bridge.port}\nCanvas origin: ${settings.origin}\nPairing code: ${bridge.pairingCode}\nEnter this code in the extension. It expires after five minutes. Keep this process running.`,
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await bridge.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
});
bridgeCommand.command("status").action(async () => {
  const client = new BridgeClient(bridgeSettings(loadConfig(process.env)));
  console.log(JSON.stringify(await client.status(), null, 2));
});
bridgeCommand.command("pair").action(async () => {
  const client = new BridgeClient(bridgeSettings(loadConfig(process.env)));
  console.log(JSON.stringify(await client.pair(), null, 2));
});
program
  .command("debug")
  .description("Read-only provider diagnostics")
  .command("graphql-schema")
  .action(() =>
    run(async (app) => {
      if (!app.provider.schema)
        throw new Error(
          "Schema discovery is available with the browser provider.",
        );
      return app.provider.schema();
    }),
  );
program
  .command("courses")
  .option("--cached", "Use the local cache instead of Canvas")
  .action(async (options) => {
    if (options.cached) return query("canvas_list_courses", {});
    return run(async (app) => {
      const user = await app.api.authCheck();
      app.repo.bindUserIdentity(user.id);
      return {
        items: await app.api.courses(),
        source: program.opts().demo ? "demo" : "live",
      };
    });
  });
program
  .command("sync")
  .option("--force", "Refresh page bodies even when timestamps match")
  .action((options) => query("canvas_sync", { force: options.force === true }));
for (const [command, tool] of [
  ["assignments", "canvas_get_assignments"],
  ["modules", "canvas_get_modules"],
  ["announcements", "canvas_get_announcements"],
  ["missing", "canvas_get_missing"],
  ["priorities", "canvas_get_priorities"],
  ["grades", "canvas_get_grade_summary"],
  ["files", "canvas_get_files"],
  ["discussions", "canvas_get_discussions"],
  ["planner", "canvas_get_planner"],
  ["exams", "canvas_list_exams"],
] as const) {
  program
    .command(command)
    .option("--course <id>")
    .action((options) => query(tool, { course_id: options.course }));
}
program
  .command("assignment <id>")
  .option("--course <id>")
  .action((id, options) =>
    query("canvas_get_assignment", {
      assignment_id: id,
      course_id: options.course,
    }),
  );
program
  .command("exam-study <id>")
  .option("--course <id>")
  .action((id, options) =>
    query("canvas_get_exam_study_guide", {
      assignment_id: id,
      course_id: options.course,
    }),
  );
program
  .command("upcoming")
  .option("--days <number>", "Horizon in days", "7")
  .option("--course <id>")
  .action((options) =>
    query("canvas_get_upcoming", {
      days: Number(options.days),
      course_id: options.course,
    }),
  );
program
  .command("changes")
  .option("--since <iso>")
  .option("--limit <number>", "Maximum changes", "100")
  .action((options) =>
    query("canvas_get_recent_changes", {
      since: options.since,
      limit: Number(options.limit),
    }),
  );
program
  .command("workspace <id>")
  .option("--course <id>")
  .option("--download", "Download referenced files subject to policy")
  .action((id, options) =>
    query("canvas_prepare_workspace", {
      assignment_id: id,
      course_id: options.course,
      download: options.download === true,
    }),
  );
program
  .command("validate <id>")
  .option("--course <id>")
  .action((id, options) =>
    query("canvas_validate_assignment", {
      assignment_id: id,
      course_id: options.course,
    }),
  );
program
  .command("study <course>")
  .option("--modules <ids>", "Comma-separated module IDs")
  .option("--assignment <id>")
  .option("--start <iso>")
  .option("--end <iso>")
  .action((course, options) =>
    query("canvas_get_study_context", {
      course_id: course,
      module_ids: options.modules?.split(","),
      assignment_id: options.assignment,
      start_date: options.start,
      end_date: options.end,
    }),
  );
program
  .command("serve")
  .description("Run the MCP server over stdio; stdout is protocol-only")
  .action(async () => {
    const app = createApp(process.env, program.opts().demo === true);
    const server = createServer(app.service, app.logger);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await server.close();
      app.close();
    };
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
    process.stdin.once("end", () => {
      void close();
    });
    await server.connect(new StdioServerTransport());
  });
program
  .command("ui")
  .description("Open the local status dashboard in your browser")
  .action(async () => {
    const loadSafe = (): Config | undefined => {
      try {
        return loadConfig(process.env);
      } catch {
        return undefined;
      }
    };
    const writeEnv = (baseUrl: string): void => {
      const path = configFilePath();
      mkdirSync(dirname(path), { recursive: true });
      let content = "";
      try {
        content = readFileSync(path, "utf8");
      } catch {
        /* absent */
      }
      const lines = content
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("CANVAS_BASE_URL="));
      lines.push(`CANVAS_BASE_URL=${baseUrl}`);
      if (!lines.some((line) => line.startsWith("CANVAS_PROVIDER=")))
        lines.push("CANVAS_PROVIDER=browser");
      writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
    };
    const viaNode = !isSeaExecutable();
    const command = viaNode ? "node" : process.execPath;
    const args = viaNode ? [resolve(process.argv[1]!), "serve"] : ["serve"];

    let config = loadSafe();
    let client: BridgeClient | undefined;
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    let app: ReturnType<typeof createApp> | undefined;
    let initError: string | undefined;

    async function init(): Promise<void> {
      config = loadSafe();
      initError = undefined;
      if (!config) {
        client = undefined;
        app = undefined;
        return;
      }
      const settings = bridgeSettings(config);
      client = new BridgeClient(settings);
      const tryStatus = async (): Promise<boolean> => {
        try {
          await client?.status();
          return true;
        } catch {
          return false;
        }
      };
      // Reuse an existing bridge (matching credentials) when one is running.
      if (!(await tryStatus())) {
        try {
          bridge = await startBridge(settings);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
            // Another process holds the port. It may be a same-credential
            // instance that just has not finished writing its state yet, so
            // retry connecting a few times before giving up.
            let reused = false;
            for (let i = 0; i < 5 && !reused; i++) {
              await new Promise((resolve) => setTimeout(resolve, 300));
              reused = await tryStatus();
            }
            if (!reused) {
              initError =
                "Port 47821 is already in use by another process. Close the other AutoCanvas window (or run `taskkill /F /IM canvas-mcp-windows-x64.exe`) and restart.";
            }
          } else {
            initError =
              error instanceof Error ? error.message : "Bridge failed to start";
          }
        }
      }
      try {
        app = createApp(process.env, program.opts().demo === true);
      } catch (error) {
        initError = `${initError ? `${initError}; ` : ""}${
          error instanceof Error ? error.message : "Failed to open cache"
        }`;
      }
    }
    await init();

    const mcpFiles = () => {
      const home = homedir();
      const claude =
        process.platform === "win32"
          ? join(
              process.env.APPDATA ?? join(home, "AppData", "Roaming"),
              "Claude",
              "claude_desktop_config.json",
            )
          : process.platform === "darwin"
            ? join(
                home,
                "Library",
                "Application Support",
                "Claude",
                "claude_desktop_config.json",
              )
            : join(home, ".config", "Claude", "claude_desktop_config.json");
      return [
        { tool: "Claude Desktop", file: claude, key: "mcpServers.canvas" },
        {
          tool: "Cursor",
          file: join(home, ".cursor", "mcp.json"),
          key: "mcpServers.canvas",
        },
        {
          tool: "Codex",
          file: join(home, ".codex", "config.toml"),
          key: "[mcp_servers.canvas]",
        },
        {
          tool: "ChatGPT Desktop",
          file: "mcpServers JSON (app-managed)",
          key: "mcpServers.canvas",
        },
      ];
    };

    const dashboard = await startDashboard({
      status: async () => {
        if (!config || !client)
          return {
            configured: false,
            bridge: {},
            health: { state: "unconfigured" },
          };
        const bridgeStatus = await client.status().catch(() => ({}));
        const health = app
          ? await app.provider.healthCheck().catch(() => ({ state: "unknown" }))
          : { state: "unknown" };
        return {
          configured: true,
          bridge: bridgeStatus,
          health,
          error: initError,
        };
      },
      pair: async () => {
        if (!client) throw new Error("Set your Canvas URL first.");
        return client.pair();
      },
      mcp: () => {
        if (!config) return { configured: false, snippet: null, files: [] };
        return {
          configured: true,
          snippet: {
            command,
            args,
            env: {
              CANVAS_BASE_URL: config.baseUrl,
              CANVAS_PROVIDER: "browser",
              CANVAS_DB_PATH: config.dbPath,
              CANVAS_WORKSPACE_ROOT: config.workspaceRoot,
            },
          },
          files: mcpFiles(),
        };
      },
      configure: async (baseUrl) => {
        try {
          process.env.CANVAS_BASE_URL = validateBaseUrl(baseUrl);
          writeEnv(process.env.CANVAS_BASE_URL);
          await init();
          return { ok: config !== undefined };
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error ? error.message : "Invalid Canvas URL",
          };
        }
      },
      install: async () => {
        try {
          const result = selfInstall();
          return {
            ok: true,
            installedPath: result.installedPath,
            addedToPath: result.addedToPath,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Install failed",
          };
        }
      },
      updateCheck: async () => checkForUpdates(),
      updateApply: async (downloadUrl) => {
        const result = await applyUpdate(downloadUrl);
        if (result.ok) {
          // Let the response reach the browser, then exit so the Windows
          // swapper (or the user) can finish installing.
          setTimeout(() => process.exit(0), 400);
        }
        return result;
      },
    });
    console.log(`Dashboard: ${dashboard.url}`);
    console.log("Keep this process running; press Ctrl+C to stop.");
    const opener =
      process.platform === "win32"
        ? "cmd"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const openArgs =
      process.platform === "win32"
        ? ["/c", "start", "", dashboard.url]
        : [dashboard.url];
    try {
      const child = spawn(opener, openArgs, {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
    } catch {
      /* the URL is printed above regardless */
    }
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await dashboard.close();
      if (bridge) await bridge.close();
      app?.close();
    };
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
  });
program
  .command("install")
  .description("Install the executable to a stable location and add it to PATH")
  .action(() => {
    if (!isSeaExecutable()) {
      console.error(
        "install: only the standalone executable can self-install. The source " +
          "build is installed via `pnpm setup` (scripts/install.mjs).",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const result = selfInstall();
      console.log(`Installed to ${result.installedPath}`);
      if (result.addedToPath) {
        console.log(
          "Added to PATH. Open a new terminal and run `canvas-mcp` from anywhere.",
        );
      } else {
        console.log(
          `Add "${installDirPath()}" to your PATH, then run \`canvas-mcp\`.`,
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Install failed");
      process.exitCode = 1;
    }
  });
// Running the binary with no command opens the dashboard (e.g. double-clicking
// the Windows executable).
if (process.argv.length <= 2) process.argv.push("ui");
program.parseAsync().catch((error) => {
  let message = error instanceof Error ? error.message : "Command failed";
  if (process.env.CANVAS_ACCESS_TOKEN)
    message = message.replaceAll(process.env.CANVAS_ACCESS_TOKEN, "[REDACTED]");
  console.error(
    JSON.stringify({
      ok: false,
      error: message,
      code:
        error instanceof Error && "code" in error
          ? error.code
          : "command_error",
      retryable:
        error instanceof Error &&
        "retryable" in error &&
        error.retryable === true,
    }),
  );
  process.exitCode = 1;
});

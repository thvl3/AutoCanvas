#!/usr/bin/env node
import { Command } from "commander";
import { config as dotenv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createApp, bridgeSettings } from "../app.js";
import { loadConfig } from "../config.js";
import { startBridge } from "../bridge/server.js";
import { BridgeClient } from "../bridge/client.js";
import { createServer } from "../mcp/server.js";
import { parseTool } from "../services/tools.js";
import { publicData } from "../services/academic.js";
dotenv({ quiet: true });
const program = new Command()
  .name("canvas-mcp")
  .description(
    "Canvas academic context, planning and MCP. No submission actions.",
  )
  .version("0.1.0")
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
const auth=program.command("auth").description("Check the Canvas browser connection");
auth.command("check").action(()=>run(app=>app.api.authCheck()));
auth.command("status").action(()=>run(app=>app.provider.healthCheck()));
const bridgeCommand=program.command("bridge").description("Pair the read-only Canvas extension over loopback");
bridgeCommand.command("start").action(async()=>{
 const settings=bridgeSettings(loadConfig(process.env));
 const bridge=await startBridge(settings);
 console.log(`Canvas Bridge listening on 127.0.0.1:${bridge.port}\nCanvas origin: ${settings.origin}\nPairing code: ${bridge.pairingCode}\nEnter this code in the extension. It expires after five minutes. Keep this process running.`);
 let closed=false;const close=async()=>{if(closed)return;closed=true;await bridge.close();};
 process.once("SIGINT",()=>{void close();});process.once("SIGTERM",()=>{void close();});
});
bridgeCommand.command("status").action(async()=>{
 const client=new BridgeClient(bridgeSettings(loadConfig(process.env)));
 console.log(JSON.stringify(await client.status(),null,2));
});
bridgeCommand.command("pair").action(async()=>{
 const client=new BridgeClient(bridgeSettings(loadConfig(process.env)));
 console.log(JSON.stringify(await client.pair(),null,2));
});
program.command("debug").description("Read-only provider diagnostics").command("graphql-schema").action(()=>run(async app=>{
 if(!app.provider.schema)throw new Error("Schema discovery is available with the browser provider.");
 return app.provider.schema();
}));
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
program.parseAsync().catch((error) => {
  let message = error instanceof Error ? error.message : "Command failed";
  if (process.env.CANVAS_ACCESS_TOKEN)
    message = message.replaceAll(process.env.CANVAS_ACCESS_TOKEN, "[REDACTED]");
  console.error(JSON.stringify({ ok: false, error: message, code: error instanceof Error && "code" in error ? error.code : "command_error", retryable: error instanceof Error && "retryable" in error && error.retryable===true }));
  process.exitCode = 1;
});

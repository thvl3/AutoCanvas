import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "canvas-release-smoke-"));
const entry = resolve("dist/cli/index.js");
const env = {
  ...process.env,
  CANVAS_DB_PATH: join(root, "cache.sqlite"),
  CANVAS_WORKSPACE_ROOT: join(root, "workspaces"),
  LOG_LEVEL: "silent",
};
const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [entry, "--demo", ...args], {
        env,
        timeout: 60000,
      })
    ).stdout,
  );
const client = new Client({ name: "release-smoke", version: "0.1.0" });
let connected = false;
try {
  const courses = await run("courses");
  assert.equal(courses.items.length, 3);
  const auth = await run("auth", "check");
  assert.equal(auth.id, "7");
  const first = await run("sync");
  assert.equal(first.status, "complete");
  const context = await run("assignment", "10101");
  assert.equal(context.related_pages.length, 1);
  assert.ok(context.rubric);
  const workspace = await run("workspace", "10101", "--download");
  assert.equal(
    workspace.warnings.some((w) => /failed|blocked/i.test(w)),
    false,
  );
  const fileNames = workspace.files;
  assert.ok(fileNames.length >= 4);
  const file = await readFile(
    join(workspace.workspace, "resources", "10150-starter.txt"),
    "utf8",
  );
  assert.match(file, /A -> B/);
  await writeFile(
    join(workspace.workspace, "submission", "report.md"),
    "# Demo mechanical validation fixture\n\nThis file tests the validator. It is not completed coursework.\n",
  );
  const validation = await run("validate", "10101");
  assert.equal(validation.submission_enabled, false);
  assert.ok(validation.checks.some((c) => c.status === "UNKNOWN"));
  const second = await run("sync");
  assert.equal(second.status, "complete");
  assert.equal(second.counts.updated, 0);
  assert.equal(second.counts.added, 0);
  const upcoming = await run("upcoming");
  assert.ok(upcoming.items.length > 0);
  const missing = await run("missing");
  assert.equal(missing.items.length, 3);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--demo", "serve"],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await client.connect(transport);
  connected = true;
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 18);
  const result = await client.callTool({
    name: "canvas_get_assignment_context",
    arguments: { course_id: "101", assignment_id: "10101" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.assignment.id, "10101");
  const invalid = await client.callTool({
    name: "canvas_prepare_workspace",
    arguments: { assignment_id: "../secrets" },
  });
  assert.equal(invalid.isError, true);
  const resource = await client.readResource({
    uri: "canvas://course/101/assignments",
  });
  assert.match(resource.contents[0].text, /10101/);
  assert.ok(!stderr.includes("demo-fixture-not-a-credential"));
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        mode: "synthetic fixtures, compiled CLI + real MCP stdio",
        courses: courses.items.length,
        upcoming: upcoming.items.length,
        missing: missing.items.length,
        mcp_tools: tools.length,
        incremental_updates: second.counts.updated,
        download_bytes: Buffer.byteLength(file),
        submission_enabled: validation.submission_enabled,
      },
      null,
      2,
    ),
  );
} finally {
  if (connected) await client.close();
  await rm(root, { recursive: true, force: true });
}

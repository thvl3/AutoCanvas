import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
it("proves courses, auth, sync, context and changes through the CLI without credentials", async () => {
  const temp = await mkdtemp(join(tmpdir(), "canvas-cli-"));
  const env = {
    ...process.env,
    CANVAS_DB_PATH: join(temp, "cache.sqlite"),
    CANVAS_WORKSPACE_ROOT: join(temp, "workspaces"),
    LOG_LEVEL: "silent",
  };
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          ["--import", "tsx", resolve("src/cli/index.ts"), "--demo", ...args],
          { env, timeout: 30000 },
        )
      ).stdout,
    );
  try {
    expect(await run("auth", "check")).toMatchObject({ id: "7" });
    const courses = await run("courses");
    expect(courses.items).toHaveLength(3);
    const sync = await run("sync");
    expect(sync).toHaveProperty("completed_at");
    const a = await run("assignment", "10101");
    expect(a.assignment.id).toBe("10101");
    expect(a.related_pages).toHaveLength(1);
    expect((await run("missing")).items.length).toBeGreaterThan(0);
    expect((await run("upcoming")).items.length).toBeGreaterThan(0);
    const changes = await run("changes");
    expect(changes.changes.length).toBeGreaterThan(0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);

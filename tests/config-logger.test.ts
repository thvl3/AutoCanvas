import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";

it("writes structured redacted logger output to stderr, leaving stdout for MCP only", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { createLogger } from './src/logger.ts'; const logger = createLogger('debug'); logger.info({accessToken:'private-token',authorization:'Bearer secret',headers:{authorization:'Bearer header'},config:{accessToken:'nested-token'},status:200}, 'request');",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("");
  const log = JSON.parse(child.stderr.trim());
  expect(log).toMatchObject({ status: 200, msg: "request" });
  expect(child.stderr).not.toMatch(
    /private-token|Bearer secret|Bearer header|nested-token/,
  );
});

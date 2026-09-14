import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("runs the self-contained executor against synthetic HTTPS using real DOMParser and strips active page content", async () => {
  const temp = await mkdtemp(join(tmpdir(), "canvas-extension-fixture-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(temp, "key.pem"),
      "-out",
      join(temp, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "pipe" },
  );
  const server = createServer(
    {
      key: await readFile(join(temp, "key.pem")),
      cert: await readFile(join(temp, "cert.pem")),
    },
    (req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/api/v1/users/self/profile") {
        res.setHeader("Content-Type", "application/json");
        if (!req.headers.cookie?.includes("fixture_session=SESSION-LOCAL")) {
          res.writeHead(401);
          res.end("{}");
        } else res.end('{"id":"42","name":"Fixture student"}');
      } else if (req.url === "/api/graphql") {
        res.setHeader("Content-Type", "application/json");
        if (
          req.method !== "POST" ||
          req.headers["x-csrf-token"] !== "CSRF/local" ||
          !req.headers.cookie?.includes("fixture_session=SESSION-LOCAL")
        ) {
          res.writeHead(403);
          res.end("{}");
        } else
          res.end(
            '{"data":{"allCourses":[{"id":"3","name":"Fixture course"}]}}',
          );
      } else if (req.url === "/courses/3/assignments/7") {
        res.end(
          '<html><script>ENV={secret:"ENV-NEVER-EXPORT"}</script><div id="assignment_show"><h1>Fixture reading</h1><div class="description user_content"><p onclick="evil()">Read chapter 1</p><script>globalThis.FIXTURE_EXECUTED=true</script><iframe src="https://unapproved.invalid"></iframe><input name="authenticity_token" value="TOKEN-NEVER-EXPORT"></div></div></html>',
        );
      } else {
        res.setHeader("Set-Cookie", [
          "fixture_session=SESSION-LOCAL; HttpOnly; Secure; SameSite=Strict; Path=/",
          "_csrf_token=CSRF%2Flocal; Secure; SameSite=Strict; Path=/",
        ]);
        res.end(
          "<html><title>Synthetic Canvas fixture</title><body>Fixture tab</body></html>",
        );
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture listen");
  const origin = `https://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(origin);
    const output = await build({
      entryPoints: ["browser-extension/src/executor.ts"],
      bundle: true,
      format: "iife",
      globalName: "FixtureExecutor",
      target: "es2022",
      write: false,
    });
    await page.addScriptTag({ content: output.outputFiles[0]!.text });
    const result = await page.evaluate(
      async (origin) =>
        (window as any).FixtureExecutor.executeInCanvas(origin, {
          type: "canvas-page",
          kind: "assignment",
          courseId: "3",
          id: "7",
        }),
      origin,
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        body: {
          id: "7",
          name: "Fixture reading",
          description: "<p>Read chapter 1</p>",
          source: "canvas-page",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ENV-NEVER|TOKEN-NEVER|onclick|<iframe|<script/,
    );
    expect(
      await page.evaluate(() => (window as any).FIXTURE_EXECUTED),
    ).toBeUndefined();
    const health = await page.evaluate(
      async (origin) =>
        (window as any).FixtureExecutor.executeInCanvas(origin, {
          type: "session-health",
        }),
      origin,
    );
    expect(health).toMatchObject({ ok: true, result: { body: { id: "42" } } });
    const courses = await page.evaluate(
      async (origin) =>
        (window as any).FixtureExecutor.executeInCanvas(origin, {
          type: "graphql-query",
          query: "query { allCourses { id name } }",
        }),
      origin,
    );
    expect(courses).toMatchObject({
      ok: true,
      result: { body: { data: { allCourses: [{ id: "3" }] } } },
    });
    expect(JSON.stringify([health, courses])).not.toMatch(
      /SESSION-LOCAL|CSRF|_csrf_token/,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);

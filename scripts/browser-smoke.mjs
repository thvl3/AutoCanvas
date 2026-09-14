// Optional integration test: node scripts/browser-smoke.mjs
// Uses only disposable profiles, a synthetic Canvas origin and synthetic cookies.
// --negative-unpaired deliberately fails the connected assertion (RED control).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { Kind, parse } from "graphql";
import { register } from "tsx/esm/api";

register();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const origin = "https://canvas.fixture.example";
const syntheticSession = "browser-smoke-synthetic-session-only";
const syntheticCsrf = "browser-smoke-synthetic-csrf-only";
const negativeUnpaired = process.argv.includes("--negative-unpaired");
const report = {
  status: "FAIL",
  mode: "synthetic Canvas fixtures; real Chromium extension + loopback bridge + browser-session provider",
  verified: [],
};
let stage = "prerequisites";
let context;
let bridge;
const root = await mkdtemp(join(tmpdir(), "autocanvas-browser-smoke-"));
const observations = [];
const fixtureErrors = [];

function noSessionSecrets(value) {
  const text = JSON.stringify(value);
  assert.equal(
    text.includes(syntheticSession),
    false,
    "HttpOnly session must not escape the browser result",
  );
  assert.equal(
    text.includes(syntheticCsrf),
    false,
    "CSRF token must not escape the browser result",
  );
}
async function eventually(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

try {
  await exec(
    process.execPath,
    [join(repoRoot, "scripts/build-extension.mjs")],
    { cwd: repoRoot, timeout: 60000 },
  );
  const extensionDir = join(root, "extension");
  await cp(join(repoRoot, "browser-extension/dist"), extensionDir, {
    recursive: true,
  });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Only this temporary copy is changed: grant our exact fixture host without permission UI.
  manifest.host_permissions = [
    ...new Set([...(manifest.host_permissions ?? []), `${origin}/*`]),
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const [
    { startBridge },
    { BridgeClient },
    { BrowserSessionProvider },
    { demoFetch },
  ] = await Promise.all([
    import("../src/bridge/server.ts"),
    import("../src/bridge/client.ts"),
    import("../src/providers/browser-session.ts"),
    import("../src/demo/fixtures.ts"),
  ]);
  const settings = {
    origin,
    stateDir: join(root, "bridge"),
    port: 0,
    timeoutMs: 10000,
  };
  bridge = await startBridge(settings);
  const client = new BridgeClient({ ...settings, port: bridge.port });
  const provider = new BrowserSessionProvider(
    { baseUrl: origin, timeoutMs: 10000, maxDownloadBytes: 1024 * 1024 },
    client,
  );

  stage = "launch isolated Chromium";
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  context.setDefaultTimeout(10000);
  report.browser = context.browser().version();
  report.playwright = JSON.parse(
    await readFile(
      join(repoRoot, "node_modules/playwright/package.json"),
      "utf8",
    ),
  ).version;
  // Do not copy any user browser state. These are the ONLY cookies this test creates.
  await context.addCookies([
    {
      name: "synthetic_canvas_session",
      value: syntheticSession,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "_csrf_token",
      value: syntheticCsrf,
      url: origin,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const fixtureCourses = [];
  for (const page of ["", "?page=2"]) {
    fixtureCourses.push(
      ...(await (await demoFetch(`${origin}/api/v1/courses${page}`)).json()),
    );
  }
  const enrolled = fixtureCourses.map((course) => ({
    _id: String(course.id * 10),
    userId: "7",
    state: "active",
    type: "StudentEnrollment",
    enrollmentState: "active",
    grades: {
      currentScore: 90,
      currentGrade: "A",
      finalScore: 90,
      finalGrade: "A",
      htmlUrl: null,
    },
    course: {
      _id: String(course.id),
      name: course.name,
      courseCode: course.course_code,
      state: course.workflow_state,
      syllabusBody: "",
      updatedAt: null,
      term: null,
    },
  }));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Let the real extension reach only the real test bridge. Canvas is fulfilled locally.
    if (
      url.origin === `http://127.0.0.1:${bridge.port}` ||
      url.protocol === "chrome-extension:"
    )
      return route.continue();
    if (url.origin !== origin) {
      fixtureErrors.push(`Unexpected network origin: ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    try {
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Synthetic Canvas session</title><h1>Fixture only — no institution login</h1>",
        });
      const headers = await request.allHeaders();
      assert.ok(
        headers.cookie?.includes(
          `synthetic_canvas_session=${syntheticSession}`,
        ),
        "Browser must send the synthetic HttpOnly session",
      );
      assert.equal(
        headers.authorization,
        undefined,
        "No PAT Authorization header is allowed",
      );
      assert.equal(headers.accept, "application/json+canvas-string-ids");
      const observed = {
        method: request.method(),
        path: url.pathname,
        authenticated: true,
      };
      observations.push(observed);
      if (url.pathname === "/api/graphql") {
        assert.equal(request.method(), "POST");
        assert.equal(headers["x-csrf-token"], syntheticCsrf);
        const payload = request.postDataJSON();
        const operation = parse(payload.query).definitions.find(
          (node) => node.kind === Kind.OPERATION_DEFINITION,
        );
        assert.equal(
          operation.operation,
          "query",
          "No mutation may reach Canvas",
        );
        observed.operation = operation.name?.value;
        if (observed.operation !== "CanvasCourses") {
          assert.ok(
            [
              "CanvasAssignments",
              "CanvasModules",
              "CanvasEnrollments",
              "CanvasSubmission",
              "CanvasSubmissions",
              "CanvasAssignment",
              "CanvasCourse",
            ].includes(observed.operation),
            "Unexpected fixture GraphQL operation",
          );
          // Deliberate fixture schema gaps exercise the real session GET fallback.
          observed.schemaGap = true;
          return route.fulfill({
            json: {
              errors: [
                {
                  message:
                    "Synthetic fixture schema does not expose this field",
                  extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
                },
              ],
            },
          });
        }
        assert.equal(payload.variables.userId, "7");
        // GraphQL nullable cursor omission and explicit null both select the first page.
        assert.ok(
          [undefined, null, "fixture-page-2"].includes(payload.variables.after),
          `Unexpected synthetic cursor: ${JSON.stringify(payload.variables.after)}`,
        );
        const secondPage = payload.variables.after === "fixture-page-2";
        return route.fulfill({
          json: {
            data: {
              user: {
                enrollmentsConnection: {
                  nodes: secondPage ? enrolled.slice(2) : enrolled.slice(0, 2),
                  pageInfo: {
                    hasNextPage: !secondPage,
                    endCursor: secondPage ? null : "fixture-page-2",
                  },
                },
              },
            },
          },
        });
      }
      assert.equal(request.method(), "GET");
      const response = await demoFetch(url);
      const responseHeaders = Object.fromEntries(response.headers);
      if (responseHeaders.link)
        responseHeaders.link = responseHeaders.link.replaceAll(
          "https://canvas.example.invalid",
          origin,
        );
      return route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: await response.text(),
      });
    } catch (error) {
      fixtureErrors.push(error.message);
      return route.fulfill({
        status: 500,
        json: { errors: [{ message: "Synthetic fixture assertion failed" }] },
      });
    }
  });
  const canvas = await context.newPage();
  await canvas.goto(origin);
  assert.equal(
    await canvas.evaluate(() =>
      document.cookie.includes("synthetic_canvas_session"),
    ),
    false,
    "HttpOnly session must be invisible to page JavaScript",
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);
  report.verified.push(
    "real unpacked MV3 extension loaded",
    "synthetic HttpOnly session hidden from page JavaScript",
  );

  stage = "pair real extension through options UI";
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator("#origin").fill(origin);
  await options.locator("#port").fill(String(bridge.port));
  if (!negativeUnpaired) {
    await options.locator("#code").fill(bridge.pairingCode);
    await options.locator("#pair").click();
    await options
      .locator("#status")
      .filter({ hasText: /^Paired\./ })
      .waitFor({ state: "visible" });
  }
  await eventually(
    async () => (await client.status()).connected === true,
    "Expected paired extension connected; unpaired negative control must fail here",
    negativeUnpaired ? 500 : 10000,
  );
  report.verified.push(
    "options UI pairing and authenticated extension WebSocket",
  );

  stage = "browser-session provider identity and GraphQL courses";
  const rawHealth = await client.request({ type: "session-health" });
  noSessionSecrets(rawHealth);
  assert.equal(String(rawHealth.body.id), "7");
  const auth = await provider.authCheck();
  assert.equal(auth.id, "7");
  const courses = await provider.courses();
  assert.deepEqual(
    courses.map((course) => course.id).sort(),
    fixtureCourses.map((course) => String(course.id)).sort(),
  );
  for (const course of courses) {
    assert.equal(course.kind, "courses");
    assert.equal(course.data.source.transport, "graphql");
    assert.equal(
      course.title,
      fixtureCourses.find((fixture) => String(fixture.id) === course.id).name,
    );
  }
  noSessionSecrets(courses);
  assert.equal(
    observations.filter((item) => item.path === "/api/v1/courses").length,
    0,
    "Course slice must use GraphQL, not fallback",
  );
  assert.equal(
    observations.filter((item) => item.operation === "CanvasCourses").length,
    2,
    "GraphQL cursor pagination must traverse both pages",
  );
  assert.deepEqual(fixtureErrors, []);
  report.courses = courses.length;
  report.graphql_course_pages = 2;
  report.verified.push(
    "normalized identity and courses via real extension execution",
    "GraphQL pagination",
    "browser session and CSRF remain outside bridge results",
  );

  stage = "read-only and bridge origin boundaries";
  const beforeMutation = observations.length;
  await assert.rejects(
    client.request({
      type: "graphql-query",
      query: "mutation FixtureMutation { forbidden }",
    }),
    (error) => error.code === "invalid_operation",
  );
  assert.equal(
    observations.length,
    beforeMutation,
    "Rejected mutation must not reach the fixture",
  );
  // Also test daemon validation without BridgeClient's local validator. Never log the key.
  {
    const { readCredentials } = await import("../src/bridge/state.ts");
    const { clientSecret } = await readCredentials(settings);
    const rejected = await fetch(`http://127.0.0.1:${bridge.port}/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Bridge-Key": clientSecret,
      },
      body: JSON.stringify({
        type: "graphql-query",
        query: "mutation FixtureMutation { forbidden }",
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "invalid_operation");
  }
  assert.equal(
    observations.length,
    beforeMutation,
    "Daemon must reject mutation before contacting browser",
  );
  const unauthenticated = await fetch(`http://127.0.0.1:${bridge.port}/status`);
  assert.equal(unauthenticated.status, 401);
  const pageOrigin = await fetch(`http://127.0.0.1:${bridge.port}/status`, {
    headers: { Origin: origin },
  });
  assert.equal(pageOrigin.status, 403);
  const pageCannotRead = await canvas.evaluate(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      return !response.ok;
    } catch {
      return true;
    }
  }, bridge.port);
  assert.equal(pageCannotRead, true);
  report.verified.push(
    "GraphQL mutation rejected before browser request",
    "unauthenticated HTTP denied (401)",
    "Canvas page origin denied (403/CORS)",
  );

  stage = "browser provider sync and persistent SQLite";
  const { createApp } = await import("../src/app.ts");
  const env = {
    CANVAS_PROVIDER: "browser",
    CANVAS_BASE_URL: origin,
    CANVAS_BRIDGE_PORT: String(bridge.port),
    CANVAS_BRIDGE_STATE_DIR: settings.stateDir,
    CANVAS_DB_PATH: join(root, "cache.sqlite"),
    CANVAS_WORKSPACE_ROOT: join(root, "workspaces"),
    CANVAS_TIMEOUT_MS: "10000",
    CANVAS_SYNC_CONCURRENCY: "2",
    LOG_LEVEL: "silent",
  };
  let app = createApp(env);
  try {
    assert.equal(app.config.accessToken, "");
    assert.ok(
      app.provider instanceof BrowserSessionProvider,
      "Use default real browser provider wiring, not provider injection",
    );
    const first = await app.service.invoke("canvas_sync", {});
    assert.equal(
      first.status,
      "complete",
      `Sync must complete: ${JSON.stringify(first.warnings)}`,
    );
    assert.deepEqual(first.warnings, []);
    report.sync_added = first.counts.added;
  } finally {
    app.close();
  }
  app = createApp(env);
  try {
    assert.equal(app.repo.list("courses").length, fixtureCourses.length);
    assert.equal(
      app.repo.list("assignments").length,
      fixtureCourses.length * 4,
    );
    noSessionSecrets(app.repo.list("courses"));
    noSessionSecrets(app.repo.list("assignments"));
    report.sqlite_courses = app.repo.list("courses").length;
    report.sqlite_assignments = app.repo.list("assignments").length;
  } finally {
    app.close();
  }
  assert.deepEqual(fixtureErrors, []);
  report.verified.push(
    "default browser-provider app wiring without PAT",
    "complete sync and reopened SQLite cache",
  );

  stage = "real MCP stdio against browser bridge and SQLite";
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);
  const mcp = new Client({ name: "browser-fixture-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      import.meta.resolve("tsx"),
      join(repoRoot, "src/cli/index.ts"),
      "serve",
    ],
    cwd: root, // No repository .env or real user Canvas configuration is loaded.
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await mcp.connect(transport);
    const tools = await mcp.listTools();
    report.mcp_tools = tools.tools.length;
    const health = await mcp.callTool({
      name: "canvas_auth_status",
      arguments: {},
    });
    assert.notEqual(health.isError, true);
    assert.equal(health.structuredContent.data.state, "connected");
    const synced = await mcp.callTool({ name: "canvas_sync", arguments: {} });
    assert.notEqual(synced.isError, true);
    assert.equal(synced.structuredContent.data.status, "complete");
    assert.equal(synced.structuredContent.data.counts.added, 0);
    assert.equal(synced.structuredContent.data.counts.updated, 0);
    const upcoming = await mcp.callTool({
      name: "canvas_get_upcoming",
      arguments: { days: 7 },
    });
    assert.notEqual(upcoming.isError, true);
    assert.equal(
      upcoming.structuredContent.data.items.length,
      fixtureCourses.length * 2,
    );
    noSessionSecrets([health, synced, upcoming, stderr]);
    report.mcp_upcoming = upcoming.structuredContent.data.items.length;
    report.incremental_updates = synced.structuredContent.data.counts.updated;
    report.verified.push(
      "real MCP stdio connected session health",
      "MCP incremental sync with zero changes",
      "MCP upcoming reads SQLite",
    );
  } finally {
    await mcp.close();
  }
  assert.deepEqual(fixtureErrors, []);

  stage = "extension disconnect";
  await context.close();
  context = undefined;
  await eventually(
    async () => (await client.status()).connected === false,
    "Bridge did not observe extension disconnect",
  );
  await assert.rejects(
    provider.courses(),
    (error) =>
      error.code === "extension_disconnected" &&
      /extension|connect/i.test(error.message),
  );
  report.verified.push(
    "extension disconnect produces actionable provider error",
  );
  report.fixture_requests = observations.length;
  report.graphql_course_pages_total = observations.filter(
    (item) => item.operation === "CanvasCourses",
  ).length;
  report.fixture_graphql_schema_gaps = observations.filter(
    (item) => item.schemaGap,
  ).length;
  report.browser_session_gets = observations.filter(
    (item) => item.method === "GET",
  ).length;
  report.verified.push(
    "daemon rejects mutation independently of client validation",
  );
  report.status = "PASS";
} catch (error) {
  report.failed_stage = stage;
  // Never print browser storage, request headers, private bridge state or pairing values.
  report.error =
    error instanceof Error
      ? error.message
          .replaceAll(syntheticSession, "[synthetic session]")
          .replaceAll(syntheticCsrf, "[synthetic csrf]")
      : "Unknown failure";
  if (fixtureErrors.length) report.fixture_errors = fixtureErrors;
  process.exitCode = 1;
} finally {
  await context?.close();
  await bridge?.close();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));

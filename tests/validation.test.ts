import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type { AssignmentContext } from "../src/services/assignment-context.js";
import { prepareWorkspace } from "../src/services/workspace.js";
import { validateAssignment } from "../src/services/submission-validation.js";

const roots: string[] = [];
async function fixture(prepare = true) {
  const root = await mkdtemp(join(tmpdir(), "autocanvas-validation-"));
  roots.push(root);
  const config: Config = {
    baseUrl: "https://canvas.example",
    accessToken: "secret",
    dbPath: ":memory:",
    workspaceRoot: join(root, "workspaces"),
    timezone: "UTC",
    timeoutMs: 1000,
    maxRetries: 0,
    maxDownloadBytes: 1024,
    downloadHosts: [],
    logLevel: "silent",
    syncConcurrency: 1,
  };
  const context: AssignmentContext = {
    assignment: {
      kind: "assignments",
      id: "23",
      course_id: "7",
      title: "Writing",
      updated_at: null,
      data: {
        description: "<p>Write an original response.</p>",
        submission_types: ["online_upload"],
        allowed_extensions: ["txt"],
        locked_for_user: false,
        unlock_at: null,
        lock_at: null,
        due_at: null,
        allowed_attempts: -1,
      },
      raw: {},
    },
    course: null,
    assignment_group: null,
    rubric: [{ description: "Thoughtful analysis", points: 10 }],
    modules: [],
    module_items: [],
    related_pages: [],
    files: [],
    announcements: [],
    discussions: [],
    submission: null,
    external_links: [],
    warnings: [],
    freshness: null,
  };
  const workspace = join(config.workspaceRoot, "course-7", "assignment-23");
  if (prepare) await prepareWorkspace(context, config);
  return {
    root,
    config,
    context,
    workspace,
    submission: join(workspace, "submission"),
  };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("read-only assignment validation", () => {
  it.each([
    "Write at least 500 words and no more than 1000 words.",
    "Write at least 500 words and no more than 100 words.",
    "Write between 500 and 100 words.",
  ])(
    "blocks readiness for ambiguous or contradictory word limits: %s",
    async (description) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.description = description;
      await writeFile(join(submission, "paper.txt"), "draft");
      const result = await validateAssignment(context, config);
      expect(result.ready).toBe(false);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          check: "word_count",
          status: "UNKNOWN",
          message: expect.stringMatching(/ambiguous|contradictory/i),
        }),
      );
    },
  );
  it.each([
    "Write 500 words.",
    "Write a 500-word response.",
    "Write at least 1,000 words.",
    "Write at least five hundred words.",
    "Word count: 500.",
    "Write at least 1 words; the final response must be 500 words.",
  ])(
    "blocks readiness for unparsed explicit word counts: %s",
    async (description) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.description = description;
      await writeFile(join(submission, "paper.txt"), "draft");
      const result = await validateAssignment(context, config);
      expect(result.ready).toBe(false);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          check: "word_count",
          status: "UNKNOWN",
          message: expect.stringMatching(/unsupported|review/i),
        }),
      );
      expect(
        result.checks.find((check) => check.check === "word_count")?.message,
      ).not.toMatch(/no explicit word-limit rule/i);
    },
  );
  it.each([
    {
      description: "<p>Write at least 5 words.</p>",
      text: "one two three",
      expected: "FAIL",
      count: 3,
    },
    {
      description: "<p>Write at least 3 words.</p>",
      text: "one two three four",
      expected: "PASS",
      count: 4,
    },
    {
      description: "<p>Write no more than 3 words.</p>",
      text: "one two three four",
      expected: "FAIL",
      count: 4,
    },
    {
      description: "<p>Write between 3 and 5 words.</p>",
      text: "one two three four",
      expected: "PASS",
      count: 4,
    },
  ])(
    "checks explicit simple word limits approximately: $description",
    async ({ description, text, expected, count }) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.description = description;
      await writeFile(join(submission, "paper.txt"), text);
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          check: "word_count",
          status: expected,
          message: expect.stringContaining(`Approximate word count: ${count}`),
        }),
      );
    },
  );
  it.each(["plain", "pdf", "multiple", "invalid-utf8"])(
    "does not invent word requirements or parse unsupported files: %s",
    async (kind) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.allowed_extensions = [];
      if (kind !== "plain")
        context.assignment.data.description = "Write at least 3 words.";
      await writeFile(
        join(submission, kind === "pdf" ? "paper.pdf" : "paper.txt"),
        kind === "invalid-utf8"
          ? Buffer.from([255, 0, 128])
          : "one two three four",
      );
      if (kind === "multiple")
        await writeFile(join(submission, "other.txt"), "one two three");
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "word_count", status: "UNKNOWN" }),
      );
      expect(result.ready).toBe(kind === "plain");
      if (kind === "plain")
        expect(JSON.stringify(result)).not.toContain("Approximate word count");
    },
  );
  it.each([
    { data: { locked_for_user: true }, expected: "FAIL" },
    { data: { unlock_at: "2030-02-01T00:00:00Z" }, expected: "FAIL" },
    { data: { lock_at: "2029-12-31T00:00:00Z" }, expected: "FAIL" },
    { data: { published: false }, expected: "FAIL" },
    { data: { locked_for_user: undefined }, expected: "UNKNOWN" },
    { data: { lock_at: "not-a-date" }, expected: "UNKNOWN" },
    {
      data: { unlock_at: null, lock_at: null, locked_for_user: false },
      expected: "PASS",
    },
  ])(
    "checks cached availability without inventing missing dates: $expected",
    async ({ data, expected }) => {
      const { config, context, submission } = await fixture();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      Object.assign(context.assignment.data, data);
      await writeFile(join(submission, "paper.txt"), "draft");
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "availability", status: expected }),
      );
      if (expected !== "PASS") expect(result.ready).toBe(false);
    },
  );
  it("warns about overdue work without pretending due_at is the lock date", async () => {
    const { config, context, submission } = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    context.assignment.data.due_at = "2029-12-31T00:00:00Z";
    await writeFile(join(submission, "paper.txt"), "draft");
    const result = await validateAssignment(context, config);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "deadline", status: "WARNING" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "availability", status: "PASS" }),
    );
  });
  it.each([
    { allowed: -1, attempt: undefined, expected: "PASS" },
    { allowed: 1, attempt: 1, expected: "FAIL" },
    { allowed: 2, attempt: 1, expected: "PASS" },
    { allowed: 0, attempt: 0, expected: "FAIL" },
    { allowed: 1, attempt: undefined, expected: "UNKNOWN" },
    { allowed: undefined, attempt: 0, expected: "UNKNOWN" },
  ])(
    "preserves unknown attempt counts: $allowed / $attempt -> $expected",
    async ({ allowed, attempt, expected }) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.allowed_attempts = allowed;
      if (attempt !== undefined)
        context.submission = {
          kind: "submissions",
          id: "99",
          course_id: "7",
          title: "Submission",
          updated_at: null,
          data: { assignment_id: "23", attempt },
          raw: {},
        };
      await writeFile(join(submission, "paper.txt"), "draft");
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "attempts", status: expected }),
      );
      if (expected !== "PASS") expect(result.ready).toBe(false);
    },
  );
  it.each([
    { name: "paper.TXT", allowed: ["txt"], expected: "PASS" },
    { name: "paper.exe", allowed: ["txt"], expected: "FAIL" },
    { name: "paper.txt.exe", allowed: ["txt"], expected: "FAIL" },
    { name: "paper.pdf", allowed: [], expected: "PASS" },
    { name: "paper.txt", allowed: undefined, expected: "UNKNOWN" },
  ])(
    "checks the literal final extension: $name / $expected",
    async ({ name, allowed, expected }) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.allowed_extensions = allowed;
      await writeFile(join(submission, name), "draft");
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "extensions", status: expected }),
      );
    },
  );
  it.each([
    { types: ["online_upload"], expected: "PASS" },
    { types: ["none"], expected: "FAIL" },
    { types: ["external_tool"], expected: "UNKNOWN" },
    { types: ["online_text_entry"], expected: "UNKNOWN" },
    { types: undefined, expected: "UNKNOWN" },
  ])(
    "reports supported local-file submission type $types as $expected",
    async ({ types, expected }) => {
      const { config, context, submission } = await fixture();
      context.assignment.data.submission_types = types;
      await writeFile(join(submission, "paper.txt"), "draft");
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "submission_type", status: expected }),
      );
      expect(result.submission_enabled).toBe(false);
    },
  );
  it("treats readiness as mechanical only, never as authorization or rubric approval", async () => {
    const { config, context, submission } = await fixture();
    await writeFile(join(submission, "paper.txt"), "draft");
    const result = await validateAssignment(context, config);
    expect(result.ready).toBe(true);
    expect(result.submission_enabled).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        check: "authorization",
        status: "WARNING",
        message: expect.stringMatching(/not.*authoriz/i),
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "rubric", status: "UNKNOWN" }),
    );
  });
  it("fails empty submission directories", async () => {
    const { config, context } = await fixture();
    const result = await validateAssignment(context, config);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "files", status: "FAIL" }),
    );
    expect(result.ready).toBe(false);
  });
  it("counts only direct regular files and does not follow hostile submission entries", async () => {
    const { root, config, context, submission } = await fixture();
    await writeFile(join(root, "private.txt"), "do-not-read");
    await symlink(join(root, "private.txt"), join(submission, "paper.txt"));
    const result = await validateAssignment(context, config);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        check: "files",
        status: "FAIL",
        message: expect.stringMatching(/unsafe|symlink/i),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("do-not-read");
    expect(result.ready).toBe(false);
  });
  it.each(["submission-symlink", "hardlink", "nested-directory"])(
    "rejects %s without recursive or arbitrary access",
    async (hostile) => {
      const { root, config, context, submission } = await fixture();
      await mkdir(join(root, "private"));
      await writeFile(join(root, "private", "secret.txt"), "do-not-read");
      if (hostile === "submission-symlink") {
        await rm(submission, { recursive: true });
        await symlink(join(root, "private"), submission);
      }
      if (hostile === "hardlink")
        await link(
          join(root, "private", "secret.txt"),
          join(submission, "paper.txt"),
        );
      if (hostile === "nested-directory")
        await mkdir(join(submission, "nested"));
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({ check: "files", status: "FAIL" }),
      );
      expect(result.ready).toBe(false);
      expect(JSON.stringify(result)).not.toContain("do-not-read");
    },
  );
  it.each(["count", "bytes"])(
    "bounds submission inspection by %s",
    async (limit) => {
      const { config, context, submission } = await fixture();
      if (limit === "count")
        await Promise.all(
          Array.from({ length: 101 }, (_, i) =>
            writeFile(join(submission, `paper-${i}.txt`), "x"),
          ),
        );
      else {
        config.maxDownloadBytes = 4;
        await writeFile(join(submission, "paper.txt"), "too large");
      }
      const result = await validateAssignment(context, config);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          check: "files",
          status: "FAIL",
          message: expect.stringMatching(/limit/i),
        }),
      );
      expect(result.ready).toBe(false);
    },
  );
  it("reports bounded direct regular files without claiming qualitative rubric compliance", async () => {
    const { config, context, submission } = await fixture();
    await writeFile(
      join(submission, "paper.txt"),
      "Thoughtful analysis original response",
    );
    const result = await validateAssignment(context, config);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "files", status: "PASS" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "rubric", status: "UNKNOWN" }),
    );
    expect(result.submission_enabled).toBe(false);
  });
  it("reports missing workspace as FAIL, cache caveat and rubric UNKNOWN; never enables submission", async () => {
    const { context, config } = await fixture(false);
    const result = await validateAssignment(context, config);
    expect(result.ready).toBe(false);
    expect(result.submission_enabled).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "workspace", status: "FAIL" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: "rubric", status: "UNKNOWN" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        check: "freshness",
        status: "WARNING",
        message: expect.stringMatching(/cache|snapshot/i),
      }),
    );
  });
});

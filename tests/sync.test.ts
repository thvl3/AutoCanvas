import { afterEach, describe, expect, it } from "vitest";
import { Repository } from "../src/db/repository.js";
import { CanvasApi } from "../src/canvas/api.js";
import { CanvasClient } from "../src/canvas/client.js";
import { SyncService } from "../src/services/sync.js";
import type { Entity, EntityKind } from "../src/domain/types.js";

function e(
  kind: EntityKind,
  id: string,
  course_id: string | null = "10",
  data: Record<string, unknown> = {},
  updated_at: string | null = "2026-09-01T00:00:00Z",
): Entity {
  return {
    kind,
    id,
    course_id,
    title: `${kind} ${id}`,
    updated_at,
    data: { id, ...data },
    raw: { id, ...data },
  };
}
class FakeApi {
  baseUrl = "https://school.example";
  user = "42";
  calls: string[] = [];
  courseRows = [e("courses", "10", null, { workflow_state: "available" })];
  collections = new Map<string, Entity[]>();
  failures = new Map<string, unknown>();
  items = new Map<string, Entity[]>();
  pages = new Map<string, Entity>();
  submissions = new Map<string, Entity>();
  async response<T>(key: string, value: T): Promise<T> {
    this.calls.push(key);
    if (this.failures.has(key)) throw this.failures.get(key);
    return structuredClone(value);
  }
  async authCheck() {
    return this.response("auth", { id: this.user });
  }
  async courses() {
    return this.response("courses", this.courseRows);
  }
  async collection(kind: EntityKind, courseId: string) {
    return this.response(
      `${kind}:${courseId}`,
      this.collections.get(`${kind}:${courseId}`) ?? [],
    );
  }
  async moduleItems(courseId: string, moduleId: string) {
    return this.response(
      `module_items:${courseId}:${moduleId}`,
      this.items.get(moduleId) ?? [],
    );
  }
  async page(courseId: string, id: string) {
    return this.response(
      `page:${courseId}:${id}`,
      this.pages.get(id) ??
        e("pages", id, courseId, { body: "<p>Default page</p>" }),
    );
  }
  async submission(courseId: string, id: string) {
    return this.response(
      `submission:${courseId}:${id}`,
      this.submissions.get(id)!,
    );
  }
}
const repositories: Repository[] = [];
function setup() {
  const repo = new Repository(":memory:");
  repositories.push(repo);
  const api = new FakeApi();
  return { repo, api, sync: new SyncService(repo, api, { concurrency: 2 }) };
}
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});

describe("SyncService", () => {
  it("syncs the listed page ID rather than interpreting its numeric slug as an ID", async () => {
    const { repo } = setup();
    const paths: string[] = [];
    const page = {
      page_id: 40,
      url: "7",
      title: "Numeric slug",
      updated_at: "2026-09-01T00:00:00Z",
    };
    const api = new CanvasApi(
      new CanvasClient(
        {
          baseUrl: "https://school.example",
          accessToken: "fixture-token",
          timeoutMs: 1000,
          maxRetries: 0,
        },
        {
          fetch: async (input) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            let payload: unknown = [];
            if (path === "/api/v1/users/self/profile") payload = { id: 42 };
            if (path === "/api/v1/courses")
              payload = [
                { id: 10, name: "Course", workflow_state: "available" },
              ];
            if (path === "/api/v1/courses/10/pages") payload = [page];
            if (path === "/api/v1/courses/10/pages/page_id:40")
              payload = { ...page, body: "<p>Correct page forty</p>" };
            if (path === "/api/v1/courses/10/pages/page_id:7")
              payload = {
                page_id: 7,
                url: "other",
                title: "Wrong page",
                body: "<p>Wrong page seven</p>",
              };
            return new Response(JSON.stringify(payload), {
              headers: { "content-type": "application/json" },
            });
          },
        },
      ),
    );
    const sync = new SyncService(repo, api);
    const result = await sync.run();
    expect(repo.get("pages", "40", "10")?.data.body).toBe(
      "<p>Correct page forty</p>",
    );
    expect(repo.get("pages", "7", "10")).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(paths).toContain("/api/v1/courses/10/pages/page_id:40");
    expect(paths).not.toContain("/api/v1/courses/10/pages/page_id:7");
    paths.length = 0;
    await sync.run();
    expect(paths).not.toContain("/api/v1/courses/10/pages/page_id:40");
  });
  it("syncs optional planner items and logs only structured start/update/completion metadata", async () => {
    const { repo, api } = setup();
    const entries: Record<string, unknown>[] = [];
    const logger = {
      warn: (metadata: Record<string, unknown>) => {
        entries.push(metadata);
      },
      info: (metadata: Record<string, unknown>) => {
        entries.push(metadata);
      },
    };
    const sync = new SyncService(repo, api, { logger, origin: api.baseUrl });
    api.collections.set("planner:10", [
      e("planner", "Assignment:11", "10", {
        plannable_id: "11",
        plannable_type: "Assignment",
        body: "private planner body",
      }),
    ]);
    const summary = await sync.run();
    expect(repo.list("planner")).toHaveLength(1);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "sync.started",
          started_at: expect.any(String),
        }),
        expect.objectContaining({
          event: "cache.updated",
          kind: "planner",
          course_id: "10",
          counts: { added: 1, updated: 0, unchanged: 0, removed: 0 },
        }),
        expect.objectContaining({
          event: "sync.completed",
          status: "complete",
          counts: summary.counts,
          completed_at: summary.completed_at,
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain("private planner body");
    api.failures.set("planner:10", { status: 403 });
    await expect(sync.run()).resolves.toMatchObject({ status: "partial" });
    expect(repo.list("planner")).toHaveLength(1);
    expect(repo.syncState()["planner:10"]).toMatchObject({ status: "stale" });
    api.failures.set("auth", { status: 401 });
    await expect(sync.run()).rejects.toMatchObject({ status: 401 });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "sync.completed",
          status: "failed",
          counts: expect.any(Object),
          completed_at: expect.any(String),
        }),
      ]),
    );
  });
  it("marks dependent and unattempted retained data stale when a parent endpoint fails or auth aborts", async () => {
    const { repo, api, sync } = setup();
    await sync.run();
    api.failures.set("assignments:10", { status: 403 });
    api.failures.set("modules:10", { status: 404 });
    await sync.run();
    expect(repo.syncState()).toMatchObject({
      "submissions:10": { status: "stale" },
      "rubrics:10": { status: "stale" },
      "module_items:10": { status: "stale" },
      "files:10": { status: "fresh" },
    });
    api.failures.clear();
    api.failures.set("auth", { status: 401 });
    await expect(sync.run()).rejects.toMatchObject({ status: 401 });
    expect(repo.syncState()).toMatchObject({
      "files:10": { status: "stale" },
      courses: { status: "stale" },
    });
  });
  it("never writes a late response or run state after losing the cross-process lease", async () => {
    const { repo, api, sync } = setup();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    api.courses = async () => {
      entered();
      await gate;
      return api.courseRows;
    };
    const running = sync.run();
    await ready;
    const lease = repo.syncState()._lease as { owner: string };
    repo.releaseSyncLease(lease.owner);
    repo.acquireSyncLease("new-owner");
    repo.setSyncState("run", { status: "running", owner: "new-owner" });
    resume();
    await expect(running).rejects.toThrow(/lease/i);
    expect(repo.list("courses")).toEqual([]);
    expect(repo.syncState().run).toEqual({
      status: "running",
      owner: "new-owner",
    });
  });
  it("keeps failed submission detail but refreshes other assignments and rejects another user payload", async () => {
    const { repo, api, sync } = setup();
    api.collections.set("assignments:10", [
      e("assignments", "11"),
      e("assignments", "12"),
    ]);
    api.submissions.set(
      "11",
      e("submissions", "s1", "10", {
        assignment_id: "11",
        user_id: "42",
        grade: "old",
      }),
    );
    api.submissions.set(
      "12",
      e("submissions", "s2", "10", {
        assignment_id: "12",
        user_id: "42",
        grade: "old",
      }),
    );
    await sync.run();
    api.failures.set("submission:10:11", { status: 404 });
    api.submissions.set(
      "12",
      e("submissions", "s2", "10", {
        assignment_id: "12",
        user_id: "42",
        grade: "new",
      }),
    );
    await sync.run();
    expect(repo.get("submissions", "s1", "10")?.data.grade).toBe("old");
    expect(repo.get("submissions", "s2", "10")?.data.grade).toBe("new");
    expect(repo.syncState()["submissions:10"]).toMatchObject({
      status: "stale",
    });
    api.failures.clear();
    api.submissions.set(
      "11",
      e("submissions", "foreign", "10", { assignment_id: "11", user_id: "99" }),
    );
    const result = await sync.run();
    expect(result.status).toBe("partial");
    expect(repo.get("submissions", "foreign", "10")).toBeUndefined();
    expect(repo.get("submissions", "s1", "10")).toBeDefined();
  });
  it("serializes overlapping calls on an instance and leases the cache against other instances", async () => {
    const { repo, api, sync } = setup();
    let active = 0;
    let peak = 0;
    const original = api.authCheck.bind(api);
    api.authCheck = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return original();
    };
    await Promise.all([sync.run(), sync.run()]);
    expect(peak).toBe(1);
    expect(api.calls.filter((x) => x === "auth")).toHaveLength(2);
    repo.acquireSyncLease("another-process");
    await expect(new SyncService(repo, api).run()).rejects.toThrow(
      /lease|in progress/i,
    );
    repo.releaseSyncLease("another-process");
    api.failures.set("auth", { status: 401 });
    await expect(sync.run()).rejects.toMatchObject({ status: 401 });
    api.failures.clear();
    await expect(sync.run()).resolves.toMatchObject({ status: "complete" });
    expect(repo.syncState()._lease).toBeUndefined();
  });
  it("honors bounded concurrency across courses", async () => {
    const { repo, api } = setup();
    api.courseRows.push(e("courses", "20", null), e("courses", "30", null));
    let active = 0;
    let peak = 0;
    const original = api.collection.bind(api);
    api.collection = async (kind, courseId) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return original(kind, courseId);
    };
    await new SyncService(repo, api, { concurrency: 2 }).run();
    expect(peak).toBe(2);
  });
  it("refreshes assignments and self submissions including comments on every run and extracts assignment rubrics", async () => {
    const { repo, api, sync } = setup();
    const assignment = e("assignments", "11", "10", {
      rubric: [{ id: "criterion", description: "Explain", points: 10 }],
      rubric_settings: { id: "r1", title: "Essay rubric" },
    });
    api.collections.set("assignments:10", [assignment]);
    api.submissions.set(
      "11",
      e("submissions", "s1", "10", {
        assignment_id: "11",
        user_id: "42",
        submission_comments: [{ id: "c1", comment: "Original" }],
      }),
    );
    await sync.run();
    expect(repo.list("submissions")).toHaveLength(1);
    expect(repo.get("rubrics", "11", "10")?.data).toMatchObject({
      assignment_id: "11",
      rubric: assignment.data.rubric,
    });
    api.calls = [];
    api.submissions.set(
      "11",
      e("submissions", "s1", "10", {
        assignment_id: "11",
        user_id: "42",
        submission_comments: [{ id: "c1", comment: "New feedback" }],
      }),
    );
    const second = await sync.run();
    expect(api.calls).toEqual(
      expect.arrayContaining(["assignments:10", "submission:10:11"]),
    );
    expect(
      repo.get("submissions", "s1", "10")?.data.submission_comments,
    ).toEqual([{ id: "c1", comment: "New feedback" }]);
    expect(second.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "submissions", change: "updated" }),
      ]),
    );
    api.failures.set("submission:10:11", { status: 403 });
    await sync.run();
    expect(repo.list("submissions")).toHaveLength(1);
    expect(repo.syncState()["submissions:10"]).toMatchObject({
      status: "stale",
    });
    api.failures.clear();
    api.collections.set("assignments:10", []);
    await sync.run();
    expect(repo.list("submissions")).toEqual([]);
    expect(repo.list("rubrics")).toEqual([]);
  });
  it("loads full page bodies incrementally only reusing known matching timestamps unless forced", async () => {
    const { repo, api, sync } = setup();
    const page = e("pages", "8", "10", {
      url: "syllabus",
      body: "<p>Original</p>",
    });
    api.collections.set("pages:10", [
      e("pages", "8", "10", { url: "syllabus" }),
    ]);
    api.pages.set("8", page);
    await sync.run();
    expect(repo.get("pages", "8", "10")?.data.body).toBe("<p>Original</p>");
    api.calls = [];
    await sync.run();
    expect(api.calls).not.toContain("page:10:8");
    expect(repo.get("pages", "8", "10")?.data.body).toBe("<p>Original</p>");
    api.calls = [];
    await sync.run({ force: true });
    expect(api.calls).toContain("page:10:8");
    const changed = "2026-09-02T00:00:00Z";
    api.collections.set("pages:10", [
      e("pages", "8", "10", { url: "syllabus" }, changed),
    ]);
    api.failures.set("page:10:8", { status: 404 });
    const result = await sync.run();
    expect(result.status).toBe("partial");
    expect(repo.get("pages", "8", "10")).toEqual(page);
    expect(repo.syncState()["pages:10"]).toMatchObject({ status: "stale" });
    api.failures.clear();
    api.pages.set("8", {
      ...page,
      updated_at: changed,
      data: { ...page.data, body: "<p>Updated</p>" },
    });
    await sync.run();
    expect(repo.get("pages", "8", "10")?.data.body).toBe("<p>Updated</p>");
    repo.upsert(e("pages", "8", "10", { url: "syllabus" }, changed));
    api.calls = [];
    await sync.run();
    expect(api.calls).toContain("page:10:8");
    api.collections.set("pages:10", [
      e("pages", "8", "10", { url: "syllabus" }, null),
    ]);
    api.calls = [];
    await sync.run();
    expect(api.calls).toContain("page:10:8");
  });
  it("always traverses full module item endpoints and retains the prior collection if any traversal fails", async () => {
    const { repo, api, sync } = setup();
    api.collections.set("modules:10", [
      e("modules", "m1", "10", { items: [{ id: "truncated" }] }),
      e("modules", "m2"),
    ]);
    api.items.set("m1", [
      e("module_items", "a", "10", { module_id: "m1" }),
      e("module_items", "b", "10", { module_id: "m1" }),
    ]);
    api.items.set("m2", [e("module_items", "c", "10", { module_id: "m2" })]);
    await sync.run();
    expect(repo.list("module_items").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(api.calls).toEqual(
      expect.arrayContaining(["module_items:10:m1", "module_items:10:m2"]),
    );
    api.items.set("m1", []);
    api.failures.set("module_items:10:m2", { status: 403 });
    const partial = await sync.run();
    expect(partial.status).toBe("partial");
    expect(repo.list("module_items")).toHaveLength(3);
    expect(repo.syncState()["module_items:10"]).toMatchObject({
      status: "stale",
    });
    api.failures.clear();
    api.items.set("m2", []);
    await sync.run();
    expect(repo.list("module_items")).toEqual([]);
    api.failures.set("module_items:10:m1", { status: 403 });
    api.calls = [];
    await sync.run();
    expect(api.calls).toContain("module_items:10:m2");
  });
  it("aborts on 401 without erasing cache and persists a failed run; account mismatch prevents collection reads", async () => {
    const { repo, api, sync } = setup();
    api.collections.set("files:10", [e("files", "1")]);
    await sync.run();
    api.calls = [];
    api.failures.set(
      "assignments:10",
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    await expect(sync.run()).rejects.toMatchObject({ status: 401 });
    expect(api.calls).not.toContain("files:10");
    expect(repo.list("files")).toHaveLength(1);
    expect(repo.syncState()).toMatchObject({
      run: { status: "failed", completed_at: expect.any(String) },
      "assignments:10": { status: "stale" },
    });
    api.failures.clear();
    api.user = "99";
    api.calls = [];
    await expect(sync.run()).rejects.toThrow(/identity/i);
    expect(api.calls).toEqual(["auth"]);
  });
  it("treats the courses endpoint as mandatory and retains its last authoritative snapshot on failure", async () => {
    const { repo, api, sync } = setup();
    await sync.run();
    api.failures.set("courses", new Error("network failure"));
    await expect(sync.run()).rejects.toThrow("network failure");
    expect(repo.list("courses")).toHaveLength(1);
    expect(repo.syncState()).toMatchObject({
      courses: { status: "stale" },
      run: { status: "failed" },
    });
  });
  it("retains failed optional/network collections as stale while reconciling successful endpoints", async () => {
    const { repo, api, sync } = setup();
    for (const kind of [
      "files",
      "pages",
      "announcements",
      "discussions",
    ] as const)
      api.collections.set(`${kind}:10`, [e(kind, "1")]);
    await sync.run();
    const lastSuccess = (
      repo.syncState()["files:10"] as { last_success_at: string }
    ).last_success_at;
    api.failures.set(
      "files:10",
      Object.assign(new Error("secret-token must not be logged"), {
        status: 403,
      }),
    );
    api.failures.set("pages:10", { status: 404 });
    api.failures.set("announcements:10", new Error("private network endpoint"));
    api.collections.set("discussions:10", []);
    const result = await sync.run();
    expect(result.status).toBe("partial");
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "files:10", status: 403 }),
        expect.objectContaining({ key: "pages:10", status: 404 }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("secret-token");
    for (const kind of ["files", "pages", "announcements"] as const)
      expect(repo.list(kind)).toHaveLength(1);
    expect(repo.list("discussions")).toEqual([]);
    expect(repo.syncState()["files:10"]).toMatchObject({
      status: "stale",
      last_success_at: lastSuccess,
    });
    expect(result.counts.removed).toBe(1);
  });
  it("syncs active courses and successful collections with persisted freshness and summary counts", async () => {
    const { repo, api, sync } = setup();
    api.courseRows.push(
      e("courses", "20", null, { workflow_state: "completed" }),
    );
    api.collections.set("files:10", [e("files", "5")]);
    api.collections.set("enrollments:10", [
      e("enrollments", "6", "10", { user_id: "42" }),
      e("enrollments", "7", "10", { user_id: "99" }),
    ]);
    const result = await sync.run();
    expect(repo.list("courses").map((x) => x.id)).toEqual(["10"]);
    expect(repo.list("files")).toHaveLength(1);
    expect(repo.list("enrollments").map((x) => x.id)).toEqual(["6"]);
    expect(result).toMatchObject({
      status: "complete",
      counts: { added: 3, updated: 0, removed: 0 },
      warnings: [],
    });
    expect(result.completed_at >= result.started_at).toBe(true);
    expect(result.changes).toHaveLength(3);
    expect(api.calls).toEqual(
      expect.arrayContaining([
        "assignments:10",
        "assignment_groups:10",
        "modules:10",
        "pages:10",
        "files:10",
        "discussions:10",
        "announcements:10",
        "enrollments:10",
      ]),
    );
    expect(api.calls.some((x) => x.endsWith(":20"))).toBe(false);
    expect(repo.syncState()).toMatchObject({
      identity: api.baseUrl,
      user_id: "42",
      "files:10": { status: "fresh", last_success_at: expect.any(String) },
      run: { status: "complete" },
    });
    api.courseRows = [];
    await sync.run();
    expect(repo.list("courses")).toEqual([]);
    expect(repo.list("files")).toHaveLength(1); // orphaned history is retained; workflows join active courses.
  });
});

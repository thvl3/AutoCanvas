import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Repository } from "../src/db/repository.js";
import type { Entity, EntityKind } from "../src/domain/types.js";

const dirs: string[] = [];
const repos: Repository[] = [];
function disk() {
  const dir = mkdtempSync(join(tmpdir(), "canvas-db-"));
  dirs.push(dir);
  return join(dir, "nested", "cache.sqlite");
}
function repo(path = ":memory:", identity?: string) {
  const r = new Repository(path, identity);
  repos.push(r);
  return r;
}
function entity(
  kind: EntityKind = "assignments",
  id = "1",
  course_id: string | null = "10",
  data: Record<string, unknown> = {},
): Entity {
  return {
    kind,
    id,
    course_id,
    title: "Example",
    updated_at: "2026-09-01T00:00:00Z",
    data,
    raw: { id, ...data },
  };
}
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Repository", () => {
  it("creates private cache directories and database files without chmodding preexisting directories", () => {
    const path = disk();
    repo(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    const otherPath = disk();
    mkdirSync(join(otherPath, ".."), { mode: 0o755 });
    repo(otherPath);
    expect(statSync(join(otherPath, "..")).mode & 0o777).toBe(0o755);
  });
  it("leases a shared cache exclusively and guards account changes independently of origin", () => {
    const path = disk();
    const a = repo(path, "https://school.example");
    const b = repo(path, "https://school.example");
    a.bindUserIdentity("42");
    b.bindUserIdentity("42");
    expect(() => b.bindUserIdentity("99")).toThrow(/identity/i);
    expect(a.acquireSyncLease("owner-a", 1000, 0)).toBe(true);
    expect(b.acquireSyncLease("owner-b", 1000, 500)).toBe(false);
    expect(a.renewSyncLease("owner-a", 1000, 500)).toBe(true);
    expect(b.acquireSyncLease("owner-b", 1000, 1100)).toBe(false);
    b.releaseSyncLease("owner-b");
    expect(b.acquireSyncLease("owner-b", 1000, 1501)).toBe(true);
    expect(a.renewSyncLease("owner-a", 1000, 1502)).toBe(false);
    b.releaseSyncLease("owner-b");
    expect(a.acquireSyncLease("owner-a", 1000, 1503)).toBe(true);
  });
  it("persists freshness and rejects opening or rebinding another identity without erasing cache", () => {
    const path = disk();
    const r = repo(path, "https://school.example|user:42");
    r.upsert(entity());
    r.setSyncState("assignments:10", {
      status: "stale",
      last_success_at: "2026-01-01",
      warning: "403",
    });
    r.close();
    expect(() => repo(path, "https://other.example|user:42")).toThrow(
      /identity/i,
    );
    const same = repo(path, "https://school.example|user:42");
    expect(same.syncState()).toMatchObject({
      "assignments:10": { status: "stale", last_success_at: "2026-01-01" },
    });
    expect(() => same.bindIdentity("https://school.example|user:99")).toThrow(
      /identity/i,
    );
    expect(same.list("assignments")).toHaveLength(1);
    same.bindIdentity("https://school.example|user:42");
  });
  it("reconciles only the requested collection atomically, rolling back invalid batches", () => {
    const r = repo();
    r.upsert(entity());
    r.upsert(entity("assignments", "2"));
    r.upsert(entity("assignments", "1", "20"));
    expect(
      r.replaceCollection("assignments", "10", [
        entity("assignments", "1"),
        entity("assignments", "3"),
      ]),
    ).toEqual({ added: 1, updated: 0, unchanged: 1, removed: 1 });
    expect(r.list("assignments", "10").map((x) => x.id)).toEqual(["1", "3"]);
    expect(r.list("assignments", "20")).toHaveLength(1);
    expect(() => r.get("assignments", "1")).toThrow(/ambiguous/i);
    const prior = r.recentChanges();
    expect(() =>
      r.replaceCollection("assignments", "10", [
        entity("assignments", "4"),
        entity("pages", "5"),
      ]),
    ).toThrow(/collection/i);
    expect(r.get("assignments", "4", "10")).toBeUndefined();
    expect(r.recentChanges()).toEqual(prior);
    expect(() =>
      r.replaceCollection("assignments", "10", [entity(), entity()]),
    ).toThrow(/duplicate/i);
    expect(r.replaceCollection("assignments", "10", [])).toEqual({
      added: 0,
      updated: 0,
      unchanged: 0,
      removed: 2,
    });
    expect(r.recentChanges()[0]).toMatchObject({
      change: "removed",
      fields: [],
    });
  });
  it("ignores key order and signed URL churn but records meaningful field names without old bodies", () => {
    const r = repo();
    const first = entity("files", "1", "10", {
      url: "https://files.example/a?X-Amz-Signature=old&X-Amz-Expires=20&download=1",
      nested: { b: 2, a: 1 },
      body: "private original",
    });
    expect(r.upsert(first)).toBe("added");
    const fresh = entity("files", "1", "10", {
      body: "private original",
      nested: { a: 1, b: 2 },
      url: "https://files.example/a?download=1&X-Amz-Expires=40&X-Amz-Signature=new",
    });
    expect(r.upsert(fresh)).toBe("unchanged");
    expect(r.get("files", "1", "10")?.data.url).toBe(fresh.data.url);
    expect(
      r.upsert({ ...fresh, data: { ...fresh.data, body: "private new" } }),
    ).toBe("updated");
    const changes = r.recentChanges();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      kind: "files",
      id: "1",
      course_id: "10",
      change: "updated",
      fields: ["data.body"],
    });
    expect(JSON.stringify(changes)).not.toContain("private");
    expect(r.recentChanges("9999-01-01T00:00:00Z")).toEqual([]);
    expect(r.recentChanges(undefined, 1)).toHaveLength(1);
  });
  it("persists entities in migrated indexed SQLite tables with the built-in SQLite module", () => {
    const path = disk();
    const r = repo(path);
    expect(r.upsert(entity())).toBe("added");
    expect(r.list("assignments", "10")).toEqual([entity()]);
    r.close();
    const reopened = repo(path);
    expect(reopened.get("assignments", "1", "10")).toEqual(entity());
    const native = new DatabaseSync(path);
    expect(
      (native.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(1);
    const tables = native
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        "courses",
        "assignments",
        "module_items",
        "submissions",
        "sync_state",
        "changes",
      ]),
    );
    expect(
      native
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='assignments'",
        )
        .all().length,
    ).toBeGreaterThan(1);
    native.close();
  });
});

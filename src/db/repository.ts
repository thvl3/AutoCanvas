import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, transaction } from "./sqlite.js";
import type { Entity, EntityKind } from "../domain/types.js";
import { ENTITY_KINDS, migrate } from "./migrations.js";
import { changedFields } from "./canonical.js";

export interface CollectionCounts {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}
export interface Change {
  kind: EntityKind;
  id: string;
  course_id: string | null;
  change: "added" | "updated" | "removed";
  changed_at: string;
  fields: string[];
}

type Row = {
  id: string;
  course_id: string;
  title: string;
  updated_at: string | null;
  data_json: string;
  raw_json: string;
};

export class Repository {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string, identity?: string) {
    if (path !== ":memory:") {
      // Set restrictive modes at creation, never chmod a preexisting shared directory.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      migrate(this.db);
      if (identity !== undefined) this.bindIdentity(identity);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  bindIdentity(identity: string): void {
    if (!identity.trim()) throw new Error("Cache identity cannot be empty");
    transaction(this.db, "BEGIN IMMEDIATE", () => {
      const prior = this.syncState().identity;
      if (prior !== undefined && prior !== identity)
        throw new Error(
          "Cache identity mismatch; use a separate cache for this Canvas account",
        );
      this.setSyncState("identity", identity);
    });
  }
  bindUserIdentity(userId: string): void {
    if (!userId.trim()) throw new Error("Canvas user identity cannot be empty");
    transaction(this.db, "BEGIN IMMEDIATE", () => {
      const prior = this.syncState().user_id;
      if (prior !== undefined && prior !== userId)
        throw new Error("Cache user identity mismatch; use a separate cache");
      this.setSyncState("user_id", userId);
    });
  }
  acquireSyncLease(owner: string, ttlMs = 120_000, now = Date.now()): boolean {
    return transaction(this.db, "BEGIN IMMEDIATE", () => {
      const lease = this.syncState()._lease as
        { owner: string; expires_at: number } | undefined;
      if (lease && lease.owner !== owner && lease.expires_at > now)
        return false;
      this.setSyncState("_lease", { owner, expires_at: now + ttlMs });
      return true;
    });
  }
  renewSyncLease(owner: string, ttlMs = 120_000, now = Date.now()): boolean {
    return transaction(this.db, "BEGIN IMMEDIATE", () => {
      const lease = this.syncState()._lease as
        { owner: string; expires_at: number } | undefined;
      if (!lease || lease.owner !== owner || lease.expires_at <= now)
        return false;
      this.setSyncState("_lease", { owner, expires_at: now + ttlMs });
      return true;
    });
  }
  releaseSyncLease(owner: string): void {
    transaction(this.db, "BEGIN IMMEDIATE", () => {
      const lease = this.syncState()._lease as { owner: string } | undefined;
      if (lease?.owner === owner)
        this.db.prepare("DELETE FROM sync_state WHERE key=?").run("_lease");
    });
  }
  syncState(): Record<string, unknown> {
    const rows = this.db
      .prepare("SELECT key,value_json FROM sync_state ORDER BY key")
      .all() as { key: string; value_json: string }[];
    return Object.fromEntries(
      rows.map((row) => [row.key, JSON.parse(row.value_json)]),
    );
  }
  setSyncState(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO sync_state(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(key, JSON.stringify(value));
  }
  private table(kind: EntityKind): string {
    if (!ENTITY_KINDS.includes(kind)) throw new Error("Unknown entity kind");
    return kind;
  }
  private decode(kind: EntityKind, row: Row): Entity {
    return {
      kind,
      id: row.id,
      course_id: row.course_id || null,
      title: row.title,
      updated_at: row.updated_at,
      data: JSON.parse(row.data_json),
      raw: JSON.parse(row.raw_json),
    };
  }
  list(kind: EntityKind, courseId?: string): Entity[] {
    const table = this.table(kind);
    const rows =
      courseId === undefined
        ? this.db.prepare(`SELECT * FROM ${table} ORDER BY course_id, id`).all()
        : this.db
            .prepare(`SELECT * FROM ${table} WHERE course_id=? ORDER BY id`)
            .all(courseId);
    return (rows as Row[]).map((row) => this.decode(kind, row));
  }
  get(kind: EntityKind, id: string, courseId?: string): Entity | undefined {
    const table = this.table(kind);
    const rows = (
      courseId === undefined
        ? this.db.prepare(`SELECT * FROM ${table} WHERE id=? LIMIT 2`).all(id)
        : this.db
            .prepare(`SELECT * FROM ${table} WHERE id=? AND course_id=?`)
            .all(id, courseId)
    ) as Row[];
    if (rows.length > 1)
      throw new Error(`Ambiguous ${kind} id; specify courseId`);
    return rows[0] ? this.decode(kind, rows[0]) : undefined;
  }
  replaceCollection(
    kind: EntityKind,
    courseId: string | null,
    entities: Entity[],
  ): CollectionCounts {
    const table = this.table(kind);
    return transaction(this.db, "BEGIN", () => {
      const ids = new Set<string>();
      const counts: CollectionCounts = {
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
      };
      for (const entity of entities) {
        if (entity.kind !== kind || entity.course_id !== courseId)
          throw new Error("Entity does not belong to collection");
        if (ids.has(entity.id))
          throw new Error("Duplicate entity in collection");
        ids.add(entity.id);
        counts[this.upsert(entity)]++;
      }
      for (const old of this.list(kind, courseId ?? "")) {
        if (ids.has(old.id)) continue;
        this.db
          .prepare(`DELETE FROM ${table} WHERE course_id=? AND id=?`)
          .run(courseId ?? "", old.id);
        this.recordChange(old, "removed", []);
        counts.removed++;
      }
      return counts;
    });
  }
  upsert(entity: Entity): "added" | "updated" | "unchanged" {
    return transaction(this.db, "BEGIN", () => {
      const old = this.get(entity.kind, entity.id, entity.course_id ?? "");
      const fields = old
        ? changedFields(old, entity)
        : ["data", "title", "updated_at"];
      const change = old ? (fields.length ? "updated" : "unchanged") : "added";
      this.db
        .prepare(
          `INSERT INTO ${this.table(entity.kind)}(id,course_id,title,updated_at,data_json,raw_json)
        VALUES(?,?,?,?,?,?) ON CONFLICT(course_id,id) DO UPDATE SET title=excluded.title,
        updated_at=excluded.updated_at,data_json=excluded.data_json,raw_json=excluded.raw_json`,
        )
        .run(
          entity.id,
          entity.course_id ?? "",
          entity.title,
          entity.updated_at,
          JSON.stringify(entity.data),
          JSON.stringify(entity.raw),
        );
      if (change !== "unchanged") this.recordChange(entity, change, fields);
      return change;
    });
  }
  private recordChange(
    entity: Entity,
    change: Change["change"],
    fields: string[],
  ): void {
    this.db
      .prepare(
        "INSERT INTO changes(kind,id,course_id,change,changed_at,fields_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        entity.kind,
        entity.id,
        entity.course_id,
        change,
        new Date().toISOString(),
        JSON.stringify(fields),
      );
  }
  recentChanges(since?: string, limit = 100): Change[] {
    const rows = this.db
      .prepare(
        `SELECT kind,id,course_id,change,changed_at,fields_json FROM changes
      WHERE (? IS NULL OR changed_at >= ?) ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        since ?? null,
        since ?? null,
        Math.max(0, Math.floor(limit)),
      ) as (Omit<Change, "fields"> & { fields_json: string })[];
    return rows.map(({ fields_json, ...row }) => ({
      ...row,
      fields: JSON.parse(fields_json),
    }));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

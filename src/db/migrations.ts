import type Database from "better-sqlite3";
import type { EntityKind } from "../domain/types.js";

export const ENTITY_KINDS: readonly EntityKind[] = [
  "courses",
  "assignments",
  "assignment_groups",
  "modules",
  "module_items",
  "pages",
  "files",
  "discussions",
  "announcements",
  "submissions",
  "rubrics",
  "enrollments",
  "planner",
];

export function migrate(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > 1)
    throw new Error("Cache schema is newer than this application");
  if (version === 1) return;
  db.transaction(() => {
    for (const kind of ENTITY_KINDS) {
      db.exec(`CREATE TABLE ${kind} (
        id TEXT NOT NULL, course_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
        updated_at TEXT, data_json TEXT NOT NULL, raw_json TEXT NOT NULL,
        PRIMARY KEY(course_id, id)
      );
      CREATE INDEX idx_${kind}_id ON ${kind}(id);
      CREATE INDEX idx_${kind}_course_updated ON ${kind}(course_id, updated_at);`);
    }
    db.exec(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
        course_id TEXT, change TEXT NOT NULL, changed_at TEXT NOT NULL, fields_json TEXT NOT NULL);
      CREATE INDEX idx_changes_time ON changes(changed_at, sequence);
      PRAGMA user_version = 1;`);
  })();
}

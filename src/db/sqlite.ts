import { DatabaseSync } from "node:sqlite";

export { DatabaseSync };

interface TxState {
  depth: number;
  counter: number;
}
const states = new WeakMap<DatabaseSync, TxState>();

/** Begin/commit/rollback a transaction, mirroring better-sqlite3's nested
 * .transaction(). node:sqlite has no helper and rejects a BEGIN inside a
 * transaction, so nested calls use SAVEPOINT. `BEGIN IMMEDIATE` matches
 * better-sqlite3's .immediate(). */
export function transaction<T>(
  db: DatabaseSync,
  mode: "BEGIN" | "BEGIN IMMEDIATE",
  fn: () => T,
): T {
  let state = states.get(db);
  if (!state) {
    state = { depth: 0, counter: 0 };
    states.set(db, state);
  }
  if (state.depth > 0) {
    const name = `sp_${++state.counter}`;
    db.exec(`SAVEPOINT ${name}`);
    state.depth++;
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      state.depth--;
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* a failed statement may have already released the savepoint */
      }
      state.depth--;
      throw error;
    }
  }
  db.exec(mode);
  state.depth = 1;
  try {
    const result = fn();
    db.exec("COMMIT");
    state.depth = 0;
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no open transaction to roll back */
    }
    state.depth = 0;
    throw error;
  }
}

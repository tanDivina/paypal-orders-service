import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Db = DatabaseSync;

export function openDb(path = process.env.DB_PATH ?? ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * Applies every .sql file in `dir` (lexicographic order) that has not been
 * applied yet. Each migration runs in its own transaction; a failure rolls
 * that migration back and aborts the run.
 */
export function runMigrations(db: Db, dir: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));"
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
  );
  const ran: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${e instanceof Error ? e.message : e}`);
    }
    ran.push(name);
  }
  return ran;
}

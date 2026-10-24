import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../src/db.js";

describe("migration runner", () => {
  it("applies pending migrations once and records them", () => {
    const db = openDb(":memory:");
    const ran = runMigrations(db, "migrations");
    expect(ran.length).toBeGreaterThan(0);
    expect(runMigrations(db, "migrations")).toEqual([]); // idempotent re-run
    const rows = db.prepare("SELECT name FROM _migrations").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(ran);
  });

  it("rolls a failing migration back and aborts", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO missing VALUES (1);");
    const db = openDb(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/002_bad\.sql failed/);
    // 001 applied, 002 fully rolled back (its CREATE TABLE is gone too)
    expect(() => db.prepare("SELECT * FROM a").all()).not.toThrow();
    expect(() => db.prepare("SELECT * FROM b").all()).toThrow();
  });
});

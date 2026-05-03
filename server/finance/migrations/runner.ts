import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));

function ensureMetaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

function appliedVersions(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT version FROM _meta_migrations").all() as { version: string }[];
  return new Set(rows.map((r) => r.version));
}

function discoverMigrations(): { version: string; file: string }[] {
  const entries = readdirSync(here)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return entries.map((file) => ({
    version: file.replace(/\.sql$/, ""),
    file: path.join(here, file),
  }));
}

export function runMigrations(db: DatabaseSync): { applied: string[] } {
  ensureMetaTable(db);
  const already = appliedVersions(db);
  const applied: string[] = [];
  for (const { version, file } of discoverMigrations()) {
    if (already.has(version)) continue;
    const sql = readFileSync(file, "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _meta_migrations (version) VALUES (?)").run(version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    }
    applied.push(version);
  }
  return { applied };
}

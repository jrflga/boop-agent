import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations/runner.js";

let instance: DatabaseSync | null = null;

function resolveDbPath(): string {
  const override = process.env.BOOP_FINANCE_DB_PATH?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), "data", "finance.db");
}

export function getFinanceDb(): DatabaseSync {
  if (instance) return instance;
  const dbPath = resolveDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const { applied } = runMigrations(db);
  if (applied.length > 0) {
    console.log(`[finance] applied migrations: ${applied.join(", ")}`);
  }
  instance = db;
  return db;
}

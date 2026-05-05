import { getFinanceDb } from "./db.js";

interface AuditEntry {
  source: "tool_call" | "watcher" | "system" | "webhook";
  action: string;
  payload?: unknown;
  result?: unknown;
  durationMs?: number;
}

export function logFinanceAudit(entry: AuditEntry): void {
  try {
    const db = getFinanceDb();
    db.prepare(
      "INSERT INTO finance_audit_log (source, action, payload, result, duration_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(
      entry.source,
      entry.action,
      entry.payload === undefined ? null : JSON.stringify(entry.payload),
      entry.result === undefined ? null : JSON.stringify(entry.result),
      entry.durationMs ?? null,
    );
  } catch (err) {
    // Audit logging should never break the calling flow; degrade to console.
    console.error("[finance.audit] failed", err);
  }
}

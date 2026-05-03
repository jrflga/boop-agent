import express from "express";
import { getFinanceDb } from "./db.js";

export function createFinanceRouter(): express.Router {
  const router = express.Router();

  router.get("/items", (_req, res) => {
    try {
      const db = getFinanceDb();
      const rows = db
        .prepare(
          "SELECT item_id, alias, connector_id, status, last_sync_at, created_at FROM pluggy_items ORDER BY created_at DESC",
        )
        .all();
      res.json({ items: rows });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/audit", (req, res) => {
    try {
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 500) : 50;
      const db = getFinanceDb();
      const rows = db
        .prepare(
          "SELECT id, source, action, payload, result, duration_ms, created_at FROM finance_audit_log ORDER BY id DESC LIMIT ?",
        )
        .all(limit);
      res.json({ entries: rows });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

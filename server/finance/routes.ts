import express from "express";
import { z } from "zod";
import { getFinanceDb } from "./db.js";
import { getPluggyClient } from "./pluggy.js";
import { logFinanceAudit } from "./audit.js";

const RegisterItemBody = z.object({
  itemId: z.string().min(1),
  alias: z.string().min(1).max(120),
});

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

  router.post("/items", async (req, res) => {
    const started = Date.now();
    const parsed = RegisterItemBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { itemId, alias } = parsed.data;

    const client = getPluggyClient();
    if (!client) {
      res.status(503).json({
        error: "Pluggy is not configured. Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET.",
      });
      return;
    }

    try {
      const item = await client.fetchItem(itemId);
      const connectorId = item.connector?.id ?? null;
      const db = getFinanceDb();
      db.prepare(
        `INSERT INTO pluggy_items (item_id, alias, connector_id, status, last_sync_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(item_id) DO UPDATE SET
           alias = excluded.alias,
           connector_id = excluded.connector_id,
           status = excluded.status,
           last_sync_at = excluded.last_sync_at`,
      ).run(
        itemId,
        alias,
        connectorId,
        item.lastUpdatedAt instanceof Date
          ? item.lastUpdatedAt.toISOString()
          : (item.lastUpdatedAt ?? null),
      );

      logFinanceAudit({
        source: "tool_call",
        action: "register_item",
        payload: { itemId, alias },
        result: { connectorId, status: "active" },
        durationMs: Date.now() - started,
      });

      res.json({ ok: true, itemId, alias, connectorId, status: "active" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logFinanceAudit({
        source: "tool_call",
        action: "register_item",
        payload: { itemId, alias },
        result: { error: message },
        durationMs: Date.now() - started,
      });
      res.status(502).json({ error: `Pluggy fetchItem failed: ${message}` });
    }
  });

  router.delete("/items/:itemId", (req, res) => {
    const started = Date.now();
    const { itemId } = req.params;
    if (!itemId) {
      res.status(400).json({ error: "itemId is required" });
      return;
    }
    try {
      const db = getFinanceDb();
      const result = db.prepare("DELETE FROM pluggy_items WHERE item_id = ?").run(itemId);
      const removed = Number(result.changes) > 0;
      logFinanceAudit({
        source: "tool_call",
        action: "remove_item",
        payload: { itemId },
        result: { removed },
        durationMs: Date.now() - started,
      });
      if (!removed) {
        res.status(404).json({ error: "item not found" });
        return;
      }
      res.json({ ok: true, itemId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

import express from "express";
import { z } from "zod";
import { getFinanceDb } from "./db.js";
import { getPluggyClient } from "./pluggy.js";
import { createPluggyConnectToken, resolvePluggyWebhookUrl } from "./pluggy.js";
import { logFinanceAudit } from "./audit.js";
import {
  deletePluggyItem,
  listRegisteredPluggyItems,
  pluggyItemToRecord,
  upsertPluggyItem,
} from "./store.js";

const RegisterItemBody = z.object({
  itemId: z.string().min(1),
  alias: z.string().min(1).max(120),
});

const ConnectTokenBody = z.object({
  itemId: z.string().min(1).optional(),
  clientUserId: z.string().min(1).optional(),
  webhookUrl: z.string().url().optional(),
});

export function createFinanceRouter(): express.Router {
  const router = express.Router();

  router.get("/items", (_req, res) => {
    try {
      res.json({ items: listRegisteredPluggyItems() });
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

  router.get("/config", (_req, res) => {
    res.json({ webhookUrl: resolvePluggyWebhookUrl() });
  });

  router.post("/connect-token", async (req, res) => {
    const parsed = ConnectTokenBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const resolvedWebhookUrl = parsed.data.webhookUrl ?? resolvePluggyWebhookUrl() ?? undefined;
      const token = await createPluggyConnectToken({
        itemId: parsed.data.itemId,
        clientUserId: parsed.data.clientUserId,
        webhookUrl: resolvedWebhookUrl,
      });
      res.json({ accessToken: token.accessToken, webhookUrl: resolvedWebhookUrl ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message });
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
      const record = pluggyItemToRecord(item, alias);
      upsertPluggyItem(record);

      logFinanceAudit({
        source: "tool_call",
        action: "register_item",
        payload: { itemId, alias },
        result: { connectorId: record.connectorId, status: record.status },
        durationMs: Date.now() - started,
      });

      res.json({ ok: true, itemId, alias, connectorId: record.connectorId, status: record.status });
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
      const removed = deletePluggyItem(itemId);
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

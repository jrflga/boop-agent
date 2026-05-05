import express from "express";
import { z } from "zod";
import { forceRefreshAccounts } from "./accounts.js";
import { logFinanceAudit } from "./audit.js";
import { deletePluggyItem, getStoredPluggyItemAlias, pluggyItemToRecord, upsertPluggyItem } from "./store.js";
import { getPluggyClient, getPluggyWebhookSecret } from "./pluggy.js";

const WebhookBody = z.object({
  event: z.string().min(1),
  eventId: z.string().optional(),
  clientUserId: z.string().optional(),
  itemId: z.string().optional(),
});

// Events that mean "Pluggy finished syncing this item, fresh account data
// is available." On these we also refresh the accounts cache so the next
// get_balance call doesn't have to wait for the daily lazy refresh.
const REFRESH_ACCOUNTS_EVENTS = new Set([
  "item/updated",
  "item/login_succeeded",
]);

async function syncItem(itemId: string, event: string, aliasFallback?: string | null) {
  const client = getPluggyClient();
  if (!client) {
    return { synced: false, error: "Pluggy is not configured" };
  }
  const item = await client.fetchItem(itemId);
  const alias = getStoredPluggyItemAlias(itemId) ?? aliasFallback ?? item.clientUserId ?? itemId;
  upsertPluggyItem(pluggyItemToRecord(item, alias));

  let accountsRefreshed: number | undefined;
  let refreshError: string | undefined;
  if (REFRESH_ACCOUNTS_EVENTS.has(event)) {
    try {
      const accounts = await forceRefreshAccounts(itemId);
      accountsRefreshed = accounts.length;
    } catch (err) {
      // Non-fatal: keep the item upsert and ack the webhook so Pluggy
      // doesn't retry. The next get_balance will still see stale-by-day
      // and refresh on its own.
      refreshError = err instanceof Error ? err.message : String(err);
    }
  }
  return { synced: true, alias, status: item.status, accountsRefreshed, refreshError };
}

export function createPluggyWebhookRouter(): express.Router {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const started = Date.now();

    // When PLUGGY_WEBHOOK_SECRET is set, Pluggy is configured (via
    // ensurePluggyWebhook) to send the matching value in
    // `X-Webhook-Secret`. Reject anything else with 401 — we don't audit
    // or 200-ack unauthenticated callers, since that would let any
    // internet stranger forge events.
    const expectedSecret = getPluggyWebhookSecret();
    if (expectedSecret) {
      const provided = req.header("x-webhook-secret");
      if (provided !== expectedSecret) {
        res.status(401).json({ error: "invalid webhook secret" });
        return;
      }
    }

    const parsed = WebhookBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { event, eventId, clientUserId, itemId } = parsed.data;
    if (!itemId && event !== "connector/status_updated") {
      res.status(400).json({ error: "itemId is required for this webhook event" });
      return;
    }

    try {
      let result: Record<string, unknown>;
      if (event === "item/deleted" && itemId) {
        const removed = deletePluggyItem(itemId);
        result = { removed };
      } else if (itemId) {
        result = await syncItem(itemId, event, clientUserId);
      } else {
        result = { ignored: true };
      }

      logFinanceAudit({
        source: "webhook",
        action: event,
        payload: { event, eventId, clientUserId, itemId },
        result,
        durationMs: Date.now() - started,
      });

      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logFinanceAudit({
        source: "webhook",
        action: event,
        payload: { event, eventId, clientUserId, itemId },
        result: { error: message },
        durationMs: Date.now() - started,
      });
      res.status(200).json({ ok: false, error: message });
    }
  });

  return router;
}

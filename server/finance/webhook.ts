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

  // Some webhook providers (and reverse proxies / uptime checks) probe a
  // URL with GET before accepting it. Without an explicit handler, the
  // request falls through to the SPA fallback in server/index.ts, which
  // ENOENTs on a fresh deploy and surfaces as a 404 HTML page — exactly
  // the shape that makes a Pluggy "Save & Test Webhook" probe fail.
  router.get("/", (_req, res) => {
    res.json({ received: true, ok: true });
  });

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

    // Be liberal with the body: the Pluggy dashboard does a connectivity
    // probe (often empty body) when saving a webhook URL, and a 4xx makes
    // it report "Failed to register webhook." Same for events we don't
    // know yet — we'd rather ack and audit than 4xx and force a retry.
    const parsed = WebhookBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      logFinanceAudit({
        source: "webhook",
        action: "probe_or_invalid",
        payload: req.body ?? null,
        result: { error: parsed.error.message },
        durationMs: Date.now() - started,
      });
      res.json({ received: true, ok: true, ignored: "unrecognized payload" });
      return;
    }

    const { event, eventId, clientUserId, itemId } = parsed.data;
    if (!itemId && event !== "connector/status_updated") {
      // Same rationale: ack with audit so Pluggy doesn't keep retrying
      // legitimate-but-unhandled events. We log enough to debug if
      // something material is being silently dropped.
      logFinanceAudit({
        source: "webhook",
        action: event,
        payload: { event, eventId, clientUserId, itemId },
        result: { ignored: "missing itemId" },
        durationMs: Date.now() - started,
      });
      res.json({ received: true, ok: true, ignored: "missing itemId" });
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

      res.json({ received: true, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logFinanceAudit({
        source: "webhook",
        action: event,
        payload: { event, eventId, clientUserId, itemId },
        result: { error: message },
        durationMs: Date.now() - started,
      });
      res.status(200).json({ received: true, ok: false, error: message });
    }
  });

  return router;
}

import type { DatabaseSync } from "node:sqlite";
import { getFinanceDb } from "./db.js";
import { getPluggyClient } from "./pluggy.js";

export interface CachedAccount {
  accountId: string;
  pluggyItemId: string;
  name: string;
  type: string;
  subtype: string | null;
  balance: number | null;
  currencyCode: string | null;
  pluggyUpdatedAt: string | null;
  cachedAt: string;
}

interface AccountRow {
  account_id: string;
  pluggy_item_id: string;
  name: string;
  type: string;
  subtype: string | null;
  balance: number | null;
  currency_code: string | null;
  pluggy_updated_at: string | null;
  cached_at: string;
}

function rowToCached(row: AccountRow): CachedAccount {
  return {
    accountId: row.account_id,
    pluggyItemId: row.pluggy_item_id,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    balance: row.balance,
    currencyCode: row.currency_code,
    pluggyUpdatedAt: row.pluggy_updated_at,
    cachedAt: row.cached_at,
  };
}

// "Stale" means the cached row was written on a different calendar day in
// the user's timezone. Comparing YYYY-MM-DD strings sidesteps the offset
// arithmetic the wall-clock-to-UTC-ms helpers in task-tools.ts have to do.
export function isStaleForToday(cachedAtIso: string, timeZone: string): boolean {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const cachedDay = fmt(new Date(cachedAtIso));
  const todayDay = fmt(new Date());
  return cachedDay !== todayDay;
}

function readCachedAccounts(db: DatabaseSync, itemId: string): CachedAccount[] {
  const rows = db
    .prepare(
      `SELECT account_id, pluggy_item_id, name, type, subtype, balance,
              currency_code, pluggy_updated_at, cached_at
       FROM pluggy_accounts WHERE pluggy_item_id = ?`,
    )
    .all(itemId) as unknown as AccountRow[];
  return rows.map(rowToCached);
}

async function fetchAndUpsertAccounts(itemId: string): Promise<CachedAccount[]> {
  const client = getPluggyClient();
  if (!client) {
    throw new Error("Pluggy is not configured. Set PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET.");
  }
  const response = await client.fetchAccounts(itemId);
  const accounts = response.results ?? [];
  const db = getFinanceDb();
  const upsert = db.prepare(
    `INSERT INTO pluggy_accounts
       (account_id, pluggy_item_id, name, type, subtype, balance,
        currency_code, pluggy_updated_at, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(account_id) DO UPDATE SET
       pluggy_item_id = excluded.pluggy_item_id,
       name = excluded.name,
       type = excluded.type,
       subtype = excluded.subtype,
       balance = excluded.balance,
       currency_code = excluded.currency_code,
       pluggy_updated_at = excluded.pluggy_updated_at,
       cached_at = excluded.cached_at`,
  );

  db.exec("BEGIN");
  try {
    for (const a of accounts) {
      // For CREDIT accounts, Pluggy's `balance` is the outstanding amount the
      // user owes. For "how much credit do I have available?" we need
      // `creditData.availableCreditLimit`. Collapse it into the single
      // `balance` column so aggregation stays trivial; revisit if a future
      // slice needs the outstanding amount alongside.
      const effectiveBalance =
        a.type === "CREDIT"
          ? (a.creditData?.availableCreditLimit ?? 0)
          : typeof a.balance === "number"
            ? a.balance
            : null;
      upsert.run(
        a.id,
        itemId,
        a.name ?? "",
        a.type ?? "",
        a.subtype ?? null,
        effectiveBalance,
        a.currencyCode ?? null,
        null,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Update parent item's last_sync_at so the items list reflects activity.
  db.prepare(
    "UPDATE pluggy_items SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE item_id = ?",
  ).run(itemId);

  return readCachedAccounts(db, itemId);
}

export async function getOrRefreshAccounts(
  itemId: string,
  timeZone: string,
): Promise<{ accounts: CachedAccount[]; refreshed: boolean }> {
  const db = getFinanceDb();
  const cached = readCachedAccounts(db, itemId);
  const stale = cached.length === 0 || cached.some((a) => isStaleForToday(a.cachedAt, timeZone));
  if (!stale) {
    return { accounts: cached, refreshed: false };
  }
  const fresh = await fetchAndUpsertAccounts(itemId);
  return { accounts: fresh, refreshed: true };
}

export async function forceRefreshAccounts(itemId: string): Promise<CachedAccount[]> {
  return fetchAndUpsertAccounts(itemId);
}

export interface ActiveItem {
  itemId: string;
  alias: string;
  connectorId: number | null;
}

export function listActiveItems(alias?: string): ActiveItem[] {
  const db = getFinanceDb();
  const sql = alias
    ? "SELECT item_id, alias, connector_id FROM pluggy_items WHERE status = 'active' AND alias = ?"
    : "SELECT item_id, alias, connector_id FROM pluggy_items WHERE status = 'active'";
  const rows = (alias ? db.prepare(sql).all(alias) : db.prepare(sql).all()) as unknown as Array<{
    item_id: string;
    alias: string;
    connector_id: number | null;
  }>;
  return rows.map((r) => ({ itemId: r.item_id, alias: r.alias, connectorId: r.connector_id }));
}

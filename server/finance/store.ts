import type { Item } from "pluggy-sdk";
import { getFinanceDb } from "./db.js";

export interface PluggyItemRecord {
  itemId: string;
  alias: string;
  connectorId: number | null;
  status: string;
  lastSyncAt: string | null;
}

export function listRegisteredPluggyItems(): Array<{
  itemId: string;
  alias: string;
  connectorId: number | null;
  status: string;
  lastSyncAt: string | null;
  createdAt: string;
}> {
  const db = getFinanceDb();
  const rows = db
    .prepare(
      "SELECT item_id, alias, connector_id, status, last_sync_at, created_at FROM pluggy_items ORDER BY created_at DESC",
    )
    .all() as Array<{
      item_id: string;
      alias: string;
      connector_id: number | null;
      status: string;
      last_sync_at: string | null;
      created_at: string;
    }>;
  return rows.map((row) => ({
    itemId: row.item_id,
    alias: row.alias,
    connectorId: row.connector_id,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
  }));
}

export function getStoredPluggyItemAlias(itemId: string): string | null {
  const db = getFinanceDb();
  const row = db
    .prepare("SELECT alias FROM pluggy_items WHERE item_id = ? LIMIT 1")
    .get(itemId) as { alias: string } | undefined;
  return row?.alias ?? null;
}

export function upsertPluggyItem(record: PluggyItemRecord): void {
  const db = getFinanceDb();
  db.prepare(
    `INSERT INTO pluggy_items (item_id, alias, connector_id, status, last_sync_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       alias = excluded.alias,
       connector_id = excluded.connector_id,
       status = excluded.status,
       last_sync_at = excluded.last_sync_at`,
  ).run(record.itemId, record.alias, record.connectorId, record.status, record.lastSyncAt);
}

export function deletePluggyItem(itemId: string): boolean {
  const db = getFinanceDb();
  const result = db.prepare("DELETE FROM pluggy_items WHERE item_id = ?").run(itemId);
  return Number(result.changes) > 0;
}

export function pluggyItemToRecord(item: Item, alias: string): PluggyItemRecord {
  return {
    itemId: item.id,
    alias,
    connectorId: item.connector?.id ?? null,
    status: item.status,
    lastSyncAt: item.lastUpdatedAt ? item.lastUpdatedAt.toISOString() : null,
  };
}

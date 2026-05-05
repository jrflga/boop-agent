CREATE TABLE pluggy_items (
  item_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  connector_id INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE finance_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT,
  result TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pluggy_accounts (
  account_id TEXT PRIMARY KEY,
  pluggy_item_id TEXT NOT NULL REFERENCES pluggy_items(item_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  balance REAL,
  currency_code TEXT,
  pluggy_updated_at TEXT,
  cached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_accounts_item_id ON pluggy_accounts (pluggy_item_id);

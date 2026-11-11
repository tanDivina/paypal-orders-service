-- Milestone 2: orders lifecycle + webhook reconciliation.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,                -- PayPal order id
  reference_id TEXT NOT NULL,
  amount_usd TEXT NOT NULL,
  status TEXT NOT NULL,               -- CREATED | AUTHORIZED | CAPTURED | CAPTURE_DENIED
  authorization_id TEXT,
  capture_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,                -- PayPal event id: replays are no-ops
  event_type TEXT NOT NULL,
  resource_id TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_orders_status ON orders (status);

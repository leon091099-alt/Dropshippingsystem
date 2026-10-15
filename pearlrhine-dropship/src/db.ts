import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE retailers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     feed_token TEXT NOT NULL UNIQUE,
     api_key_hash TEXT,
     api_key_prefix TEXT,
     -- Absender auf dem Lieferschein = Rechnungsadresse der Order (JSON MailingAddress)
     sender_address TEXT NOT NULL DEFAULT '{}',
     return_mode TEXT NOT NULL DEFAULT 'retailer' CHECK (return_mode IN ('retailer','us')),
     -- optionale Verknüpfung mit Shopify-B2B (Zahlungsziel, Katalogpreise)
     company_id TEXT, company_location_id TEXT, company_contact_id TEXT,
     auto_accept INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     retailer_id INTEGER NOT NULL REFERENCES retailers(id),
     reference TEXT NOT NULL,
     channel TEXT NOT NULL,
     status TEXT NOT NULL,
     payload TEXT NOT NULL,
     problems TEXT,
     shopify_order_id TEXT,
     shopify_order_name TEXT,
     tracking TEXT,
     status_checked_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (retailer_id, reference)
   )`,
  `CREATE INDEX orders_status ON orders(status)`,
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `ALTER TABLE retailers ADD COLUMN ek_discount_percent REAL;
   CREATE INDEX IF NOT EXISTS orders_shopify_id ON orders(shopify_order_id)`,
];

export function openDb(dataDir: string): DB {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    file = join(dataDir, 'dropship.sqlite');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function kvGet<T>(db: DB, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(db: DB, key: string, value: unknown) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value));
}

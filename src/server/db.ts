import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, mask TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_batches(
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, file_hash TEXT NOT NULL, format TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','committed','discarded')), as_of TEXT NOT NULL,
  payload TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, committed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_committed_hash ON import_batches(file_hash) WHERE status='committed';
CREATE TABLE IF NOT EXISTS positions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES import_batches(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  symbol TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sub_type TEXT NOT NULL DEFAULT 'standard',
  quantity TEXT, file_price TEXT, file_value TEXT, cost_basis TEXT, currency TEXT NOT NULL DEFAULT 'USD',
  source_asset_type TEXT NOT NULL DEFAULT '', is_cash INTEGER NOT NULL DEFAULT 0, as_of TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, fingerprint TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_positions_active ON positions(active, account_id);
CREATE TABLE IF NOT EXISTS classification_overrides(
  symbol TEXT PRIMARY KEY, instrument_type TEXT, asset_class TEXT, sector TEXT, geography TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS manual_assets(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, value TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  valued_at TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', geography TEXT NOT NULL DEFAULT 'United States', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS latest_quotes(
  symbol TEXT PRIMARY KEY, price TEXT NOT NULL, currency TEXT NOT NULL, quote_ts TEXT NOT NULL, retrieved_ts TEXT NOT NULL,
  source TEXT NOT NULL, feed TEXT, kind TEXT NOT NULL, delayed_minutes INTEGER NOT NULL DEFAULT 0, realtime_entitled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fx_rates(
  currency TEXT PRIMARY KEY, per_usd TEXT NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
export const audit = (db: Db, action: string, detail = '') =>
  db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?,?,?)').run(new Date().toISOString(), action, detail);

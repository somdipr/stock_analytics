import { Db } from './db.js';
import { Decimal, D, fromDb } from './money.js';
import { classify, Override } from './classification.js';
import { classifyStatus, getLatestQuotes } from './quotes.js';
import { marketStatus } from './calendar.js';
import { valuePortfolio, ValPosition, ValQuote, ValManual } from './valuation.js';
import type { PortfolioView } from '../shared/types.js';
import type { FxRates } from './fx.js';

export function loadOverrides(db: Db): Map<string, Override> {
  const m = new Map<string, Override>();
  for (const r of db.prepare('SELECT * FROM classification_overrides').all() as any[])
    m.set(r.symbol, { instrumentType: r.instrument_type ?? undefined, assetClass: r.asset_class ?? undefined, sector: r.sector ?? undefined, geography: r.geography ?? undefined });
  return m;
}

export function buildPortfolio(db: Db, opts: { now?: Date; realtimeMaxAgeSec: number }): PortfolioView {
  const now = opts.now ?? new Date();
  const market = marketStatus(now);
  const positions: ValPosition[] = (db.prepare(`SELECT p.*, a.display_name FROM positions p JOIN accounts a ON a.id=p.account_id WHERE p.active=1`).all() as any[]).map((r) => ({
    id: r.id, accountId: r.account_id, accountName: r.display_name, symbol: r.symbol, description: r.description, subType: r.sub_type,
    quantity: fromDb(r.quantity), filePrice: fromDb(r.file_price), fileValue: fromDb(r.file_value), costBasis: fromDb(r.cost_basis),
    currency: r.currency, sourceAssetType: r.source_asset_type, isCash: !!r.is_cash, asOf: r.as_of }));
  const quotes = new Map<string, ValQuote>();
  for (const [sym, q] of getLatestQuotes(db))
    quotes.set(sym, { price: q.price, currency: q.currency, quoteTs: q.quoteTs, retrievedTs: q.retrievedTs, source: q.source, feed: q.feed, status: classifyStatus(q, now, market, opts.realtimeMaxAgeSec) });
  const manual: ValManual[] = (db.prepare('SELECT * FROM manual_assets ORDER BY name').all() as any[]).map((r) => ({
    id: r.id, name: r.name, category: r.category, value: D(r.value), currency: r.currency, valuedAt: r.valued_at, geography: r.geography, notes: r.notes }));
  const fx: FxRates = {}; for (const r of db.prepare('SELECT * FROM fx_rates').all() as any[]) fx[r.currency] = new Decimal(r.per_usd);
  const overrides = loadOverrides(db);
  return valuePortfolio({ base: 'USD', positions, manual, quotes, fx, now, classify: (s, d, t, c) => classify(s, d, t, c, overrides) });
}

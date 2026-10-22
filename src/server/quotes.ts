import type { Database } from 'better-sqlite3';
import { Decimal, D } from './money.js';
import { MarketStatus } from './calendar.js';
import { QuoteStatus } from '../shared/types.js';

export type QuoteKind = 'trade' | 'delayed' | 'eod';
export interface QuoteInput {
  symbol: string; price: Decimal; currency: string; quoteTs: Date; retrievedTs: Date; source: string; feed: string | null;
  kind: QuoteKind; delayedMinutes?: number; realtimeEntitled: boolean;
}
export interface StoredQuote {
  symbol: string; price: Decimal; currency: string; quoteTs: string; retrievedTs: string; source: string; feed: string | null;
  kind: QuoteKind; delayedMinutes: number; realtimeEntitled: boolean;
}
export type IngestResult = { result: 'stored' | 'ignored_older' | 'ignored_duplicate' | 'rejected'; reason?: string };

const SESSION_SLACK_MS = 6 * 3600_000;

/**
 * Derive freshness from facts, not from a provider's label. 'real-time' requires (a) the provider confirmed
 * a real-time entitlement for this feed and (b) a quote timestamp no older than maxAgeSec.
 */
export function classifyStatus(
  q: Pick<StoredQuote, 'kind' | 'delayedMinutes' | 'realtimeEntitled' | 'quoteTs'>, now: Date, market: MarketStatus, maxAgeSec: number,
): QuoteStatus {
  const age = now.getTime() - new Date(q.quoteTs).getTime();
  const isLatestSession = new Date(q.quoteTs).getTime() >= new Date(market.lastCloseUtc).getTime() - SESSION_SLACK_MS;
  if (q.kind === 'eod') return isLatestSession ? 'end-of-day' : 'stale';
  if (q.kind === 'delayed') {
    if (age <= (q.delayedMinutes * 60 + maxAgeSec) * 1000) return 'delayed';
    return market.state === 'closed' && isLatestSession ? 'end-of-day' : 'stale';
  }
  if (q.realtimeEntitled && age <= maxAgeSec * 1000) return 'real-time';
  if (market.state === 'closed' && isLatestSession) return 'end-of-day';
  return 'stale';
}

export function rowToQuote(r: any): StoredQuote {
  return { symbol: r.symbol, price: D(r.price), currency: r.currency, quoteTs: r.quote_ts, retrievedTs: r.retrieved_ts, source: r.source,
    feed: r.feed, kind: r.kind, delayedMinutes: r.delayed_minutes, realtimeEntitled: !!r.realtime_entitled };
}
export const getLatestQuotes = (db: Database): Map<string, StoredQuote> =>
  new Map((db.prepare('SELECT * FROM latest_quotes').all() as any[]).map((r) => [r.symbol, rowToQuote(r)]));

/**
 * The only write path for prices. The last valid price is never deleted by an outage, and an older (or equal)
 * quote can never overwrite a newer valid one.
 */
export function ingestQuote(db: Database, q: QuoteInput, now: Date = new Date()): IngestResult {
  if (!q.price.isFinite() || q.price.lte(0)) return { result: 'rejected', reason: 'price must be a positive number' };
  if (!q.currency) return { result: 'rejected', reason: 'currency missing' };
  if (Number.isNaN(q.quoteTs.getTime())) return { result: 'rejected', reason: 'quote timestamp invalid' };
  if (q.quoteTs.getTime() > now.getTime() + 5 * 60_000) return { result: 'rejected', reason: 'quote timestamp is in the future' };
  const cur = db.prepare('SELECT * FROM latest_quotes WHERE symbol = ?').get(q.symbol) as any;
  if (cur) {
    if (cur.currency !== q.currency) return { result: 'rejected', reason: `currency changed from ${cur.currency} to ${q.currency}` };
    const diff = q.quoteTs.getTime() - new Date(cur.quote_ts).getTime();
    if (diff < 0) return { result: 'ignored_older' };
    if (diff === 0) return { result: 'ignored_duplicate' };
  }
  db.prepare(`INSERT INTO latest_quotes(symbol, price, currency, quote_ts, retrieved_ts, source, feed, kind, delayed_minutes, realtime_entitled)
    VALUES(@symbol,@price,@currency,@quote_ts,@retrieved_ts,@source,@feed,@kind,@delayed,@ent)
    ON CONFLICT(symbol) DO UPDATE SET price=@price, currency=@currency, quote_ts=@quote_ts, retrieved_ts=@retrieved_ts, source=@source,
    feed=@feed, kind=@kind, delayed_minutes=@delayed, realtime_entitled=@ent`).run({
    symbol: q.symbol, price: q.price.toFixed(), currency: q.currency, quote_ts: q.quoteTs.toISOString(), retrieved_ts: q.retrievedTs.toISOString(),
    source: q.source, feed: q.feed, kind: q.kind, delayed: q.delayedMinutes ?? 0, ent: q.realtimeEntitled ? 1 : 0 });
  return { result: 'stored' };
}

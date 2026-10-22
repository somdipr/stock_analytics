import { describe, expect, it } from 'vitest';
import { D } from '../src/server/money.js';
import { freshDb } from './helpers.js';
import { classifyStatus, getLatestQuotes, ingestQuote, QuoteInput } from '../src/server/quotes.js';
import { marketStatus } from '../src/server/calendar.js';

const now = new Date('2026-07-15T15:00:00Z'); // 11:00 ET, open
const q = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  symbol: 'AAPL', price: D('200'), currency: 'USD', quoteTs: new Date('2026-07-15T14:59:30Z'), retrievedTs: now, source: 'alpaca', feed: 'iex', kind: 'trade', realtimeEntitled: true, ...over,
});

describe('ingestQuote: price update rules', () => {
  it('stores a valid quote with every provenance field', () => {
    const db = freshDb(); expect(ingestQuote(db, q(), now).result).toBe('stored');
    expect(getLatestQuotes(db).get('AAPL')).toMatchObject({ currency: 'USD', source: 'alpaca', feed: 'iex', kind: 'trade', quoteTs: '2026-07-15T14:59:30.000Z', retrievedTs: now.toISOString() });
  });
  it('a newer quote replaces an older one', () => {
    const db = freshDb(); ingestQuote(db, q(), now);
    expect(ingestQuote(db, q({ price: D('201'), quoteTs: new Date('2026-07-15T14:59:50Z') }), now).result).toBe('stored');
    expect(getLatestQuotes(db).get('AAPL')!.price.toFixed()).toBe('201');
  });
  it('an older quote can never overwrite a newer valid one', () => {
    const db = freshDb(); ingestQuote(db, q({ price: D('201'), quoteTs: new Date('2026-07-15T14:59:50Z') }), now);
    expect(ingestQuote(db, q({ price: D('150'), quoteTs: new Date('2026-07-15T14:00:00Z') }), now).result).toBe('ignored_older');
    expect(getLatestQuotes(db).get('AAPL')!.price.toFixed()).toBe('201');
  });
  it('an end-of-day quote from yesterday cannot replace a fresher trade', () => {
    const db = freshDb(); ingestQuote(db, q(), now);
    expect(ingestQuote(db, q({ kind: 'eod', source: 'fmp', feed: null, quoteTs: new Date('2026-07-14T20:00:00Z') }), now).result).toBe('ignored_older');
  });
  it('treats an identical timestamp as a duplicate', () => {
    const db = freshDb(); ingestQuote(db, q(), now); expect(ingestQuote(db, q(), now).result).toBe('ignored_duplicate');
  });
  it.each([
    ['zero price', { price: D(0) }], ['negative price', { price: D(-1) }], ['NaN price', { price: D(NaN) }], ['future timestamp', { quoteTs: new Date('2026-07-16T00:00:00Z') }],
  ])('rejects %s', (_n, over) => { const db = freshDb(); expect(ingestQuote(db, q(over as Partial<QuoteInput>), now).result).toBe('rejected'); expect(getLatestQuotes(db).size).toBe(0); });
  it('rejects a currency change instead of silently mixing currencies', () => {
    const db = freshDb(); ingestQuote(db, q(), now);
    const r = ingestQuote(db, q({ currency: 'EUR', quoteTs: new Date('2026-07-15T14:59:55Z') }), now);
    expect(r.result).toBe('rejected'); expect(getLatestQuotes(db).get('AAPL')!.currency).toBe('USD');
  });
});

describe('classifyStatus: freshness labels', () => {
  const st = (over: object, at = now) => classifyStatus({ kind: 'trade', delayedMinutes: 0, realtimeEntitled: true, quoteTs: '2026-07-15T14:59:30.000Z', ...over } as any, at, marketStatus(at), 300);
  it('real-time needs entitlement AND a fresh timestamp', () => {
    expect(st({})).toBe('real-time');
    expect(st({ realtimeEntitled: false })).toBe('stale');          // never claimed without provider-confirmed entitlement
    expect(st({ quoteTs: '2026-07-15T14:40:00.000Z' })).toBe('stale'); // 20 min old during market hours
  });
  it('labels provider-declared delays as delayed', () => {
    expect(st({ kind: 'delayed', delayedMinutes: 15, realtimeEntitled: false, quoteTs: '2026-07-15T14:45:00.000Z' })).toBe('delayed');
  });
  it('labels the last close as end-of-day when the market is closed', () => {
    const sat = new Date('2026-07-18T15:00:00Z');
    expect(st({ quoteTs: '2026-07-17T19:59:00.000Z' }, sat)).toBe('end-of-day');
    expect(st({ kind: 'eod', realtimeEntitled: false, quoteTs: '2026-07-17T20:00:00.000Z' }, sat)).toBe('end-of-day');
  });
  it('labels older data stale, including an EOD close that is no longer the latest', () => {
    const mon = new Date('2026-07-20T15:00:00Z'); // Monday 11:00 ET, Friday's close is the latest
    expect(st({ kind: 'eod', realtimeEntitled: false, quoteTs: '2026-07-16T20:00:00.000Z' }, mon)).toBe('stale');
    expect(st({ kind: 'eod', realtimeEntitled: false, quoteTs: '2026-07-17T20:00:00.000Z' }, mon)).toBe('end-of-day');
  });
});

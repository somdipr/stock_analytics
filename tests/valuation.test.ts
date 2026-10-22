import { describe, expect, it } from 'vitest';
import { freshDb, importFixture } from './helpers.js';
import { buildPortfolio } from '../src/server/portfolio.js';
import { ingestQuote } from '../src/server/quotes.js';
import { D } from '../src/server/money.js';
import { valuePortfolio, ValPosition } from '../src/server/valuation.js';
import { classify } from '../src/server/classification.js';

const NOW = new Date('2026-07-16T21:00:00Z'); // after the close, same day as the fixtures
const port = (db: ReturnType<typeof freshDb>, now = NOW) => buildPortfolio(db, { now, realtimeMaxAgeSec: 300 });
const sum = (xs: { value: number }[]) => Math.round(xs.reduce((a, b) => a + b.value, 0) * 100) / 100;

describe('portfolio reconciliation', () => {
  it('consolidates two accounts: totals match the files and nothing is counted twice', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv'); await importFixture(db, 'synthetic-single-account-B.csv');
    const p = port(db);
    expect(p.totalValue).toBe(7015 + 2600); // each file's own stated total, summed
    const schd = p.holdings.find((h) => h.symbol === 'SCHD')!;
    expect(schd.quantity).toBe(150.5); expect(schd.value).toBe(3015 + 1500);
    expect(schd.lots.map((l) => [l.accountName, l.quantity])).toEqual(expect.arrayContaining([['Test Account A', 100.5], ['Test Account B', 50]]));
    expect(p.holdings.filter((h) => h.symbol === 'SCHD')).toHaveLength(1);
  });
  it('every view of the portfolio adds up to the same total', async () => {
    const db = freshDb(); for (const f of ['synthetic-single-account-A.csv', 'synthetic-single-account-B.csv', 'synthetic-multi-account.csv']) await importFixture(db, f);
    const p = port(db);
    expect(sum(p.holdings)).toBeCloseTo(p.totalValue, 2);
    for (const k of ['assetClass', 'sector', 'geography', 'instrumentType', 'account'] as const) {
      expect(sum(p.allocation[k])).toBeCloseTo(p.totalValue, 1);
      expect(p.allocation[k].reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 2);
    }
    expect(p.cashValue + p.investedValue).toBeCloseTo(p.totalValue, 2);
    expect(p.allocation.account.map((a) => a.key).sort()).toEqual(['Test Account A', 'Test Account B', 'Test Individual - TOD']);
  });
  it('sums margin and cash lots of one holding (GLD) once', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-multi-account.csv');
    const gld = port(db).holdings.find((h) => h.symbol === 'GLD')!;
    expect(gld.quantity).toBe(4.75); expect(gld.value).toBe(1050 + 375); expect(gld.lots).toHaveLength(2);
    expect(port(db).totalValue).toBe(800 + 1050 + 375 + 200);
  });
  it('classifies by asset class, sector, geography, instrument type and account', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const p = port(db);
    expect(p.allocation.assetClass.map((s) => s.key).sort()).toEqual(['Cash', 'Equity']);
    expect(p.allocation.sector.map((s) => s.key)).toEqual(expect.arrayContaining(['Information Technology', 'Utilities', 'Diversified', 'Unclassified', 'Cash']));
    expect(p.allocation.instrumentType.map((s) => s.key)).toEqual(expect.arrayContaining(['Stock', 'ETF', 'Cash']));
    expect(p.warnings.find((w) => w.code === 'unclassified' && w.subject === 'ZZZZ')).toBeTruthy();
  });
  it('values from imported prices only until a live quote exists, and says so', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const p = port(db);
    expect(p.holdings.find((h) => h.symbol === 'AAPL')).toMatchObject({ basis: 'imported', status: 'stale', source: 'import' });
    expect(p.warnings.some((w) => w.code === 'imported_prices')).toBe(true);
    expect(p.priceSummary.stale).toBe(4); expect(p.priceSummary.cash).toBe(1);
  });
});

describe('valuation recalculates when valid prices change', () => {
  const quote = (symbol: string, price: string, ts: string) => ({ symbol, price: D(price), currency: 'USD', quoteTs: new Date(ts), retrievedTs: NOW, source: 'alpaca', feed: 'iex', kind: 'trade' as const, realtimeEntitled: true });
  it('a live quote re-prices the holding, total and weights', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv'); const before = port(db);
    ingestQuote(db, quote('AAPL', '250', '2026-07-16T20:59:00Z'), NOW);
    const after = port(db);
    const aapl = after.holdings.find((h) => h.symbol === 'AAPL')!;
    expect(aapl).toMatchObject({ price: 250, value: 2500, basis: 'live', status: 'real-time', source: 'alpaca', feed: 'iex', quoteTs: '2026-07-16T20:59:00.000Z' });
    expect(after.totalValue).toBe(before.totalValue + 500);
    expect(aapl.weightPct).toBeCloseTo((2500 / after.totalValue) * 100, 3);
    expect(after.allocation.assetClass.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 2);
  });
  it('an older or invalid quote leaves valuations untouched', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    ingestQuote(db, quote('AAPL', '250', '2026-07-16T20:59:00Z'), NOW); const t = port(db).totalValue;
    ingestQuote(db, quote('AAPL', '100', '2026-07-16T19:00:00Z'), NOW); ingestQuote(db, quote('AAPL', '-5', '2026-07-16T20:59:30Z'), NOW);
    expect(port(db).totalValue).toBe(t);
  });
  it('the same live price degrades to stale then keeps being used (last valid price preserved)', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv'); ingestQuote(db, quote('AAPL', '250', '2026-07-16T20:59:00Z'), NOW);
    const later = port(db, new Date('2026-07-20T15:00:00Z')); // Monday, market open, quote is days old
    expect(later.holdings.find((h) => h.symbol === 'AAPL')).toMatchObject({ value: 2500, status: 'stale' });
  });
});

describe('currency handling and manual assets', () => {
  const pos = (over: Partial<ValPosition>): ValPosition => ({ id: 1, accountId: 'a', accountName: 'A', symbol: 'ABC', description: '', subType: 'standard', quantity: D(10), filePrice: D(100),
    fileValue: null, costBasis: null, currency: 'USD', sourceAssetType: 'Equity', isCash: false, asOf: NOW.toISOString(), ...over });
  const run = (positions: ValPosition[], fx = {}) => valuePortfolio({ base: 'USD', positions, manual: [], quotes: new Map(), fx, now: NOW, classify: (s, d, t, c) => classify(s, d, t, c, new Map()) });
  it('converts non-USD positions into the base currency', () => expect(run([pos({ currency: 'EUR' })], { EUR: D('0.5') }).totalValue).toBe(2000));
  it('excludes a holding and raises an error warning when the FX rate is missing', () => {
    const p = run([pos({ currency: 'GBP' }), pos({ id: 2, symbol: 'DEF' })]);
    expect(p.totalValue).toBe(1000); expect(p.warnings.find((w) => w.code === 'missing_fx')?.severity).toBe('error');
  });
  it('values physical gold, silver and real estate manually and warns when stale', () => {
    const p = valuePortfolio({ base: 'USD', positions: [], quotes: new Map(), fx: {}, now: NOW, classify: () => ({} as any), manual: [
      { id: '1', name: 'Gold bars', category: 'physical-gold', value: D('5000'), currency: 'USD', valuedAt: '2026-07-01T00:00:00Z', geography: 'United States', notes: '' },
      { id: '2', name: 'House', category: 'real-estate', value: D('300000'), currency: 'USD', valuedAt: '2025-01-01T00:00:00Z', geography: 'United States', notes: '' }] });
    expect(p.totalValue).toBe(305000); expect(p.priceSummary.manual).toBe(2);
    expect(p.allocation.assetClass.map((s) => s.key)).toEqual(['Real Estate', 'Commodity']);
    expect(p.warnings.filter((w) => w.code === 'manual_stale').map((w) => w.subject)).toEqual(['House']);
    expect(p.holdings.find((h) => h.symbol === 'MANUAL:Gold bars')).toMatchObject({ status: 'manual', source: 'manual valuation' });
  });
});

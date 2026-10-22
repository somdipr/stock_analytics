import { describe, expect, it, vi } from 'vitest';
import { freshDb, importFixture } from './helpers.js';
import { PriceService } from '../src/server/scheduler.js';
import { D } from '../src/server/money.js';
import { buildPortfolio } from '../src/server/portfolio.js';
import { getLatestQuotes, QuoteInput } from '../src/server/quotes.js';
import { MarketDataProvider, ProviderError } from '../src/server/providers/types.js';

const NOW = new Date('2026-07-16T20:30:00Z');
const mk = (symbol: string, price: string, ts: string, over: Partial<QuoteInput> = {}): QuoteInput =>
  ({ symbol, price: D(price), currency: 'USD', quoteTs: new Date(ts), retrievedTs: NOW, source: 'alpaca', feed: 'iex', kind: 'trade', realtimeEntitled: true, ...over });
const provider = (getSnapshots: MarketDataProvider['getSnapshots'], rate: number | null = 200): MarketDataProvider => ({
  capabilities: () => ({ id: 't', label: 't', realtime: true, delayedMinutes: 0, feed: 'iex', streaming: false, maxStreamSymbols: 0, rateLimitPerMin: rate, dailyCallBudget: null, coverage: '', attribution: '', licensing: '', notes: [] }),
  getSnapshots,
});
const setup = async (get: MarketDataProvider['getSnapshots'], extra: Partial<ConstructorParameters<typeof PriceService>[0]> = {}) => {
  const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
  const svc = new PriceService({ db, provider: provider(get), intervalSec: 45, stream: false, now: () => NOW, ...extra }); return { db, svc };
};
const val = (db: any) => buildPortfolio(db, { now: NOW, realtimeMaxAgeSec: 300 });

describe('automatic price updates', () => {
  it('requests only active, non-cash symbols and stores the returned quotes', async () => {
    const get = vi.fn(async (s: string[]) => s.filter((x) => x === 'AAPL').map((x) => mk(x, '250', '2026-07-16T20:00:00Z')));
    const { db, svc } = await setup(get); const r = await svc.refreshOnce();
    expect(get).toHaveBeenCalledWith(['AAPL', 'SCHD', 'XLU', 'ZZZZ']); expect(r).toMatchObject({ requested: 4, stored: 1 }); expect(r.missing).toEqual(['SCHD', 'XLU', 'ZZZZ']);
    expect(val(db).holdings.find((h) => h.symbol === 'AAPL')!.value).toBe(2500); expect(svc.health).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
  it('emits an update event so the UI can refresh', async () => {
    const { svc } = await setup(async () => [mk('AAPL', '250', '2026-07-16T20:00:00Z')]); const seen = vi.fn(); svc.on('update', seen);
    await svc.refreshOnce(); await new Promise((r) => setTimeout(r, 900)); expect(seen).toHaveBeenCalledWith({ updated: 1 }); svc.stop();
  });
  it('keeps the last valid price through an outage and reports the degraded state', async () => {
    let fail = false; const get = vi.fn(async () => { if (fail) throw new ProviderError('unavailable', 'HTTP 503'); return [mk('AAPL', '250', '2026-07-16T20:00:00Z')]; });
    const { db, svc } = await setup(get); await svc.refreshOnce(); fail = true; await svc.refreshOnce();
    expect(svc.health).toMatchObject({ state: 'degraded', consecutiveFailures: 1, lastError: 'HTTP 503' });
    expect(getLatestQuotes(db).get('AAPL')!.price.toFixed()).toBe('250'); expect(val(db).holdings.find((h) => h.symbol === 'AAPL')!.value).toBe(2500);
  });
  it('does not let a late, older quote overwrite a newer one', async () => {
    let n = 0; const get = async () => [n++ === 0 ? mk('AAPL', '250', '2026-07-16T20:10:00Z') : mk('AAPL', '100', '2026-07-16T19:00:00Z')];
    const { db, svc } = await setup(get); await svc.refreshOnce(); const r = await svc.refreshOnce();
    expect(r.ignored).toBe(1); expect(getLatestQuotes(db).get('AAPL')!.price.toFixed()).toBe('250');
  });
  it('rejects invalid provider data without crashing or changing prices', async () => {
    const { db, svc } = await setup(async () => [mk('AAPL', '-3', '2026-07-16T20:00:00Z')]); const r = await svc.refreshOnce();
    expect(r.rejected[0]).toMatch(/AAPL: price must be a positive number/); expect(getLatestQuotes(db).size).toBe(0);
  });
  it('stops polling after an authentication failure instead of hammering the provider', async () => {
    const get = vi.fn(async () => { throw new ProviderError('auth', 'bad keys'); }); const timers: any[] = [];
    const { svc } = await setup(get, { setTimer: ((fn: any) => { timers.push(fn); return 0; }) as any });
    svc.start(); await new Promise((r) => setTimeout(r, 20)); expect(svc.health.state).toBe('error'); expect(timers).toHaveLength(0); expect(get).toHaveBeenCalledTimes(1);
  });
  it('backs off after repeated failures', async () => {
    const waits: number[] = []; const get = vi.fn(async () => { throw new ProviderError('unavailable', 'down'); });
    const { svc } = await setup(get, { setTimer: ((_fn: any, ms: number) => { waits.push(ms); return 0; }) as any });
    svc.start(); await new Promise((r) => setTimeout(r, 20)); expect(waits[0]).toBe(90_000); // 45 s doubled after one failure
  });
  it('honours the provider rate limit', async () => {
    const get = vi.fn(async () => []); const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const svc = new PriceService({ db, provider: provider(get, 1), intervalSec: 45, stream: false, now: () => NOW }); // cap = floor(1*0.8) = 0 calls/min
    await svc.refreshOnce(); expect(get).not.toHaveBeenCalled(); expect(svc.health.lastError).toMatch(/rate limit/);
  });
  it('uses the end-of-day fallback only for symbols the main provider could not price, once per day', async () => {
    const eod = { capabilities: () => ({ id: 'fmp' } as any), getSnapshots: async () => [], getEodCloses: vi.fn(async (s: string[]) => s.map((x) => mk(x, '12', '2026-07-16T20:00:00Z', { source: 'fmp', feed: null, kind: 'eod', realtimeEntitled: false }))) };
    const { db, svc } = await setup(async () => [mk('AAPL', '250', '2026-07-16T20:00:00Z')], { eod });
    await svc.refreshOnce(); await svc.refreshOnce();
    expect(eod.getEodCloses).toHaveBeenCalledTimes(1); expect(eod.getEodCloses).toHaveBeenCalledWith(['SCHD', 'XLU', 'ZZZZ']);
    expect(getLatestQuotes(db).get('SCHD')).toMatchObject({ source: 'fmp', kind: 'eod' });
    expect(val(db).holdings.find((h) => h.symbol === 'SCHD')).toMatchObject({ status: 'end-of-day', source: 'fmp' });
  });
});

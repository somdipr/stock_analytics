import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AlpacaProvider } from '../src/server/providers/alpaca.js';
import { FmpProvider } from '../src/server/providers/fmp.js';
import { SyntheticProvider } from '../src/server/providers/synthetic.js';
import { ProviderError } from '../src/server/providers/types.js';

const NOW = new Date('2026-07-16T15:00:30Z');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const alpaca = (f: any, feed: 'iex' | 'sip' = 'iex') => new AlpacaProvider({ keyId: 'KEY_ID_X', secretKey: 'SECRET_X', feed, fetchImpl: f, now: () => NOW });

describe('Alpaca REST adapter', () => {
  it('calls the IEX snapshot endpoint with auth headers and maps trades to quotes', async () => {
    const f = vi.fn().mockResolvedValue(json({ AAPL: { latestTrade: { t: '2026-07-16T15:00:10Z', p: 201.25 } }, SCHD: { latestTrade: { t: '2026-07-16T14:59:00Z', p: 30.1 } } }));
    const p = alpaca(f); expect(p.capabilities().realtime).toBe(false); // nothing confirmed yet
    const qs = await p.getSnapshots(['AAPL', 'SCHD']);
    const [url, init] = f.mock.calls[0]; expect(url).toContain('/v2/stocks/snapshots?symbols=AAPL%2CSCHD&feed=iex');
    expect(init.headers['APCA-API-KEY-ID']).toBe('KEY_ID_X');
    expect(qs.map((q) => [q.symbol, q.price.toFixed(), q.currency, q.source, q.feed, q.kind, q.realtimeEntitled])).toEqual([['AAPL', '201.25', 'USD', 'alpaca', 'iex', 'trade', true], ['SCHD', '30.1', 'USD', 'alpaca', 'iex', 'trade', true]]);
    expect(qs[0].quoteTs.toISOString()).toBe('2026-07-16T15:00:10.000Z'); expect(qs[0].retrievedTs).toEqual(NOW);
    expect(p.capabilities().realtime).toBe(true); // confirmed by an authenticated IEX response
  });
  it('omits unknown symbols and malformed trades rather than inventing prices', async () => {
    const f = vi.fn().mockResolvedValue(json({ AAPL: { latestTrade: { t: 'garbage', p: 1 } }, MSFT: { latestTrade: { t: '2026-07-16T15:00:10Z', p: 0 } }, TSLA: {} }));
    expect(await alpaca(f).getSnapshots(['AAPL', 'MSFT', 'TSLA', 'NOPE'])).toEqual([]);
  });
  it('classifies HTTP failures', async () => {
    await expect(alpaca(vi.fn().mockResolvedValue(json({ message: 'forbidden' }, 401))).getSnapshots(['A'])).rejects.toMatchObject({ kind: 'auth' });
    await expect(alpaca(vi.fn().mockResolvedValue(new Response('subscription does not permit querying recent SIP data', { status: 403 }))).getSnapshots(['A'])).rejects.toMatchObject({ kind: 'restricted' });
    await expect(alpaca(vi.fn().mockResolvedValue(json({}, 429, { 'retry-after': '12' }))).getSnapshots(['A'])).rejects.toMatchObject({ kind: 'rate_limit', retryAfterSec: 12 });
    await expect(alpaca(vi.fn().mockResolvedValue(json({}, 503))).getSnapshots(['A'])).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(alpaca(vi.fn().mockRejectedValue(new Error('ECONNRESET'))).getSnapshots(['A'])).rejects.toBeInstanceOf(ProviderError);
  });
  it('isolates one invalid symbol instead of failing the whole batch', async () => {
    const f = vi.fn(async (url: string) => /symbols=BAD%2C/.test(url) || /symbols=BAD&/.test(url) ? json({ message: 'invalid symbol' }, 400) : /OK/.test(url) && !/%2C/.test(url)
      ? json({ OK: { latestTrade: { t: '2026-07-16T15:00:10Z', p: 10 } } }) : json({ message: 'invalid symbol' }, 400));
    const qs = await alpaca(f as any).getSnapshots(['OK', 'BAD']);
    expect(qs.map((q) => q.symbol)).toEqual(['OK']);
  });
  it('never exposes credentials through capabilities', () => expect(JSON.stringify(alpaca(vi.fn()).capabilities())).not.toMatch(/SECRET_X|KEY_ID_X/));
});

class FakeWs extends EventEmitter { sent: any[] = []; closed = false; send(m: string) { this.sent.push(JSON.parse(m)); } close() { this.closed = true; this.emit('close'); } }
describe('Alpaca WebSocket stream', () => {
  const setup = () => {
    const ws = new FakeWs(); const quotes: any[] = []; const states: any[] = [];
    const p = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'iex', wsImpl: function () { return ws; } as any, now: () => NOW });
    const h = p.stream!(['AAPL', 'SCHD'], (q) => quotes.push(q), (s) => states.push(s.state));
    return { ws, quotes, states, h };
  };
  it('authenticates, subscribes to trades and maps trade messages', () => {
    const { ws, quotes, states } = setup();
    ws.emit('open'); expect(ws.sent[0]).toEqual({ action: 'auth', key: 'K', secret: 'S' });
    ws.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
    expect(ws.sent[1]).toEqual({ action: 'subscribe', trades: ['AAPL', 'SCHD'] });
    ws.emit('message', JSON.stringify([{ T: 'subscription', trades: ['AAPL', 'SCHD'] }, { T: 't', S: 'AAPL', p: 201.5, t: '2026-07-16T15:00:20Z' }, { T: 't', S: 'AAPL', p: -1, t: '2026-07-16T15:00:21Z' }]));
    expect(quotes).toHaveLength(1); expect(quotes[0]).toMatchObject({ symbol: 'AAPL', kind: 'trade', feed: 'iex', realtimeEntitled: true }); expect(quotes[0].price.toFixed()).toBe('201.5');
    expect(states).toEqual(expect.arrayContaining(['connecting', 'authenticated', 'subscribed']));
  });
  it('stops (does not reconnect-loop) on a connection-limit error', () => {
    const { ws, states } = setup(); ws.emit('open');
    ws.emit('message', JSON.stringify([{ T: 'error', code: 406, msg: 'connection limit exceeded' }]));
    expect(ws.closed).toBe(true); expect(states).toContain('error');
  });
});

describe('FMP end-of-day adapter', () => {
  const fmp = (f: any, budget = 5) => new FmpProvider({ apiKey: 'FMPKEY', dailyBudget: budget, fetchImpl: f, now: () => NOW });
  it('maps the latest close to an end-of-day quote at 4 pm ET', async () => {
    const f = vi.fn().mockResolvedValue(json([{ symbol: 'ABC', date: '2026-07-14', price: 11 }, { symbol: 'ABC', date: '2026-07-15', price: 12.5 }]));
    const [q] = await fmp(f).getEodCloses(['ABC']);
    expect(q).toMatchObject({ symbol: 'ABC', kind: 'eod', source: 'fmp', currency: 'USD', realtimeEntitled: false }); expect(q.price.toFixed()).toBe('12.5');
    expect(q.quoteTs.toISOString()).toBe('2026-07-15T20:00:00.000Z');
  });
  it('stops at the daily call budget and never spends beyond it', async () => {
    const f = vi.fn().mockImplementation(async () => json([{ symbol: 'X', date: '2026-07-15', price: 1 }])); const p = fmp(f, 2);
    expect((await p.getEodCloses(['A', 'B', 'C', 'D'])).length).toBe(2); expect(f).toHaveBeenCalledTimes(2); expect(p.callsRemaining()).toBe(0);
    expect(await p.getEodCloses(['E'])).toEqual([]);
  });
  it('treats empty results as unknown (no invented price) and maps plan restrictions', async () => {
    expect(await fmp(vi.fn().mockResolvedValue(json([]))).getEodCloses(['ZZZ'])).toEqual([]);
    await expect(fmp(vi.fn().mockResolvedValue(json({}, 402))).getEodCloses(['A'])).rejects.toMatchObject({ kind: 'restricted' });
    await expect(fmp(vi.fn().mockResolvedValue(json({}, 429))).getEodCloses(['A'])).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('synthetic provider', () => {
  it('refuses to exist outside demo mode', () => expect(() => new SyntheticProvider('live')).toThrow(/demo/));
  it('is clearly labelled, deterministic and never claims real-time', async () => {
    const p = new SyntheticProvider('demo', () => NOW); const a = await p.getSnapshots(['AAPL']); const b = await p.getSnapshots(['AAPL']);
    expect(a[0]).toMatchObject({ source: 'synthetic', feed: 'synthetic', realtimeEntitled: false }); expect(a[0].price.toFixed()).toBe(b[0].price.toFixed());
    expect(p.capabilities().label).toMatch(/SYNTHETIC/);
  });
});

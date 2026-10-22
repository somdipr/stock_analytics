import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { createProviders } from '../src/server/providers/index.js';
import { PriceService } from '../src/server/scheduler.js';
import { seedDemo } from '../src/server/demo.js';
import { fixture, freshDb } from './helpers.js';

function multipart(files: { name: string; content: Buffer | string }[]) {
  const b = '----pptest' + Math.random().toString(16).slice(2); const chunks: Buffer[] = [];
  for (const f of files) chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(f.content), Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const make = async (env: Record<string, string> = {}) => {
  const cfg = loadConfig({ DATA_DIR: './data', ...env }); const db = freshDb(); const providers = createProviders(cfg);
  const prices = providers.intraday ? new PriceService({ db, provider: providers.intraday, intervalSec: 45, stream: false }) : null;
  return { app: await buildApp({ db, cfg, providers, prices }), db, cfg, prices };
};

describe('API: upload, review, import, portfolio', () => {
  it('runs the whole flow and blocks the same file the second time', async () => {
    const { app } = await make();
    const up = await app.inject({ method: 'POST', url: '/api/imports/stage', ...multipart([{ name: 'A.csv', content: fixture('synthetic-single-account-A.csv') }, { name: 'B.csv', content: fixture('synthetic-single-account-B.csv') }, { name: 'junk.csv', content: 'a,b\n1,2\n' }]) });
    const { results } = up.json(); expect(results.map((r: any) => r.ok)).toEqual([true, true, false]); expect(results[2].code).toBe('unrecognized_format');
    const [a, b] = results; expect(a.batch.rows).toHaveLength(5);
    // correct a value during review
    const fix = await app.inject({ method: 'PATCH', url: `/api/imports/staged/${a.batch.id}/rows/${a.batch.rows[0].id}`, payload: { quantity: '11' } });
    expect(fix.json().rows[0].quantity).toBe('11');
    expect((await app.inject({ method: 'POST', url: `/api/imports/staged/${a.batch.id}/commit` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/imports/staged/${b.batch.id}/commit` })).statusCode).toBe(200);
    const p = (await app.inject({ url: '/api/portfolio' })).json();
    expect(p.holdings.find((h: any) => h.symbol === 'AAPL')).toMatchObject({ quantity: 16, value: 3200 }); // 11 + 5, price 200 from the files
    expect(p.totalValue).toBe(7015 + 200 + 2600);
    const again = await app.inject({ method: 'POST', url: '/api/imports/stage', ...multipart([{ name: 'A-copy.csv', content: fixture('synthetic-single-account-A.csv') }]) });
    expect(again.json().results[0]).toMatchObject({ ok: false, code: 'duplicate_file' });
    expect((await app.inject({ url: '/api/portfolio' })).json().totalValue).toBe(p.totalValue);
  });
  it('returns plain-language validation problems instead of importing bad rows', async () => {
    const { app } = await make();
    const up = (await app.inject({ method: 'POST', url: '/api/imports/stage', ...multipart([{ name: 'g.csv', content: 'Symbol,Quantity,Last Price\nAAPL,xyz,200\n' }]) })).json().results[0].batch;
    const r = await app.inject({ method: 'POST', url: `/api/imports/staged/${up.id}/commit` });
    expect(r.statusCode).toBe(422); expect(r.json().problems[0]).toMatch(/quantity must be greater than zero/);
  });
  it('applies a classification override to the portfolio', async () => {
    const { app } = await make();
    const b = (await app.inject({ method: 'POST', url: '/api/imports/stage', ...multipart([{ name: 'A.csv', content: fixture('synthetic-single-account-A.csv') }]) })).json().results[0].batch;
    await app.inject({ method: 'POST', url: `/api/imports/staged/${b.id}/commit` });
    expect((await app.inject({ url: '/api/portfolio' })).json().warnings.some((w: any) => w.code === 'unclassified')).toBe(true);
    await app.inject({ method: 'PUT', url: '/api/classification-overrides/zzzz', payload: { assetClass: 'Equity', sector: 'Materials', geography: 'United States' } });
    const p = (await app.inject({ url: '/api/portfolio' })).json();
    expect(p.warnings.some((w: any) => w.code === 'unclassified')).toBe(false);
    expect(p.holdings.find((h: any) => h.symbol === 'ZZZZ').classification).toMatchObject({ sector: 'Materials', source: 'override' });
  });
});

describe('API: manual valuation', () => {
  it('validates input and includes manual assets in totals', async () => {
    const { app } = await make();
    expect((await app.inject({ method: 'POST', url: '/api/manual-assets', payload: { name: 'Coins', category: 'physical-gold', value: 'lots' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/manual-assets', payload: { name: 'Gold coins', category: 'physical-gold', value: '12500.50', notes: 'owner estimate' } });
    expect(ok.statusCode).toBe(201);
    const p = (await app.inject({ url: '/api/portfolio' })).json();
    expect(p.totalValue).toBe(12500.5); expect(p.holdings[0]).toMatchObject({ status: 'manual', classification: { assetClass: 'Commodity' } });
    const id = ok.json().id; await app.inject({ method: 'DELETE', url: `/api/manual-assets/${id}` });
    expect((await app.inject({ url: '/api/portfolio' })).json().totalValue).toBe(0);
  });
});

describe('API: configuration and secrets', () => {
  it('never returns API keys, and reports provider limits and licensing', async () => {
    const { app } = await make({ ALPACA_KEY_ID: 'AKSECRETID', ALPACA_SECRET_KEY: 'SUPERSECRET', FMP_API_KEY: 'FMPSECRET' });
    const meta = (await app.inject({ url: '/api/meta' })).json(); const text = JSON.stringify(meta);
    expect(text).not.toMatch(/AKSECRETID|SUPERSECRET|FMPSECRET/); expect(meta.provider.id).toBe('alpaca'); expect(meta.provider.licensing).toMatch(/Redistribution/); expect(meta.eodProvider.dailyCallBudget).toBe(200);
  });
  it('clamps the refresh interval into the 30-300 s range and says so', async () => {
    const { cfg } = await make({ PRICE_REFRESH_SECONDS: '5' }); expect(cfg.refreshSeconds).toBe(30); expect(cfg.notes[0]).toMatch(/30 s floor/);
    expect((await make({ PRICE_REFRESH_SECONDS: '60' })).cfg.refreshSeconds).toBe(60);
  });
  it('runs without a provider: no keys means imported prices only, no fabricated quotes', async () => {
    const { app, cfg } = await make(); expect(cfg.alpaca.enabled).toBe(false);
    const meta = (await app.inject({ url: '/api/meta' })).json(); expect(meta.provider).toBeNull(); expect(meta.banner).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/prices/refresh' })).json().skipped).toMatch(/No market-data provider/);
  });
});

describe('demo mode', () => {
  it('is labelled synthetic everywhere and prices come only from the synthetic provider', async () => {
    const cfg = loadConfig({ PORTFOLIO_MODE: 'demo', DATA_DIR: './data' }); const db = freshDb(); await seedDemo(db); await seedDemo(db); // idempotent
    const providers = createProviders(cfg); const prices = new PriceService({ db, provider: providers.intraday, intervalSec: 45, stream: false });
    const app = await buildApp({ db, cfg, providers, prices }); await prices.refreshOnce();
    const meta = (await app.inject({ url: '/api/meta' })).json(); expect(meta.banner).toMatch(/DEMO MODE.*synthetic/i); expect(meta.provider.label).toMatch(/SYNTHETIC/);
    const p = (await app.inject({ url: '/api/portfolio' })).json();
    expect(p.allocation.account.filter((a: any) => a.key !== 'Manual assets').every((a: any) => /synthetic/i.test(a.key))).toBe(true);
    expect(p.holdings.filter((h: any) => h.status === 'manual').every((h: any) => /synthetic/i.test(h.symbol))).toBe(true);
    expect(p.holdings.filter((h: any) => h.basis === 'live').every((h: any) => h.source === 'synthetic' && h.status !== 'real-time')).toBe(true);
    expect(p.holdings.some((h: any) => h.status === 'manual')).toBe(true);
  });
  it('cannot use synthetic prices in live mode', () => { expect(createProviders(loadConfig({ PORTFOLIO_MODE: 'live', DATA_DIR: './data' })).intraday).toBeNull(); });
});

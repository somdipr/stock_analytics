import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { Db, audit } from './db.js';
import { buildPortfolio } from './portfolio.js';
import { marketStatus } from './calendar.js';
import {
  commitStaged, DuplicateFileError, discardStaged, ImportValidationError, listStaged, loadStaged, mapAccount, NotFoundError, patchRow, renameAccount, stageFile,
} from './imports.js';
import { UnrecognizedFormatError } from './parsers/index.js';
import type { Providers } from './providers/index.js';
import type { PriceService } from './scheduler.js';

export interface Ctx { db: Db; cfg: Config; providers: Providers; prices: PriceService | null }

const LIMITATIONS = [
  'Prices come from a free feed. On the Alpaca free plan that is the IEX exchange only, not the consolidated market.',
  'Symbols a provider does not know stay on the price from your imported file and are labelled as such.',
  'Only US holdings are supported for now; FX conversion exists but has no automatic rate feed.',
  'Mutual funds and money-market funds are valued from the imported file; the free providers are not relied on for fund NAVs.',
  'Sector and geography come from a small built-in reference list plus your own overrides; anything else is flagged, never guessed.',
  'No trading, order entry or automated investment decisions exist in this milestone.',
];

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 20 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DuplicateFileError) return reply.code(409).send({ error: err.message, code: 'duplicate_file' });
    if (err instanceof ImportValidationError) return reply.code(422).send({ error: err.message, code: 'validation', problems: err.problems });
    if (err instanceof UnrecognizedFormatError) return reply.code(422).send({ error: err.message, code: 'unrecognized_format' });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues });
    return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Unexpected error' });
  });

  // ---- meta / health
  app.get('/api/meta', async () => ({
    mode: ctx.cfg.mode, market: marketStatus(new Date()), refreshSeconds: ctx.cfg.refreshSeconds, realtimeMaxAgeSec: ctx.cfg.realtimeMaxAgeSec,
    provider: ctx.providers.intraday?.capabilities() ?? null, eodProvider: ctx.providers.eod?.capabilities() ?? null, health: ctx.prices?.health ?? null,
    configNotes: ctx.cfg.notes, limitations: LIMITATIONS,
    banner: ctx.cfg.mode === 'demo' ? 'DEMO MODE: every account, holding and price on this screen is synthetic.' : null,
  }));

  // ---- portfolio
  app.get('/api/portfolio', async () => buildPortfolio(ctx.db, { realtimeMaxAgeSec: ctx.cfg.realtimeMaxAgeSec }));
  app.post('/api/prices/refresh', async () => {
    if (!ctx.prices) return { skipped: 'No market-data provider is configured' };
    return ctx.prices.refreshOnce();
  });
  app.get('/api/accounts', async () => ctx.db.prepare('SELECT id, display_name AS name, mask FROM accounts ORDER BY display_name').all());

  // ---- imports: stage -> review -> commit
  app.post('/api/imports/stage', async (req, reply) => {
    const results: any[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      try { results.push({ filename: part.filename, ok: true, batch: await stageFile(ctx.db, part.filename, buf) }); }
      catch (e: any) {
        if (e instanceof DuplicateFileError) results.push({ filename: part.filename, ok: false, code: 'duplicate_file', error: e.message });
        else if (e instanceof UnrecognizedFormatError) results.push({ filename: part.filename, ok: false, code: 'unrecognized_format', error: e.message });
        else throw e;
      }
    }
    return reply.send({ results });
  });
  app.get('/api/imports/staged', async () => listStaged(ctx.db));
  app.get('/api/imports/staged/:id', async (req) => loadStaged(ctx.db, (req.params as any).id));
  const rowPatch = z.object({
    symbol: z.string().max(20).optional(), description: z.string().max(200).optional(), quantity: z.string().nullable().optional(), filePrice: z.string().nullable().optional(),
    fileValue: z.string().nullable().optional(), costBasis: z.string().nullable().optional(), included: z.boolean().optional(), subType: z.string().max(30).optional(), isCash: z.boolean().optional(),
  });
  app.patch('/api/imports/staged/:id/rows/:rowId', async (req) => { const p = req.params as any; return patchRow(ctx.db, p.id, p.rowId, rowPatch.parse(req.body)); });
  app.patch('/api/imports/staged/:id/accounts/:key', async (req) => {
    const p = req.params as any; const b = z.object({ name: z.string().min(1).max(80).optional(), mapTo: z.string().optional() }).parse(req.body);
    let r = loadStaged(ctx.db, p.id);
    if (b.name) r = renameAccount(ctx.db, p.id, p.key, b.name);
    if (b.mapTo) r = mapAccount(ctx.db, p.id, p.key, b.mapTo);
    return r;
  });
  app.delete('/api/imports/staged/:id', async (req, reply) => { discardStaged(ctx.db, (req.params as any).id); return reply.code(204).send(); });
  app.post('/api/imports/staged/:id/commit', async (req) => {
    const r = commitStaged(ctx.db, (req.params as any).id);
    void ctx.prices?.refreshOnce().catch(() => {});
    return r;
  });
  app.get('/api/imports', async () => ctx.db.prepare("SELECT id, filename, format, as_of AS asOf, committed_at AS committedAt FROM import_batches WHERE status='committed' ORDER BY committed_at DESC").all());

  // ---- classification overrides
  const ovr = z.object({ instrumentType: z.string().max(40).optional(), assetClass: z.string().max(40).optional(), sector: z.string().max(60).optional(), geography: z.string().max(60).optional() });
  app.put('/api/classification-overrides/:symbol', async (req) => {
    const sym = String((req.params as any).symbol).toUpperCase(); const b = ovr.parse(req.body);
    ctx.db.prepare(`INSERT INTO classification_overrides(symbol, instrument_type, asset_class, sector, geography, updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(symbol) DO UPDATE SET instrument_type=COALESCE(excluded.instrument_type, instrument_type), asset_class=COALESCE(excluded.asset_class, asset_class),
      sector=COALESCE(excluded.sector, sector), geography=COALESCE(excluded.geography, geography), updated_at=excluded.updated_at`)
      .run(sym, b.instrumentType ?? null, b.assetClass ?? null, b.sector ?? null, b.geography ?? null, new Date().toISOString());
    audit(ctx.db, 'classification.override', sym); return { ok: true };
  });
  app.delete('/api/classification-overrides/:symbol', async (req, reply) => {
    ctx.db.prepare('DELETE FROM classification_overrides WHERE symbol=?').run(String((req.params as any).symbol).toUpperCase()); return reply.code(204).send();
  });

  // ---- manual valuations (physical gold/silver, real estate, other)
  const manual = z.object({
    name: z.string().min(1).max(80), category: z.enum(['physical-gold', 'physical-silver', 'real-estate', 'other']),
    value: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter a positive amount like 12500.00'), currency: z.string().length(3).default('USD'),
    valuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(), notes: z.string().max(300).default(''), geography: z.string().max(60).default('United States'),
  });
  app.get('/api/manual-assets', async () => ctx.db.prepare('SELECT * FROM manual_assets ORDER BY name').all());
  app.post('/api/manual-assets', async (req, reply) => {
    const b = manual.parse(req.body); const id = randomUUID(); const now = new Date().toISOString();
    ctx.db.prepare('INSERT INTO manual_assets(id,name,category,value,currency,valued_at,notes,geography,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, b.name, b.category, b.value, b.currency.toUpperCase(), b.valuedAt ? new Date(b.valuedAt).toISOString() : now, b.notes, b.geography, now);
    audit(ctx.db, 'manual.create', b.name); return reply.code(201).send({ id });
  });
  app.put('/api/manual-assets/:id', async (req) => {
    const b = manual.parse(req.body); const id = (req.params as any).id;
    const r = ctx.db.prepare('UPDATE manual_assets SET name=?, category=?, value=?, currency=?, valued_at=?, notes=?, geography=? WHERE id=?')
      .run(b.name, b.category, b.value, b.currency.toUpperCase(), b.valuedAt ? new Date(b.valuedAt).toISOString() : new Date().toISOString(), b.notes, b.geography, id);
    if (!r.changes) throw new NotFoundError('Manual asset not found'); return { ok: true };
  });
  app.delete('/api/manual-assets/:id', async (req, reply) => { ctx.db.prepare('DELETE FROM manual_assets WHERE id=?').run((req.params as any).id); return reply.code(204).send(); });

  // ---- FX rates (units of currency per 1 USD); manual entry until an automatic source is added
  app.get('/api/fx', async () => ctx.db.prepare('SELECT currency, per_usd AS perUsd, as_of AS asOf, source FROM fx_rates').all());
  app.put('/api/fx/:currency', async (req) => {
    const b = z.object({ perUsd: z.string().regex(/^\d+(\.\d+)?$/) }).parse(req.body);
    ctx.db.prepare('INSERT INTO fx_rates(currency, per_usd, as_of, source) VALUES(?,?,?,?) ON CONFLICT(currency) DO UPDATE SET per_usd=excluded.per_usd, as_of=excluded.as_of, source=excluded.source')
      .run(String((req.params as any).currency).toUpperCase(), b.perUsd, new Date().toISOString(), 'manual'); return { ok: true };
  });

  // ---- live updates (Server-Sent Events). No keys or provider detail ever leave the server.
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write('retry: 5000\n\n');
    const send = () => reply.raw.write(`event: prices\ndata: ${Date.now()}\n\n`);
    ctx.prices?.on('update', send);
    const ka = setInterval(() => reply.raw.write(': keep-alive\n\n'), 20_000);
    req.raw.on('close', () => { clearInterval(ka); ctx.prices?.off('update', send); });
    reply.hijack();
  });

  const dist = resolve('web/dist');
  if (existsSync(dist)) await app.register(fastifyStatic, { root: dist, wildcard: false }).then(() => app.get('/*', (_q, r) => r.sendFile('index.html')));
  return app;
}

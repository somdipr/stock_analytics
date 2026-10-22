import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createProviders } from './providers/index.js';
import { PriceService } from './scheduler.js';
import { buildPortfolio } from './portfolio.js';
import { buildApp } from './app.js';
import { seedDemo } from './demo.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
if (cfg.mode === 'demo') await seedDemo(db);
const providers = createProviders(cfg);
const prices = providers.intraday || providers.eod
  ? new PriceService({
      db, provider: providers.intraday, eod: providers.eod, intervalSec: cfg.refreshSeconds, stream: cfg.alpaca.stream && cfg.mode === 'live',
      rank: () => buildPortfolio(db, { realtimeMaxAgeSec: cfg.realtimeMaxAgeSec }).holdings.filter((h) => h.status !== 'cash' && h.status !== 'manual').map((h) => h.symbol),
    })
  : null;
const app = await buildApp({ db, cfg, providers, prices });
await app.listen({ port: cfg.port, host: '127.0.0.1' }); // local only
prices?.start();
console.log(`PortfolioPilot AI (${cfg.mode} mode) on http://127.0.0.1:${cfg.port}`);
if (cfg.mode === 'live' && !providers.intraday) console.log('No market-data provider configured: holdings use prices from imported files. See README.');
for (const n of cfg.notes) console.log('Note:', n);
const stop = () => { prices?.stop(); void app.close().then(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

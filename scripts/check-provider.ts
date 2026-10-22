/**
 * Read-only connectivity check for your market-data credentials. Run:  npm run check:provider [-- --stream] [-- --fmp]
 * Prints facts about the connection; never prints keys. Makes ONE Alpaca snapshot call (and, only with --fmp, one FMP call).
 */
import { loadConfig } from '../src/server/config.js';
import { createProviders } from '../src/server/providers/index.js';
import { marketStatus } from '../src/server/calendar.js';
import { classifyStatus } from '../src/server/quotes.js';

const cfg = loadConfig(); const args = new Set(process.argv.slice(2));
const { intraday, eod } = createProviders({ ...cfg, mode: 'live' } as typeof cfg);
const market = marketStatus(new Date());
console.log(`Market: ${market.label} (last close ${market.lastCloseUtc}, next open ${market.nextOpenUtc}${market.calendarKnown ? '' : '; holiday calendar does not cover this year'})`);

if (!intraday) { console.log('Alpaca: NOT configured. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env (see .env.example).'); process.exitCode = 1; }
else {
  try {
    const t0 = Date.now(); const quotes = await intraday.getSnapshots(['AAPL', 'SPY']);
    console.log(`Alpaca REST: OK in ${Date.now() - t0} ms, feed=${intraday.capabilities().feed}, real-time entitlement confirmed=${intraday.capabilities().realtime}`);
    if (!quotes.length) console.log('  No trades returned (the market may be closed and the IEX window empty). That is not an error.');
    for (const q of quotes) {
      const status = classifyStatus({ ...q, delayedMinutes: q.delayedMinutes ?? 0, quoteTs: q.quoteTs.toISOString() }, new Date(), market, cfg.realtimeMaxAgeSec);
      console.log(`  ${q.symbol}: price ${q.price.toFixed(2)} ${q.currency}, trade time ${q.quoteTs.toISOString()} (${Math.round((Date.now() - q.quoteTs.getTime()) / 1000)} s old) -> classified "${status}"`);
    }
  } catch (e) { console.log(`Alpaca REST: FAILED - ${(e as Error).message}`); process.exitCode = 1; }
  if (args.has('--stream') && intraday.stream) {
    console.log('Alpaca stream: connecting for 10 seconds...');
    const h = intraday.stream(['AAPL'], (q) => console.log(`  trade ${q.symbol} ${q.price.toFixed(2)} at ${q.quoteTs.toISOString()}`), (s) => console.log(`  stream state: ${s.state}${s.detail ? ` (${s.detail})` : ''}`));
    await new Promise((r) => setTimeout(r, 10_000)); h.stop();
  }
}
if (args.has('--fmp')) {
  if (!eod?.getEodCloses) console.log('FMP: NOT configured (set FMP_API_KEY).');
  else {
    try { const q = await eod.getEodCloses(['AAPL']); console.log(q.length ? `FMP: OK, AAPL close ${q[0].price.toFixed(2)} on ${q[0].quoteTs.toISOString().slice(0, 10)}` : 'FMP: call succeeded but returned no data (endpoint may be restricted on the free plan).'); }
    catch (e) { console.log(`FMP: FAILED - ${(e as Error).message}`); process.exitCode = 1; }
  }
} else if (eod) console.log('FMP: configured (not called; add --fmp to spend one of your daily calls on a check).');

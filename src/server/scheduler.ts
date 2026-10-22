import { EventEmitter } from 'node:events';
import { Db } from './db.js';
import { ingestQuote, QuoteInput } from './quotes.js';
import { MarketDataProvider, ProviderError, StreamHandle, StreamState } from './providers/types.js';

export interface PriceHealth {
  state: 'idle' | 'ok' | 'degraded' | 'error'; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  consecutiveFailures: number; nextAttemptInSec: number | null; stream: StreamState | null; streamSymbols: number; fmpCallsRemaining: number | null;
}
export interface RefreshSummary { requested: number; stored: number; ignored: number; rejected: string[]; missing: string[] }

export interface PriceServiceOptions {
  db: Db; provider: MarketDataProvider | null; eod?: MarketDataProvider | null; intervalSec: number; stream: boolean;
  rank?: () => string[]; now?: () => Date; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}

/**
 * Polls the provider inside its rate limit, optionally overlays a WebSocket stream for the largest holdings, and
 * routes every quote through ingestQuote() so older data can never overwrite newer data and outages keep the last price.
 */
export class PriceService extends EventEmitter {
  health: PriceHealth = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, nextAttemptInSec: null, stream: null, streamSymbols: 0, fmpCallsRemaining: null };
  private timer: ReturnType<typeof setTimeout> | null = null; private streamHandle: StreamHandle | null = null; private streamSet = '';
  private reqLog: number[] = []; private eodTried = new Set<string>(); private eodDay = ''; private running = false; private halted = false;
  private pending = 0; private flush: NodeJS.Timeout | null = null;
  constructor(private o: PriceServiceOptions) { super(); }
  private now() { return this.o.now ? this.o.now() : new Date(); }

  trackedSymbols(): string[] {
    return (this.o.db.prepare('SELECT DISTINCT symbol FROM positions WHERE active=1 AND is_cash=0 ORDER BY symbol').all() as any[]).map((r) => r.symbol);
  }
  private underRateLimit(calls: number): boolean {
    const cap = this.o.provider?.capabilities().rateLimitPerMin; const t = this.now().getTime();
    this.reqLog = this.reqLog.filter((x) => t - x < 60_000);
    return !cap || this.reqLog.length + calls <= Math.floor(cap * 0.8);
  }
  private store(q: QuoteInput, sum?: RefreshSummary) {
    const r = ingestQuote(this.o.db, q, this.now());
    if (r.result === 'stored') { sum && sum.stored++; this.pending++; this.scheduleEmit(); }
    else if (r.result === 'rejected') sum?.rejected.push(`${q.symbol}: ${r.reason}`);
    else if (sum) sum.ignored++;
  }
  private scheduleEmit() { if (this.flush) return; this.flush = setTimeout(() => { this.flush = null; const n = this.pending; this.pending = 0; if (n) this.emit('update', { updated: n }); }, 750); }

  async refreshOnce(): Promise<RefreshSummary> {
    const sum: RefreshSummary = { requested: 0, stored: 0, ignored: 0, rejected: [], missing: [] };
    const p = this.o.provider; const symbols = this.trackedSymbols(); sum.requested = symbols.length;
    this.health.lastAttemptAt = this.now().toISOString();
    if (!p || !symbols.length) { this.health.state = 'idle'; return sum; }
    const calls = Math.ceil(symbols.length / 100);
    if (!this.underRateLimit(calls)) { this.health.lastError = 'Skipped a refresh to stay inside the provider rate limit'; return sum; }
    try {
      for (let i = 0; i < calls; i++) this.reqLog.push(this.now().getTime());
      const quotes = await p.getSnapshots(symbols);
      for (const q of quotes) this.store(q, sum);
      const got = new Set(quotes.map((q) => q.symbol));
      sum.missing = symbols.filter((s) => !got.has(s));
      this.health.state = 'ok'; this.health.lastSuccessAt = this.now().toISOString(); this.health.lastError = null; this.health.consecutiveFailures = 0;
    } catch (e) {
      this.health.consecutiveFailures++; this.health.lastError = (e as Error).message;
      if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'restricted')) { this.health.state = 'error'; this.halted = true; }
      else this.health.state = 'degraded';
      if (e instanceof ProviderError && e.kind === 'rate_limit') this.health.nextAttemptInSec = e.retryAfterSec ?? 60;
    }
    await this.fallbackEod(symbols.filter((s) => sum.missing.includes(s) || this.health.state !== 'ok'), sum);
    this.syncStream();
    return sum;
  }

  /** End-of-day fallback: only for symbols with no stored quote, once per symbol per UTC day, inside the provider's call budget. */
  private async fallbackEod(candidates: string[], sum: RefreshSummary) {
    const eod = this.o.eod; if (!eod?.getEodCloses) return;
    const day = this.now().toISOString().slice(0, 10); if (day !== this.eodDay) { this.eodDay = day; this.eodTried.clear(); }
    const have = new Set((this.o.db.prepare('SELECT symbol FROM latest_quotes').all() as any[]).map((r) => r.symbol));
    const todo = candidates.filter((s) => !have.has(s) && !this.eodTried.has(s)); if (!todo.length) return;
    todo.forEach((s) => this.eodTried.add(s));
    try { for (const q of await eod.getEodCloses(todo)) this.store(q, sum); }
    catch (e) { this.health.lastError = `End-of-day fallback: ${(e as Error).message}`; }
    const cap = eod.capabilities(); this.health.fmpCallsRemaining = (eod as any).callsRemaining?.() ?? null; void cap;
  }

  private syncStream() {
    const p = this.o.provider;
    if (!this.o.stream || !p?.stream || this.halted) return;
    const max = p.capabilities().maxStreamSymbols; const ranked = (this.o.rank?.() ?? this.trackedSymbols()).slice(0, max);
    const key = ranked.join(',');
    if (key === this.streamSet) return;
    this.streamHandle?.stop(); this.streamSet = key; this.health.streamSymbols = ranked.length;
    if (!ranked.length) { this.streamHandle = null; return; }
    this.streamHandle = p.stream(ranked, (q) => this.store(q), (s) => { this.health.stream = s; });
  }

  start() {
    if (this.running) return; this.running = true;
    const loop = async () => {
      if (!this.running || this.halted) return;
      await this.refreshOnce();
      if (this.halted || !this.running) return; // permanent failure (bad keys / plan restriction): do not schedule another call
      const f = this.health.consecutiveFailures;
      const wait = Math.max(this.o.intervalSec * 2 ** Math.min(f, 4), this.health.nextAttemptInSec ?? 0, 0);
      this.health.nextAttemptInSec = null;
      this.timer = (this.o.setTimer ?? setTimeout)(loop, Math.min(wait, 300) * 1000);
    };
    void loop();
  }
  stop() { this.running = false; if (this.timer) (this.o.clearTimer ?? clearTimeout)(this.timer); this.streamHandle?.stop(); if (this.flush) clearTimeout(this.flush); }
}

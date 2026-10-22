import WebSocket from 'ws';
import { D } from '../money.js';
import type { QuoteInput } from '../quotes.js';
import { MarketDataProvider, ProviderCapabilities, ProviderError, StreamHandle, StreamState } from './types.js';

export interface AlpacaConfig {
  keyId: string; secretKey: string; feed: 'iex' | 'sip'; dataUrl?: string; streamUrl?: string;
  fetchImpl?: typeof fetch; wsImpl?: new (url: string) => WebSocket; now?: () => Date;
}

/** Map one Alpaca trade (REST latestTrade or stream "t" message) to a provider-neutral quote. */
export function tradeToQuote(symbol: string, p: unknown, t: unknown, feed: string, entitled: boolean, now: Date): QuoteInput | null {
  const price = Number(p);
  const ts = new Date(String(t));
  if (!Number.isFinite(price) || price <= 0 || Number.isNaN(ts.getTime())) return null;
  return { symbol, price: D(price), currency: 'USD', quoteTs: ts, retrievedTs: now, source: 'alpaca', feed, kind: 'trade', realtimeEntitled: entitled };
}

export class AlpacaProvider implements MarketDataProvider {
  private entitled = false;
  private f: typeof fetch; private now: () => Date;
  constructor(private cfg: AlpacaConfig) { this.f = cfg.fetchImpl ?? fetch; this.now = cfg.now ?? (() => new Date()); }

  capabilities(): ProviderCapabilities {
    return {
      id: 'alpaca', label: `Alpaca Market Data (Basic, ${this.cfg.feed.toUpperCase()} feed)`, realtime: this.entitled && this.cfg.feed === 'iex', delayedMinutes: 0,
      feed: this.cfg.feed, streaming: true, maxStreamSymbols: 30, rateLimitPerMin: 200, dailyCallBudget: null, coverage: 'US stocks and ETFs (IEX venue only on the free plan)',
      attribution: 'Review Alpaca\'s Market Data Agreement for display and attribution terms before any sharing or hosting.',
      licensing: 'Free Basic plan: personal use. IEX data is a single venue, not the consolidated tape. Redistribution is not permitted.',
      notes: ['IEX is one exchange; last-trade prices of thinly traded symbols can be old even when the market is open.',
        'Real-time is only claimed when the provider call succeeded on the IEX feed and the trade timestamp is fresh.'],
    };
  }

  private headers() { return { 'APCA-API-KEY-ID': this.cfg.keyId, 'APCA-API-SECRET-KEY': this.cfg.secretKey, accept: 'application/json' }; }

  private async get(path: string): Promise<any> {
    let res: Response;
    try { res = await this.f(`${this.cfg.dataUrl ?? 'https://data.alpaca.markets'}${path}`, { headers: this.headers() }); }
    catch (e) { throw new ProviderError('unavailable', `Network error calling Alpaca: ${(e as Error).message}`); }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      throw new ProviderError(/subscription|sip/i.test(body) ? 'restricted' : 'auth', `Alpaca rejected the request (${res.status}). ${body.slice(0, 200)}`);
    }
    if (res.status === 429) throw new ProviderError('rate_limit', 'Alpaca rate limit reached', Number(res.headers.get('retry-after')) || 30);
    if (res.status === 400 || res.status === 422) throw new ProviderError('bad_request', `Alpaca could not process the request (${res.status}): ${(await res.text()).slice(0, 200)}`);
    if (!res.ok) throw new ProviderError('unavailable', `Alpaca returned HTTP ${res.status}`);
    return res.json();
  }

  async getSnapshots(symbols: string[]): Promise<QuoteInput[]> {
    const out: QuoteInput[] = [];
    for (let i = 0; i < symbols.length; i += 100) {
      const chunk = symbols.slice(i, i + 100);
      let body: any;
      try { body = await this.get(`/v2/stocks/snapshots?symbols=${encodeURIComponent(chunk.join(','))}&feed=${this.cfg.feed}`); }
      catch (e) {
        if (!(e instanceof ProviderError && e.kind === 'bad_request' && chunk.length > 1)) throw e;
        for (const s of chunk) { try { out.push(...(await this.getSnapshots([s]))); } catch (e2) { if (!(e2 instanceof ProviderError && e2.kind === 'bad_request')) throw e2; } }
        continue;
      }
      this.entitled = this.cfg.feed === 'iex'; // an authenticated 200 on the IEX feed confirms the free real-time entitlement
      const map = body?.snapshots ?? body ?? {};
      for (const [sym, snap] of Object.entries<any>(map)) {
        const q = tradeToQuote(sym, snap?.latestTrade?.p, snap?.latestTrade?.t, this.cfg.feed, this.entitled, this.now());
        if (q) out.push(q);
      }
    }
    return out;
  }

  stream(symbols: string[], onQuote: (q: QuoteInput) => void, onState: (s: StreamState) => void): StreamHandle {
    const Ws = this.cfg.wsImpl ?? (WebSocket as unknown as new (url: string) => WebSocket);
    const url = this.cfg.streamUrl ?? `wss://stream.data.alpaca.markets/v2/${this.cfg.feed}`;
    let stopped = false; let ws: WebSocket | null = null; let attempt = 0; let timer: NodeJS.Timeout | null = null;
    const connect = () => {
      if (stopped) return;
      onState({ state: 'connecting' });
      ws = new Ws(url);
      ws.on('open', () => ws!.send(JSON.stringify({ action: 'auth', key: this.cfg.keyId, secret: this.cfg.secretKey })));
      ws.on('message', (raw) => {
        let msgs: any[]; try { msgs = JSON.parse(String(raw)); } catch { return; }
        for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
          if (m.T === 'success' && m.msg === 'authenticated') { attempt = 0; this.entitled = this.cfg.feed === 'iex'; onState({ state: 'authenticated' }); ws!.send(JSON.stringify({ action: 'subscribe', trades: symbols })); }
          else if (m.T === 'subscription') onState({ state: 'subscribed', detail: `${(m.trades ?? []).length} symbols` });
          else if (m.T === 't') { const q = tradeToQuote(m.S, m.p, m.t, this.cfg.feed, this.entitled, this.now()); if (q) onQuote(q); }
          else if (m.T === 'error') {
            onState({ state: 'error', detail: `${m.code}: ${m.msg}` });
            if (m.code === 406 || m.code === 402 || m.code === 403) { stopped = true; ws?.close(); } // connection limit / auth: do not hammer
          }
        }
      });
      const retry = () => {
        if (stopped) return; onState({ state: 'closed' });
        const delay = Math.min(60_000, 1000 * 2 ** attempt++); timer = setTimeout(connect, delay);
      };
      ws.on('close', retry); ws.on('error', (e) => { onState({ state: 'error', detail: e.message }); });
    };
    connect();
    return { stop() { stopped = true; if (timer) clearTimeout(timer); ws?.close(); } };
  }
}

import { D } from '../money.js';
import { etToUtc } from '../calendar.js';
import type { QuoteInput } from '../quotes.js';
import { MarketDataProvider, ProviderCapabilities, ProviderError } from './types.js';

export interface FmpConfig { apiKey: string; dailyBudget: number; baseUrl?: string; fetchImpl?: typeof fetch; now?: () => Date }

/** FMP free plan: end-of-day closes only, used as a fallback for symbols the intraday provider cannot price. */
export class FmpProvider implements MarketDataProvider {
  private f: typeof fetch; private now: () => Date; private day = ''; private used = 0;
  constructor(private cfg: FmpConfig) { this.f = cfg.fetchImpl ?? fetch; this.now = cfg.now ?? (() => new Date()); }
  capabilities(): ProviderCapabilities {
    return { id: 'fmp', label: 'Financial Modeling Prep (Basic, end-of-day)', realtime: false, delayedMinutes: 0, feed: null, streaming: false, maxStreamSymbols: 0,
      rateLimitPerMin: null, dailyCallBudget: this.cfg.dailyBudget, coverage: 'US symbols, end-of-day closes (free plan: 250 calls/day, 5 years history)',
      attribution: 'Check FMP\'s terms for required attribution before sharing or hosting.', licensing: 'Free plan is for personal use; display or redistribution needs a commercial licence.',
      notes: ['Each symbol costs one call. The app stops at the configured daily budget and never upgrades the plan.', 'Which endpoints the free plan allows can change; run npm run check:provider.'] };
  }
  callsRemaining(): number { this.roll(); return Math.max(0, this.cfg.dailyBudget - this.used); }
  private roll() { const d = this.now().toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.used = 0; } }
  async getSnapshots(): Promise<QuoteInput[]> { return []; } // no intraday data on the free plan
  async getEodCloses(symbols: string[]): Promise<QuoteInput[]> {
    const out: QuoteInput[] = [];
    for (const s of symbols) {
      if (this.callsRemaining() <= 0) break;
      this.used++;
      let res: Response;
      try { res = await this.f(`${this.cfg.baseUrl ?? 'https://financialmodelingprep.com'}/stable/historical-price-eod/light?symbol=${encodeURIComponent(s)}&apikey=${this.cfg.apiKey}`); }
      catch (e) { throw new ProviderError('unavailable', `Network error calling FMP: ${(e as Error).message}`); }
      if (res.status === 429) throw new ProviderError('rate_limit', 'FMP daily limit reached');
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', `FMP rejected the API key (${res.status})`);
      if (res.status === 402) throw new ProviderError('restricted', 'FMP says this endpoint needs a paid plan');
      if (!res.ok) throw new ProviderError('unavailable', `FMP returned HTTP ${res.status}`);
      const body: any = await res.json();
      if (!Array.isArray(body) || !body.length) continue; // unknown symbol or restricted: skip, do not invent
      const latest = [...body].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      const [y, m, d] = String(latest.date).split('-').map(Number); const price = Number(latest.price ?? latest.close);
      if (!y || !Number.isFinite(price) || price <= 0) continue;
      out.push({ symbol: s, price: D(price), currency: 'USD', quoteTs: new Date(etToUtc(y, m, d, 16, 0)), retrievedTs: this.now(), source: 'fmp', feed: null, kind: 'eod', realtimeEntitled: false });
    }
    return out;
  }
}

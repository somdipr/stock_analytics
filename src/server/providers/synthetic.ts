import { D } from '../money.js';
import type { QuoteInput } from '../quotes.js';
import { MarketDataProvider, ProviderCapabilities } from './types.js';

const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/** DEMO MODE ONLY. Produces clearly labelled synthetic prices; it refuses to be constructed in live mode. */
export class SyntheticProvider implements MarketDataProvider {
  constructor(mode: string, private now: () => Date = () => new Date()) {
    if (mode !== 'demo') throw new Error('SyntheticProvider is only available when PORTFOLIO_MODE=demo');
  }
  capabilities(): ProviderCapabilities {
    return { id: 'synthetic', label: 'SYNTHETIC demo prices (not market data)', realtime: false, delayedMinutes: 0, feed: 'synthetic', streaming: false, maxStreamSymbols: 0,
      rateLimitPerMin: null, dailyCallBudget: null, coverage: 'Any symbol, fabricated', attribution: 'n/a', licensing: 'Synthetic, for demonstration only',
      notes: ['These numbers are generated, not observed. Never use them for decisions.'] };
  }
  price(symbol: string, at: Date): number {
    const base = 20 + (hash(symbol) % 38000) / 100;
    const minute = Math.floor(at.getTime() / 60_000);
    return Math.round(base * (1 + 0.01 * Math.sin(minute / 7 + hash(symbol) % 13) + 0.004 * Math.sin(minute / 2.3)) * 100) / 100;
  }
  async getSnapshots(symbols: string[]): Promise<QuoteInput[]> {
    const t = this.now();
    return symbols.map((s) => ({ symbol: s, price: D(this.price(s, t)), currency: 'USD', quoteTs: t, retrievedTs: t, source: 'synthetic', feed: 'synthetic', kind: 'trade' as const, realtimeEntitled: false }));
  }
}

import type { QuoteInput } from '../quotes.js';

export interface ProviderCapabilities {
  id: string; label: string; realtime: boolean; delayedMinutes: number; feed: string | null; streaming: boolean; maxStreamSymbols: number;
  rateLimitPerMin: number | null; dailyCallBudget: number | null; coverage: string; attribution: string; licensing: string; notes: string[];
}
export type ProviderErrorKind = 'auth' | 'rate_limit' | 'restricted' | 'unavailable' | 'bad_request';
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public retryAfterSec?: number) { super(message); }
}
export interface StreamHandle { stop(): void }
export type StreamState = { state: 'connecting' | 'authenticated' | 'subscribed' | 'closed' | 'error'; detail?: string };

/** The seam that keeps a paid provider a one-adapter change. Nothing outside src/server/providers knows a vendor's wire format. */
export interface MarketDataProvider {
  capabilities(): ProviderCapabilities;
  /** Latest trade/quote per symbol. Symbols the provider does not know are simply absent from the result. */
  getSnapshots(symbols: string[]): Promise<QuoteInput[]>;
  getEodCloses?(symbols: string[]): Promise<QuoteInput[]>;
  stream?(symbols: string[], onQuote: (q: QuoteInput) => void, onState: (s: StreamState) => void): StreamHandle;
}

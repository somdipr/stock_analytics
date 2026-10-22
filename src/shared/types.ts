/** Freshness classification for a price. Never inferred from a provider label alone. */
export type QuoteStatus = 'real-time' | 'delayed' | 'end-of-day' | 'stale' | 'unavailable';
export const QUOTE_STATUSES: QuoteStatus[] = ['real-time', 'delayed', 'end-of-day', 'stale', 'unavailable'];

export type PriceBasis = 'live' | 'imported' | 'none' | 'cash';
export type Severity = 'info' | 'warn' | 'error';

export interface Warning { code: string; severity: Severity; message: string; subject?: string }

export interface Classification {
  instrumentType: string; assetClass: string; sector: string; geography: string;
  source: 'override' | 'seed' | 'source-label' | 'unknown';
}

export interface Lot { accountId: string; accountName: string; subType: string; quantity: number; value: number }

export interface HoldingView {
  symbol: string; description: string; quantity: number; price: number | null; currency: string;
  value: number; weightPct: number; costBasis: number | null; gain: number | null;
  status: QuoteStatus | 'cash' | 'manual'; basis: PriceBasis; source: string; feed: string | null;
  quoteTs: string | null; retrievedTs: string | null; classification: Classification; lots: Lot[];
}
export interface AllocationSlice { key: string; value: number; pct: number }
export interface PortfolioView {
  baseCurrency: string; generatedAt: string; totalValue: number; cashValue: number; investedValue: number;
  costBasis: number | null; unrealizedGain: number | null;
  holdings: HoldingView[];
  allocation: { assetClass: AllocationSlice[]; sector: AllocationSlice[]; geography: AllocationSlice[]; instrumentType: AllocationSlice[]; account: AllocationSlice[] };
  priceSummary: Record<QuoteStatus | 'cash' | 'manual', number>;
  warnings: Warning[];
}

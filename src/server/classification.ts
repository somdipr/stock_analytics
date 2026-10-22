import { Classification } from '../shared/types.js';

type Seed = [instrumentType: string, assetClass: string, sector: string, geography: string];
const S = (sector: string): Seed => ['Stock', 'Equity', sector, 'United States'];
const E = (sector: string, geo = 'United States'): Seed => ['ETF', 'Equity', sector, geo];

/**
 * Reference data only: sector/geography are GICS-style labels by listing and domicile, curated by hand and
 * editable in the app (overrides win). Anything not listed here is flagged as unclassified, never guessed.
 */
export const SEED: Record<string, Seed> = {
  AAPL: S('Information Technology'), MSFT: S('Information Technology'), NVDA: S('Information Technology'), PANW: S('Information Technology'),
  GOOGL: S('Communication Services'), GOOG: S('Communication Services'), META: S('Communication Services'), NFLX: S('Communication Services'),
  AMZN: S('Consumer Discretionary'), TSLA: S('Consumer Discretionary'), F: S('Consumer Discretionary'), MCD: S('Consumer Discretionary'),
  KO: S('Consumer Staples'), MS: S('Financials'), JPM: S('Financials'), V: S('Financials'), SPGI: S('Financials'),
  RTX: S('Industrials'), UBER: S('Industrials'), DE: S('Industrials'), UPS: S('Industrials'),
  CLOV: S('Health Care'), ABBV: S('Health Care'), MRK: S('Health Care'), UNH: S('Health Care'),
  FCX: S('Materials'), SLB: S('Energy'), XOM: S('Energy'),
  SCHD: E('Diversified'), JEPI: E('Diversified'), GPIX: E('Diversified'), SPY: E('Diversified'), VOO: E('Diversified'),
  IVV: E('Diversified'), VTI: E('Diversified'), QQQ: E('Diversified'), IWM: E('Diversified'), XLU: E('Utilities'),
  VXUS: E('Diversified', 'International ex-US'), VEA: E('Diversified', 'International ex-US'), VWO: E('Diversified', 'International ex-US'),
  BND: ['ETF', 'Fixed Income', 'Diversified', 'United States'], AGG: ['ETF', 'Fixed Income', 'Diversified', 'United States'],
  GLD: ['ETF', 'Commodity', 'Precious Metals', 'Global'], SLV: ['ETF', 'Commodity', 'Precious Metals', 'Global'],
  CASH: ['Cash', 'Cash', 'Cash', 'United States'], SPAXX: ['Money market fund', 'Cash', 'Cash', 'United States'],
  FDRXX: ['Money market fund', 'Cash', 'Cash', 'United States'], SWVXX: ['Money market fund', 'Cash', 'Cash', 'United States'],
  VMFXX: ['Money market fund', 'Cash', 'Cash', 'United States'],
};

export const UNCLASSIFIED = 'Unclassified';
export type Override = Partial<Pick<Classification, 'instrumentType' | 'assetClass' | 'sector' | 'geography'>>;

export function classify(symbol: string, description: string, sourceAssetType: string, isCash: boolean, overrides: Map<string, Override>): Classification {
  let base: Classification;
  const seed = SEED[symbol];
  if (seed) base = { instrumentType: seed[0], assetClass: seed[1], sector: seed[2], geography: seed[3], source: 'seed' };
  else if (isCash || /cash and money market/i.test(sourceAssetType))
    base = { instrumentType: 'Cash', assetClass: 'Cash', sector: 'Cash', geography: 'United States', source: 'source-label' };
  else if (/^equity$/i.test(sourceAssetType)) base = { instrumentType: 'Stock', assetClass: 'Equity', sector: UNCLASSIFIED, geography: UNCLASSIFIED, source: 'source-label' };
  else if (/etf/i.test(sourceAssetType)) base = { instrumentType: 'ETF', assetClass: UNCLASSIFIED, sector: UNCLASSIFIED, geography: UNCLASSIFIED, source: 'source-label' };
  else if (/mutual fund/i.test(sourceAssetType)) base = { instrumentType: 'Mutual fund', assetClass: UNCLASSIFIED, sector: UNCLASSIFIED, geography: UNCLASSIFIED, source: 'source-label' };
  else base = { instrumentType: UNCLASSIFIED, assetClass: UNCLASSIFIED, sector: UNCLASSIFIED, geography: UNCLASSIFIED, source: 'unknown' };
  const o = overrides.get(symbol);
  if (o) {
    for (const k of ['instrumentType', 'assetClass', 'sector', 'geography'] as const) if (o[k]) base[k] = o[k]!;
    base.source = 'override';
  }
  return base;
}
export const isIncomplete = (c: Classification) => [c.assetClass, c.sector, c.geography, c.instrumentType].includes(UNCLASSIFIED);

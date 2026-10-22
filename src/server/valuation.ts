/**
 * Pure portfolio maths. No I/O, no AI. All arithmetic is decimal.js; numbers are only produced at the edge for display.
 */
import { Decimal, D, ZERO, money2, pct4 } from './money.js';
import { FxRates, tryConvert } from './fx.js';
import { isIncomplete } from './classification.js';
import {
  AllocationSlice, Classification, HoldingView, Lot, PortfolioView, PriceBasis, QUOTE_STATUSES, QuoteStatus, Warning,
} from '../shared/types.js';

export interface ValPosition {
  id: number; accountId: string; accountName: string; symbol: string; description: string; subType: string;
  quantity: Decimal | null; filePrice: Decimal | null; fileValue: Decimal | null; costBasis: Decimal | null; currency: string;
  sourceAssetType: string; isCash: boolean; asOf: string;
}
export interface ValQuote { price: Decimal; currency: string; quoteTs: string; retrievedTs: string; source: string; feed: string | null; status: QuoteStatus }
export interface ValManual { id: string; name: string; category: string; value: Decimal; currency: string; valuedAt: string; geography: string; notes: string }
export interface ValInput {
  base: string; positions: ValPosition[]; manual: ValManual[]; quotes: Map<string, ValQuote>; fx: FxRates; now: Date;
  classify: (symbol: string, description: string, sourceAssetType: string, isCash: boolean) => Classification;
  manualStaleDays?: number;
}

const MANUAL_CLASS: Record<string, [string, string]> = {
  'physical-gold': ['Commodity', 'Precious Metals'], 'physical-silver': ['Commodity', 'Precious Metals'],
  'real-estate': ['Real Estate', 'Real Estate'], other: ['Alternative', 'Other'],
};

interface Acc {
  symbol: string; description: string; qty: Decimal; value: Decimal; cost: Decimal; costMissing: boolean; costLots: number;
  basis: PriceBasis; status: HoldingView['status']; source: string; feed: string | null; quoteTs: string | null; retrievedTs: string | null;
  quotePrice: Decimal | null; currency: string; cls: Classification; lots: Lot[];
}

export function valuePortfolio(inp: ValInput): PortfolioView {
  const warnings: Warning[] = [];
  const acc = new Map<string, Acc>();
  const byAccount = new Map<string, Decimal>();
  const addAccount = (name: string, v: Decimal) => byAccount.set(name, (byAccount.get(name) ?? ZERO).plus(v));
  const conv = (amt: Decimal, from: string, subject: string): Decimal | null => {
    const r = tryConvert(amt, from, inp.base, inp.fx);
    if (!r) warnings.push({ code: 'missing_fx', severity: 'error', subject, message: `No ${from} to ${inp.base} exchange rate, so ${subject} is excluded from totals` });
    return r;
  };

  for (const p of inp.positions) {
    const cls = inp.classify(p.symbol, p.description, p.sourceAssetType, p.isCash);
    let value: Decimal | null = null; let basis: PriceBasis = 'none'; let status: HoldingView['status'] = 'unavailable';
    let source = 'none'; let feed: string | null = null; let quoteTs: string | null = null; let retrievedTs: string | null = null; let quotePrice: Decimal | null = null;
    let cost: Decimal | null = null;
    if (p.isCash) {
      value = p.fileValue ? conv(p.fileValue, p.currency, p.symbol) : ZERO; basis = 'cash'; status = 'cash'; source = 'import'; quoteTs = p.asOf;
      cost = value;
    } else {
      const q = inp.quotes.get(p.symbol);
      if (q && p.quantity) {
        value = conv(p.quantity.mul(q.price), q.currency, p.symbol); basis = 'live'; status = q.status; source = q.source; feed = q.feed;
        quoteTs = q.quoteTs; retrievedTs = q.retrievedTs; quotePrice = q.price;
      } else if (p.quantity && p.filePrice) {
        value = conv(p.quantity.mul(p.filePrice), p.currency, p.symbol); basis = 'imported'; status = 'stale'; source = 'import'; quoteTs = p.asOf;
      } else if (p.fileValue) {
        value = conv(p.fileValue, p.currency, p.symbol); basis = 'imported'; status = 'unavailable'; source = 'import'; quoteTs = p.asOf;
        warnings.push({ code: 'no_price', severity: 'warn', subject: p.symbol, message: `${p.symbol} has no price from the market-data provider or the file; using the file's market value` });
      } else {
        value = ZERO; warnings.push({ code: 'no_price', severity: 'error', subject: p.symbol, message: `${p.symbol} has no price or value and is counted as 0` });
      }
      cost = p.costBasis ? conv(p.costBasis, p.currency, p.symbol) : null;
    }
    if (value === null) continue; // missing FX: excluded and warned
    const key = p.symbol;
    let a = acc.get(key);
    if (!a) {
      a = { symbol: key, description: p.description, qty: ZERO, value: ZERO, cost: ZERO, costMissing: false, costLots: 0, basis, status, source, feed, quoteTs,
        retrievedTs, quotePrice, currency: inp.base, cls, lots: [] };
      acc.set(key, a);
    } else if (a.status !== status && basis !== 'cash') { a.status = a.status === 'stale' || status === 'stale' ? 'stale' : a.status; }
    if (!a.description && p.description) a.description = p.description;
    a.qty = a.qty.plus(p.quantity ?? ZERO); a.value = a.value.plus(value);
    if (cost === null) a.costMissing = true; else { a.cost = a.cost.plus(cost); a.costLots++; }
    a.lots.push({ accountId: p.accountId, accountName: p.accountName, subType: p.subType, quantity: (p.quantity ?? ZERO).toNumber(), value: money2(value) });
    addAccount(p.accountName, value);
  }

  const manualStale = (inp.manualStaleDays ?? 90) * 86400_000;
  const holdings: { acc: Acc; manual?: ValManual }[] = [...acc.values()].map((a) => ({ acc: a }));
  for (const m of inp.manual) {
    const v = conv(m.value, m.currency, m.name); if (v === null) continue;
    const [assetClass, sector] = MANUAL_CLASS[m.category] ?? MANUAL_CLASS.other;
    holdings.push({ manual: m, acc: { symbol: `MANUAL:${m.name}`, description: m.notes || m.name, qty: D(1), value: v, cost: v, costMissing: false, costLots: 1,
      basis: 'none', status: 'manual', source: 'manual valuation', feed: null, quoteTs: m.valuedAt, retrievedTs: null, quotePrice: null, currency: inp.base,
      cls: { instrumentType: 'Manual asset', assetClass, sector, geography: m.geography, source: 'override' },
      lots: [{ accountId: 'manual', accountName: 'Manual assets', subType: m.category, quantity: 1, value: money2(v) }] } });
    addAccount('Manual assets', v);
    if (inp.now.getTime() - new Date(m.valuedAt).getTime() > manualStale)
      warnings.push({ code: 'manual_stale', severity: 'warn', subject: m.name, message: `${m.name} was last valued on ${m.valuedAt.slice(0, 10)}; update the valuation` });
  }

  const total = holdings.reduce((s, h) => s.plus(h.acc.value), ZERO);
  const slices = (keyOf: (h: { acc: Acc }) => string): AllocationSlice[] => {
    const m = new Map<string, Decimal>();
    for (const h of holdings) m.set(keyOf(h), (m.get(keyOf(h)) ?? ZERO).plus(h.acc.value));
    return [...m.entries()].sort((a, b) => b[1].cmp(a[1])).map(([key, v]) => ({ key, value: money2(v), pct: total.isZero() ? 0 : pct4(v.div(total).mul(100)) }));
  };

  const priceSummary = Object.fromEntries([...QUOTE_STATUSES, 'cash', 'manual'].map((s) => [s, 0])) as PortfolioView['priceSummary'];
  const views: HoldingView[] = holdings.map(({ acc: a }) => {
    priceSummary[a.status]++;
    const isCash = a.status === 'cash';
    if (!isCash && a.status !== 'manual' && isIncomplete(a.cls))
      warnings.push({ code: 'unclassified', severity: 'warn', subject: a.symbol, message: `${a.symbol} is not fully classified; set its asset class, sector and geography` });
    if (a.costMissing && !isCash && a.status !== 'manual')
      warnings.push({ code: 'cost_basis_missing', severity: 'info', subject: a.symbol, message: `${a.symbol} has no cost basis in at least one account, so its gain is not shown` });
    const price = a.quotePrice ?? (a.qty.gt(0) && !isCash ? a.value.div(a.qty) : null);
    const costKnown = !a.costMissing && a.costLots > 0;
    return {
      symbol: a.symbol, description: a.description, quantity: a.qty.toNumber(), price: price ? price.toDecimalPlaces(4).toNumber() : null, currency: a.currency,
      value: money2(a.value), weightPct: total.isZero() ? 0 : pct4(a.value.div(total).mul(100)), costBasis: costKnown ? money2(a.cost) : null,
      gain: costKnown ? money2(a.value.minus(a.cost)) : null, status: a.status, basis: a.basis, source: a.source, feed: a.feed,
      quoteTs: a.quoteTs, retrievedTs: a.retrievedTs, classification: a.cls, lots: a.lots,
    };
  }).sort((x, y) => y.value - x.value);

  const imported = views.filter((v) => v.basis === 'imported').length;
  if (imported) warnings.push({ code: 'imported_prices', severity: 'info', message: `${imported} holding(s) are valued from prices in the imported file, not a live quote` });

  const cash = holdings.filter((h) => h.acc.status === 'cash').reduce((s, h) => s.plus(h.acc.value), ZERO);
  const costed = holdings.every((h) => h.acc.status === 'cash' || h.acc.status === 'manual' || (!h.acc.costMissing && h.acc.costLots > 0));
  const costBasis = costed ? holdings.reduce((s, h) => s.plus(h.acc.cost), ZERO) : null;
  return {
    baseCurrency: inp.base, generatedAt: inp.now.toISOString(), totalValue: money2(total), cashValue: money2(cash), investedValue: money2(total.minus(cash)),
    costBasis: costBasis ? money2(costBasis) : null, unrealizedGain: costBasis ? money2(total.minus(costBasis)) : null, holdings: views,
    allocation: {
      assetClass: slices((h) => h.acc.cls.assetClass), sector: slices((h) => h.acc.cls.sector), geography: slices((h) => h.acc.cls.geography),
      instrumentType: slices((h) => h.acc.cls.instrumentType),
      account: [...byAccount.entries()].sort((a, b) => b[1].cmp(a[1])).map(([key, v]) => ({ key, value: money2(v), pct: total.isZero() ? 0 : pct4(v.div(total).mul(100)) })),
    },
    priceSummary, warnings,
  };
}

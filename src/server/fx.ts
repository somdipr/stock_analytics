import { Decimal, D } from './money.js';

/** Rates are quoted as units of currency per 1 USD, e.g. { EUR: 0.92, INR: 83.1 }. USD is implicit (1). */
export type FxRates = Record<string, Decimal>;
export class MissingFxRateError extends Error {
  constructor(public from: string, public to: string) { super(`No FX rate available to convert ${from} to ${to}`); }
}

/** Convert via USD pivot. Same-currency conversion never needs a rate. Throws when a rate is missing. */
export function convert(amount: Decimal, from: string, to: string, rates: FxRates): Decimal {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) return amount;
  const perUsd = (c: string): Decimal => {
    if (c === 'USD') return D(1);
    const r = rates[c];
    if (!r || r.lte(0)) throw new MissingFxRateError(from, to);
    return r;
  };
  return amount.div(perUsd(f)).mul(perUsd(t));
}

export function tryConvert(amount: Decimal, from: string, to: string, rates: FxRates): Decimal | null {
  try { return convert(amount, from, to, rates); } catch (e) { if (e instanceof MissingFxRateError) return null; throw e; }
}

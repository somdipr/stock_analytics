import Decimal from 'decimal.js';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export { Decimal };
export const D = (v: Decimal.Value): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

const ABSENT = new Set(['', '--', '---', 'n/a', 'na', 'none', 'null', '-']);
/** True when a cell carries no value (brokers use "--", "N/A", blanks). */
export function isAbsent(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  return ABSENT.has(String(raw).trim().toLowerCase());
}

/**
 * Parse broker-formatted numbers: "$1,234.56 ", "($16.46)", "-$1.23", "-0.45%", "+3.1".
 * Returns null when absent OR unparseable; use isAbsent() to tell them apart.
 */
export function parseMoney(raw: unknown): Decimal | null {
  if (isAbsent(raw)) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Decimal(raw) : null;
  let s = String(raw).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, '').replace(/^\+/, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const d = new Decimal(s);
  return neg ? d.neg() : d;
}

export const money2 = (d: Decimal): number => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
export const pct4 = (d: Decimal): number => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
/** Persist decimals as exact text. */
export const toDb = (d: Decimal | null | undefined): string | null => (d ? d.toFixed() : null);
export const fromDb = (s: string | null | undefined): Decimal | null => (s === null || s === undefined ? null : new Decimal(s));

import type { HoldingView, QuoteStatus } from '../../src/shared/types';

export const usd = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
export const num = (n: number | null | undefined, max = 4) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: max }));
export const pct = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
export const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');

export const STATUS_META: Record<string, { label: string; cls: string; help: string }> = {
  'real-time': { label: 'Real-time', cls: 'rt', help: 'Provider-confirmed real-time entitlement and a very recent trade timestamp.' },
  delayed: { label: 'Delayed', cls: 'dl', help: 'The provider declares this data is delayed.' },
  'end-of-day': { label: 'End of day', cls: 'eod', help: 'The last official close or last trade of the most recent session.' },
  stale: { label: 'Stale', cls: 'st', help: 'Older than the freshness limit, or taken from your imported file. Still the last valid price.' },
  unavailable: { label: 'Unavailable', cls: 'un', help: 'No usable price from the provider or the file.' },
  cash: { label: 'Cash', cls: 'ca', help: 'Cash and money-market balances come from your file.' },
  manual: { label: 'Manual', cls: 'ma', help: 'Valued by you, not by a market feed.' },
  synthetic: { label: 'Synthetic', cls: 'syn', help: 'Fabricated demo price, not market data.' },
};

export function PriceBadge({ h }: { h: HoldingView }) {
  const synth = h.source === 'synthetic';
  const m = STATUS_META[h.status];
  const label = synth ? 'Synthetic' : h.basis === 'imported' ? 'From file' : m.label;
  const cls = synth ? 'syn' : h.basis === 'imported' ? 'st' : m.cls;
  const suffix = !synth && h.status === 'real-time' && h.feed === 'iex' ? ' · IEX' : '';
  return <span className={`badge ${cls}`} title={synth ? 'Fabricated demo price, not market data.' : m.help}>{label}{suffix}</span>;
}
export function Dot({ s }: { s: QuoteStatus | 'cash' | 'manual' }) { return <i className={`dot ${STATUS_META[s].cls}`} />; }

import type { Meta, ProviderInfo } from '../api';
import { STATUS_META, ago, stamp } from '../ui';

function Provider({ p, title }: { p: ProviderInfo | null; title: string }) {
  if (!p) return <div className="prov"><h3>{title}</h3><p className="muted">Not configured.</p></div>;
  return <div className="prov"><h3>{title}</h3><p><b>{p.label}</b></p><dl>
    <dt>Coverage</dt><dd>{p.coverage}</dd><dt>Limits</dt><dd>{[p.rateLimitPerMin && `${p.rateLimitPerMin} requests/min`, p.dailyCallBudget && `${p.dailyCallBudget} calls/day budget`, p.maxStreamSymbols ? `${p.maxStreamSymbols} streamed symbols` : null].filter(Boolean).join(' · ') || 'n/a'}</dd>
    <dt>Licensing</dt><dd>{p.licensing}</dd><dt>Attribution</dt><dd>{p.attribution}</dd></dl>{p.notes.map((n, i) => <p key={i} className="muted">{n}</p>)}</div>;
}
export function StatusPage({ meta }: { meta: Meta }) {
  const h = meta.health;
  return (
    <>
      <section className="card"><h2>Market data</h2>
        <p>{meta.market.label}. {meta.market.state === 'closed' ? `Next open ${stamp(meta.market.nextOpenUtc)}.` : `Closes today per the exchange calendar.`}{!meta.market.calendarKnown && ' The holiday calendar does not cover this year; treat market status as approximate.'}</p>
        <div className="provs"><Provider p={meta.provider} title="Intraday prices" /><Provider p={meta.eodProvider} title="End-of-day fallback" /></div>
        {h && <p className={h.state === 'ok' ? 'msg ok' : h.state === 'idle' ? 'msg info' : 'msg err'}>Price service: {h.state}. Last success {ago(h.lastSuccessAt)}.{h.lastError && ` Last problem: ${h.lastError}`}{h.stream && ` Stream: ${h.stream.state}${h.stream.detail ? ` (${h.stream.detail})` : ''}, ${h.streamSymbols} symbols.`}{h.fmpCallsRemaining !== null && ` End-of-day calls left today: ${h.fmpCallsRemaining}.`}</p>}
        <p className="muted">Refreshing every {meta.refreshSeconds} seconds. A trade older than {meta.realtimeMaxAgeSec} seconds is not labelled real-time.</p>
        {meta.configNotes.map((n, i) => <p key={i} className="msg info">{n}</p>)}
      </section>
      <section className="card"><h2>What the price labels mean</h2>
        <dl className="defs">{(['real-time', 'delayed', 'end-of-day', 'stale', 'unavailable', 'manual'] as const).map((s) => <div key={s}><dt><span className={`badge ${STATUS_META[s].cls}`}>{STATUS_META[s].label}</span></dt><dd>{STATUS_META[s].help}</dd></div>)}</dl></section>
      <section className="card"><h2>Current limitations</h2><ul>{meta.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></section>
    </>
  );
}

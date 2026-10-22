import { Fragment, useMemo, useState } from 'react';
import { api } from '../api';
import type { HoldingView, PortfolioView } from '../../../src/shared/types';
import { PriceBadge, ago, num, pct, stamp, usd } from '../ui';

const ASSET = ['Equity', 'Fixed Income', 'Commodity', 'Cash', 'Real Estate', 'Alternative'];
const INSTR = ['Stock', 'ETF', 'Mutual fund', 'Money market fund', 'Cash', 'Option', 'Other'];
const SECTORS = ['Information Technology', 'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials', 'Health Care', 'Industrials', 'Materials', 'Real Estate', 'Utilities', 'Diversified', 'Precious Metals', 'Other'];
const GEO = ['United States', 'International ex-US', 'Global', 'Other'];

function Classify({ h, done }: { h: HoldingView; done: () => void }) {
  const [v, setV] = useState({ instrumentType: h.classification.instrumentType, assetClass: h.classification.assetClass, sector: h.classification.sector, geography: h.classification.geography });
  const sel = (k: keyof typeof v, opts: string[]) => (
    <label>{({ instrumentType: 'Instrument', assetClass: 'Asset class', sector: 'Sector', geography: 'Geography' })[k]}
      <select value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })}>{!opts.includes(v[k]) && <option>{v[k]}</option>}{opts.map((o) => <option key={o}>{o}</option>)}</select></label>);
  const save = async () => { await api(`/api/classification-overrides/${encodeURIComponent(h.symbol)}`, { method: 'PUT', json: v }); done(); };
  return <div className="classify">{sel('instrumentType', INSTR)}{sel('assetClass', ASSET)}{sel('sector', SECTORS)}{sel('geography', GEO)}
    <button onClick={save} disabled={Object.values(v).includes('Unclassified')}>Save classification</button>
    {h.classification.source === 'override' && <button className="ghost" onClick={async () => { await api(`/api/classification-overrides/${encodeURIComponent(h.symbol)}`, { method: 'DELETE' }); done(); }}>Remove override</button>}</div>;
}

export function Holdings({ pf, reload }: { pf: PortfolioView; reload: () => Promise<void> }) {
  const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null); const [status, setStatus] = useState('all');
  const rows = useMemo(() => pf.holdings.filter((h) => (status === 'all' || h.status === status || (status === 'imported' && h.basis === 'imported'))
    && (h.symbol + h.description + h.classification.sector).toLowerCase().includes(q.toLowerCase())), [pf, q, status]);
  const now = Date.now();
  if (!pf.holdings.length) return <section className="empty"><h2>No holdings to show</h2><p>Import a file first.</p></section>;
  return (
    <section className="card">
      <div className="tools"><input placeholder="Search symbol, name or sector" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search holdings" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by price status">
          <option value="all">All prices</option><option value="real-time">Real-time</option><option value="delayed">Delayed</option><option value="end-of-day">End of day</option>
          <option value="stale">Stale</option><option value="imported">From file</option><option value="unavailable">Unavailable</option><option value="manual">Manual</option></select>
        <span className="muted">{rows.length} of {pf.holdings.length}</span></div>
      <div className="scroll"><table className="grid">
        <thead><tr><th>Holding</th><th className="r">Quantity</th><th className="r">Price</th><th className="r">Value</th><th className="r">Weight</th><th className="r">Gain</th><th>Price status</th><th>Quote time</th></tr></thead>
        <tbody>{rows.map((h) => (
          <Fragment key={h.symbol}>
            <tr className={open === h.symbol ? 'open' : ''} onClick={() => setOpen(open === h.symbol ? null : h.symbol)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === h.symbol ? null : h.symbol)}>
              <td><b>{h.symbol.replace('MANUAL:', '')}</b><span className="desc">{h.description}</span>
                <span className="tags">{h.classification.sector}{h.classification.sector === 'Unclassified' && <em className="needs"> · needs classification</em>}</span></td>
              <td className="r">{num(h.quantity)}</td><td className="r">{usd(h.price)}</td><td className="r"><b>{usd(h.value)}</b></td><td className="r">{pct(h.weightPct)}</td>
              <td className={`r ${h.gain !== null && h.gain < 0 ? 'neg' : ''}`}>{h.gain === null ? '—' : usd(h.gain, 0)}</td>
              <td><PriceBadge h={h} /></td>
              <td className="qt" title={h.quoteTs ? `Quote: ${stamp(h.quoteTs)}${h.retrievedTs ? `\nRetrieved: ${stamp(h.retrievedTs)}` : ''}` : ''}>{h.status === 'cash' ? 'file' : ago(h.quoteTs, now)}<span className="muted"> {h.source}</span></td>
            </tr>
            {open === h.symbol && <tr className="detail"><td colSpan={8}>
              <div className="lots"><b>Where it is held</b>{h.lots.map((l, i) => <span key={i}>{l.accountName}{l.subType !== 'standard' ? ` (${l.subType})` : ''}: {num(l.quantity)} · {usd(l.value)}</span>)}</div>
              <p className="muted">Classification source: {h.classification.source}. Quote {stamp(h.quoteTs)}{h.retrievedTs ? `, retrieved ${stamp(h.retrievedTs)}` : ''}{h.feed ? `, feed ${h.feed}` : ''}.</p>
              {h.status !== 'manual' && h.status !== 'cash' && <Classify h={h} done={reload} />}
            </td></tr>}
          </Fragment>))}</tbody></table></div>
    </section>
  );
}

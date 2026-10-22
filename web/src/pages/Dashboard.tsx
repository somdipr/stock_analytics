import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { Meta, PortfolioView } from '../api';
import { STATUS_META, ago, pct, usd } from '../ui';

const DIMS = [['assetClass', 'Asset class'], ['sector', 'Sector'], ['geography', 'Geography'], ['instrumentType', 'Instrument'], ['account', 'Account']] as const;
const PALETTE = ['#0d6e6e', '#2f5d9e', '#b4541a', '#7a5ea8', '#4d8f3a', '#a8782a', '#8a3f5b', '#4f6b7a', '#9c9c3a', '#5a5a5a'];
const ORDER = ['real-time', 'delayed', 'end-of-day', 'stale', 'unavailable', 'cash', 'manual', 'synthetic'] as const;
const kindOf = (h: PortfolioView['holdings'][number]) => (h.source === 'synthetic' ? 'synthetic' : h.status);

export function Dashboard({ pf, meta, go }: { pf: PortfolioView; meta: Meta; go: (t: any) => void }) {
  const [dim, setDim] = useState<(typeof DIMS)[number][0]>('assetClass');
  if (!pf.holdings.length) return (
    <section className="empty"><h2>No holdings yet</h2><p>Import a CSV or Excel export from your brokerage to build your portfolio. You can review and correct every row before anything is saved.</p>
      <button onClick={() => go('import')}>Import files</button></section>);
  const slices = pf.allocation[dim];
  // How much of the total value rests on each kind of price: the thing to check before trusting a number.
  const byStatus = ORDER.map((s) => { const hs = pf.holdings.filter((h) => kindOf(h) === s); return { s, v: hs.reduce((a, h) => a + h.value, 0), n: hs.length }; }).filter((x) => x.n > 0);
  const warns = pf.warnings.filter((w) => w.severity !== 'info'); const infos = pf.warnings.filter((w) => w.severity === 'info');
  return (
    <>
      <section className="hero">
        <div><p className="lbl">Total portfolio value</p><p className="big">{usd(pf.totalValue)}</p>
          <p className="sub">{usd(pf.investedValue, 0)} invested · {usd(pf.cashValue, 0)} cash{pf.unrealizedGain !== null && <> · unrealized {pf.unrealizedGain >= 0 ? '+' : ''}{usd(pf.unrealizedGain, 0)}</>}</p></div>
        <div className="mkt"><p className="lbl">{meta.market.label}</p><p className="sub">{meta.health?.lastSuccessAt ? `Prices updated ${ago(meta.health.lastSuccessAt)}` : meta.provider ? 'Waiting for first price update' : 'No price provider configured'}</p></div>
      </section>

      <section className="trust" aria-label="How current the prices behind this total are">
        <div className="bar" role="img" aria-label={byStatus.map((x) => `${STATUS_META[x.s].label} ${pct((x.v / pf.totalValue) * 100)}`).join(', ')}>
          {byStatus.map((x) => <span key={x.s} className={STATUS_META[x.s].cls} style={{ flexGrow: Math.max(x.v, pf.totalValue * 0.01) }} title={`${STATUS_META[x.s].label}: ${usd(x.v, 0)}`} />)}
        </div>
        <ul className="legend">{byStatus.map((x) => <li key={x.s}><i className={`dot ${STATUS_META[x.s].cls}`} />{STATUS_META[x.s].label} <b>{pct((x.v / pf.totalValue) * 100)}</b> <span className="muted">({x.n})</span></li>)}</ul>
      </section>

      <section className="card">
        <div className="seg" role="tablist" aria-label="Allocation view">{DIMS.map(([id, label]) => <button key={id} role="tab" aria-selected={dim === id} className={dim === id ? 'on' : ''} onClick={() => setDim(id)}>{label}</button>)}</div>
        <div className="alloc">
          <div className="donut"><ResponsiveContainer width="100%" height={240}><PieChart>
            <Pie data={slices} dataKey="value" nameKey="key" innerRadius={68} outerRadius={105} paddingAngle={1} stroke="none" isAnimationActive={false}>{slices.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie>
            <Tooltip formatter={(v) => usd(Number(v), 0)} /></PieChart></ResponsiveContainer></div>
          <table className="slim"><tbody>{slices.map((s, i) => (
            <tr key={s.key}><td><i className="dot" style={{ background: PALETTE[i % PALETTE.length] }} />{s.key}</td><td className="r">{usd(s.value, 0)}</td><td className="r w">{pct(s.pct)}</td>
              <td className="meter"><span style={{ width: `${Math.min(100, s.pct)}%`, background: PALETTE[i % PALETTE.length] }} /></td></tr>))}</tbody></table>
        </div>
      </section>

      <section className="card">
        <h2>Data-quality warnings <span className="muted">{warns.length}</span></h2>
        {warns.length === 0 ? <p className="muted">Nothing needs attention.</p> : <ul className="warns">{warns.map((w, i) => <li key={i} className={w.severity}>{w.message}</li>)}</ul>}
        {infos.length > 0 && <ul className="warns info">{infos.map((w, i) => <li key={i}>{w.message}</li>)}</ul>}
        {warns.some((w) => w.code === 'unclassified') && <button className="ghost" onClick={() => go('holdings')}>Classify holdings</button>}
      </section>
    </>
  );
}

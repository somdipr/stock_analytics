import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { usd } from '../ui';

const CATS: [string, string][] = [['physical-gold', 'Physical gold'], ['physical-silver', 'Physical silver'], ['real-estate', 'Real estate'], ['other', 'Other asset']];
interface MA { id: string; name: string; category: string; value: string; valued_at: string; notes: string }
export function ManualPage({ reload }: { reload: () => Promise<void> }) {
  const [items, setItems] = useState<MA[]>([]); const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', category: 'physical-gold', value: '', valuedAt: new Date().toISOString().slice(0, 10), notes: '' });
  const load = useCallback(async () => setItems(await api<MA[]>('/api/manual-assets')), []);
  useEffect(() => { void load(); }, [load]);
  const add = async () => {
    try { await api('/api/manual-assets', { json: f }); setF({ ...f, name: '', value: '', notes: '' }); setErr(null); await load(); await reload(); }
    catch (e) { const x = e as ApiError; setErr(x.body?.issues?.map((i: any) => i.message).join(', ') ?? x.message); }
  };
  return (
    <>
      <section className="card"><h2>Add a manually valued asset</h2>
        <p className="muted">For things without a market price, such as physical gold or silver, real estate or private holdings. Enter your own estimate and the date you made it; the app flags valuations older than 90 days.</p>
        <div className="form">
          <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Gold coins in safe" /></label>
          <label>Type<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>Value (USD)<input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} placeholder="12500.00" /></label>
          <label>Valued on<input type="date" value={f.valuedAt} onChange={(e) => setF({ ...f, valuedAt: e.target.value })} /></label>
          <label className="full">Notes<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="How you arrived at this value" /></label>
          <button onClick={add} disabled={!f.name || !f.value}>Add asset</button></div>
        {err && <p className="msg err" role="alert">{err}</p>}
      </section>
      <section className="card"><h2>Manual assets</h2>
        {items.length === 0 ? <p className="muted">None yet.</p> : <table className="grid"><thead><tr><th>Name</th><th>Type</th><th className="r">Value</th><th>Valued on</th><th /></tr></thead>
          <tbody>{items.map((m) => <tr key={m.id}><td><b>{m.name}</b><span className="desc">{m.notes}</span></td><td>{CATS.find(([v]) => v === m.category)?.[1]}</td><td className="r">{usd(Number(m.value))}</td>
            <td>{m.valued_at.slice(0, 10)}</td><td><button className="ghost" onClick={async () => { await api(`/api/manual-assets/${m.id}`, { method: 'DELETE' }); await load(); await reload(); }}>Remove</button></td></tr>)}</tbody></table>}
      </section>
    </>
  );
}

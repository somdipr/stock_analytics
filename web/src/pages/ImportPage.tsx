import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { num } from '../ui';

interface Row { id: string; accountKey: string; symbol: string; description: string; subType: string; quantity: string | null; filePrice: string | null; fileValue: string | null; costBasis: string | null; isCash: boolean; included: boolean; warnings: string[] }
interface Batch { id: string; filename: string; format: string; asOf: string; accounts: { key: string; name: string; mask: string | null }[]; rows: Row[]; warnings: string[]; overlapWarnings: string[] }
const FORMATS: Record<string, string> = { 'single-account-positions': 'Single-account positions export', 'multi-account-positions': 'Multi-account positions export', 'generic-mapped': 'Generic table (columns matched by name)' };

function Cell({ row, field, batch, onBatch }: { row: Row; field: 'symbol' | 'description' | 'subType' | 'quantity' | 'filePrice' | 'fileValue' | 'costBasis'; batch: Batch; onBatch: (b: Batch) => void }) {
  const [v, setV] = useState(String(row[field] ?? '')); useEffect(() => setV(String(row[field] ?? '')), [row, field]);
  const commit = async () => { if (v === String(row[field] ?? '')) return; onBatch(await api<Batch>(`/api/imports/staged/${batch.id}/rows/${row.id}`, { method: 'PATCH', json: { [field]: v } })); };
  return <input className={field === 'description' ? 'wide' : field === 'symbol' ? 'sym' : 'numin'} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={`${field} for ${row.symbol}`} />;
}

export function ImportPage({ reload }: { reload: () => Promise<void> }) {
  const [batches, setBatches] = useState<Batch[]>([]); const [msgs, setMsgs] = useState<{ kind: 'ok' | 'err' | 'info'; text: string }[]>([]);
  const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null); const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const refresh = useCallback(async () => { setBatches(await api<Batch[]>('/api/imports/staged')); setAccounts(await api('/api/accounts')); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const say = (kind: 'ok' | 'err' | 'info', text: string) => setMsgs((m) => [...m, { kind, text }]);
  const swap = (b: Batch) => setBatches((all) => all.map((x) => (x.id === b.id ? b : x)));

  const upload = async (files: FileList | File[]) => {
    setBusy(true); setMsgs([]); const fd = new FormData(); [...files].forEach((f) => fd.append('files', f));
    try {
      const { results } = await api<{ results: any[] }>('/api/imports/stage', { method: 'POST', body: fd });
      for (const r of results) if (!r.ok) say(r.code === 'duplicate_file' ? 'info' : 'err', `${r.filename}: ${r.error}`);
      await refresh();
    } catch (e) { say('err', (e as Error).message); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const commit = async (b: Batch) => {
    try {
      const r = await api<any>(`/api/imports/staged/${b.id}/commit`, { method: 'POST' });
      say('ok', `${b.filename}: imported ${r.rowsImported} rows into ${r.accounts.map((a: any) => a.name).join(', ')}.`); r.warnings.filter((w: string) => /replaced|older/.test(w)).forEach((w: string) => say('info', w));
      await refresh(); await reload();
    } catch (e) { const err = e as ApiError; say('err', err.body?.problems ? `${b.filename}: ${err.body.problems.join(' · ')}` : err.message); }
  };
  const discard = async (b: Batch) => { await api(`/api/imports/staged/${b.id}`, { method: 'DELETE' }); await refresh(); };

  return (
    <>
      <section className="card drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        <h2>Import portfolio files</h2><p className="muted">Add one or more CSV or Excel (.xlsx) exports. Nothing is saved until you review the rows and import them.</p>
        <input ref={input} type="file" multiple accept=".csv,.xlsx" hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
        <button onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Reading files…' : 'Choose files'}</button><span className="muted"> or drop them here</span>
        {msgs.map((m, i) => <p key={i} className={`msg ${m.kind}`} role={m.kind === 'err' ? 'alert' : 'status'}>{m.text}</p>)}
      </section>
      {batches.map((b) => {
        const inc = b.rows.filter((r) => r.included).length; const warnRows = b.rows.filter((r) => r.included && r.warnings.length).length;
        return (
          <section className="card" key={b.id}>
            <div className="bh"><div><h2>{b.filename}</h2><p className="muted">{FORMATS[b.format]} · snapshot {new Date(b.asOf).toLocaleString()} · {b.rows.length} rows</p></div>
              <div className="acts"><button onClick={() => commit(b)}>Import {inc} rows</button><button className="ghost" onClick={() => discard(b)}>Discard</button></div></div>
            {[...b.warnings, ...b.overlapWarnings].map((w, i) => <p key={i} className="msg info">{w}</p>)}
            {warnRows > 0 && <p className="msg info">{warnRows} row(s) have warnings. Fix the values below, or untick rows you do not want.</p>}
            <div className="accts">{b.accounts.map((a) => (
              <label key={a.key}>Account {a.mask ? `…${a.mask}` : ''}
                <input defaultValue={a.name} onBlur={async (e) => e.target.value !== a.name && swap(await api<Batch>(`/api/imports/staged/${b.id}/accounts/${encodeURIComponent(a.key)}`, { method: 'PATCH', json: { name: e.target.value } }))} />
                {accounts.length > 0 && <select defaultValue="" onChange={async (e) => e.target.value && (swap(await api<Batch>(`/api/imports/staged/${b.id}/accounts/${encodeURIComponent(a.key)}`, { method: 'PATCH', json: { mapTo: e.target.value } })), void refresh())} aria-label="Same as an existing account">
                  <option value="">Same as existing account…</option>{accounts.filter((x) => x.id !== a.key).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
              </label>))}</div>
            <div className="scroll"><table className="grid edit"><thead><tr><th>Use</th><th>Account</th><th>Symbol</th><th>Description</th><th>Type</th><th className="r">Quantity</th><th className="r">Price</th><th className="r">Value</th><th className="r">Cost basis</th></tr></thead>
              <tbody>{b.rows.map((r) => (
                <tr key={r.id} className={!r.included ? 'off' : r.warnings.length ? 'warn' : ''}>
                  <td><input type="checkbox" checked={r.included} aria-label={`Include ${r.symbol}`} onChange={async (e) => swap(await api<Batch>(`/api/imports/staged/${b.id}/rows/${r.id}`, { method: 'PATCH', json: { included: e.target.checked } }))} /></td>
                  <td className="muted">{b.accounts.find((a) => a.key === r.accountKey)?.name}</td>
                  <td><Cell row={r} field="symbol" batch={b} onBatch={swap} />{r.isCash && <small className="muted"> cash</small>}</td>
                  <td><Cell row={r} field="description" batch={b} onBatch={swap} /></td><td><Cell row={r} field="subType" batch={b} onBatch={swap} /></td>
                  <td className="r">{r.isCash ? '—' : <Cell row={r} field="quantity" batch={b} onBatch={swap} />}</td><td className="r"><Cell row={r} field="filePrice" batch={b} onBatch={swap} /></td>
                  <td className="r"><Cell row={r} field="fileValue" batch={b} onBatch={swap} /></td><td className="r"><Cell row={r} field="costBasis" batch={b} onBatch={swap} /></td>
                  {r.warnings.length > 0 && <td className="rw">{r.warnings.map((w, i) => <span key={i}>{w}</span>)}</td>}
                </tr>))}</tbody></table></div>
            <p className="muted">Total of included rows' file values: {num(b.rows.filter((r) => r.included && r.fileValue).reduce((s, r) => s + Number(r.fileValue), 0), 2)}</p>
          </section>);
      })}
    </>
  );
}

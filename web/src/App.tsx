import { useCallback, useEffect, useState } from 'react';
import { api, Meta, PortfolioView } from './api';
import { Dashboard } from './pages/Dashboard';
import { Holdings } from './pages/Holdings';
import { ImportPage } from './pages/ImportPage';
import { ManualPage } from './pages/ManualPage';
import { StatusPage } from './pages/StatusPage';

const TABS = [['dashboard', 'Overview'], ['holdings', 'Holdings'], ['import', 'Import'], ['manual', 'Manual assets'], ['status', 'Data & limits']] as const;
type Tab = (typeof TABS)[number][0];

export function App() {
  const [tab, setTab] = useState<Tab>((location.hash.slice(1) as Tab) || 'dashboard');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [pf, setPf] = useState<PortfolioView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const [m, p] = await Promise.all([api<Meta>('/api/meta'), api<PortfolioView>('/api/portfolio')]); setMeta(m); setPf(p); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const es = new EventSource('/api/events'); es.addEventListener('prices', () => void load()); return () => es.close(); }, [load]);
  useEffect(() => { location.hash = tab; }, [tab]);

  return (
    <div className={meta?.mode === 'demo' ? 'app demo' : 'app'}>
      {meta?.banner && <div className="banner" role="status">{meta.banner}</div>}
      <header className="top">
        <h1>PortfolioPilot</h1>
        <nav aria-label="Sections">{TABS.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} aria-current={tab === id}>{label}</button>)}</nav>
        <button className="ghost" onClick={() => void api('/api/prices/refresh', { method: 'POST' }).then(load)} title="Fetch prices now">Refresh prices</button>
      </header>
      {error && <p className="err" role="alert">Can’t reach the PortfolioPilot server: {error}</p>}
      <main>
        {!pf || !meta ? <p className="muted">Loading…</p> : <>
          {tab === 'dashboard' && <Dashboard pf={pf} meta={meta} go={setTab} />}
          {tab === 'holdings' && <Holdings pf={pf} reload={load} />}
          {tab === 'import' && <ImportPage reload={load} />}
          {tab === 'manual' && <ManualPage reload={load} />}
          {tab === 'status' && <StatusPage meta={meta} />}
        </>}
      </main>
    </div>
  );
}

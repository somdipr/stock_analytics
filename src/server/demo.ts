import { Db } from './db.js';
import { commitStaged, stageFile } from './imports.js';
import { SyntheticProvider } from './providers/synthetic.js';
import { randomUUID } from 'node:crypto';

/** Synthetic accounts for demo mode only. Every name says "synthetic"; quantities and prices are fabricated. */
export async function seedDemo(db: Db) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM positions').get() as any).n) return;
  const synth = new SyntheticProvider('demo'); const at = new Date();
  const hold: Record<string, [string, string, number][]> = {
    'DEMO Brokerage (synthetic) 0001': [['AAPL', 'APPLE INC', 40], ['MSFT', 'MICROSOFT CORP', 25], ['XOM', 'EXXON MOBIL CORP', 60], ['SCHD', 'SCHWAB US DIVIDEND EQUITY ETF', 300], ['VXUS', 'VANGUARD TOTAL INTL STOCK ETF', 150], ['GLD', 'SPDR GOLD SHARES', 20]],
    'DEMO Roth IRA (synthetic) 0002': [['SCHD', 'SCHWAB US DIVIDEND EQUITY ETF', 120], ['VXUS', 'VANGUARD TOTAL INTL STOCK ETF', 80], ['NVDA', 'NVIDIA CORP', 15], ['XLU', 'UTILITIES SELECT SECTOR SPDR', 50]],
  };
  let n = 0;
  for (const [acct, rows] of Object.entries(hold)) {
    const lines = ['Account number,Account name,Symbol,Description,Quantity,Last price,Current value,Cost basis total,Type'];
    for (const [sym, desc, qty] of rows) {
      const px = synth.price(sym, at);
      lines.push(`DEMO${acct.slice(-4)},${acct},${sym},${desc},${qty},$${px},$${(px * qty).toFixed(2)},$${(px * qty * 0.8).toFixed(2)},Cash`);
    }
    lines.push(`DEMO${acct.slice(-4)},${acct},SPAXX**,HELD IN MONEY MARKET,,,$2500.00,,Cash`);
    lines.push('', `"SYNTHETIC DEMO DATA - not a real account"`, `Date downloaded ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][at.getUTCMonth()]}-${String(at.getUTCDate()).padStart(2, '0')}-${at.getUTCFullYear()} 09:00 a.m ET`);
    // vary content so each demo file has its own hash
    lines.push(`# demo-file-${randomUUID()}`);
    const staged = await stageFile(db, `demo-${++n}-synthetic.csv`, Buffer.from(lines.join('\n')));
    commitStaged(db, staged.id);
  }
  const ins = db.prepare('INSERT INTO manual_assets(id,name,category,value,currency,valued_at,notes,geography,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const iso = at.toISOString();
  ins.run(randomUUID(), 'DEMO gold coins (synthetic)', 'physical-gold', '12500', 'USD', iso, 'Synthetic example of a manually valued asset', 'United States', iso);
  ins.run(randomUUID(), 'DEMO rental property (synthetic)', 'real-estate', '240000', 'USD', iso, 'Synthetic example; owner estimate', 'United States', iso);
}

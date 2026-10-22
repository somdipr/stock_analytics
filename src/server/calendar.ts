/** US equity market sessions (NYSE/Nasdaq) in America/New_York. Holiday tables must be reviewed yearly. */
export type MarketState = 'open' | 'pre-market' | 'after-hours' | 'closed';
export interface MarketStatus {
  state: MarketState; label: string; lastCloseUtc: string; nextOpenUtc: string; calendarKnown: boolean;
}

const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']); // 1:00 pm ET
const KNOWN_YEARS = new Set([2026, 2027]);

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function etParts(ms: number) {
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
function etOffsetMin(utcMs: number): number {
  const p = etParts(utcMs);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 60000;
}
export function etToUtc(y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = etOffsetMin(guess);
  let utc = guess - off * 60000;
  const off2 = etOffsetMin(utc);
  if (off2 !== off) utc = guess - off2 * 60000;
  return utc;
}
const ds = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function isTradingDay(y: number, m: number, d: number): boolean {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(ds(y, m, d));
}
interface Session { openUtc: number; closeUtc: number; preUtc: number; postEndUtc: number }
function sessionFor(y: number, m: number, d: number): Session {
  const early = EARLY_CLOSE.has(ds(y, m, d));
  return {
    preUtc: etToUtc(y, m, d, 4, 0), openUtc: etToUtc(y, m, d, 9, 30),
    closeUtc: etToUtc(y, m, d, early ? 13 : 16, 0), postEndUtc: etToUtc(y, m, d, early ? 17 : 20, 0),
  };
}
function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function marketStatus(now: Date): MarketStatus {
  const nowMs = now.getTime();
  const p = etParts(nowMs);
  let state: MarketState = 'closed';
  if (isTradingDay(p.year, p.month, p.day)) {
    const s = sessionFor(p.year, p.month, p.day);
    if (nowMs >= s.openUtc && nowMs < s.closeUtc) state = 'open';
    else if (nowMs >= s.preUtc && nowMs < s.openUtc) state = 'pre-market';
    else if (nowMs >= s.closeUtc && nowMs < s.postEndUtc) state = 'after-hours';
  }
  // last regular close at or before now; next regular open after now
  let lastClose = 0, nextOpen = 0;
  for (let i = 0; i > -10 && !lastClose; i--) {
    const a = addDays(p.year, p.month, p.day, i);
    if (isTradingDay(a.y, a.m, a.d)) { const c = sessionFor(a.y, a.m, a.d).closeUtc; if (c <= nowMs) lastClose = c; }
  }
  for (let i = 0; i < 10 && !nextOpen; i++) {
    const a = addDays(p.year, p.month, p.day, i);
    if (isTradingDay(a.y, a.m, a.d)) { const o = sessionFor(a.y, a.m, a.d).openUtc; if (o > nowMs) nextOpen = o; }
  }
  const labels: Record<MarketState, string> = { open: 'Market open', 'pre-market': 'Pre-market', 'after-hours': 'After hours', closed: 'Market closed' };
  return {
    state, label: labels[state], lastCloseUtc: new Date(lastClose).toISOString(), nextOpenUtc: new Date(nextOpen).toISOString(),
    calendarKnown: KNOWN_YEARS.has(p.year),
  };
}

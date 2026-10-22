import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { Decimal, D, isAbsent, parseMoney } from '../money.js';
import { etToUtc } from '../calendar.js';
import { ParsedFile, StagedAccount, StagedRow, UnrecognizedFormatError } from './types.js';
export * from './types.js';

type Table = string[][];
const clean = (s: unknown) => String(s ?? '').replace(/^\uFEFF/, '').trim();
const blankRow = (r: string[]) => r.every((c) => clean(c) === '');
/** Remove "(alias)" suffixes and punctuation so "Qty (Quantity)" and "Quantity" both become "qty"/"quantity". */
const norm = (h: string) => clean(h).replace(/\(.*\)/, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();

export function readCsv(text: string): Table {
  return Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: false }).data.map((r) => r.map(clean));
}
export async function readXlsx(buf: Buffer): Promise<Table[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const t: Table = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(clean(row.getCell(c).text));
      t.push(cells);
    });
    return t;
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const monthIdx: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function normalizeSymbol(raw: string): string { return clean(raw).replace(/\*+$/, '').toUpperCase(); }
const MM_PATTERN = /^[A-Z]{4}X{1,2}$/;
export function looksLikeCash(symbol: string, description: string, assetType = ''): boolean {
  return /money market|cash/i.test(description) || /cash and money market/i.test(assetType) || MM_PATTERN.test(symbol) || symbol === 'CASH';
}
const num = (raw: string | undefined): string | null => {
  if (raw === undefined || isAbsent(raw)) return null;
  const d = parseMoney(raw);
  return d ? d.toFixed() : null;
};

/** Attach per-row sanity warnings shared by all formats and by the review screen. */
export function validateRow(r: StagedRow): string[] {
  const w: string[] = [];
  if (!r.isCash) {
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(r.symbol)) w.push(`Symbol "${r.symbol}" looks unusual`);
    const q = r.quantity === null ? null : D(r.quantity);
    if (q === null) w.push('Quantity is missing');
    else if (q.lte(0)) w.push('Quantity is zero or negative');
    if (q && r.filePrice && r.fileValue) {
      const implied = q.mul(r.filePrice), actual = D(r.fileValue);
      if (!actual.isZero() && implied.minus(actual).abs().div(actual.abs()).gt(0.01))
        w.push('File value differs from quantity x price by more than 1%');
    }
    if (r.costBasis === null) w.push('No cost basis in file');
  } else if (r.fileValue === null) w.push('Cash row has no value');
  return w;
}

function mkRow(i: number, p: Partial<StagedRow> & { accountKey: string; symbol: string }): StagedRow {
  const row: StagedRow = {
    id: `r${i}`, description: '', subType: 'standard', quantity: null, filePrice: null, fileValue: null, costBasis: null,
    sourceAssetType: '', isCash: false, included: true, warnings: [], rowIndex: i, ...p,
  };
  row.warnings = validateRow(row);
  return row;
}

/** Find the header row by a predicate, returning its index and a column lookup. */
function headerMap(table: Table, from: number, test: (n: string[]) => boolean) {
  for (let i = from; i < Math.min(table.length, from + 15); i++) {
    const names = table[i].map(norm);
    if (test(names)) return { index: i, col: (...opts: string[]) => names.findIndex((n) => opts.includes(n)) };
  }
  return null;
}

function parseSingleAccount(table: Table): ParsedFile | null {
  const m = /^Positions for account (.+?) \.\.\.(\w+) as of (\d{1,2}):(\d{2})\s*(AM|PM) ET,\s*(\d{4})\/(\d{2})\/(\d{2})/i.exec(clean(table[0]?.[0]));
  if (!m) return null;
  const [, name, mask, hh, mm, ap, y, mo, d] = m;
  let h = Number(hh) % 12; if (/pm/i.test(ap)) h += 12;
  const asOf = new Date(etToUtc(Number(y), Number(mo), Number(d), h, Number(mm))).toISOString();
  const hm = headerMap(table, 1, (n) => n[0] === 'symbol' && n.includes('qty'));
  if (!hm) throw new UnrecognizedFormatError('Found an account title line but no Symbol/Qty header row');
  const c = { sym: hm.col('symbol'), desc: hm.col('description'), qty: hm.col('qty'), price: hm.col('price'),
    val: hm.col('mkt val'), cost: hm.col('cost basis'), type: hm.col('asset type') };
  const acct: StagedAccount = { key: `acct:${slug(name)}:${mask}`, name: name.trim(), mask };
  const rows: StagedRow[] = []; const totals: ParsedFile['statedTotals'] = []; const warnings: string[] = [];
  for (let i = hm.index + 1; i < table.length; i++) {
    const r = table[i]; if (blankRow(r)) continue;
    const sym = clean(r[c.sym]);
    if (/^positions total$/i.test(sym)) { const v = num(r[c.val]); if (v) totals.push({ accountKey: acct.key, value: v }); continue; }
    if (/^cash & cash investments$/i.test(sym)) {
      rows.push(mkRow(i, { accountKey: acct.key, symbol: 'CASH', description: 'Cash & cash investments', isCash: true,
        fileValue: num(r[c.val]), sourceAssetType: clean(r[c.type]) })); continue;
    }
    if (!sym) continue;
    const symbol = normalizeSymbol(sym); const description = clean(r[c.desc]);
    const type = clean(r[c.type]);
    rows.push(mkRow(i, { accountKey: acct.key, symbol, description, quantity: num(r[c.qty]), filePrice: num(r[c.price]),
      fileValue: num(r[c.val]), costBasis: num(r[c.cost]), sourceAssetType: type, isCash: looksLikeCash(symbol, description, type) }));
  }
  return { format: 'single-account-positions', asOf, accounts: [acct], rows, statedTotals: totals, warnings };
}

function parseMultiAccount(table: Table): ParsedFile | null {
  const hm = headerMap(table, 0, (n) => n.includes('account number') && n.includes('symbol') && n.includes('quantity'));
  if (!hm) return null;
  const c = { acct: hm.col('account number'), name: hm.col('account name'), sym: hm.col('symbol'), desc: hm.col('description'),
    qty: hm.col('quantity'), price: hm.col('last price'), val: hm.col('current value'), cost: hm.col('cost basis total'), type: hm.col('type') };
  const accounts = new Map<string, StagedAccount>(); const rows: StagedRow[] = []; const warnings: string[] = [];
  let end = table.length;
  for (let i = hm.index + 1; i < table.length; i++) if (blankRow(table[i])) { end = i; break; }
  for (let i = hm.index + 1; i < end; i++) {
    const r = table[i]; const acctNo = clean(r[c.acct]); const sym = clean(r[c.sym]);
    if (!acctNo || !sym) continue;
    // The raw account number is never stored: a hash is the key, the last 4 characters are the display mask.
    const key = `acct:${createHash('sha256').update(acctNo).digest('hex').slice(0, 12)}`;
    if (!accounts.has(key)) accounts.set(key, { key, name: clean(r[c.name]) || 'Account', mask: acctNo.slice(-4) });
    const symbol = normalizeSymbol(sym); const description = clean(r[c.desc]);
    if (/\s/.test(symbol) && num(r[c.qty]) === null) {
      warnings.push(`Skipped non-position row "${sym}"${num(r[c.val]) ? ' that carries a value; check it is not missing from your totals' : ''}`); continue;
    }
    const isCash = looksLikeCash(symbol, description);
    rows.push(mkRow(i, { accountKey: key, symbol: isCash && !MM_PATTERN.test(symbol) ? symbol : symbol, description,
      subType: clean(r[c.type]).toLowerCase() || 'standard', quantity: isCash ? null : num(r[c.qty]),
      filePrice: num(r[c.price]), fileValue: num(r[c.val]), costBasis: num(r[c.cost]), isCash }));
  }
  let asOf = new Date().toISOString(); let found = false;
  for (const r of table.slice(end)) {
    const m = /Date downloaded\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap])\.?m/i.exec(clean(r[0]));
    if (m) { let h = Number(m[4]) % 12; if (/p/i.test(m[6])) h += 12;
      asOf = new Date(etToUtc(Number(m[3]), monthIdx[m[1].toLowerCase()], Number(m[2]), h, Number(m[5]))).toISOString(); found = true; break; }
  }
  if (!found) warnings.push('No "Date downloaded" line found; using the import time as the snapshot date');
  return { format: 'multi-account-positions', asOf, accounts: [...accounts.values()], rows, statedTotals: [], warnings };
}

const SYN: Record<string, string[]> = {
  symbol: ['symbol', 'ticker'], description: ['description', 'name', 'security', 'security name'],
  quantity: ['quantity', 'qty', 'shares', 'units'], price: ['price', 'last price', 'last'],
  value: ['value', 'market value', 'mkt val', 'current value'], cost: ['cost basis', 'cost basis total', 'cost'],
  account: ['account', 'account name', 'account number'], type: ['asset type', 'type', 'asset class'],
};
function parseGeneric(table: Table, fallbackAccount: string): ParsedFile | null {
  const hm = headerMap(table, 0, (n) => SYN.symbol.some((s) => n.includes(s)) && SYN.quantity.some((s) => n.includes(s)));
  if (!hm) return null;
  const col = (k: string) => hm.col(...SYN[k]);
  const c = { sym: col('symbol'), desc: col('description'), qty: col('quantity'), price: col('price'), val: col('value'),
    cost: col('cost'), acct: col('account'), type: col('type') };
  const accounts = new Map<string, StagedAccount>(); const rows: StagedRow[] = [];
  for (let i = hm.index + 1; i < table.length; i++) {
    const r = table[i]; if (blankRow(r) || !clean(r[c.sym])) continue;
    const name = c.acct >= 0 && clean(r[c.acct]) ? clean(r[c.acct]) : fallbackAccount;
    const key = `acct:${slug(name)}`; if (!accounts.has(key)) accounts.set(key, { key, name, mask: null });
    const symbol = normalizeSymbol(r[c.sym]); const description = c.desc >= 0 ? clean(r[c.desc]) : '';
    rows.push(mkRow(i, { accountKey: key, symbol, description, quantity: num(r[c.qty]), filePrice: c.price >= 0 ? num(r[c.price]) : null,
      fileValue: c.val >= 0 ? num(r[c.val]) : null, costBasis: c.cost >= 0 ? num(r[c.cost]) : null,
      sourceAssetType: c.type >= 0 ? clean(r[c.type]) : '', isCash: looksLikeCash(symbol, description) }));
  }
  return { format: 'generic-mapped', asOf: new Date().toISOString(), accounts: [...accounts.values()], rows, statedTotals: [],
    warnings: ['Columns were matched by name. Review every row before importing; no snapshot date was found, so the import time is used.'] };
}

/** Compare each account's stated total (when the file has one) to the sum of its rows. */
export function reconcileStated(p: ParsedFile): string[] {
  const out: string[] = [];
  for (const t of p.statedTotals) {
    const sum = p.rows.filter((r) => r.accountKey === t.accountKey && r.fileValue !== null).reduce((a, r) => a.plus(r.fileValue!), new Decimal(0));
    if (sum.minus(t.value).abs().gt(0.01)) out.push(`Rows sum to ${sum.toFixed(2)} but the file states a total of ${D(t.value).toFixed(2)}`);
  }
  return out;
}

export function parseTable(table: Table, fallbackAccount: string): ParsedFile {
  const parsed = parseSingleAccount(table) ?? parseMultiAccount(table) ?? parseGeneric(table, fallbackAccount);
  if (!parsed) throw new UnrecognizedFormatError(
    'Could not find a holdings table. Expected a Symbol column and a Quantity column; first row was: ' + table[0]?.slice(0, 6).join(' | '));
  parsed.warnings.push(...reconcileStated(parsed));
  return parsed;
}

export async function parseUpload(filename: string, buf: Buffer): Promise<ParsedFile> {
  const fallback = `Imported from ${filename.replace(/\.[^.]+$/, '')}`;
  if (/\.xlsx$/i.test(filename)) {
    const sheets = await readXlsx(buf);
    const parsed: ParsedFile[] = [];
    for (const t of sheets) { try { parsed.push(parseTable(t, fallback)); } catch (e) { if (!(e instanceof UnrecognizedFormatError)) throw e; } }
    if (!parsed.length) throw new UnrecognizedFormatError('No worksheet in this workbook contains a recognisable holdings table.');
    const first = parsed[0];
    for (const p of parsed.slice(1)) {
      first.rows.push(...p.rows.map((r) => ({ ...r, id: `s${first.rows.length + r.rowIndex}` })));
      first.accounts.push(...p.accounts.filter((a) => !first.accounts.some((x) => x.key === a.key)));
      first.warnings.push(...p.warnings);
    }
    return first;
  }
  if (/\.xls$/i.test(filename)) throw new UnrecognizedFormatError('Legacy .xls files are not supported. Save the file as .xlsx or .csv.');
  return parseTable(readCsv(buf.toString('utf8')), fallback);
}

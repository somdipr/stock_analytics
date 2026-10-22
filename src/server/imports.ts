import { createHash, randomUUID } from 'node:crypto';
import { Db, audit } from './db.js';
import { parseUpload, ParsedFile, StagedRow, validateRow } from './parsers/index.js';
import { D, isAbsent, parseMoney } from './money.js';

export class DuplicateFileError extends Error { constructor(public existingFilename: string, public committedAt: string) { super(`This exact file was already imported on ${committedAt.slice(0, 10)} (as "${existingFilename}")`); } }
export class ImportValidationError extends Error { constructor(public problems: string[]) { super(`${problems.length} problem(s) must be fixed before importing`); } }
export class NotFoundError extends Error {}

export interface StagedBatch extends ParsedFile { id: string; filename: string; fileHash: string; overlapWarnings: string[] }

const save = (db: Db, b: StagedBatch) =>
  db.prepare('UPDATE import_batches SET payload=?, warnings=?, as_of=? WHERE id=?').run(JSON.stringify(b), JSON.stringify([...b.warnings, ...b.overlapWarnings]), b.asOf, b.id);

export function loadStaged(db: Db, id: string): StagedBatch {
  const r = db.prepare("SELECT payload FROM import_batches WHERE id=? AND status='staged'").get(id) as any;
  if (!r) throw new NotFoundError('Staged import not found (it may already be committed or discarded)');
  return JSON.parse(r.payload);
}
export const listStaged = (db: Db): StagedBatch[] =>
  (db.prepare("SELECT payload FROM import_batches WHERE status='staged' ORDER BY created_at").all() as any[]).map((r) => JSON.parse(r.payload));

const norm = (row: StagedRow) => `${row.symbol}|${row.subType}|${row.quantity ?? ''}`;

/** Compare staged accounts with accounts that already hold active positions to catch the same account arriving from two sources. */
export function detectOverlap(db: Db, b: ParsedFile): string[] {
  const out: string[] = [];
  const existing = db.prepare(`SELECT p.account_id, a.display_name, p.symbol, p.quantity FROM positions p JOIN accounts a ON a.id=p.account_id
    WHERE p.active=1 AND p.is_cash=0`).all() as any[];
  const byAcct = new Map<string, { name: string; keys: Set<string> }>();
  for (const e of existing) { const g = byAcct.get(e.account_id) ?? { name: e.display_name, keys: new Set() }; g.keys.add(`${e.symbol}|${D(e.quantity).toFixed()}`); byAcct.set(e.account_id, g); }
  for (const acct of b.accounts) {
    const mine = new Set(b.rows.filter((r) => r.accountKey === acct.key && !r.isCash && r.quantity).map((r) => `${r.symbol}|${D(r.quantity!).toFixed()}`));
    if (mine.size < 2) continue;
    for (const [id, g] of byAcct) {
      if (id === acct.key) continue;
      const inter = [...mine].filter((k) => g.keys.has(k)).length;
      if (inter / new Set([...mine, ...g.keys]).size >= 0.8)
        out.push(`"${acct.name}" holds almost exactly the same positions as the existing account "${g.name}". If they are the same account, map it to the existing one to avoid double-counting.`);
    }
  }
  return out;
}

export async function stageFile(db: Db, filename: string, buf: Buffer): Promise<StagedBatch> {
  const fileHash = createHash('sha256').update(buf).digest('hex');
  const dup = db.prepare("SELECT filename, committed_at FROM import_batches WHERE file_hash=? AND status='committed'").get(fileHash) as any;
  if (dup) throw new DuplicateFileError(dup.filename, dup.committed_at);
  const parsed = await parseUpload(filename, buf);
  // Same symbol + sub-type + quantity twice in one account looks like a repeated line: exclude it by default.
  const seen = new Set<string>();
  for (const r of parsed.rows) {
    if (r.isCash) continue;
    const k = `${r.accountKey}|${norm(r)}`;
    if (seen.has(k)) { r.included = false; r.warnings.push('Looks like a repeated line in this file (same symbol, type and quantity); excluded by default'); }
    seen.add(k);
  }
  const batch: StagedBatch = { ...parsed, id: randomUUID(), filename, fileHash, overlapWarnings: [] };
  batch.overlapWarnings = detectOverlap(db, batch);
  // Replace an earlier staged copy of the same file rather than stacking duplicates in the review queue.
  db.prepare("UPDATE import_batches SET status='discarded' WHERE file_hash=? AND status='staged'").run(fileHash);
  db.prepare(`INSERT INTO import_batches(id, filename, file_hash, format, status, as_of, payload, warnings, created_at)
    VALUES(?,?,?,?, 'staged', ?,?,?,?)`).run(batch.id, filename, fileHash, batch.format, batch.asOf, JSON.stringify(batch),
    JSON.stringify([...batch.warnings, ...batch.overlapWarnings]), new Date().toISOString());
  return batch;
}

export interface RowPatch { symbol?: string; description?: string; quantity?: string | null; filePrice?: string | null; fileValue?: string | null; costBasis?: string | null; included?: boolean; subType?: string; isCash?: boolean }

export function patchRow(db: Db, id: string, rowId: string, patch: RowPatch): StagedBatch {
  const b = loadStaged(db, id);
  const row = b.rows.find((r) => r.id === rowId); if (!row) throw new NotFoundError('Row not found');
  const asNum = (v: string | null | undefined) => (v === null || v === undefined || isAbsent(v) ? null : (parseMoney(v)?.toFixed() ?? 'invalid'));
  if (patch.symbol !== undefined) row.symbol = patch.symbol.trim().toUpperCase();
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.subType !== undefined) row.subType = patch.subType.trim().toLowerCase() || 'standard';
  if (patch.isCash !== undefined) row.isCash = patch.isCash;
  if (patch.included !== undefined) row.included = patch.included;
  for (const k of ['quantity', 'filePrice', 'fileValue', 'costBasis'] as const)
    if (patch[k] !== undefined) { const v = asNum(patch[k]); (row as any)[k] = v === 'invalid' ? null : v; if (v === 'invalid') row.warnings = [`${k} could not be read as a number`]; }
  const invalid = row.warnings.filter((w) => w.endsWith('could not be read as a number'));
  row.warnings = [...invalid, ...validateRow(row)];
  save(db, b); return b;
}
export function renameAccount(db: Db, id: string, key: string, name: string): StagedBatch {
  const b = loadStaged(db, id); const a = b.accounts.find((x) => x.key === key); if (!a) throw new NotFoundError('Account not found');
  a.name = name.trim() || a.name; save(db, b); return b;
}
/** Point a staged account at an account that already exists, so this snapshot replaces that account's positions. */
export function mapAccount(db: Db, id: string, key: string, targetAccountId: string): StagedBatch {
  const b = loadStaged(db, id); const a = b.accounts.find((x) => x.key === key); if (!a) throw new NotFoundError('Account not found');
  const t = db.prepare('SELECT id, display_name, mask FROM accounts WHERE id=?').get(targetAccountId) as any; if (!t) throw new NotFoundError('Target account not found');
  for (const r of b.rows) if (r.accountKey === key) r.accountKey = t.id;
  a.key = t.id; a.name = t.display_name; a.mask = t.mask;
  b.accounts = b.accounts.filter((x, i, arr) => arr.findIndex((y) => y.key === x.key) === i);
  b.overlapWarnings = detectOverlap(db, b); save(db, b); return b;
}
export function discardStaged(db: Db, id: string) {
  const r = db.prepare("UPDATE import_batches SET status='discarded' WHERE id=? AND status='staged'").run(id);
  if (!r.changes) throw new NotFoundError('Staged import not found');
}

export interface CommitResult { batchId: string; rowsImported: number; accounts: { id: string; name: string; applied: boolean; replacedRows: number }[]; warnings: string[] }

export function commitStaged(db: Db, id: string): CommitResult {
  const b = loadStaged(db, id);
  const rows = b.rows.filter((r) => r.included);
  const problems: string[] = [];
  for (const r of rows) {
    if (r.isCash) { if (r.fileValue === null) problems.push(`Row ${r.rowIndex + 1} (${r.symbol}): cash row needs a value`); continue; }
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(r.symbol)) problems.push(`Row ${r.rowIndex + 1}: symbol "${r.symbol}" is not valid`);
    if (r.quantity === null || D(r.quantity).lte(0)) problems.push(`Row ${r.rowIndex + 1} (${r.symbol}): quantity must be greater than zero`);
  }
  if (!rows.length) problems.push('No rows are selected for import');
  if (problems.length) throw new ImportValidationError(problems);
  const dup = db.prepare("SELECT filename, committed_at FROM import_batches WHERE file_hash=? AND status='committed'").get(b.fileHash) as any;
  if (dup) throw new DuplicateFileError(dup.filename, dup.committed_at);

  const result: CommitResult = { batchId: b.id, rowsImported: 0, accounts: [], warnings: [...b.warnings, ...b.overlapWarnings] };
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    for (const acct of b.accounts) {
      const mine = rows.filter((r) => r.accountKey === acct.key); if (!mine.length) continue;
      db.prepare(`INSERT INTO accounts(id, display_name, mask, created_at) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, mask=COALESCE(excluded.mask, accounts.mask)`).run(acct.key, acct.name, acct.mask, now);
      const prev = db.prepare(`SELECT MAX(p.as_of) AS as_of, MIN(bt.filename) AS filename, COUNT(*) AS n FROM positions p JOIN import_batches bt ON bt.id=p.batch_id
        WHERE p.account_id=? AND p.active=1`).get(acct.key) as any;
      // Snapshot semantics: a newer snapshot REPLACES the account's earlier positions; it never adds to them.
      const applies = !prev.n || new Date(b.asOf).getTime() >= new Date(prev.as_of).getTime();
      let replaced = 0;
      if (applies && prev.n) {
        replaced = db.prepare('UPDATE positions SET active=0 WHERE account_id=? AND active=1').run(acct.key).changes;
        result.warnings.push(`${acct.name}: replaced ${replaced} position(s) from the earlier snapshot "${prev.filename}"`);
      } else if (!applies) result.warnings.push(`${acct.name}: this file (${b.asOf.slice(0, 10)}) is older than the snapshot already loaded (${String(prev.as_of).slice(0, 10)}), so it was saved but not applied`);
      const ins = db.prepare(`INSERT INTO positions(batch_id, account_id, symbol, description, sub_type, quantity, file_price, file_value, cost_basis, currency,
        source_asset_type, is_cash, as_of, active, fingerprint) VALUES(?,?,?,?,?,?,?,?,?,'USD',?,?,?,?,?)`);
      for (const r of mine) {
        const fp = createHash('sha256').update(`${acct.key}|${r.symbol}|${r.subType}|${r.quantity}|${b.asOf}`).digest('hex');
        ins.run(b.id, acct.key, r.symbol, r.description, r.subType, r.quantity, r.filePrice, r.fileValue, r.costBasis, r.sourceAssetType, r.isCash ? 1 : 0, b.asOf, applies ? 1 : 0, fp);
        result.rowsImported++;
      }
      result.accounts.push({ id: acct.key, name: acct.name, applied: applies, replacedRows: replaced });
    }
    db.prepare("UPDATE import_batches SET status='committed', committed_at=?, payload=? WHERE id=?").run(now, JSON.stringify(b), b.id);
    audit(db, 'import.commit', `${b.filename}: ${result.rowsImported} rows`);
  });
  tx();
  return result;
}

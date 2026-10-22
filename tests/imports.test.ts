import { describe, expect, it } from 'vitest';
import { freshDb, fixture, importFixture } from './helpers.js';
import { commitStaged, DuplicateFileError, ImportValidationError, mapAccount, patchRow, stageFile } from '../src/server/imports.js';
import { buildPortfolio } from '../src/server/portfolio.js';

const total = (db: ReturnType<typeof freshDb>) => buildPortfolio(db, { now: new Date('2026-07-16T21:00:00Z'), realtimeMaxAgeSec: 300 });

describe('duplicate imports', () => {
  it('rejects the identical file a second time and leaves the portfolio unchanged', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const before = total(db).totalValue;
    await expect(stageFile(db, 'renamed-copy.csv', fixture('synthetic-single-account-A.csv'))).rejects.toThrow(DuplicateFileError);
    expect(total(db).totalValue).toBe(before);
  });
  it('re-staging an uncommitted file replaces the earlier staged copy', async () => {
    const db = freshDb(); await stageFile(db, 'a.csv', fixture('synthetic-single-account-A.csv')); await stageFile(db, 'a.csv', fixture('synthetic-single-account-A.csv'));
    expect(db.prepare("SELECT COUNT(*) n FROM import_batches WHERE status='staged'").get()).toEqual({ n: 1 });
  });
  it('a newer snapshot of the same account REPLACES the old one (no double-counting)', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const newer = fixture('synthetic-single-account-A.csv').toString().replace('04:04 PM ET, 2026/07/16', '04:04 PM ET, 2026/07/17').replace('"10.0000"', '"12.0000"');
    const s = await stageFile(db, 'a-next-day.csv', Buffer.from(newer)); const r = commitStaged(db, s.id);
    expect(r.accounts[0]).toMatchObject({ applied: true, replacedRows: 5 });
    const p = total(db); expect(p.holdings.find((h) => h.symbol === 'AAPL')!.quantity).toBe(12); // 12, not 22
    expect(db.prepare('SELECT COUNT(*) n FROM positions WHERE active=1').get()).toEqual({ n: 5 });
  });
  it('an OLDER snapshot is saved but does not overwrite newer positions', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const older = fixture('synthetic-single-account-A.csv').toString().replace('2026/07/16', '2026/07/10').replace('"10.0000"', '"3.0000"');
    const s = await stageFile(db, 'old.csv', Buffer.from(older)); const r = commitStaged(db, s.id);
    expect(r.accounts[0].applied).toBe(false); expect(r.warnings.join()).toMatch(/older than the snapshot already loaded/);
    expect(total(db).holdings.find((h) => h.symbol === 'AAPL')!.quantity).toBe(10);
  });
  it('flags (and excludes) a repeated line inside one file', async () => {
    const db = freshDb(); const csv = 'Symbol,Quantity,Last Price,Account\nAAPL,3,200,X\nAAPL,3,200,X\n';
    const s = await stageFile(db, 'dup-line.csv', Buffer.from(csv));
    expect(s.rows.map((r) => r.included)).toEqual([true, false]); expect(s.rows[1].warnings.join()).toMatch(/repeated line/);
  });
  it('detects the same account arriving from two different exports and lets you map it', async () => {
    const db = freshDb(); await importFixture(db, 'synthetic-single-account-A.csv');
    const clone = fixture('synthetic-single-account-A.csv').toString().replace('Test Account A ...123', 'Alias Of A ...999').replace('2026/07/16', '2026/07/17');
    const s = await stageFile(db, 'alias.csv', Buffer.from(clone));
    expect(s.overlapWarnings[0]).toMatch(/almost exactly the same positions as the existing account "Test Account A"/);
    const mapped = mapAccount(db, s.id, 'acct:alias-of-a:999', 'acct:test-account-a:123'); expect(mapped.overlapWarnings).toHaveLength(0);
    commitStaged(db, s.id);
    expect(total(db).totalValue).toBe(7015); // replaced, not doubled
  });
});

describe('review and correction before import', () => {
  it('lets you fix a row, and blocks the import until problems are fixed', async () => {
    const db = freshDb(); const s = await stageFile(db, 'g.csv', Buffer.from('Symbol,Quantity,Last Price,Account\nAAPL,abc,200,X\nMSFT,2,300,X\n'));
    expect(s.rows[0].quantity).toBeNull();
    expect(() => commitStaged(db, s.id)).toThrow(ImportValidationError);
    patchRow(db, s.id, 'r1', { quantity: '4', symbol: 'aapl ' });
    expect(commitStaged(db, s.id).rowsImported).toBe(2);
    expect(total(db).holdings.find((h) => h.symbol === 'AAPL')!.quantity).toBe(4);
  });
  it('leaves excluded rows out of the portfolio', async () => {
    const db = freshDb(); const s = await stageFile(db, 'a.csv', fixture('synthetic-single-account-A.csv'));
    expect(s.rows[0].symbol).toBe('AAPL');
    patchRow(db, s.id, s.rows[0].id, { included: false });
    commitStaged(db, s.id);
    expect(db.prepare('SELECT COUNT(*) n FROM positions').get()).toEqual({ n: 4 });
    expect(total(db).holdings.some((h) => h.symbol === 'AAPL')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseUpload, UnrecognizedFormatError } from '../src/server/parsers/index.js';
import { fixture } from './helpers.js';

describe('single-account layout (title line + table + totals)', () => {
  it('reads account, snapshot time, positions, cash and ignores the total row', async () => {
    const p = await parseUpload('a.csv', fixture('synthetic-single-account-A.csv'));
    expect(p.format).toBe('single-account-positions');
    expect(p.accounts).toEqual([{ key: 'acct:test-account-a:123', name: 'Test Account A', mask: '123' }]);
    expect(p.asOf).toBe('2026-07-16T20:04:00.000Z'); // 4:04 PM EDT
    expect(p.rows.map((r) => r.symbol)).toEqual(['AAPL', 'SCHD', 'XLU', 'ZZZZ', 'CASH']);
    const schd = p.rows.find((r) => r.symbol === 'SCHD')!;
    expect(schd).toMatchObject({ quantity: '100.5', filePrice: '30', fileValue: '3015', costBasis: '2500', sourceAssetType: 'ETFs & Closed End Funds', isCash: false });
    expect(p.rows.find((r) => r.symbol === 'CASH')).toMatchObject({ isCash: true, fileValue: '350' });
  });
  it('reconciles the rows to the total stated in the file', async () => {
    const p = await parseUpload('a.csv', fixture('synthetic-single-account-A.csv'));
    expect(p.statedTotals).toEqual([{ accountKey: 'acct:test-account-a:123', value: '7015' }]);
    expect(p.warnings.filter((w) => /states a total/.test(w))).toHaveLength(0);
  });
  it('warns when rows do not add up to the stated total', async () => {
    const bad = fixture('synthetic-single-account-A.csv').toString().replace('"$7,015.00"', '"$9,999.00"');
    const p = await parseUpload('a.csv', Buffer.from(bad));
    expect(p.warnings.some((w) => /Rows sum to 7015\.00 but the file states a total of 9999\.00/.test(w))).toBe(true);
  });
});

describe('multi-account layout (BOM, CRLF, accounting negatives, sub-positions, footer)', () => {
  it('reads positions, strips footer/disclaimer and hashes the account number', async () => {
    const p = await parseUpload('m.csv', fixture('synthetic-multi-account.csv'));
    expect(p.format).toBe('multi-account-positions');
    expect(p.accounts).toHaveLength(1);
    expect(p.accounts[0].mask).toBe('2345'); expect(p.accounts[0].name).toBe('Test Individual - TOD');
    expect(JSON.stringify(p)).not.toContain('TEST12345'); // raw account number is never kept
    expect(p.asOf).toBe('2026-07-17T02:05:00.000Z'); // Jul 16 10:05 pm EDT
    expect(p.rows).toHaveLength(4);
  });
  it('keeps margin and cash lots of the same symbol as separate rows (not duplicates)', async () => {
    const p = await parseUpload('m.csv', fixture('synthetic-multi-account.csv'));
    const gld = p.rows.filter((r) => r.symbol === 'GLD');
    expect(gld.map((r) => [r.subType, r.quantity])).toEqual([['margin', '3.5'], ['cash', '1.25']]);
  });
  it('normalises trailing spaces, $ signs and the ** money-market marker', async () => {
    const p = await parseUpload('m.csv', fixture('synthetic-multi-account.csv'));
    expect(p.rows.find((r) => r.symbol === 'AAPL')).toMatchObject({ filePrice: '200', fileValue: '800', costBasis: '600' });
    expect(p.rows.find((r) => r.symbol === 'SPAXX')).toMatchObject({ isCash: true, fileValue: '200' });
  });
});

describe('generic mapped files and Excel', () => {
  it('maps common header names in a plain CSV and flags it for review', async () => {
    const p = await parseUpload('mine.csv', Buffer.from('Ticker,Shares,Market Value,Account\nAAPL,3,"$600.00",Joint\nMSFT,2,"$800.00",Joint\n'));
    expect(p.format).toBe('generic-mapped');
    expect(p.rows.map((r) => [r.symbol, r.quantity, r.fileValue])).toEqual([['AAPL', '3', '600'], ['MSFT', '2', '800']]);
    expect(p.warnings[0]).toMatch(/Review every row/);
  });
  it('reads an .xlsx workbook', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Holdings');
    ws.addRow(['Symbol', 'Quantity', 'Last Price', 'Account']); ws.addRow(['AAPL', 7, 200, 'Excel Acct']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const p = await parseUpload('holdings.xlsx', buf);
    expect(p.rows[0]).toMatchObject({ symbol: 'AAPL', quantity: '7', filePrice: '200' }); expect(p.accounts[0].name).toBe('Excel Acct');
  });
  it('explains an unrecognised file instead of importing garbage', async () => {
    await expect(parseUpload('x.csv', Buffer.from('foo,bar\n1,2\n'))).rejects.toThrow(UnrecognizedFormatError);
    await expect(parseUpload('x.xls', Buffer.from('x'))).rejects.toThrow(/\.xlsx/);
  });
  it('flags bad rows with plain-language warnings', async () => {
    const p = await parseUpload('b.csv', Buffer.from('Symbol,Quantity,Last Price,Market Value\nAAPL,-2,200,"$400.00"\nMSFT,,100,\nTSLA,10,100,"$5,000.00"\n'));
    expect(p.rows[0].warnings.join()).toMatch(/zero or negative/);
    expect(p.rows[1].warnings.join()).toMatch(/Quantity is missing/);
    expect(p.rows[2].warnings.join()).toMatch(/more than 1%/);
  });
});

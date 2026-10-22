import { describe, expect, it } from 'vitest';
import { classify, isIncomplete, Override } from '../src/server/classification.js';

const none = new Map<string, Override>();
describe('classification', () => {
  it('uses the curated seed for known stocks and ETFs', () => {
    expect(classify('AAPL', '', 'Equity', false, none)).toMatchObject({ instrumentType: 'Stock', assetClass: 'Equity', sector: 'Information Technology', geography: 'United States', source: 'seed' });
    expect(classify('VXUS', '', '', false, none)).toMatchObject({ instrumentType: 'ETF', geography: 'International ex-US' });
    expect(classify('GLD', '', '', false, none)).toMatchObject({ assetClass: 'Commodity', sector: 'Precious Metals' });
  });
  it('classifies cash by flag or source label', () => {
    expect(classify('SPAXX', 'HELD IN MONEY MARKET', '', true, none).assetClass).toBe('Cash');
    expect(classify('XYZ', '', 'Cash and Money Market', false, none).assetClass).toBe('Cash');
  });
  it('flags (never guesses) symbols it cannot classify', () => {
    const c = classify('ZZZZ', 'UNKNOWN CORP', 'Equity', false, none);
    expect(c).toMatchObject({ instrumentType: 'Stock', sector: 'Unclassified', source: 'source-label' }); expect(isIncomplete(c)).toBe(true);
    const u = classify('QQQQ1', '', '', false, none); expect(u.source).toBe('unknown'); expect(isIncomplete(u)).toBe(true);
  });
  it('lets user overrides win, field by field', () => {
    const o = new Map<string, Override>([['AAPL', { sector: 'Consumer Discretionary' }], ['ZZZZ', { assetClass: 'Equity', sector: 'Materials', geography: 'United States' }]]);
    expect(classify('AAPL', '', 'Equity', false, o)).toMatchObject({ sector: 'Consumer Discretionary', assetClass: 'Equity', source: 'override' });
    expect(isIncomplete(classify('ZZZZ', '', 'Equity', false, o))).toBe(false);
  });
});

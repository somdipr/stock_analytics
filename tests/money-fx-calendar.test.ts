import { describe, expect, it } from 'vitest';
import { D, isAbsent, parseMoney } from '../src/server/money.js';
import { convert, MissingFxRateError, tryConvert } from '../src/server/fx.js';
import { etToUtc, marketStatus } from '../src/server/calendar.js';

describe('parseMoney', () => {
  it.each([
    ['$1,234.56 ', '1234.56'], ['($16.46)', '-16.46'], ['-$1.23', '-1.23'], ['-0.45%', '-0.45'], ['+3.1', '3.1'], ['100.5000', '100.5'], ['0', '0'],
  ])('reads %s', (raw, out) => expect(parseMoney(raw)!.toFixed()).toBe(out));
  it.each(['--', '', 'N/A', '  ', null, undefined])('treats %s as absent', (raw) => { expect(isAbsent(raw)).toBe(true); expect(parseMoney(raw)).toBeNull(); });
  it('returns null for garbage without throwing', () => { expect(parseMoney('abc')).toBeNull(); expect(isAbsent('abc')).toBe(false); });
  it('keeps exact decimals (no float drift)', () => { expect(D('0.1').plus('0.2').toFixed()).toBe('0.3'); });
});

describe('currency conversion', () => {
  const rates = { EUR: D('0.9'), INR: D('80') };
  it('same currency needs no rate', () => expect(convert(D(100), 'USD', 'usd', {}).toFixed()).toBe('100'));
  it('converts from USD and to USD', () => {
    expect(convert(D(100), 'USD', 'EUR', rates).toFixed()).toBe('90');
    expect(convert(D(90), 'EUR', 'USD', rates).toFixed()).toBe('100');
  });
  it('crosses through USD', () => expect(convert(D(90), 'EUR', 'INR', rates).toFixed()).toBe('8000'));
  it('throws on a missing rate and tryConvert returns null', () => {
    expect(() => convert(D(1), 'GBP', 'USD', rates)).toThrow(MissingFxRateError);
    expect(tryConvert(D(1), 'GBP', 'USD', rates)).toBeNull();
  });
  it('round-trips without loss', () => expect(convert(convert(D('123.45'), 'USD', 'INR', rates), 'INR', 'USD', rates).toFixed(8)).toBe('123.45000000'));
});

describe('market calendar', () => {
  const at = (iso: string) => marketStatus(new Date(iso));
  it('is open during regular hours (EDT)', () => expect(at('2026-07-15T14:00:00Z').state).toBe('open')); // 10:00 ET
  it('is open during regular hours (EST)', () => expect(at('2026-12-02T15:00:00Z').state).toBe('open')); // 10:00 ET
  it('knows pre-market and after-hours', () => {
    expect(at('2026-07-15T12:00:00Z').state).toBe('pre-market'); // 08:00 ET
    expect(at('2026-07-15T21:00:00Z').state).toBe('after-hours'); // 17:00 ET
  });
  it('is closed overnight, on weekends and on holidays', () => {
    expect(at('2026-07-16T03:00:00Z').state).toBe('closed');
    expect(at('2026-07-18T15:00:00Z').state).toBe('closed'); // Saturday
    expect(at('2026-07-03T15:00:00Z').state).toBe('closed'); // Independence Day observed
  });
  it('closes early the day after Thanksgiving', () => {
    expect(at('2026-11-27T17:30:00Z').state).toBe('open');         // 12:30 ET, before the 1 pm close
    expect(at('2026-11-27T18:30:00Z').state).toBe('after-hours');  // 1:30 pm ET, after the early close
  });
  it('reports last close and next open', () => {
    const s = at('2026-07-18T15:00:00Z'); // Saturday
    expect(new Date(etToUtc(2026, 7, 17, 16, 0)).toISOString()).toBe(s.lastCloseUtc);
    expect(s.lastCloseUtc).toBe('2026-07-17T20:00:00.000Z');
    expect(s.nextOpenUtc).toBe('2026-07-20T13:30:00.000Z');
  });
  it('flags years outside the holiday table', () => expect(at('2030-01-15T15:00:00Z').calendarKnown).toBe(false));
});

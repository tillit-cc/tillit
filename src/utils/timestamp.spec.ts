import { toDate } from './timestamp';

describe('toDate', () => {
  it('returns null for null/undefined', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });

  it('passes through a valid Date', () => {
    const d = new Date('2026-06-26T10:00:00.000Z');
    expect(toDate(d)).toBe(d);
  });

  it('returns null for an invalid Date', () => {
    expect(toDate(new Date('nope'))).toBeNull();
  });

  it('treats a small integer as epoch SECONDS (legacy sqlite trigger)', () => {
    // 1_782_000_000 s ≈ 2026-06; must NOT be read as 1970 (ms).
    const d = toDate(1_782_000_000)!;
    expect(d.getTime()).toBe(1_782_000_000 * 1000);
    expect(d.getUTCFullYear()).toBe(2026);
  });

  it('treats a large integer as epoch MILLISECONDS', () => {
    const ms = 1_782_000_000_000;
    expect(toDate(ms)!.getTime()).toBe(ms);
  });

  it('parses a numeric string (bigint column) as epoch', () => {
    expect(toDate('1782000000000')!.getTime()).toBe(1_782_000_000_000);
    expect(toDate('1782000000')!.getTime()).toBe(1_782_000_000 * 1000);
  });

  it('parses an ISO / datetime string (TypeORM date column)', () => {
    expect(toDate('2026-06-26T10:00:00.000Z')!.getUTCFullYear()).toBe(2026);
    expect(toDate('2026-06-26 10:00:00')!.getUTCFullYear()).toBe(2026);
  });

  it('returns null for an unparseable string', () => {
    expect(toDate('not-a-date')).toBeNull();
  });
});

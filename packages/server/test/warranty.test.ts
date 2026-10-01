import { describe, expect, it } from 'vitest';
import { addMonths, assessWarranty } from '../src/support/warranty.js';

const at = (date: string) => new Date(`${date}T15:30:00Z`);

describe('addMonths', () => {
  it('adds whole months', () => {
    expect(addMonths('2026-03-14', 24)).toBe('2028-03-14');
    expect(addMonths('2023-11-02', 12)).toBe('2024-11-02');
  });

  it('crosses a year boundary', () => {
    expect(addMonths('2025-12-20', 2)).toBe('2026-02-20');
  });

  it('clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  });

  it('rejects an impossible date', () => {
    expect(() => addMonths('2026-02-31', 1)).toThrow(/Invalid date/);
  });
});

describe('assessWarranty', () => {
  it('is in warranty with the days left', () => {
    expect(assessWarranty('2026-03-14', 24, at('2028-03-04'))).toEqual({
      status: 'in_warranty',
      endDate: '2028-03-14',
      daysRemaining: 10,
    });
  });

  it('still covers the last day', () => {
    expect(assessWarranty('2026-03-14', 24, at('2028-03-14'))).toMatchObject({ status: 'in_warranty', daysRemaining: 0 });
  });

  it('has expired the day after', () => {
    expect(assessWarranty('2026-03-14', 24, at('2028-03-15'))).toEqual({
      status: 'expired',
      endDate: '2028-03-14',
      daysSinceExpiry: 1,
    });
  });

  it('ignores the time of day', () => {
    expect(assessWarranty('2026-03-14', 12, new Date('2027-03-14T23:59:59Z')).status).toBe('in_warranty');
    expect(assessWarranty('2026-03-14', 12, new Date('2027-03-15T00:00:01Z')).status).toBe('expired');
  });

  it('is unknown without a purchase date', () => {
    expect(assessWarranty(undefined, 24, at('2026-10-01'))).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/No purchase date/) });
  });

  it('is unknown for an impossible or future purchase date', () => {
    expect(assessWarranty('2026-02-31', 24, at('2026-10-01')).status).toBe('unknown');
    expect(assessWarranty('not a date', 24, at('2026-10-01')).status).toBe('unknown');
    expect(assessWarranty('2027-01-01', 24, at('2026-10-01'))).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/future/) });
  });
});

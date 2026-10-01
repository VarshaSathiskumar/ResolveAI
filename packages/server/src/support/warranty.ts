export type WarrantyStatus = 'in_warranty' | 'expired' | 'unknown';

export interface WarrantyAssessment {
  status: WarrantyStatus;
  /** Last day covered, YYYY-MM-DD. */
  endDate?: string;
  daysRemaining?: number;
  daysSinceExpiry?: number;
  /** Why the status is unknown. */
  reason?: string;
}

const DAY_MS = 86_400_000;

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  // Reject dates JavaScript quietly rolls over, such as 2026-02-31.
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date;
}

/** Adds calendar months in UTC, clamping to the end of a shorter month (31 January plus one month is 28 February). */
export function addMonths(isoDate: string, months: number): string {
  const start = parseDate(isoDate);
  if (!start) throw new Error(`Invalid date: ${isoDate}`);
  const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

/** Works out whether a product bought on `purchaseDate` is still inside a warranty of `termMonths` on `now`. */
export function assessWarranty(purchaseDate: string | undefined, termMonths: number, now: Date): WarrantyAssessment {
  if (!purchaseDate) return { status: 'unknown', reason: 'No purchase date is known.' };
  const purchased = parseDate(purchaseDate);
  if (!purchased) return { status: 'unknown', reason: `"${purchaseDate}" is not a valid date (use YYYY-MM-DD).` };

  const today = parseDate(now.toISOString().slice(0, 10))!;
  if (purchased.getTime() > today.getTime()) {
    return { status: 'unknown', reason: 'The purchase date is in the future.' };
  }

  const endDate = addMonths(purchaseDate, termMonths);
  const end = parseDate(endDate)!;
  // The end date itself is still covered.
  if (today.getTime() <= end.getTime()) {
    return { status: 'in_warranty', endDate, daysRemaining: Math.round((end.getTime() - today.getTime()) / DAY_MS) };
  }
  return { status: 'expired', endDate, daysSinceExpiry: Math.round((today.getTime() - end.getTime()) / DAY_MS) };
}

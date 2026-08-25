import { addDays } from "@/lib/dates";

export type Frequency = "biweekly" | "monthly";

/** How often an installment falls due, in days. */
export const STEP_DAYS: Record<Frequency, number> = { biweekly: 14, monthly: 30 };

/**
 * Splits what is left across N installments without losing a single cent.
 *
 * Bs 2.400 over 3 divides exactly, but Bs 2.401 does not: dividing and rounding
 * each installment separately would give 800,33 × 3 = 2.400,99 and leave a cent
 * hanging forever. The remainder is spread across the first ones, which is how
 * any financier does it.
 */
export function splitInstallments(remainingMinor: number, count: number): number[] {
  const base = Math.floor(remainingMinor / count);
  const leftover = remainingMinor - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < leftover ? 1 : 0));
}

/**
 * The complete schedule: how much and when.
 *
 * It lives in a module with no database on purpose. The service uses it to write
 * the installments, and the form to **show them before saving**: it asked for
 * price, down payment, number of installments, frequency and date, and never
 * said how much each one comes to nor when the first falls — which is the one
 * thing you want to know when signing. If the same form computes the 40% down
 * payment live, this division does too.
 *
 * Both surfaces have to give the same result, so it comes from here and not from
 * two similar calculations.
 */
export function installmentSchedule(params: {
  remainingMinor: number;
  count: number;
  frequency: Frequency;
  /** Purchase date, in ISO. */
  purchasedOn: string;
  /** If not given, the first falls due one period after the purchase. */
  firstDueOn?: string;
}): Array<{ number: number; amountMinor: number; dueOn: string }> {
  const step = STEP_DAYS[params.frequency];
  const first = params.firstDueOn || addDays(params.purchasedOn, step);
  return splitInstallments(params.remainingMinor, params.count).map((amountMinor, i) => ({
    number: i + 1,
    amountMinor,
    dueOn: addDays(first, step * i),
  }));
}

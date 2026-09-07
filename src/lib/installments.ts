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
  /**
   * The interest AGREED across the whole schedule, if any. Never computed here.
   *
   * planfly does not derive interest from a rate, and deliberately: what a
   * financier actually charges is the figure on the paper, arrived at with its
   * own rounding, its own day count and its own fees. A rate applied here would
   * produce a number close to that one and different from it, and the difference
   * would be found — if it ever were — a year later, on the last installment.
   *
   * So it is asked for and stored. What this splits is the total across the
   * instalments, exactly as it splits the principal.
   */
  interestMinor?: number;
}): Array<{ number: number; amountMinor: number; interestMinor: number; dueOn: string }> {
  const step = STEP_DAYS[params.frequency];
  const first = params.firstDueOn || addDays(params.purchasedOn, step);
  const principal = splitInstallments(params.remainingMinor, params.count);
  const interest = splitInstallments(Math.max(0, params.interestMinor ?? 0), params.count);

  return principal.map((principalMinor, i) => ({
    number: i + 1,
    /*
     * What is actually paid, which is principal plus interest. The interest goes
     * INSIDE it and not beside it, so that every screen and every report that
     * already reads `amountMinor` keeps reading the figure that leaves the
     * account — and one that has never heard of interest is not wrong, only
     * silent about the split.
     */
    amountMinor: principalMinor + interest[i],
    interestMinor: interest[i],
    dueOn: addDays(first, step * i),
  }));
}

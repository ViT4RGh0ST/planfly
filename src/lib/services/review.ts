/**
 * Why a row is in the review tray, and what can be done about it.
 *
 * It lives here and not in the page because two things have to agree about it:
 * the screen, which offers the actions, and `updateTransaction`, which decides
 * whether a row leaves the tray. When they disagree the app offers a button
 * that cannot do what it says — «It's fine» took the row nowhere and the toast
 * had to explain, after the click, that it was staying.
 */

/** The row's own data, with no formatting: the same shape `recentTransactions` returns. */
export type ReviewableRow = {
  category: string | null;
  confidence: number | null;
  baseBcvMinor: number | null;
  baseP2pMinor: number | null;
  currency: string;
  source: string;
};

export type ReviewReasonKey =
  | "noCategory"
  | "lowConfidence"
  | "noRate"
  | "fromPhoto"
  | "flagged";

/**
 * The reason approving cannot clear.
 *
 * `approve` does not write `needs_review = false` bare: it goes through
 * `updateTransaction`, which RECALCULATES and flags the row again if the line
 * is still left with no equivalent — `needsReview = leftUnvalued || itemsDoubtful`.
 * So a row with no rate comes straight back, however many times it is approved.
 *
 * `itemsDoubtful` is not here because approving sends no breakdown, so it
 * cannot be true on that path.
 */
const APPROVAL_CANNOT_CLEAR: ReviewReasonKey[] = ["noRate"];

/**
 * Why a row landed in the tray.
 *
 * Keys and not sentences: the screen turns them into words and the decision
 * below reads them. It used to return text already translated, which left the
 * row unable to reason about its own reasons.
 */
export function reviewReasons(row: ReviewableRow, baseCurrency: string): ReviewReasonKey[] {
  const reasons: ReviewReasonKey[] = [];
  if (!row.category) reasons.push("noCategory");
  if (row.confidence != null && row.confidence < 0.7) reasons.push("lowConfidence");
  // Against the household's currency, not against a hard-coded "USD": it was
  // right by luck because today the base IS the dollar.
  if (row.currency !== baseCurrency && row.baseBcvMinor == null && row.baseP2pMinor == null) {
    reasons.push("noRate");
  }
  if (row.source === "ocr") reasons.push("fromPhoto");
  if (reasons.length === 0) reasons.push("flagged");
  return reasons;
}

/**
 * Whether «It's fine» would take this row out of the tray.
 *
 * One unclearable reason is enough: the recalculation flags the row again
 * whatever the other reasons say, so approving would be a click that changes
 * nothing and answers that it changed nothing.
 */
export function canBeApproved(reasons: ReviewReasonKey[]): boolean {
  return !reasons.some((reason) => APPROVAL_CANNOT_CLEAR.includes(reason));
}

/**
 * The fiscal id, in its two shapes.
 *
 * It has to be COMPARED in one canonical form — "J-30012345-6", "J300123456"
 * and "j 30012345 6" are one company, and only a comparison that ignores the
 * punctuation can see that — and READ in the shape the invoice prints, because
 * that is what somebody holds next to the screen when checking a receipt.
 *
 * Same reasoning as the number format: the figure is written the way the paper
 * writes it. So the canonical form is what is stored and the printed form is
 * built when it is painted, never the other way round.
 *
 * This lives apart from `manage-payees.ts` because both sides need it and that
 * module reaches for the database: a client component importing it would drag
 * the whole connection into the browser bundle.
 */

/** "J-30012345-6" -> "J300123456". Null when there is nothing left. */
export function normalizeTaxId(input: string | undefined | null): string | null {
  if (!input) return null;
  const canonical = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return canonical || null;
}

/**
 * "J300123456" -> "J-30012345-6", and anything else back untouched.
 *
 * The Venezuelan shape is a letter, eight or nine digits and a check digit.
 * A foreign shop's id, or a made-up one for the plumber, does not fit it and is
 * printed exactly as it was typed: inventing dashes for it would be the screen
 * claiming a structure the number does not have.
 */
export function formatTaxId(taxId: string | null | undefined): string {
  if (!taxId) return "";
  const match = /^([A-Z])(\d{7,9})(\d)$/.exec(taxId);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : taxId;
}

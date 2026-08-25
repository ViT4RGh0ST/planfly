import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { InvalidAmountError } from "@/lib/money";
import { InvalidReadingError } from "@/lib/rates/provider";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import { InvalidProductError } from "@/lib/services/products";
import { InvalidRecurrenceError } from "@/lib/services/recurring";

/**
 * What can be shown to a person about an error.
 *
 * Only the text of the errors we write ourselves: they are worded deliberately,
 * they say what happened and what to do, and they are meant to be repeated
 * verbatim. Everything else — a Drizzle failure, a timeout, an unexpected type —
 * is logged and replaced by a fixed sentence.
 *
 * It is not cosmetic. A Postgres error carries half a kilobyte of SQL with the
 * parameters inside: table names, identifiers and the amounts of the row being
 * written. Showing that in a toast helps nobody — whoever reads it can do
 * nothing with it — and publishes the shape of the database to whoever is
 * looking at the screen.
 */
const OURS = [
  InvalidTransactionError,
  InvalidAmountError,
  InvalidRecurrenceError,
  InvalidReadingError,
  InvalidProductError,
] as const;

/**
 * The amount error, written out.
 *
 * `money.ts` throws a code and its data — it is the module that knows no
 * language — so the sentence is assembled here, and the rate reasons say «rate»
 * rather than «amount» because that is what was being read.
 */
export function amountErrorMessage(err: InvalidAmountError, locale: string): string {
  const t = getTranslator(normalizeLocale(locale));
  const head = err.reason.startsWith("rate") ? "services.amount.rateHead" : "services.amount.head";
  return t(head, {
    input: JSON.stringify(err.input),
    reason: t(`services.amount.${err.reason}`, err.detail ?? {}),
  });
}

export function isOwnError(err: unknown): boolean {
  return OURS.some((C) => err instanceof C);
}

/**
 * `locale` is required and not optional on purpose.
 *
 * The errors we write ourselves already come out in the household's language,
 * because the service that threw them was handed the locale. Only the fallback
 * sentence is worded here — and an optional parameter would let a new action be
 * born answering in English inside a Spanish screen without anything failing.
 */
export function messageForScreen(err: unknown, locale: string): string {
  if (err instanceof InvalidAmountError) return amountErrorMessage(err, locale);
  if (isOwnError(err)) return (err as Error).message;
  console.error("[action] unforeseen error:", err);
  return getTranslator(normalizeLocale(locale))("services.error.generic");
}

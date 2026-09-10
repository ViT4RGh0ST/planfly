import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { currencies } from "@/db/schema";
import { SYMBOLS, minorUnit } from "@/lib/money";
import { InvalidTransactionError } from "./record-transaction";

/**
 * Adding a currency without a migration.
 *
 * The list of what a planfly knows lived in code and in the table, and a new one
 * meant editing both and deploying. For a self-hosted product that is a wall in
 * front of a row: somebody with an account in pesos, or in soles, or in reais
 * cannot record it until whoever wrote this ships a release.
 *
 * **The decimals are NOT asked for, and that is the whole design of this file.**
 *
 * `money.ts` keeps its own map of them and falls back to two, and it cannot read
 * this table: it is pure and synchronous, a client component formats with it, and
 * making it await anything would drag a connection into the browser. The guard in
 * `currencies-guard.test.ts` keeps the two honest — but it runs at build time
 * over the DECLARED list, and a row written here at runtime never passes through
 * it.
 *
 * So a currency created from the screen takes the decimals `money.ts` would use
 * anyway, which is two. That is right for almost every currency there is, and
 * for the handful written whole — the Chilean peso, the yen, the Icelandic króna
 * — two lists that disagree would put every amount out by a hundred, in both
 * directions, silently. Those need a line of code, and the screen says so
 * instead of offering a field that would quietly lie.
 */

/** Uppercase letters, three by convention, and never something that is not a code. */
const CODE = /^[A-Z]{2,6}$/;

function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

async function assertNew(code: string, locale: Locale) {
  const t = getTranslator(locale);
  if (!CODE.test(code)) {
    throw new InvalidTransactionError(t("services.manageCurrencies.badCode"), "bad_code");
  }

  const [clash] = await db
    .select({ code: currencies.code })
    .from(currencies)
    .where(eq(currencies.code, code))
    .limit(1);

  if (clash) {
    throw new InvalidTransactionError(
      t("services.manageCurrencies.alreadyThere", { code }),
      "duplicate_currency",
    );
  }
  return code;
}

export type CreateCurrencyInput = {
  /** The household's language: the summary is worded here and repeated verbatim. */
  locale: string;
  code: string;
  name: string;
  /** What amounts print with. Left empty it prints the code, which is unambiguous. */
  symbol?: string;
  /** Whether an official rate exists for it at all. Most countries: no. */
  hasOfficial?: boolean;
  isCrypto?: boolean;
};

export async function createCurrency(input: CreateCurrencyInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const code = await assertNew(normalizeCode(input.code), locale);
  const name = input.name.trim();
  if (!name) {
    throw new InvalidTransactionError(t("services.manageCurrencies.missingName"), "missing_name");
  }

  /*
   * The symbol is checked against what the screen will actually print.
   *
   * `formatAmount` reads its own map and falls back to the code, so a symbol
   * typed here for a currency the code does not know is stored and never shown.
   * Rather than accept it and quietly ignore it, only the one that will be
   * printed is allowed — which for a new currency is its code.
   */
  const willPrint = SYMBOLS[code] ?? code;
  const symbol = input.symbol?.trim() || willPrint;
  if (symbol !== willPrint) {
    throw new InvalidTransactionError(
      t("services.manageCurrencies.symbolFixed", { code, symbol: willPrint }),
      "symbol_fixed",
    );
  }

  await db.insert(currencies).values({
    code,
    name,
    symbol,
    // Never from the form: see the note at the top of this file.
    minorUnit: minorUnit(code),
    isCrypto: input.isCrypto ?? false,
    // A crypto pegged to the base does not age; everything else does.
    rateAges: !(input.isCrypto ?? false),
    hasOfficial: input.hasOfficial ?? false,
  });

  return {
    code,
    summary: t("services.manageCurrencies.created", { code, name }),
  };
}

export type UpdateCurrencyInput = {
  locale: string;
  code: string;
  name?: string;
  hasOfficial?: boolean;
};

/**
 * What can be corrected afterwards, and what cannot.
 *
 * The name and whether it has an official rate are descriptions, and changing
 * them changes what a screen says. The decimals and the code are not: they are
 * what every amount ever stored in this currency was written with, and moving
 * them would reinterpret history rather than correct it.
 */
export async function updateCurrency(input: UpdateCurrencyInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const code = normalizeCode(input.code);

  const [row] = await db.select().from(currencies).where(eq(currencies.code, code)).limit(1);
  if (!row) {
    throw new InvalidTransactionError(
      t("services.manageCurrencies.notFound", { code }),
      "currency_not_found",
    );
  }

  const changes: string[] = [];
  const patch: Record<string, unknown> = {};

  if (input.name != null && input.name.trim() && input.name.trim() !== row.name) {
    patch.name = input.name.trim();
    changes.push(t("services.manageCurrencies.change.name"));
  }
  if (input.hasOfficial != null && input.hasOfficial !== row.hasOfficial) {
    patch.hasOfficial = input.hasOfficial;
    changes.push(
      input.hasOfficial
        ? t("services.manageCurrencies.change.hasOfficial")
        : t("services.manageCurrencies.change.noOfficial"),
    );
  }

  if (changes.length === 0) {
    return { code, changes, summary: t("services.manageCurrencies.nothingToChange") };
  }

  await db.update(currencies).set(patch).where(eq(currencies.code, code));
  return {
    code,
    changes,
    summary: t("services.manageCurrencies.done", { code, changes: changes.join(", ") }),
  };
}

export type CurrencyInUse = {
  code: string;
  name: string;
  symbol: string;
  minorUnit: number;
  hasOfficial: boolean;
  rateAges: boolean;
  /** How many accounts are held in it. What decides whether it can be removed. */
  accounts: number;
};

/** Every currency this planfly knows, with what is held in each. */
export async function listCurrencies(): Promise<CurrencyInUse[]> {
  const { rows } = await db.execute<{
    code: string;
    name: string;
    symbol: string;
    minor_unit: number;
    has_official: boolean;
    rate_ages: boolean;
    accounts: string;
  }>(sql`
    SELECT c.code, c.name, c.symbol, c.minor_unit, c.has_official, c.rate_ages,
           (SELECT count(*) FROM accounts a
             WHERE a.currency = c.code AND a.archived_at IS NULL)::text AS accounts
      FROM currencies c
     ORDER BY c.code
  `);

  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    minorUnit: r.minor_unit,
    hasOfficial: r.has_official,
    rateAges: r.rate_ages,
    accounts: Number(r.accounts),
  }));
}

/**
 * Removing one, which is only ever safe while nothing is held in it.
 *
 * There is no archiving here as there is for an account or a category: those are
 * a household's own things and their history points at them. A currency is
 * reference data, and one with an account in it cannot go — the foreign key says
 * so, but with a Postgres error rather than an answer.
 */
export async function removeCurrency(code: string, locale: string) {
  // The locale travels in, as it does everywhere else: a currency belongs to no
  // household, so there is none to ask.
  const t = getTranslator(normalizeLocale(locale));
  const wanted = normalizeCode(code);

  const [row] = await db.select().from(currencies).where(eq(currencies.code, wanted)).limit(1);
  if (!row) {
    throw new InvalidTransactionError(
      t("services.manageCurrencies.notFound", { code: wanted }),
      "currency_not_found",
    );
  }

  const { rows: held } = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM accounts WHERE currency = ${wanted}
  `);
  if (Number(held[0]?.n ?? 0) > 0) {
    throw new InvalidTransactionError(
      t("services.manageCurrencies.inUse", { code: wanted, n: Number(held[0].n) }),
      "currency_in_use",
    );
  }

  await db.delete(currencies).where(eq(currencies.code, wanted));
  return { code: wanted, summary: t("services.manageCurrencies.removed", { code: wanted }) };
}

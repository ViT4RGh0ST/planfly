import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import { accounts, currencies } from "@/db/schema";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import { today } from "@/lib/dates";
import { accountBalance } from "./balances";
import { normalize, toSlug } from "./resolve-entities";
import { InvalidTransactionError } from "./record-transaction";

/**
 * The ONE write path into the chart of accounts.
 *
 * Same principle as `recordTransaction()` and `updateTransaction()`: until now
 * accounts were only born in `scripts/seed.ts`, so any change meant opening
 * psql. With the page writing on its side and the seed on its own, the rules —
 * a liability's sign, the unique slug, the currency bound to the account — would
 * end up written twice and diverging.
 */

export type AccountType =
  | "cash"
  | "bank"
  | "crypto"
  | "investment"
  | "credit_card"
  | "prepaid"
  | "loan"
  | "other";

/**
 * Nature inferred from the type, never asked for.
 *
 * Asking for both separately invites marking a credit card as an asset, and then
 * the debt ADDS to net worth instead of subtracting: the mistake fails nowhere,
 * it just gives a cheerful figure.
 */
export function natureOf(type: AccountType): "asset" | "liability" {
  return type === "credit_card" || type === "loan" ? "liability" : "asset";
}

/**
 * The balance as it is stored, from what the person types.
 *
 * A liability is asked "how much do you owe?", which is how a debt is thought
 * of, and here it turns negative — which is how net worth subtracts it
 * (`netWorth` adds assets and liabilities as-is, so a liability only subtracts
 * if its balance already carries the sign). Typing 3.000 of debt and having net
 * worth go up by 3.000 would be this screen's silent bug.
 */
export function storedBalance(amountMinor: number, type: AccountType): number {
  const abs = Math.abs(amountMinor);
  const signed = natureOf(type) === "liability" ? -abs : amountMinor;
  // Never -0, same as in `convertToBase`: a card at zero must carry no sign,
  // and `-0` sneaks into comparisons where it is not expected.
  return Object.is(signed, -0) ? 0 : signed;
}

/**
 * The currency has to be one this installation knows.
 *
 * Nothing checked it, so an unknown code reached the foreign key and came back
 * as a Postgres error with no answer inside it. What the caller needs is the
 * list: the bot had its own written by hand, and when somebody asked for pesos
 * it said planfly did not support them and opened the account in another
 * currency instead — which is worse than refusing, because an account whose
 * currency is not the money inside it makes every figure it touches false.
 */
async function assertCurrencyExists(code: string, locale: Locale) {
  const rows = await db.select({ code: currencies.code }).from(currencies);
  if (rows.some((row) => row.code === code)) return code;

  throw new InvalidTransactionError(
    getTranslator(locale)("services.manageAccounts.unknownCurrency", {
      currency: code,
      known: rows.map((row) => row.code).sort().join(", "),
    }),
    "unknown_currency",
  );
}

/** "provincial, bbva, pago movil" -> ["provincial","bbva","pago movil"] */
export function parseAliases(input: string | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const piece of input.split(",")) {
    const alias = normalize(piece);
    if (alias) seen.add(alias);
  }
  return [...seen];
}

async function assertNameFree(
  householdId: string,
  name: string,
  locale: Locale,
  exceptId?: string,
) {
  const t = getTranslator(locale);
  const slug = toSlug(name);
  if (!slug) throw new InvalidTransactionError(t("services.manageAccounts.missingName"), "missing_name");

  const [clash] = await db
    .select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.slug, slug)))
    .limit(1);

  if (clash && clash.id !== exceptId) {
    // The unique index would fire anyway, but with a Postgres error that says
    // neither which account is in the way nor whether it is archived.
    throw new InvalidTransactionError(
      clash.archivedAt
        ? t("services.manageAccounts.duplicateArchived", { name: clash.name })
        : t("services.manageAccounts.duplicateName", { name: clash.name }),
      "duplicate_name",
    );
  }
  return slug;
}

/** How many lines the account has. Decides whether its currency can still change. */
async function entryCount(accountId: string): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM transaction_entries WHERE account_id = ${accountId}
  `);
  return Number(rows[0]?.n ?? 0);
}


async function loadAccount(householdId: string, accountId: string, locale: Locale) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.householdId, householdId)))
    .limit(1);

  if (!row) {
    throw new InvalidTransactionError(
      getTranslator(locale)("services.manageAccounts.accountNotFound"),
      "account_not_found",
    );
  }
  return row;
}

export type CreateAccountInput = {
  householdId: string;
  timezone: string;
  /** The household's language. It travels with the timezone: both shape what is said. */
  locale: string;
  name: string;
  type: AccountType;
  currency: string;
  /** MAJOR units as they are written: "1.234,56". On a liability, the debt. */
  openingBalance?: string;
  institution?: string;
  aliases?: string;
};

export async function createAccount(input: CreateAccountInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const name = input.name.trim();
  const slug = await assertNameFree(input.householdId, name, locale);
  const currency = await assertCurrencyExists(input.currency.toUpperCase(), locale);

  const opening = input.openingBalance?.trim()
    ? storedBalance(parseAmountToMinor(input.openingBalance, currency), input.type)
    : 0;

  // At the end of the list: the order is the person's, not the insert's luck.
  const [last] = await db
    .select({ sortOrder: accounts.sortOrder })
    .from(accounts)
    .where(eq(accounts.householdId, input.householdId))
    .orderBy(desc(accounts.sortOrder))
    .limit(1);

  const [row] = await db
    .insert(accounts)
    .values({
      householdId: input.householdId,
      name,
      slug,
      type: input.type,
      nature: natureOf(input.type),
      currency,
      openingBalanceMinor: opening,
      // `opening_date` enters no calculation — the balance sums ALL lines, with no
      // date filter — so it is not asked for: it would be a field that looks like
      // it does something and does not.
      openingDate: today(input.timezone),
      institution: input.institution?.trim() || null,
      aliases: parseAliases(input.aliases),
      sortOrder: (last?.sortOrder ?? 0) + 1,
    })
    .returning({ id: accounts.id, name: accounts.name });

  return {
    id: row.id,
    summary: t("services.manageAccounts.created", {
      name: row.name,
      opening:
        opening !== 0
          ? t("services.manageAccounts.createdWith", { amount: formatAmount(opening, currency) })
          : t("services.manageAccounts.createdEmpty"),
    }),
  };
}

export type UpdateAccountInput = {
  householdId: string;
  accountId: string;
  /** The household's language. */
  locale: string;
  name?: string;
  type?: AccountType;
  currency?: string;
  openingBalance?: string;
  institution?: string;
  aliases?: string;
};

export async function updateAccount(input: UpdateAccountInput) {
  const locale = normalizeLocale(input.locale);
  const t = getTranslator(locale);
  const account = await loadAccount(input.householdId, input.accountId, locale);
  const changes: string[] = [];
  const patch: Record<string, unknown> = {};

  if (input.name != null && input.name.trim() && input.name.trim() !== account.name) {
    patch.slug = await assertNameFree(input.householdId, input.name, locale, account.id);
    patch.name = input.name.trim();
    changes.push(t("services.manageAccounts.change.name"));
  }

  const type = (input.type ?? account.type) as AccountType;
  if (input.type && input.type !== account.type) {
    patch.type = input.type;
    // Nature is glued to the type, always. Moving it alone would leave a card
    // counting as an asset.
    patch.nature = natureOf(input.type);
    changes.push(t("services.manageAccounts.change.type"));
  }

  let currency = account.currency;
  if (input.currency && input.currency.toUpperCase() !== account.currency) {
    // Each line's currency has to be its account's: it is what makes a balance
    // mean something. Changing it with entries inside would turn bolívares into
    // dollars by decree.
    const n = await entryCount(account.id);
    if (n > 0) {
      throw new InvalidTransactionError(
        t("services.manageAccounts.currencyLocked", {
          account: account.name,
          n,
          currency: account.currency,
          wanted: input.currency.toUpperCase(),
        }),
        "currency_locked",
      );
    }
    currency = await assertCurrencyExists(input.currency.toUpperCase(), locale);
    patch.currency = currency;
    changes.push(t("services.manageAccounts.change.currency"));
  }

  if (input.openingBalance != null && input.openingBalance.trim() !== "") {
    const opening = storedBalance(parseAmountToMinor(input.openingBalance, currency), type);
    if (opening !== account.openingBalanceMinor) {
      patch.openingBalanceMinor = opening;
      changes.push(t("services.manageAccounts.change.openingBalance", { amount: formatAmount(opening, currency) }));
    }
  } else if (input.type && natureOf(type) !== account.nature) {
    // It went from asset to liability (or the other way) without touching the
    // figure: the sign has to be flipped or the debt would keep adding.
    const flipped = storedBalance(account.openingBalanceMinor, type);
    if (flipped !== account.openingBalanceMinor) patch.openingBalanceMinor = flipped;
  }

  const institution = input.institution?.trim() || null;
  if (input.institution != null && institution !== account.institution) {
    patch.institution = institution;
    changes.push(t("services.manageAccounts.change.institution"));
  }

  if (input.aliases != null) {
    const aliases = parseAliases(input.aliases);
    if (aliases.join("|") !== account.aliases.join("|")) {
      patch.aliases = aliases;
      changes.push(t("services.manageAccounts.change.aliases"));
    }
  }

  if (changes.length === 0) {
    return { id: account.id, changes, summary: t("services.manageAccounts.nothingToChange") };
  }

  patch.updatedAt = new Date();
  await db.update(accounts).set(patch).where(eq(accounts.id, account.id));

  return { id: account.id, changes, summary: t("services.manageAccounts.done", { changes: changes.join(", ") }) };
}

/**
 * Archiving. It never deletes: the account's entries stay in the history, and
 * deleting it would leave expenses pointing at nothing.
 */
export async function archiveAccount(householdId: string, accountId: string) {
  const t = getTranslator(await localeOf(householdId));
  const account = await loadAccount(householdId, accountId, await localeOf(householdId));
  if (account.archivedAt) {
    return { id: account.id, summary: t("services.manageAccounts.alreadyArchived", { account: account.name }) };
  }

  // `netWorth` filters archived ones out, so archiving an account with money
  // inside would lower net worth with no entry to explain it.
  const balance = await accountBalance(account.id);
  if (balance !== 0) {
    throw new InvalidTransactionError(
      t("services.manageAccounts.notEmpty", {
        account: account.name,
        amount: formatAmount(balance, account.currency),
      }),
      "account_not_empty",
    );
  }

  await db
    .update(accounts)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(accounts.id, account.id));

  return { id: account.id, summary: t("services.manageAccounts.archived", { account: account.name }) };
}

/** Returns an archived account to the list. */
export async function unarchiveAccount(householdId: string, accountId: string) {
  const locale = await localeOf(householdId);
  const account = await loadAccount(householdId, accountId, locale);
  await db
    .update(accounts)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(accounts.id, account.id));
  return {
    id: account.id,
    summary: getTranslator(locale)("services.manageAccounts.unarchived", { account: account.name }),
  };
}

/** The archived accounts, so they can be recovered without opening psql. */
export async function archivedAccounts(householdId: string) {
  return db
    .select({ id: accounts.id, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), isNotNull(accounts.archivedAt)))
    .orderBy(accounts.name);
}


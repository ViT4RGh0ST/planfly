import { NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { accounts, categories, currencies } from "@/db/schema";
import { withToken } from "@/lib/api/handler";
import { today } from "@/lib/dates";
import { currentRates } from "@/lib/rates/service";
import { netWorth } from "@/lib/services/reports";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Everything the agent needs so as not to invent names.
 *
 * Without this, faced with "which accounts do I have?" the model improvises.
 * With it, it answers with the real names, and when `planfly_record` returns a
 * doubtful category it can offer the ones that genuinely exist.
 */
export const GET = withToken("context:read", async ({ principal }) => {
  const date = today(principal.timezone);

  const [accountList, categoryList, currencyList, rates, position] = await Promise.all([
    db
      .select({
        name: accounts.name,
        slug: accounts.slug,
        type: accounts.type,
        nature: accounts.nature,
        currency: accounts.currency,
        aliases: accounts.aliases,
        institution: accounts.institution,
      })
      .from(accounts)
      .where(and(eq(accounts.householdId, principal.householdId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.sortOrder), asc(accounts.name)),

    db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        kind: categories.kind,
        parentId: categories.parentId,
        aliases: categories.aliases,
      })
      .from(categories)
      .where(and(eq(categories.householdId, principal.householdId), isNull(categories.archivedAt)))
      .orderBy(asc(categories.sortOrder), asc(categories.name)),

    // The currencies an account may be opened in. It is the list the agent used
    // to carry written into its own tool schema, and got wrong.
    db.select({ code: currencies.code }).from(currencies).orderBy(asc(currencies.code)),

    currentRates(date),
    netWorth(principal.householdId, date, principal.baseCurrency),
  ]);

  const nameById = new Map(categoryList.map((c) => [c.id, c.name]));
  const t = getTranslator(normalizeLocale(principal.locale));

  /*
   * The listing, already worded.
   *
   * The adapter used to assemble it itself, which meant it had to know the
   * household's language — and it does not: it only has a token. Every other
   * route already answers with a `summary` meant to be repeated verbatim; this
   * one was the exception.
   */
  const lines = [t("api.context.accounts", { base: principal.baseCurrency })];
  for (const a of accountList) {
    const balance = position.accounts.find((p) => p.name === a.name);
    lines.push(
      t("api.context.accountLine", {
        name: a.name,
        type: a.type,
        currency: a.currency,
        balance: balance?.balanceText
          ? t("api.context.accountBalance", { balance: balance.balanceText })
          : "",
        liability: a.nature === "liability" ? t("api.context.liability") : "",
      }),
    );
  }
  const named = (c: (typeof categoryList)[number]) =>
    c.parentId ? `${nameById.get(c.parentId) ?? ""} › ${c.name}` : c.name;
  lines.push("", t("api.context.expenseCategories"));
  lines.push(categoryList.filter((c) => c.kind === "expense").map(named).join(", "));
  lines.push("", t("api.context.incomeCategories"));
  lines.push(categoryList.filter((c) => c.kind === "income").map((c) => c.name).join(", "));
  if (rates.official || rates.parallel) {
    lines.push("", t("api.context.ratesToday"));
    for (const source of ["official", "parallel"] as const) {
      const rate = rates[source];
      if (rate) {
        lines.push(
          t("api.context.rateLine", {
            source: source.toUpperCase(),
            rate: Number(rate.rate).toFixed(2),
          }),
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    summary: lines.join("\n"),
    date,
    timezone: principal.timezone,
    base_currency: principal.baseCurrency,
    /*
     * Which currencies exist, because the agent had its own list.
     *
     * The tool schema carried «VES, USD, USDT, EUR» written by hand, so when a
     * person asked for an account in pesos the bot answered that planfly does
     * not support them — and then did something far worse than refusing: it
     * opened the account in another currency and suggested converting in your
     * head. An account whose currency is not the money inside it makes every
     * figure it touches false.
     *
     * Read from the table, an added currency reaches the bot the moment the row
     * exists, and there is one list instead of two.
     */
    currencies: currencyList.map((c) => c.code),
    accounts: accountList.map((a) => {
      const balance = position.accounts.find((p) => p.name === a.name);
      return {
        name: a.name,
        slug: a.slug,
        type: a.type,
        nature: a.nature,
        currency: a.currency,
        aliases: a.aliases,
        institution: a.institution,
        balance: balance?.balanceText ?? null,
      };
    }),
    categories: categoryList.map((c) => ({
      name: c.name,
      slug: c.slug,
      kind: c.kind,
      parent: c.parentId ? (nameById.get(c.parentId) ?? null) : null,
      aliases: c.aliases,
    })),
    rates,
    net_worth: {
      bcv_minor: position.totalOfficialMinor,
      p2p_minor: position.totalParallelMinor,
      currency: position.baseCurrency,
    },
  });
});

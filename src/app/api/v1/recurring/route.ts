import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { createRecurringSchema } from "@/lib/validation";
import { formatDay } from "@/lib/dates";
import { listRecurringRules, saveRecurringRule } from "@/lib/services/recurring";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Creating recurring operations from the bot.
 *
 * It fires nothing: it only leaves the rule written with its next date. What
 * fires it is the application's heartbeat, through a single place — if this
 * route also recorded the first entry, there would be two paths by which a
 * recurrence is born and they would end up disagreeing on the rules that matter.
 */
export const POST = withToken("recurring:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, createRecurringSchema);
  const input = createRecurringSchema.parse(body);

  const result = await saveRecurringRule({
    householdId: principal.householdId,
    timezone: principal.timezone,
    locale: principal.locale,
    name: input.name,
    cadence: input.cadence,
    daysOfMonth: input.days_of_month,
    startOn: input.start_on,
    template: {
      kind: input.kind,
      amount: input.amount,
      currency: input.currency,
      amountCurrency: input.amount_currency,
      rateSource: input.rate_source,
      account: input.account,
      toAccount: input.to_account,
      // A transfer carries no category: it is the ledger's invariant.
      category: input.kind === "transfer" ? undefined : input.category,
      description: input.description ?? input.name,
      source: "recurring",
    },
  });

  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});

/** What is configured, so the agent neither invents nor duplicates. */
export const GET = withToken("context:read", async ({ principal }) => {
  const rules = await listRecurringRules(principal.householdId);
  const t = getTranslator(normalizeLocale(principal.locale));

  return NextResponse.json({
    ok: true,
    summary:
      rules.length === 0
        ? t("api.recurring.none")
        : rules
            .map((r) => {
              // The currency is only named when it is the AMOUNT's and not the
              // account's: otherwise «1.200,00 VES de Banco Provincial» repeats
              // a datum the account already carries.
              const currency = r.template.amountCurrency ?? r.template.currency ?? null;
              const source = r.template.amountCurrency ? (r.template.rateSource ?? null) : null;
              return t("api.recurring.line", {
                name: r.name,
                amount: String(r.template.amount ?? ""),
                currency: currency ? ` ${currency}` : "",
                rate: source ? t("api.recurring.atRate", { source: source.toUpperCase() }) : "",
                account: r.template.account
                  ? t("api.recurring.fromAccount", { account: r.template.account })
                  : "",
                state: r.isActive
                  ? t("api.recurring.nextOn", { date: formatDay(r.nextRunOn, principal.locale) })
                  : t("api.recurring.paused"),
                id: r.id,
              });
            })
            .join("\n"),
    recurring: rules.map((r) => ({
      id: r.id,
      name: r.name,
      cadence: r.cadence,
      days_of_month: r.daysOfMonth,
      next_run_on: r.nextRunOn,
      next_run_text: formatDay(r.nextRunOn, principal.locale),
      active: r.isActive,
      amount: r.template.amount,
      currency: r.template.amountCurrency ?? r.template.currency ?? null,
      rate_source: r.template.amountCurrency ? (r.template.rateSource ?? null) : null,
      account: r.template.account ?? null,
    })),
  });
});

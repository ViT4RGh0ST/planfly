import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import { today } from "@/lib/dates";
import { listBudgets, removeBudget, saveBudget } from "@/lib/services/budgets";
import { saveBudgetSchema, removeBudgetSchema } from "@/lib/validation";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/** Setting or changing a cap. The upsert says what was there before, if it changed. */
export const POST = withToken("budgets:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, saveBudgetSchema);
  const input = saveBudgetSchema.parse(body);

  const result = await saveBudget({
    householdId: principal.householdId,
    baseCurrency: principal.baseCurrency,
    timezone: principal.timezone,
    locale: principal.locale,
    today: today(principal.timezone),
    category: input.category,
    amount: input.amount,
    period: input.period,
    periodStart: input.period_start,
    periodEnd: input.period_end,
  });

  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});

/** Removing it. Deactivates, does not delete: the period that passed did have a cap. */
export const DELETE = withToken("budgets:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);
  rejectUnknownKeys(body, removeBudgetSchema);
  const input = removeBudgetSchema.parse(body);

  const result = await removeBudget({
    householdId: principal.householdId,
    locale: principal.locale,
    category: input.category,
    period: input.period,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const GET = withToken("context:read", async ({ principal }) => {
  const rules = await listBudgets(principal.householdId, principal.locale);
  const t = getTranslator(normalizeLocale(principal.locale));
  return NextResponse.json({
    ok: true,
    summary:
      rules.length === 0
        ? t("api.budgets.none")
        : rules
            .map((b) =>
              t("api.budgets.line", {
                category: b.category,
                amount: b.amount,
                period: b.periodName,
                range: b.rangeText,
              }),
            )
            .join("\n"),
    budgets: rules.map((b) => ({
      category: b.category,
      amount: b.amount,
      period: b.period,
      period_name: b.periodName,
      range: b.rangeText,
    })),
  });
});

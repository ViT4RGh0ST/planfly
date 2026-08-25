import { NextResponse } from "next/server";

import { withToken, rejectIdentityKeys, rejectUnknownKeys } from "@/lib/api/handler";
import {
  createFinancedPurchaseSchema,
  payInstallmentSchema,
  unpayInstallmentSchema,
  voidPlanSchema,
} from "@/lib/validation";
import { formatDay } from "@/lib/dates";
import { formatAmount } from "@/lib/money";
import {
  financingPlansView,
  payInstallment,
  recordFinancedPurchase,
  unpayInstallment,
  voidFinancingPlan,
} from "@/lib/services/financing";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

export const dynamic = "force-dynamic";

/**
 * Installment purchases from the bot.
 *
 * It exists for a reason beyond convenience: without it the model "helps" with
 * what it has to hand, and what it has to hand is `planfly_record`. With that it
 * can charge the expense to Cashea, or record an installment's transfer — and in
 * both cases the ledger looks reasonable while the installment schedule says
 * something else. Half an installment purchase is worse than none: it does not
 * fail, and the debt planfly shows stops being the one you have.
 */
export const POST = withToken("financing:write", async ({ principal, req }) => {
  const body = await req.json();
  rejectIdentityKeys(body);

  // The four operations are the same family and the same permission, but
  // different bodies: the discriminator is which fields arrive.
  if (typeof body?.plan_id === "string") {
    rejectUnknownKeys(body, voidPlanSchema);
    const input = voidPlanSchema.parse(body);
    const result = await voidFinancingPlan({
      householdId: principal.householdId,
      planId: input.plan_id,
      reason: input.reason,
    });
    return NextResponse.json(result);
  }

  if (typeof body?.installment_id === "string" && body?.undo === true) {
    // With a schema like the other three branches: without it, an id that was not
    // a uuid reached the WHERE and came out as a 500 with Postgres's text inside.
    rejectUnknownKeys(body, unpayInstallmentSchema);
    const input = unpayInstallmentSchema.parse(body);
    const result = await unpayInstallment(principal.householdId, input.installment_id);
    return NextResponse.json(result);
  }

  if (typeof body?.installment_id === "string") {
    rejectUnknownKeys(body, payInstallmentSchema);
    const pay = payInstallmentSchema.parse(body);
    const result = await payInstallment({
      householdId: principal.householdId,
      installmentId: pay.installment_id,
      fromAccount: pay.from_account,
      paidOn: pay.paid_on,
    });
    return NextResponse.json(result);
  }

  rejectUnknownKeys(body, createFinancedPurchaseSchema);
  const input = createFinancedPurchaseSchema.parse(body);

  const result = await recordFinancedPurchase({
    householdId: principal.householdId,
    financier: input.financier,
    total: input.total,
    // It is compared against the financier's currency inside the service: if they
    // match, nothing is converted.
    totalCurrency: input.total_currency,
    downPayment: input.down_payment,
    downPaymentAccount: input.down_payment_account,
    installmentCount: input.installments,
    frequency: input.frequency,
    firstDueOn: input.first_due_on,
    category: input.category,
    description: input.description,
    occurredOn: input.occurred_on,
    rateSource: input.rate_source,
    source: "api",
    createdByUserId: principal.userId,
  });

  return NextResponse.json(result, { status: 201 });
});

/** What is owed and what is due, so the agent invents nothing and asks the user for no ids. */
export const GET = withToken("context:read", async ({ principal }) => {
  const plans = await financingPlansView(principal.householdId);
  const t = getTranslator(normalizeLocale(principal.locale));

  const lines: string[] = [];
  for (const p of plans) {
    lines.push(
      t("api.financing.planLine", {
        description: p.description,
        financier: p.financier,
        pending: formatAmount(p.pendingMinor, p.currency),
        total: formatAmount(p.totalMinor, p.currency),
        id: p.id,
      }),
    );
    for (const i of p.installments) {
      lines.push(
        t("api.financing.installmentLine", {
          number: i.number,
          amount: formatAmount(i.amountMinor, p.currency),
          state: i.paid
            ? t("api.financing.paid")
            : t("api.financing.dueOn", { date: formatDay(i.dueOn, principal.locale) }),
        }) + (i.paid ? "" : ` · id ${i.id}`),
      );
    }
  }

  return NextResponse.json({
    ok: true,
    summary: plans.length === 0 ? t("api.financing.none") : lines.join("\n"),
    plans: plans.map((p) => ({
      // The id goes because voiding a whole purchase needs it.
      id: p.id,
      description: p.description,
      financier: p.financier,
      currency: p.currency,
      pending: formatAmount(p.pendingMinor, p.currency),
      total: formatAmount(p.totalMinor, p.currency),
      purchased_on: p.purchasedOn,
      installments: p.installments.map((i) => ({
        // The id goes because paying an installment needs it, and the number because
        // it is how a person names it: "the second one from Cashea".
        id: i.id,
        number: i.number,
        due_on: i.dueOn,
        due_text: formatDay(i.dueOn, principal.locale),
        amount: formatAmount(i.amountMinor, p.currency),
        paid: i.paid,
      })),
    })),
  });
});

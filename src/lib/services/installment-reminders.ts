import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { accounts, financingPlans, households, installments } from "@/db/schema";
import { formatAmount } from "@/lib/money";
import { addDays, formatDay, today } from "@/lib/dates";
import { notificationsEnabled, notify } from "@/lib/notify";
import { normalizeLocale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";

/**
 * Installment reminder: the day before it falls due.
 *
 * It leans on the same heartbeat that captures the rates, so no second timer is
 * needed. And it leans on state, not on time: it checks whether it already
 * warned today, so if the PC was off at 8:00 and gets turned on at 11:00 the
 * alert goes out all the same — just like the rate capture.
 *
 * Idempotent per day: `reminded_on` marks the date each installment was warned
 * about, so even if the heartbeat passes four times only one is sent.
 */

/** How many days ahead we warn. One: just enough to move money. */
const NOTICE_DAYS = 1;

export async function sendDueInstallmentReminders(): Promise<number> {
  if (!notificationsEnabled()) return 0;

  const homes = await db
    .select({ id: households.id, timezone: households.timezone, locale: households.locale })
    .from(households);

  let sent = 0;

  for (const home of homes) {
    const t = getTranslator(normalizeLocale(home.locale));
    const localToday = today(home.timezone);
    const target = addDays(localToday, NOTICE_DAYS);

    const due = await db
      .select({
        id: installments.id,
        number: installments.number,
        dueOn: installments.dueOn,
        amountMinor: installments.amountMinor,
        currency: financingPlans.currency,
        description: financingPlans.description,
        financier: accounts.name,
      })
      .from(installments)
      .innerJoin(financingPlans, eq(financingPlans.id, installments.planId))
      .innerJoin(accounts, eq(accounts.id, financingPlans.financierAccountId))
      .where(
        and(
          eq(installments.householdId, home.id),
          isNull(installments.paidAt),
          // What falls due tomorrow, plus what is already overdue and still unpaid:
          // speaking up is most needed.
          sql`${installments.dueOn} <= ${target}`,
          sql`(${installments.remindedOn} IS NULL OR ${installments.remindedOn} < ${localToday})`,
        ),
      );

    if (due.length === 0) continue;

    const lines = due.map((installment) => {
      const late = installment.dueOn < localToday;
      const when = late
        ? t("services.installmentReminders.overdue", {
            date: formatDay(installment.dueOn, home.locale),
          })
        : t("services.installmentReminders.dueTomorrow");
      /*
       * The `<b>` goes here and not in the message.
       *
       * ICU reads `<b>…</b>` inside a message as a rich-text tag and demands a
       * handler for it; with none, `t()` gives back the key itself — and the
       * notification went out reading «services.installmentReminders.line».
       * Telegram's markup is not a translatable part of the sentence, so it
       * wraps the argument instead of living inside the catalogue.
       */
      return t("services.installmentReminders.line", {
        description: `<b>${installment.description}</b>`,
        number: installment.number,
        amount: formatAmount(installment.amountMinor, installment.currency),
        financier: installment.financier,
        when,
      });
    });

    const total = due.reduce((sum, c) => sum + c.amountMinor, 0);
    const text =
      t("services.installmentReminders.heading", { n: due.length }) +
      "\n\n" +
      lines.join("\n") +
      "\n\n" +
      t("services.installmentReminders.total", {
        amount: `<b>${formatAmount(total, due[0].currency)}</b>`,
      });

    if (await notify(text)) {
      await db
        .update(installments)
        .set({ remindedOn: localToday })
        .where(
          sql`${installments.id} IN (${sql.join(
            due.map((c) => sql`${c.id}::uuid`),
            sql`, `,
          )})`,
        );
      sent += due.length;
    }
  }

  return sent;
}

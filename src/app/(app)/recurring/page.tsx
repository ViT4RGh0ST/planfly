import { and, asc, eq, isNull } from "drizzle-orm";

import { AddRecurring } from "@/components/recurring-actions";
import { RecurringList } from "@/components/recurring-list";
import { db } from "@/db";
import { accounts, categories } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { today } from "@/lib/dates";
import { listRecurringRules } from "@/lib/services/recurring";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * What repeats without you deciding anything each time.
 *
 * It is not a calendar screen: it is a list of rules and when they are due. The
 * calendar already exists — it is the history — and what is needed here is
 * knowing what will come in on its own and when, so month end brings no surprise.
 */
export default async function RecurringPage() {
  const ctx = await requireSession();
  const t = await getTranslations();
  const date = today(ctx.timezone);

  const [rules, accountList, categoryList] = await Promise.all([
    listRecurringRules(ctx.householdId),
    db
      .select({ name: accounts.name, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.householdId, ctx.householdId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.sortOrder)),
    db
      .select({ name: categories.name, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.householdId, ctx.householdId), isNull(categories.archivedAt)))
      .orderBy(asc(categories.sortOrder)),
  ]);

  const expenseList = categoryList.filter((c) => c.kind === "expense").map((c) => c.name);
  const incomeList = categoryList.filter((c) => c.kind === "income").map((c) => c.name);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-medium tracking-tight">{t("ui.recurring.title")}</h1>
          <AddRecurring
            accounts={accountList}
            expenseCategories={expenseList}
            incomeCategories={incomeList}
            baseCurrency={ctx.baseCurrency}
            todayDate={date}
          />
        </div>
        <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.recurring.hint")}
        </p>
      </header>

      <RecurringList
        rules={rules}
        accounts={accountList}
        expenseCategories={expenseList}
        incomeCategories={incomeList}
        baseCurrency={ctx.baseCurrency}
        todayDate={date}
      />
    </div>
  );
}

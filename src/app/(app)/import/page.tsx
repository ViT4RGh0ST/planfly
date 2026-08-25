import { and, asc, eq, isNull } from "drizzle-orm";

import { ImportWizard } from "@/components/import-wizard";
import { RulesManager } from "@/components/rules-manager";
import { db } from "@/db";
import { accounts, categories } from "@/db/schema";
import { listRules } from "@/lib/services/rules";
import { requireSession } from "@/lib/session";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const ctx = await requireSession();
  const t = await getTranslations();

  const [accountList, rules, categoryList] = await Promise.all([
    db
      .select({ name: accounts.name, currency: accounts.currency })
      .from(accounts)
      .where(and(eq(accounts.householdId, ctx.householdId), isNull(accounts.archivedAt)))
      .orderBy(asc(accounts.sortOrder)),
    listRules(ctx.householdId),
    db
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.householdId, ctx.householdId), eq(categories.kind, "expense")))
      .orderBy(asc(categories.name)),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-lg font-medium tracking-tight">{t("ui.import.title")}</h1>
        {/* max-w in ch: without it the line reached 115 characters, well above
            the ~75 that read comfortably in one pass. */}
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          {t("ui.import.hint")}
        </p>
      </header>

      {/* No containing card: the wizard already has its own step structure, and
          wrapping it added one border inside another. */}
      <ImportWizard accounts={accountList} />

      <RulesManager rules={rules} categories={categoryList.map((c) => c.name)} />
    </div>
  );
}

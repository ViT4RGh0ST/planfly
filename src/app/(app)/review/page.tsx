import { and, asc, eq, isNull } from "drizzle-orm";
import { Check } from "lucide-react";

import { ReviewRow } from "@/components/review-row";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { recentTransactions } from "@/lib/services/reports";
import { canBeApproved, reviewReasons } from "@/lib/services/review";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const ctx = await requireSession();
  const tr = await getTranslations();

  const [pending, categoryList] = await Promise.all([
    recentTransactions(ctx.householdId, { limit: 100, onlyNeedsReview: true }),
    db
      .select({ name: categories.name })
      .from(categories)
      .where(and(eq(categories.householdId, ctx.householdId), isNull(categories.archivedAt)))
      .orderBy(asc(categories.sortOrder)),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-lg font-medium tracking-tight">{tr("ui.review.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {pending.length === 0
            ? tr("ui.review.empty")
            : tr("ui.review.count", { n: pending.length })}
        </p>
      </header>

      {pending.length === 0 ? (
        // threads it carefully.
        // An empty state with a reason: at the start this screen is nearly always
        // empty, so it has to say what that means, not just that there is nothing.
        <div className="flex items-start gap-3 rounded-lg border border-positive/25 bg-positive/[0.06] px-4 py-4">
          <Check className="mt-0.5 size-4 shrink-0 text-positive" />
          <div>
            <p className="text-sm font-medium">{tr("ui.review.nothingPending")}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {tr("ui.review.nothingPendingHint")}
            </p>
          </div>
        </div>
      ) : (
        /* A list with separators, not cards inside a card: the outer container added
           nothing and duplicated each row's border. */
        <ul className="divide-y divide-border border-y border-border">
          {pending.map((t) => (
            <li key={t.id}>
              <ReviewRow
                transaction={t}
                /* Explains WHY the row landed here. Without this the tray is a
                   pile of rows with no context and people approve in bulk
                   without looking. */
                reasons={reviewReasons(t, ctx.baseCurrency).map((key) => ({
                  key,
                  text: tr(`ui.review.reason.${key}`, { base: ctx.baseCurrency }),
                }))}
                canApprove={canBeApproved(reviewReasons(t, ctx.baseCurrency))}
                categories={categoryList.map((c) => c.name)}
                baseCurrency={ctx.baseCurrency}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RecurringForm } from "@/components/recurring-form";
import { deleteRecurring, toggleRecurring } from "@/app/(app)/actions";
import { formatDay } from "@/lib/dates";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { RecurringRuleView } from "@/lib/services/recurring";
import { useLocale, useTranslations } from "next-intl";

const LAST_DAY = -1;

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The day, said the way it is said. `-1` is the last, be it 28, 30 or 31. */
function dayName(day: number, t: Translate): string {
  return day === LAST_DAY ? t("ui.recurring.day.last") : t("ui.recurring.day.numbered", { day });
}

/**
 * The rhythm in words.
 *
 * All three are stored the same way — a list of days — so the sentence comes
 * from the days and not from the label: if they are ever edited by hand, the
 * text stays true instead of repeating the preset it was born with.
 */
export function cadenceText(days: number[], t: Translate): string {
  if (days.length === 0) return t("ui.recurring.cadence.noDays");
  if (days.length === 1) return t("ui.recurring.cadence.one", { day: dayName(days[0], t) });
  const names = days.map((d) => dayName(d, t));
  const last = names.pop()!;
  return t("ui.recurring.cadence.many", { days: names.join(", "), last });
}

export function RecurringList({
  rules,
  accounts,
  expenseCategories,
  incomeCategories,
  baseCurrency,
  todayDate,
}: {
  rules: RecurringRuleView[];
  accounts: { name: string; currency: string }[];
  expenseCategories: string[];
  incomeCategories: string[];
  baseCurrency: string;
  todayDate: string;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState<RecurringRuleView | null>(null);

  return (
    <>
      {rules.length === 0 ? (
        // The empty state explains: this screen is empty until it is used once.
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("ui.recurring.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rules.map((rule) => (
            <Row key={rule.id} rule={rule} onEdit={() => setEditing(rule)} today={todayDate} />
          ))}
        </ul>
      )}

      {editing && (
        <RecurringForm
          rule={editing}
          accounts={accounts}
          expenseCategories={expenseCategories}
          incomeCategories={incomeCategories}
          baseCurrency={baseCurrency}
          todayDate={todayDate}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  );
}

function Row({
  rule,
  onEdit,
  today,
}: {
  rule: RecurringRuleView;
  onEdit: () => void;
  today: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message: string } | null>) =>
    startTransition(async () => {
      const result = await fn();
      if (!result) return;
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    });

  // Due and not fired: the heartbeat has not passed, or the app was stopped.
  const overdue = rule.isActive && rule.nextRunOn < today;

  return (
    <li className={cn("flex items-start justify-between gap-4 py-3", !rule.isActive && "opacity-55")}>
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {rule.name}
          {!rule.isActive && <span className="ml-2 text-xs font-normal">{t("ui.recurring.paused")}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {/* The amount as it was configured, not the one that comes out: «15
              USD at BCV» is what is still true in six months' time, and the
              bolívares are not. */}
          {rule.template.amountCurrency && rule.template.amountCurrency !== rule.template.currency
            ? t("ui.recurring.amountAtRate", {
                amount: rule.template.amount ?? "",
                currency: rule.template.amountCurrency,
                source: rule.template.rateSource === "bcv" ? "BCV" : "P2P",
              })
            : t("ui.recurring.amountPlain", {
                amount: rule.template.amount ?? "",
                currency: rule.template.currency ?? "",
              })}
          {cadenceText(rule.daysOfMonth, t)}
        </p>
        <p className={cn("mt-0.5 text-xs", overdue ? "text-caution" : "text-muted-foreground")}>
          {rule.isActive
            ? overdue
              ? t("ui.recurring.wasDue", { date: formatDay(rule.nextRunOn, locale) })
              : t("ui.recurring.nextOn", { date: formatDay(rule.nextRunOn, locale) })
            : t("ui.recurring.inactive")}
          {rule.lastRunOn && t("ui.recurring.lastRun", { date: formatDay(rule.lastRunOn, locale) })}
        </p>
      </div>

      <div className="flex shrink-0 items-start gap-1">
        {rule.estimatedAmountMinor != null && (
          <p className="text-right text-sm tabular-nums">
            {formatAmount(rule.estimatedAmountMinor, rule.template.currency ?? "VES")}
          </p>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-9"
              disabled={pending}
              aria-label={t("ui.recurring.menu", { name: rule.name })}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{t("ui.recurring.edit")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run(() => toggleRecurring(rule.id, !rule.isActive))}>
              {rule.isActive ? t("ui.recurring.pause") : t("ui.recurring.resume")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => run(() => deleteRecurring(rule.id))}
            >
              {t("ui.recurring.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

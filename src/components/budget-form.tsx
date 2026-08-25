"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveBudget, type ActionState } from "@/app/(app)/actions";
import { useTranslations } from "next-intl";

/**
 * The four rhythms you can budget at.
 *
 * The fortnight is there because in Venezuela people are paid fortnightly: a
 * monthly cap for someone paid on the 15th and the 30th warns that you overspent
 * when there is no fortnight left to correct. The custom range is for what does
 * not fit a calendar — a trip, some building work, a holiday.
 */
/**
 * The four periods, by key.
 *
 * The cap's label used to be built as «Tope » + the period's name lowercased.
 * Lowercasing a translation is a bug waiting for a language — in German every
 * noun is capitalised — so each one has its own complete message.
 */
const PERIODS = ["monthly", "biweekly", "yearly", "custom"] as const;

const CAP_LABEL = {
  monthly: "capMonthly",
  biweekly: "capBiweekly",
  yearly: "capYearly",
  custom: "capCustom",
} as const;

export function BudgetForm({
  categories,
  currency,
  today,
  onSaved,
}: {
  categories: string[];
  currency: string;
  /** Today in the household's timezone: the custom range's default. */
  today: string;
  /** Called on a successful save, so whoever opened it can close itself. */
  onSaved?: () => void;
}) {
  const t = useTranslations();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("monthly");

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await saveBudget(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onSaved?.();
      }
      return result;
    },
    null,
  );

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="period" value={period} />

      <div className="grid gap-2">
        <Label htmlFor="budget-category">{t("ui.budgets.form.category")}</Label>
        <Select name="category" required>
          <SelectTrigger id="budget-category">
            <SelectValue placeholder={t("ui.budgets.form.categoryPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="budget-period">{t("ui.budgets.form.howOften")}</Label>
        <Select
          value={period}
          onValueChange={(value) => setPeriod(value as (typeof PERIODS)[number])}
        >
          <SelectTrigger id="budget-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`ui.budgets.form.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`ui.budgets.form.${period}Hint`)}</p>
      </div>

      {period === "custom" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="period_start">{t("ui.budgets.form.from")}</Label>
            <Input id="period_start" name="period_start" type="date" defaultValue={today} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="period_end">{t("ui.budgets.form.to")}</Label>
            {/* It asks for the last day included, which is how people say
                it; the server converts it to the half-open range everything
                else uses. */}
            <Input id="period_end" name="period_end" type="date" defaultValue={today} required />
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="amount">
          {t(`ui.budgets.form.${CAP_LABEL[period]}`, { currency })}
        </Label>
        <Input id="amount" name="amount" inputMode="decimal" placeholder="150" required />
        {/* In the base currency on purpose: budgeting in bolívares with the
            inflation there is forces you to rewrite the number every month. */}
        <p className="text-xs text-muted-foreground">
          {t("ui.budgets.form.inBase", { currency })}
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? t("ui.form.saving") : t("ui.form.save")}
      </Button>

      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}

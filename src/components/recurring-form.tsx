"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveRecurring, type ActionState } from "@/app/(app)/actions";
import { cn } from "@/lib/utils";
import type { RecurringRuleView } from "@/lib/services/recurring";
import { useTranslations } from "next-intl";

const LAST_DAY = -1;

/** Presets first, «your own way» last: it is the order they are read in. */
const CADENCES = ["monthly", "biweekly", "custom"] as const;

/**
 * Creating and correcting a recurring operation.
 *
 * Two things in one form: **when** it repeats and **what** it records. The what
 * is an ordinary entry and is stored as the same payload manual recording
 * accepts, so when its turn comes it will write through the one path there is.
 *
 * The when is always days of the month, the fortnight and the month included:
 * the first two are presets of the same model, not separate rhythms. That is why
 * choosing "the days you pick" does not change the form, it only opens the grid.
 */
export function RecurringForm({
  rule,
  accounts,
  expenseCategories,
  incomeCategories,
  baseCurrency,
  todayDate,
  open,
  onOpenChange,
}: {
  rule: RecurringRuleView | null;
  accounts: { name: string; currency: string }[];
  expenseCategories: string[];
  incomeCategories: string[];
  baseCurrency: string;
  todayDate: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const editing = rule != null;
  const [kind, setKind] = useState(rule?.template.kind ?? "expense");
  const [cadence, setCadence] = useState(rule?.cadence ?? "monthly");
  const [days, setDays] = useState<number[]>(
    rule?.cadence === "custom" ? rule.daysOfMonth : [1],
  );
  const [account, setAccount] = useState(rule?.template.account ?? accounts[0]?.name ?? "");
  const [toAccount, setToAccount] = useState(
    rule?.template.toAccount ?? accounts[1]?.name ?? "",
  );
  /*
   * Which currency the amount is THOUGHT of in.
   *
   * «The gym is 15 dollars» leaves a bolívar account, and what has to be stored
   * is the 15 — still true next month — and not the bolívares, which expire with
   * the rate. The conversion happens on the day it fires.
   */
  const [amountCurrency, setAmountCurrency] = useState(
    rule?.template.amountCurrency ?? "",
  );
  const [rateSource, setRateSource] = useState<"bcv" | "p2p">(
    rule?.template.rateSource === "bcv" ? "bcv" : "p2p",
  );

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await saveRecurring(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  const toggleDay = (day: number) =>
    setDays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b),
    );

  const currency = accounts.find((a) => a.name === account)?.currency ?? baseCurrency;
  const categories = kind === "income" ? incomeCategories : expenseCategories;
  // Written in another currency: then we need to say which rate converts it.
  const written = amountCurrency || currency;
  const valued = written !== currency;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="recurring-help" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? t("ui.recurringForm.titleEdit") : t("ui.recurringForm.titleNew")}</DialogTitle>
          <DialogDescription id="recurring-help">
            {t("ui.recurringForm.help")}
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="grid gap-4">
          {editing && <input type="hidden" name="id" value={rule.id} />}
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="cadence" value={cadence} />
          <input type="hidden" name="days_of_month" value={days.join(",")} />
          <input type="hidden" name="currency" value={currency} />
          {valued && <input type="hidden" name="amount_currency" value={written} />}
          {valued && <input type="hidden" name="rate_source" value={rateSource} />}

          <div className="grid gap-2">
            <Label htmlFor="rec-name">{t("ui.recurringForm.name")}</Label>
            <Input
              id="rec-name"
              name="name"
              defaultValue={rule?.name}
              placeholder={t("ui.recurringForm.namePlaceholder")}
              required
              autoFocus
            />
          </div>

          <div role="radiogroup" aria-label={t("ui.form.kindGroup")} className="flex gap-2">
            {(["expense", "income", "transfer"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                role="radio"
                aria-checked={kind === option}
                variant={kind === option ? "default" : "outline"}
                size="sm"
                onClick={() => setKind(option)}
              >
                {t(`domain.entryKind.${option}`)}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="rec-amount">{t("ui.form.amount")}</Label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="rec-amount"
                  name="amount"
                  inputMode="decimal"
                  defaultValue={rule ? String(rule.template.amount) : ""}
                  placeholder="12.000,00"
                  required
                  className="min-w-0 flex-1"
                />
                {/* The amount's currency, not the account's: they are different
                    things the moment a subscription is charged in dollars. */}
                <Select
                  value={written}
                  onValueChange={(v) => setAmountCurrency(v === currency ? "" : v)}
                >
                  <SelectTrigger aria-label={t("ui.recurringForm.amountCurrency")} className="w-24 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([currency, baseCurrency])].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid min-w-0 gap-2">
              <Label htmlFor="rec-account">
                {kind === "transfer" ? t("ui.recurringForm.outOf") : t("ui.form.account")}
              </Label>
              <Select name="account" value={account} onValueChange={setAccount}>
                <SelectTrigger id="rec-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.name} · {a.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {kind === "transfer" && (
            <div className="grid gap-2">
              <Label htmlFor="rec-to-account">{t("ui.recurringForm.into")}</Label>
              <Select name="to_account" value={toAccount} onValueChange={setToAccount}>
                <SelectTrigger id="rec-to-account" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts
                    .filter((a) => a.name !== account)
                    .map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.name} · {a.currency}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {valued && (
            <div className="grid gap-2">
              <Label>{t("ui.recurringForm.whichRate")}</Label>
              <div role="radiogroup" aria-label={t("ui.recurringForm.whichRate")} className="flex gap-2">
                {(["p2p", "bcv"] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={rateSource === option}
                    variant={rateSource === option ? "default" : "outline"}
                    size="sm"
                    onClick={() => setRateSource(option)}
                  >
                    {option === "p2p" ? t("ui.recurringForm.parallel") : t("ui.recurringForm.official")}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ui.recurringForm.rateHint", { example: written === baseCurrency ? "$ 15" : "15" })}
              </p>
            </div>
          )}

          {kind !== "transfer" && (
          <div className="grid gap-2">
            <Label htmlFor="rec-category">{t("ui.form.category")}</Label>
            <Select name="category" defaultValue={rule?.template.category}>
              <SelectTrigger id="rec-category">
                <SelectValue placeholder={t("ui.form.categoryPlaceholder")} />
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
          )}

          <div className="grid gap-2">
            <Label>{t("ui.recurringForm.howOften")}</Label>
            <div role="radiogroup" aria-label={t("ui.recurringForm.howOften")} className="flex flex-wrap gap-2">
              {CADENCES.map((value) => (
                <Button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={cadence === value}
                  variant={cadence === value ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setCadence(value);
                    if (value === "monthly") setDays([1]);
                    if (value === "biweekly") setDays([15, LAST_DAY]);
                  }}
                >
                  {t(`domain.cadence.${value}.label`)}
                </Button>
              ))}
            </div>
            {cadence !== "custom" && (
              <p className="text-xs text-muted-foreground">
                {t(`domain.cadence.${cadence}.hint`)}
              </p>
            )}
          </div>

          {cadence === "custom" && (
            <div className="grid gap-2">
              <Label>{t("ui.recurringForm.whichDays")}</Label>
              {/* A grid and not a text field: there are thirty-two known
                  options, and typing them comma-separated invites putting in a
                  33 or repeating the 5. */}
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={days.includes(day) ? "default" : "outline"}
                    aria-pressed={days.includes(day)}
                    className="h-8 w-9 p-0 tabular-nums"
                    onClick={() => toggleDay(day)}
                  >
                    {day}
                  </Button>
                ))}
                {/* The last day goes separately because it is not a number: in
                    February it is the 28th and in March the 31st, and picking
                    "31" is not the same thing. */}
                <Button
                  type="button"
                  size="sm"
                  variant={days.includes(LAST_DAY) ? "default" : "outline"}
                  aria-pressed={days.includes(LAST_DAY)}
                  className={cn("h-8 px-2")}
                  onClick={() => toggleDay(LAST_DAY)}
                >
                  {t("ui.recurringForm.lastDay")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ui.recurringForm.daysHint")}
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="rec-start">{t("ui.recurringForm.startFrom")}</Label>
            <Input
              id="rec-start"
              name="start_on"
              type="date"
              defaultValue={todayDate}
            />
            <p className="text-xs text-muted-foreground">
              {t("ui.recurringForm.startHint")}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
              {t("ui.rowActions.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("ui.form.saving") : editing ? t("ui.form.save") : t("ui.recurringForm.create")}
            </Button>
          </DialogFooter>

          {state && !state.ok && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

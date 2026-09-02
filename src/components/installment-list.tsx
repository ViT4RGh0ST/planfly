"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { MoreHorizontal } from "lucide-react";

import { formatDay } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  payInstallmentAction,
  unpayInstallmentAction,
  voidFinancingPlanAction,
} from "@/app/(app)/actions";
import type { PlanView } from "@/lib/services/financing";
import { BothRates } from "@/components/rate-line";
import { convertToBase } from "@/lib/money";
import { useLocale, useTranslations } from "next-intl";

type Rates = Record<string, { rate: string; effectiveOn: string; stale: boolean }>;

/**
 * A plan and its installments.
 *
 * What you come here to know is **how much is left and by when**, so anything
 * overdue is said in words and not by colour alone: «3 days overdue» is the
 * information, the red only underlines it.
 */
export function InstallmentList({
  plan,
  accounts,
  todayDate,
  baseCurrency,
  valuation,
  rates,
}: {
  plan: PlanView;
  /** Where it can be paid from, with its currency: without it you choose blind. */
  accounts: { name: string; currency: string }[];
  todayDate: string;
  baseCurrency: string;
  valuation: "official" | "parallel";
  /** TODAY's rates: what paying the installment would cost now, not what was agreed. */
  rates: Rates;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [paying, setPaying] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState(accounts[0]?.name ?? "");

  /*
   * At today's rate, not at the purchase day's.
   *
   * This screen's question is "how much is the 24th going to hurt?", and that is
   * paid with whatever bolívares the dollar is worth that day, not with those of
   * when it was signed. It is the same rule the net position uses for what is
   * committed: a pending installment is a claim on what you have today.
   */
  const inBase = (minor: number) => ({
    officialMinor: convertToBase(minor, plan.currency, baseCurrency, rates.official?.rate),
    parallelMinor: convertToBase(minor, plan.currency, baseCurrency, rates.parallel?.rate),
  });

  const run = (fn: () => Promise<{ ok: boolean; message: string } | null>) =>
    startTransition(async () => {
      const result = await fn();
      if (!result) return;
      if (result.ok) {
        toast.success(result.message);
        setPaying(null);
      } else {
        toast.error(result.message);
      }
    });

  const days = (iso: string) => {
    const a = Date.parse(`${iso}T12:00:00Z`);
    const b = Date.parse(`${todayDate}T12:00:00Z`);
    return Math.round((a - b) / 86_400_000);
  };

  return (
    <article className="border-t border-border py-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-medium">{plan.description}</h3>
        <span className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            {t("ui.installments.boughtOn", {
              financier: plan.financier,
              date: formatDay(plan.purchasedOn, locale),
            })}
          </p>
          {/* Voiding the whole purchase: recording it writes several data
              — price, deposit, how many installments — and getting one of them
              wrong is easy. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-9"
                disabled={pending}
                aria-label={t("ui.installments.menu", { description: plan.description })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setVoiding(true)}>
                {t("ui.installments.voidPurchase")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>

      {voiding && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <span className="grid gap-1.5">
            <Label htmlFor={`void-${plan.id}`} className="text-xs">
              {t("ui.installments.voidWhy")}
            </Label>
            <Input
              id={`void-${plan.id}`}
              value={reason}
              autoFocus
              placeholder={t("ui.installments.voidPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                // Escape cancels, Enter voids: the same pair as in the history.
                if (e.key === "Escape") setVoiding(false);
                if (e.key === "Enter" && !pending) {
                  e.preventDefault();
                  run(() => voidFinancingPlanAction(plan.id, reason));
                }
              }}
              className="h-9 w-64"
            />
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="h-9"
            disabled={pending}
            onClick={() => run(() => voidFinancingPlanAction(plan.id, reason))}
          >
            {t("ui.installments.void")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            disabled={pending}
            onClick={() => setVoiding(false)}
          >
            {t("ui.rowActions.cancel")}
          </Button>
          {/* What is going to happen, before it does: it is several entries. */}
          <p className="w-full text-xs text-muted-foreground">
            {t("ui.installments.voidWhat", {
              amount: formatAmount(plan.totalMinor, plan.currency),
              deposit: plan.downPaymentMinor > 0 ? t("ui.installments.voidDeposit") : "",
              paid: plan.installments.some((c) => c.paid) ? t("ui.installments.voidPaid") : "",
            })}
          </p>
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <p>
          <span className="tabular-nums text-foreground">
            {formatAmount(plan.pendingMinor, plan.currency)}
          </span>
          {t("ui.installments.pendingOf", { total: formatAmount(plan.totalMinor, plan.currency) })}
        </p>
        <BothRates
          {...inBase(plan.pendingMinor)}
          baseCurrency={baseCurrency}
          valuation={valuation}
          className="items-start"
        />
      </div>

      <ul className="mt-3 divide-y divide-border/60">
        {plan.installments.map((installment) => {
          const remaining = days(installment.dueOn);
          const overdue = !installment.paid && remaining < 0;
          const soon = !installment.paid && remaining >= 0 && remaining <= 3;

          return (
            <li key={installment.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
              <span
                className={cn(
                  "w-6 shrink-0 text-sm tabular-nums",
                  installment.paid ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {installment.number}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm tabular-nums",
                    installment.paid && "text-muted-foreground line-through",
                  )}
                >
                  {formatAmount(installment.amountMinor, plan.currency)}
                </span>
                {/* With a single installment, the plan's line above already
                    says exactly the same trio: repeating it ten pixels away is
                    noise, not confirmation. */}
                {!installment.paid && plan.installments.length > 1 && (
                  <BothRates
                    {...inBase(installment.amountMinor)}
                    baseCurrency={baseCurrency}
                    valuation={valuation}
                    className="items-start"
                  />
                )}
                {/* The state is written, not only tinted: colour cannot be the
                    only thing saying something is overdue. */}
                <span
                  className={cn(
                    "block text-xs",
                    overdue ? "text-negative" : soon ? "text-caution" : "text-muted-foreground",
                  )}
                >
                  {installment.paid
                    ? t("ui.installments.paid")
                    : overdue
                      ? t("ui.installments.overdue", { n: Math.abs(remaining) })
                      : remaining === 0
                        ? t("ui.installments.dueToday", { date: formatDay(installment.dueOn, locale) })
                        : t("ui.installments.dueIn", {
                            n: remaining,
                            date: formatDay(installment.dueOn, locale),
                          })}
                </span>
              </span>

              {installment.paid ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => unpayInstallmentAction(installment.id))}
                >
                  {t("ui.installments.undo")}
                </Button>
              ) : paying === installment.id ? (
                <span className="flex items-center gap-2">
                  <Select value={from} onValueChange={setFrom}>
                    <SelectTrigger className="h-9 w-44" aria-label={t("ui.installments.payFrom")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* With its currency, like every other account selector. It
                          was the only one that left it out, and picking a dollar
                          account for an installment in bolívares gives no
                          warning: the resolver redirects it by currency without
                          saying so. */}
                      {accounts.map((a) => (
                        <SelectItem key={a.name} value={a.name}>
                          {a.name} · {a.currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={pending || !from}
                    onClick={() => run(() => payInstallmentAction(installment.id, from))}
                  >
                    {t("ui.installments.pay")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPaying(null)}>
                    {t("ui.rowActions.cancel")}
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setPaying(installment.id)}>
                  {t("ui.installments.payOpen")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

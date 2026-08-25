"use client";

import { useActionState, useState, useTransition } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";

import { formatDay } from "@/lib/dates";
import { convertToBase } from "@/lib/money";
import { BothRates } from "@/components/rate-line";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { removeFinancier, saveFinancier, type ActionState } from "@/app/(app)/actions";
import type { FinancierView } from "@/lib/services/financing";
import { useLocale, useTranslations } from "next-intl";

/**
 * Who you owe, right at the top.
 *
 * A financier is a liability account — its balance IS the debt, and that is why
 * it subtracts from net worth — but in the account list it gets mixed in with a
 * mortgage or with what you owe a friend, which are managed differently. Here
 * only the ones financing purchases show up, with what belongs to them: how
 * much, how many installments are left and when the next falls due.
 */
export function FinancierList({
  financiers,
  currencies,
  baseCurrency,
  todayDate,
  valuation,
  rates,
}: {
  financiers: FinancierView[];
  currencies: string[];
  baseCurrency: string;
  todayDate: string;
  valuation: "bcv" | "p2p";
  rates: Record<string, { rate: string; effectiveOn: string; stale: boolean }>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [editing, setEditing] = useState<FinancierView | "new" | null>(null);

  return (
    <section aria-labelledby="financiadoras" className="mb-10">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2
          id="financiadoras"
          className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {t("ui.financiers.title")}
        </h2>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {t("ui.financiers.add")}
        </Button>
      </div>

      {financiers.length === 0 ? (
        // The empty state explains: at the start this list is always empty.
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("ui.financiers.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {financiers.map((f) => {
            const late = f.nextDueOn != null && f.nextDueOn < todayDate;
            return (
              <li key={f.accountId} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.pendingInstallments === 0 ? (
                      t("ui.financiers.noPending")
                    ) : (
                      <>
                        {t("ui.financiers.pending", {
                          n: f.pendingInstallments,
                          m: f.openPlans,
                        })}
                        {f.nextDueOn && (
                          <>
                            {" · "}
                            {/* Overdue is said in words, not only in colour. */}
                            <span className={late ? "text-negative" : undefined}>
                              {late
                                ? t("ui.financiers.overdueOn", { date: formatDay(f.nextDueOn, locale) })
                                : t("ui.financiers.nextOn", { date: formatDay(f.nextDueOn, locale) })}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </p>
                  {/* Its terms, if it has any: they are what fills in the
                      purchase form and saves typing them every time.

                      No `/80` on the colour: `--muted-foreground` is calibrated
                      right at 4.73:1 on a light background, so any opacity on
                      top of it drops below WCAG's 4.5:1. */}
                  {(f.downPaymentPercent != null || f.defaultInstallments != null) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {f.downPaymentPercent != null &&
                        t("ui.financiers.downPaymentPercent", { percent: f.downPaymentPercent })}
                      {f.downPaymentPercent != null &&
                        f.defaultInstallments != null &&
                        t("ui.financiers.termsSeparator")}
                      {f.defaultInstallments != null &&
                        t("ui.financiers.defaultInstallmentsPlural", {
                          n: f.defaultInstallments,
                          frequency: f.defaultFrequency ?? "monthly",
                        })}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-start gap-1">
                  <p
                    className={cn(
                      "text-right text-sm tabular-nums",
                      f.owedMinor > 0 ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {formatAmount(f.owedMinor, f.currency)}
                    {f.owedMinor !== 0 && (
                      <BothRates
                        bcvMinor={convertToBase(f.owedMinor, f.currency, baseCurrency, rates.bcv?.rate)}
                        p2pMinor={convertToBase(f.owedMinor, f.currency, baseCurrency, rates.p2p?.rate)}
                        baseCurrency={baseCurrency}
                        valuation={valuation}
                        className="font-normal"
                      />
                    )}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {f.owedMinor > 0 ? t("ui.financiers.owed") : t("ui.financiers.settled")}
                    </span>
                  </p>
                  <FinancierActions financier={f} onEdit={() => setEditing(f)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <FinancierForm
          financier={editing === "new" ? null : editing}
          currencies={currencies}
          baseCurrency={baseCurrency}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </section>
  );
}

function FinancierActions({
  financier,
  onEdit,
}: {
  financier: FinancierView;
  onEdit: () => void;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={pending}
          aria-label={t("ui.financiers.menu", { name: financier.name })}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>{t("ui.financiers.edit")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            startTransition(async () => {
              const result = await removeFinancier(financier.accountId);
              if (result?.ok) toast.success(result.message);
              else if (result) toast.error(result.message);
            })
          }
        >
          {t("ui.financiers.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Creating and editing a financier.
 *
 * Creating one also creates its account, as a loan: whoever finances you is who
 * you owe, and only a liability account subtracts from net worth.
 */
function FinancierForm({
  financier,
  currencies,
  baseCurrency,
  open,
  onOpenChange,
}: {
  financier: FinancierView | null;
  currencies: string[];
  baseCurrency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await saveFinancier(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="financier-help">
        <DialogHeader>
          <DialogTitle>{financier ? financier.name : t("ui.financiers.form.titleNew")}</DialogTitle>
          <DialogDescription id="financier-help">
            {t("ui.financiers.form.help")}
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="grid gap-4">
          {financier && <input type="hidden" name="account_id" value={financier.accountId} />}

          {!financier && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="fr-name">{t("ui.financiers.form.name")}</Label>
                <Input id="fr-name" name="name" placeholder="Cashea" required autoFocus />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fr-currency">{t("ui.financiers.form.currency")}</Label>
                <Select name="currency" defaultValue={currencies.includes("VES") ? "VES" : baseCurrency}>
                  <SelectTrigger id="fr-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="fr-percent">{t("ui.financiers.form.downPayment")}</Label>
              {/* A percentage and not an amount: in Cashea it depends on your
                  tier and applies to each price. */}
              <div className="relative">
                <Input
                  id="fr-percent"
                  name="down_payment_percent"
                  inputMode="decimal"
                  defaultValue={financier?.downPaymentPercent ?? ""}
                  placeholder="40"
                  className="pr-7"
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">
                  %
                </span>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fr-installments">{t("ui.financiers.form.installments")}</Label>
              <Input
                id="fr-installments"
                name="default_installments"
                type="number"
                min={1}
                max={60}
                defaultValue={financier?.defaultInstallments ?? ""}
                placeholder="3"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fr-frequency">{t("ui.financiers.form.every")}</Label>
              <Select name="default_frequency" defaultValue={financier?.defaultFrequency ?? "biweekly"}>
                <SelectTrigger id="fr-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="biweekly">{t("ui.financiers.form.biweekly")}</SelectItem>
                  <SelectItem value="monthly">{t("ui.financiers.form.monthly")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {t("ui.financiers.form.hint")}
          </p>

          {state && !state.ok && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
              {t("ui.rowActions.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("ui.form.saving") : t("ui.form.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
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
import {
  MoneyField,
  useMoneyEntry,
  type Rates,
} from "@/components/money-field";
import { formatAmount, parseAmountToMinor } from "@/lib/money";
import { formatDay } from "@/lib/dates";
import { installmentSchedule } from "@/lib/installments";
import { cn } from "@/lib/utils";
import { createFinancedPurchase, type ActionState } from "@/app/(app)/actions";
import { useLocale, useTranslations } from "next-intl";

/**
 * Recording an installment purchase.
 *
 * It asks for what they actually tell you in the shop — total, down payment, how
 * many installments — and the server derives the rest: the full expense against
 * the financier, the down payment as a transfer, and the schedule split without
 * losing cents.
 */
/** Sentinel value for the dropdown: it is no account's name. */
const NEW_FINANCIER = "__nueva__";

/**
 * The down-payment percentages offered in one tap.
 *
 * Cashea and Kari work in these steps depending on your tier. The chosen
 * financier's is put first if it has one configured and it isn't there already.
 */
const COMMON_PERCENTS = [10, 20, 30, 40, 50];

/** The percentage applied to what was typed, returned in Venezuelan format. */
function percentOf(amount: string, percent: number, currency: string): string {
  try {
    const minor = Math.abs(parseAmountToMinor(amount, currency));
    if (minor === 0) return "";
    return formatAmount(Math.round((minor * percent) / 100), currency, { withSymbol: false });
  } catch {
    // Mid-typing there is still nothing to split.
    return "";
  }
}

export function FinancingForm({
  financiers,
  accounts,
  categories,
  todayDate,
  rates,
  baseCurrency,
  ratedCurrencies,
  currencies,
  defaultCurrency,
  rulesByAccount,
}: {
  /** Liability accounts: who you owe. With none there is nothing to do. */
  financiers: { name: string; currency: string }[];
  accounts: { name: string; currency: string }[];
  categories: string[];
  todayDate: string;
  /** The two rates of the day, so the price can be typed in dollars. */
  rates: Rates;
  baseCurrency: string;
  ratedCurrencies: string[];
  /** Currencies an account can be opened in. */
  currencies: string[];
  /** The currency the new financier is proposed with. */
  defaultCurrency: string;
  /** How each one finances you, by account name. */
  rulesByAccount: Record<
    string,
    { downPaymentPercent: number | null; defaultInstallments: number | null; defaultFrequency: string }
  >;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [hasDownPayment, setHasDownPayment] = useState(true);
  // If there is no financier yet, the dialog opens straight into "create
  // one": it is the normal case the first time.
  const [financier, setFinancier] = useState(financiers[0]?.name ?? NEW_FINANCIER);
  // One single currency and rate choice for the whole dialog: the price and the
  // down payment are the same purchase, and converting them at different rates
  // would give a remainder that matches neither.
  const entry = useMoneyEntry();

  // The currency it is stored in is the financier's: Cashea deals in bolívares,
  // a dollar loan deals in dollars.
  const creatingFinancier = financier === NEW_FINANCIER;
  const [total, setTotal] = useState("");
  const [downPayment, setDownPayment] = useState("");
  const [installments, setInstallments] = useState("3");
  const [frequency, setFrequency] = useState("biweekly");
  const [newCurrency, setNewCurrency] = useState(defaultCurrency);
  const [customPercent, setCustomPercent] = useState("");
  const [purchasedOn, setPurchasedOn] = useState(todayDate);
  const financierCurrency = creatingFinancier
    ? newCurrency
    : (financiers.find((f) => f.name === financier)?.currency ?? "");
  /*
   * The schedule, computed as you type.
   *
   * It asked for price, down payment, how many installments, how often and which
   * day, and never said how much each installment comes to nor when the first
   * one falls: you left the dialog without knowing the one thing you were going
   * to want to know. It is the same calculation the server does, imported from
   * the same place so the two cannot disagree.
   */
  const schedule = (() => {
    if (!total.trim() || !financierCurrency || !purchasedOn) return null;
    const count = Number(installments);
    if (!Number.isInteger(count) || count < 1 || count > 60) return null;
    try {
      const totalMinor = Math.abs(parseAmountToMinor(total, financierCurrency));
      const downMinor = downPayment.trim()
        ? Math.abs(parseAmountToMinor(downPayment, financierCurrency))
        : 0;
      const remaining = totalMinor - downMinor;
      if (remaining <= 0) return null;
      return installmentSchedule({
        remainingMinor: remaining,
        count,
        frequency: frequency === "monthly" ? "monthly" : "biweekly",
        purchasedOn,
      });
    } catch {
      // Mid-typing it is not a number yet.
      return null;
    }
  })();

  // Same as in the entry form: the resolved pair goes both ways, and a USDT
  // account stays out because that pair does not exist.
  const convertible =
    Boolean(rates.bcv || rates.p2p) &&
    Boolean(financierCurrency) &&
    (financierCurrency === baseCurrency || ratedCurrencies.includes(financierCurrency));

  /**
   * The financier's rules fill in the form.
   *
   * The down payment is computed as a percentage of the price, which is how it
   * genuinely works: on Cashea it depends on your tier and applies to each
   * purchase. It is written into the field, not applied underneath, so it can be
   * corrected when that day was different.
   */
  const rules = rulesByAccount[financier];

  // The financier's first: it is the one that will be right nearly always.
  const percentOptions = [
    ...(rules?.downPaymentPercent != null && !COMMON_PERCENTS.includes(rules.downPaymentPercent)
      ? [rules.downPaymentPercent]
      : []),
    ...COMMON_PERCENTS,
  ];

  const applyRules = (name: string) => {
    const r = rulesByAccount[name];
    if (!r) return;
    if (r.defaultInstallments != null) setInstallments(String(r.defaultInstallments));
    setFrequency(r.defaultFrequency);
    if (r.downPaymentPercent != null && total.trim()) {
      setDownPayment(percentOf(total, r.downPaymentPercent, financierCurrency));
    }
  };

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await createFinancedPurchase(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        setOpen(false);
      }
      return result;
    },
    null,
  );

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.financingForm.button")}
      </Button>

      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby="financing-help">
            <DialogHeader>
              <DialogTitle>{t("ui.financingForm.title")}</DialogTitle>
              <DialogDescription id="financing-help">
                {t("ui.financingForm.help")}
              </DialogDescription>
            </DialogHeader>

            <form action={action} className="grid gap-4">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="fin-description">{t("ui.financingForm.what")}</Label>
                <Input
                  id="fin-description"
                  name="description"
                  placeholder={t("ui.financingForm.whatPlaceholder")}
                  required
                  /* Only when there is no financier to create: two `autoFocus`
                     at once in the same dialog compete, and the last to mount
                     wins. */
                  autoFocus={!creatingFinancier}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="fin-financier">{t("ui.financingForm.who")}</Label>
                  <Select
                    name="financier"
                    value={financier}
                    onValueChange={(v) => {
                      setFinancier(v);
                      applyRules(v);
                    }}
                  >
                    <SelectTrigger id="fin-financier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {financiers.map((f) => (
                        <SelectItem key={f.name} value={f.name}>
                          {f.name} · {f.currency}
                        </SelectItem>
                      ))}
                      {/* Cashea, Kari, a neighbour: whoever lends to you is
                          nearly never already created, and sending you to
                          Accounts and back for a name is the friction that
                          makes you not record it at all. */}
                      <SelectItem value={NEW_FINANCIER}>
                        {/* A drawn icon and not a glyph: the full-width `＋`
                            does not exist in Archivo and came out as a box. */}
                        <Plus aria-hidden className="size-3.5" />
                        {t("ui.financingForm.otherFinancier")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <MoneyField
                  id="fin-total"
                  name="total"
                  label={t("ui.financingForm.totalPrice")}
                  value={total}
                  onValueChange={(v) => {
                    setTotal(v);
                    if (rules?.downPaymentPercent != null) {
                      setDownPayment(percentOf(v, rules.downPaymentPercent, financierCurrency));
                    }
                  }}
                  entry={entry}
                  rates={rates}
                  nativeCurrency={financierCurrency}
                  baseCurrency={baseCurrency}
                  convertible={convertible}
                  rateSourceName="rate_source"
                  placeholder="4.000,00"
                  required
                />
              </div>

              {creatingFinancier && (
                <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                  <div className="grid gap-2">
                    <Label htmlFor="fin-new-name">{t("ui.financingForm.newName")}</Label>
                    <Input
                      id="fin-new-name"
                      name="new_financier_name"
                      placeholder={t("ui.financingForm.newNamePlaceholder")}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="fin-new-currency">{t("ui.financingForm.newCurrency")}</Label>
                    <Select name="new_financier_currency" value={newCurrency} onValueChange={setNewCurrency}>
                      <SelectTrigger id="fin-new-currency">
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
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t("ui.financingForm.newHint")}
                  </p>
                </div>
              )}

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="fin-category">{t("ui.financingForm.category")}</Label>
                <Select name="category">
                  <SelectTrigger id="fin-category">
                    <SelectValue placeholder={t("ui.financingForm.categoryPlaceholder")} />
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={hasDownPayment}
                  onClick={() => setHasDownPayment((v) => !v)}
                  className="flex w-fit items-center gap-2 rounded-md py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span
                    className={
                      hasDownPayment
                        ? "flex h-4 w-7 items-center rounded-full bg-foreground p-0.5"
                        : "flex h-4 w-7 items-center rounded-full bg-border p-0.5"
                    }
                  >
                    <span
                      className={
                        hasDownPayment
                          ? "size-3 translate-x-3 rounded-full bg-background transition-transform"
                          : "size-3 rounded-full bg-background transition-transform"
                      }
                    />
                  </span>
                  {t("ui.financingForm.paidDeposit")}
                </button>

                {hasDownPayment && (
                  <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                    <MoneyField
                      id="fin-down"
                      name="down_payment"
                      label={
                        rules?.downPaymentPercent != null
                          ? t("ui.financingForm.depositWithPercent", { percent: rules.downPaymentPercent })
                          : t("ui.financingForm.deposit")
                      }
                      value={downPayment}
                      onValueChange={setDownPayment}
                      entry={entry}
                      rates={rates}
                      nativeCurrency={financierCurrency}
                      baseCurrency={baseCurrency}
                      convertible={convertible}
                      // The controls are already above: repeating them would be two
                      // toggles for a single decision.
                      showControls={false}
                      placeholder="1.600,00"
                      footer={
                        /*
                         * You almost never know the down payment in bolívares:
                         * you know they asked you for 10% or 40%. Working it out
                         * by hand over Bs 46.931 is exactly the friction that
                         * makes a purchase go unrecorded — or get recorded with
                         * an invented figure.
                         */
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs text-muted-foreground">{t("ui.financingForm.ofThePrice")}</span>
                          {percentOptions.map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => setDownPayment(percentOf(total, pct, financierCurrency))}
                              disabled={!total.trim()}
                              className={cn(
                                "-mx-1 rounded-md px-1 py-0.5 text-xs tabular-nums transition-colors",
                                "hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent",
                                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                // This financier's stands out: it is the one that
                                // will be right nearly always.
                                rules?.downPaymentPercent === pct
                                  ? "text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {pct}%
                            </button>
                          ))}
                          <span className="flex items-center gap-1">
                            <Input
                              aria-label={t("ui.financingForm.otherPercent")}
                              inputMode="decimal"
                              value={customPercent}
                              placeholder={t("ui.financingForm.otherPlaceholder")}
                              onChange={(e) => {
                                setCustomPercent(e.target.value);
                                const pct = Number(e.target.value.replace(",", "."));
                                if (Number.isFinite(pct) && pct > 0 && pct < 100) {
                                  setDownPayment(percentOf(total, pct, financierCurrency));
                                }
                              }}
                              className="h-7 w-14 px-2 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">%</span>
                          </span>
                        </span>
                      }
                    />
                    <div className="grid gap-2">
                      <Label htmlFor="fin-down-account">{t("ui.financingForm.fromAccount")}</Label>
                      <Select name="down_payment_account" defaultValue={accounts[0]?.name}>
                        <SelectTrigger id="fin-down-account">
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
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-3 sm:items-start">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="fin-count">{t("ui.financingForm.installments")}</Label>
                  <Input
                    id="fin-count"
                    name="installment_count"
                    type="number"
                    min={1}
                    max={60}
                    value={installments}
                    onChange={(e) => setInstallments(e.target.value)}
                    required
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="fin-frequency">{t("ui.financingForm.every")}</Label>
                  {/* Cashea goes fortnightly; a loan between people usually
                      goes monthly. It is the only thing the calendar reads. */}
                  <Select name="frequency" value={frequency} onValueChange={setFrequency}>
                    <SelectTrigger id="fin-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="biweekly">{t("ui.financingForm.biweekly")}</SelectItem>
                      <SelectItem value="monthly">{t("ui.financingForm.monthly")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="fin-date">{t("ui.financingForm.purchaseDate")}</Label>
                  <Input
                    id="fin-date"
                    name="occurred_on"
                    type="date"
                    value={purchasedOn}
                    onChange={(e) => setPurchasedOn(e.target.value)}
                    max={todayDate}
                  />
                </div>
              </div>

              {schedule && (
                <p className="text-sm text-muted-foreground">
                  {t("ui.financingForm.scheduleHead", { n: schedule.length })}
                  <span className="font-medium tabular-nums text-foreground">
                    {formatAmount(schedule[0].amountMinor, financierCurrency)}
                  </span>
                  {/* The split sends the remainder to the first ones, so with
                      an amount that does not divide exactly the last one is not
                      the same: saying so keeps the figure above from looking
                      rounded. */}
                  {schedule[schedule.length - 1].amountMinor !== schedule[0].amountMinor && (
                    <>
                      {t("ui.financingForm.scheduleLast")}
                      <span className="tabular-nums">
                        {formatAmount(schedule[schedule.length - 1].amountMinor, financierCurrency)}
                      </span>
                      {")"}
                    </>
                  )}
                  {/* No full stop: "24 sept." already brings its own, and in
                      Spanish the abbreviation's dot closes the sentence. */}
                  {schedule.length > 1
                    ? t("ui.financingForm.scheduleFirstDueMore", { date: formatDay(schedule[0].dueOn, locale) })
                    : t("ui.financingForm.scheduleFirstDue", { date: formatDay(schedule[0].dueOn, locale) })}
                  {schedule.length > 1 &&
                    t("ui.financingForm.scheduleLastDue", {
                      date: formatDay(schedule[schedule.length - 1].dueOn, locale),
                    })}
                </p>
              )}

              {state && !state.ok && (
                <p role="alert" className="text-sm text-destructive">
                  {state.message}
                </p>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                  {t("ui.rowActions.cancel")}
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? t("ui.form.saving") : t("ui.financingForm.record")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

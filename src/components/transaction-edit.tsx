"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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
import { ItemsEditor, type ItemRow } from "@/components/items-editor";
import { MoneyField, useMoneyEntry } from "@/components/money-field";
import { parseAmountToMinor } from "@/lib/money";
import {
  editTransaction,
  transactionForEdit,
  type ActionState,
  type EditableTransaction,
} from "@/app/(app)/actions";

/**
 * Correcting a whole entry, not just its category.
 *
 * Until now the dashboard knew how to do three things — recategorise, set the
 * rate and void — and the amount was not among them, which is exactly what gets
 * mistyped most. Correcting a figure meant voiding the row and writing it again,
 * leaving two entries where there had been one.
 *
 * A transfer's two legs are edited separately and with their currency written
 * beside them: across different currencies they share neither amount nor rate,
 * and presenting them as a single field was the way to unbalance them without
 * noticing.
 */
export function TransactionEdit({
  id,
  accounts,
  categories,
  todayDate,
  open,
  onOpenChange,
}: {
  id: string;
  accounts: { name: string; currency: string }[];
  categories: string[];
  todayDate: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const [data, setData] = useState<EditableTransaction | null>(null);
  const [failed, setFailed] = useState(false);
  // Correcting an amount is exactly when converting is most needed: you
  // remember the dollars and not the exact bolívares that left.
  /*
   * One `entry` per leg, not a shared one.
   *
   * Each remembers which rate ITS figure was derived with. Sharing it made
   * converting "Out" have "In" say «converted at BCV» without being touched: a
   * false provenance printed next to a figure, which is worse than saying nothing.
   */
  const entry = useMoneyEntry();
  const toEntry = useMoneyEntry();
  const [amount, setAmount] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = await editTransaction(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  // Loaded on opening and not with the row: these are fields only needed when
  // an edit is actually going to happen. The component mounts from scratch on
  // every opening, so there is no previous state to clear before asking.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    transactionForEdit(id)
      .then((result) => {
        if (!alive) return;
        if (!result) {
          setFailed(true);
          return;
        }
        setData(result);
        setAmount(result.legs.find((l) => l.sortOrder === 0)?.amount ?? "");
        setItems(result.items);
        setToAmount(result.legs.find((l) => l.sortOrder === 1)?.amount ?? "");
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, id]);

  const from = data?.legs.find((l) => l.sortOrder === 0);
  const to = data?.legs.find((l) => l.sortOrder === 1);
  const isTransfer = data?.kind === "transfer";
  const sameCurrency = Boolean(to) && from?.currency === to?.currency;

  /** The total as it currently stands, to measure what is left to itemise. */
  const editedTotal = (() => {
    if (!from || !amount.trim()) return null;
    try {
      return Math.abs(parseAmountToMinor(amount, from.currency));
    } catch {
      return null;
    }
  })();

  /** The USD/VES pair goes both ways; USDT is not resolved. */
  const convertible = (currency: string) =>
    Boolean(data && (data.rates.bcv || data.rates.p2p)) &&
    Boolean(data) &&
    (currency === data!.baseCurrency || (data?.ratedCurrencies ?? []).includes(currency));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="edit-help">
        <DialogHeader>
          <DialogTitle>{t("ui.edit.title")}</DialogTitle>
          <DialogDescription id="edit-help">
            {isTransfer
              ? sameCurrency
                ? t("ui.edit.helpSameCurrency")
                : t("ui.edit.helpTransfer")
              : t("ui.edit.help")}
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("ui.edit.failed")}
          </p>
        )}

        {!data && !failed && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ui.edit.loading")}</p>
        )}

        {data && from && (
          <form action={action} className="grid gap-4">
            <input type="hidden" name="id" value={data.id} />

            <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
              <MoneyField
                id="edit-amount"
                name="amount"
                label={isTransfer ? t("ui.edit.out") : t("ui.form.amount")}
                entry={entry}
                rates={data.rates}
                nativeCurrency={from.currency}
                baseCurrency={data.baseCurrency}
                convertible={convertible(from.currency)}
                rateSourceName="rate_source"
                value={amount}
                onValueChange={setAmount}
              />

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="edit-account">
                  {isTransfer ? t("ui.form.fromAccount") : t("ui.form.account")}
                </Label>
                <Select name="account" defaultValue={from.account}>
                  <SelectTrigger id="edit-account">
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

            {isTransfer && to ? (
              <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                <div className="grid gap-2">
                  {/* With the same currency on both sides the incoming figure
                      is fixed by the outgoing one, so no conversion is
                      offered. */}
                  {sameCurrency ? (
                    <>
                      <Label htmlFor="edit-to-amount">
                        {t("ui.edit.in")}{" "}
                        <span className="text-muted-foreground">({to.currency})</span>
                      </Label>
                      <Input
                        id="edit-to-amount"
                        name="to_amount"
                        inputMode="decimal"
                        value={toAmount}
                        readOnly
                        aria-describedby="edit-mirror"
                        className="text-muted-foreground"
                      />
                      <p id="edit-mirror" className="text-xs text-muted-foreground">
                        {t("ui.edit.mirrors")}
                      </p>
                    </>
                  ) : (
                    <MoneyField
                      id="edit-to-amount"
                      name="to_amount"
                      label={t("ui.edit.in")}
                      entry={toEntry}
                      rates={data.rates}
                      nativeCurrency={to.currency}
                      baseCurrency={data.baseCurrency}
                      convertible={convertible(to.currency)}
                      rateSourceName="to_rate_source"
                      showControls={false}
                      value={toAmount}
                      onValueChange={setToAmount}
                    />
                  )}
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="edit-to-account">{t("ui.form.toAccount")}</Label>
                  <Select name="to_account" defaultValue={to.account}>
                    <SelectTrigger id="edit-to-account">
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
            ) : (
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="edit-category">{t("ui.form.category")}</Label>
                <Select name="category" defaultValue={from.category || undefined}>
                  <SelectTrigger id="edit-category">
                    <SelectValue placeholder={t("ui.edit.categoryPlaceholder")} />
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

            <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="edit-description">{t("ui.form.description")}</Label>
                <Input
                  id="edit-description"
                  name="description"
                  defaultValue={data.description}
                />
              </div>
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="edit-date">{t("ui.form.date")}</Label>
                <Input
                  id="edit-date"
                  name="occurred_on"
                  type="date"
                  defaultValue={data.occurredOn}
                  // An entry happened, it is not going to happen.
                  max={todayDate}
                />
              </div>
            </div>

            {/* The rate is offered only where it means something: an entry
                already in the household's currency needs none. */}
            {(from.currency !== data.baseCurrency ||
              (to && to.currency !== data.baseCurrency)) && (
              <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
                {from.currency !== data.baseCurrency && (
                  <div className="grid gap-2">
                    <Label htmlFor="edit-rate">
                      {t("ui.form.rate")}{" "}
                      <span className="text-muted-foreground">
                        {t("ui.edit.rateOf", { quote: from.currency, base: data.baseCurrency })}
                      </span>
                    </Label>
                    <Input
                      id="edit-rate"
                      name="rate"
                      inputMode="decimal"
                      defaultValue={from.manualRate}
                      placeholder={t("ui.edit.ratePlaceholder")}
                    />
                  </div>
                )}
                {to && to.currency !== data.baseCurrency && (
                  <div className="grid gap-2">
                    <Label htmlFor="edit-to-rate">
                      {t("ui.edit.toRate")}{" "}
                      <span className="text-muted-foreground">
                        {t("ui.edit.rateOf", { quote: to.currency, base: data.baseCurrency })}
                      </span>
                    </Label>
                    <Input
                      id="edit-to-rate"
                      name="to_rate"
                      inputMode="decimal"
                      defaultValue={to.manualRate}
                      placeholder={t("ui.edit.ratePlaceholder")}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="edit-notes">
                {t("ui.edit.note")} <span className="text-muted-foreground">{t("ui.form.optional")}</span>
              </Label>
              <Input id="edit-notes" name="notes" defaultValue={data.notes} />
            </div>

            {/* The breakdown, if there is one or if you want to add one. Here
                it comes unfolded when it already exists: correcting what the
                camera read is exactly what this dialog is opened for. */}
            {!isTransfer && (
              <div className="grid gap-2">
                <Label>{t("ui.edit.breakdown")}</Label>
                <ItemsEditor
                  rows={items}
                  onChange={setItems}
                  currency={from.currency}
                  totalMinor={editedTotal}
                />
              </div>
            )}

            {state && !state.ok && (
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                {t("ui.rowActions.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t("ui.form.saving") : t("ui.edit.saveChanges")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatDay } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveTransaction,
  overrideRate,
  recategorize,
  voidTransaction,
} from "@/app/(app)/actions";
import type { TransactionRow } from "@/components/transactions-table";
import { useLocale, useTranslations } from "next-intl";

/**
 * A row of the review tray.
 *
 * Everything the AI could not fully interpret lands here: doubtful category, low
 * confidence, an old or absent rate. The idea is that correcting should be
 * faster than writing it again.
 */
export function ReviewRow({
  transaction,
  reasons,
  canApprove,
  categories,
  baseCurrency,
}: {
  transaction: TransactionRow;
  reasons: Array<{ key: string; text: string }>;
  /**
   * Whether «It's fine» would take the row out of the tray.
   *
   * Decided in `services/review.ts`, beside the rule that puts it there. A row
   * with no equivalent comes back however many times it is approved, so the
   * button is not offered: the rate field below is what actually resolves it.
   */
  canApprove: boolean;
  categories: string[];
  /** The household's currency. It used to be hard-coded as "USD" and was right by luck. */
  baseCurrency: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("");
  const [rate, setRate] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; message: string } | null>) =>
    startTransition(async () => {
      const result = await fn();
      if (result?.ok) toast.success(result.message);
      else if (result) toast.error(result.message);
    });

  return (
    // No border or background of its own: the page list already separates the
    // rows. A border in here would be a card inside another.
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{transaction.description}</p>
          <p className="text-sm text-muted-foreground">
            {formatDay(transaction.occurredOn, locale)} · {transaction.account} ·{" "}
            <span className="tabular-nums">{transaction.amountText}</span>
            {transaction.category && <> · {transaction.category}</>}
            {transaction.confidence != null && (
              <>{t("ui.review.confidence", { percent: Math.round(transaction.confidence * 100) })}</>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {reasons.map((reason) => (
              <Badge key={reason.key} variant="outline" className="border-caution/40 text-caution">
                {reason.text}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          {/* Not offered when it would change nothing: approving recalculates,
              and a line with no equivalent is flagged again. It used to be a
              button that answered, after the click, that the row was staying. */}
          {canApprove && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => approveTransaction(transaction.id))}
            >
              <Check className="size-4" /> {t("ui.review.approve")}
            </Button>
          )}
          {/* The same contract as in the history: an accessible name, a written
              reason and Cancel. It was the app's only destructive action with no
              label, no confirmation and one click away from «It's fine». */}
          {voiding ? (
            <span className="flex items-end gap-1.5">
              <span className="grid gap-1.5">
                <Label htmlFor={`void-${transaction.id}`} className="text-xs">
                  {t("ui.review.voidWhy")}
                </Label>
                <Input
                  id={`void-${transaction.id}`}
                  value={reason}
                  autoFocus
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setVoiding(false);
                    if (e.key === "Enter" && !pending) {
                      e.preventDefault();
                      run(() => voidTransaction(transaction.id, reason));
                    }
                  }}
                  placeholder={t("ui.review.voidPlaceholder")}
                  className="h-8 w-52"
                />
              </span>
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                disabled={pending}
                onClick={() => run(() => voidTransaction(transaction.id, reason))}
              >
                {t("ui.review.void")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={pending}
                onClick={() => setVoiding(false)}
              >
                {t("ui.rowActions.cancel")}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={t("ui.review.voidNamed", { description: transaction.description })}
              onClick={() => setVoiding(true)}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <div className="flex gap-2">
          <Input
            list={`cats-${transaction.id}`}
            placeholder={t("ui.review.moveCategoryPlaceholder")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onKeyDown={(e) => {
              // This is THE screen for working in batches: without Enter, correcting forty
              // imported rows is a hundred and twenty trips to the mouse.
              if (e.key === "Enter" && !pending && category) {
                e.preventDefault();
                run(() => recategorize(transaction.id, category));
              }
            }}
            className="h-8 w-48"
          />
          <datalist id={`cats-${transaction.id}`}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !category}
            onClick={() => run(() => recategorize(transaction.id, category))}
          >
            {t("ui.review.move")}
          </Button>
        </div>

        {transaction.currency !== baseCurrency && (
          <div className="flex gap-2">
            <Input
              placeholder={t("ui.review.fixRatePlaceholder")}
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pending && rate) {
                  e.preventDefault();
                  run(() => overrideRate(transaction.id, rate));
                }
              }}
              className="h-8 w-40"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={pending || !rate}
              onClick={() => run(() => overrideRate(transaction.id, rate))}
            >
              {t("ui.review.set")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

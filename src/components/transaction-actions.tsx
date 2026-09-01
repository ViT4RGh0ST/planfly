"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { TransactionEdit } from "@/components/transaction-edit";
import { overrideRate, recategorize, voidTransaction } from "@/app/(app)/actions";

/**
 * The verbs of a history row.
 *
 * `recategorize`, `overrideRate` and `voidTransaction` existed from the start,
 * but could only be invoked during the window in which the AI was unsure: as
 * soon as you approved the row, it left the tray and there was no way to touch
 * it. An entry the bot understood correctly can also be wrong.
 *
 * The single-purpose shortcuts stay because they are one click; "Correct…" opens
 * the whole form, which is the only thing reaching the amount and the date.
 */
export function TransactionActions({
  id,
  description,
  currency,
  baseCurrency,
  voided,
  categories,
  places,
  accounts,
  todayDate,
}: {
  id: string;
  description: string;
  currency: string;
  baseCurrency: string;
  voided: boolean;
  categories: string[];
  places: string[];
  /** With no accounts the full form cannot be offered: only the shortcuts. */
  accounts?: { name: string; currency: string }[];
  todayDate?: string;
}) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<null | "category" | "rate" | "void">(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  // A voided entry cannot be recategorised or revalued: it stays there so the
  // history has no holes, but it takes part in nothing any more.
  if (voided) return null;

  const run = (fn: () => Promise<{ ok: boolean; message: string } | null>) =>
    startTransition(async () => {
      const result = await fn();
      if (!result) return;
      if (result.ok) {
        toast.success(result.message);
        setMode(null);
        setValue("");
      } else {
        toast.error(result.message);
      }
    });

  /** The pair travels to every rate message: it is what the figure is stored in. */
  const pair = { quote: currency, base: baseCurrency };

  const descriptions = {
    category: t("ui.rowActions.category.help"),
    rate: t("ui.rowActions.rate.help", pair),
    void: t("ui.rowActions.void.help"),
  } as const;

  const labels = {
    category: {
      title: t("ui.rowActions.category.title"),
      placeholder: t("ui.rowActions.category.placeholder"),
      cta: t("ui.rowActions.category.cta"),
    },
    rate: {
      title: t("ui.rowActions.rate.title", pair),
      placeholder: t("ui.rowActions.rate.placeholder"),
      cta: t("ui.rowActions.rate.cta"),
    },
    void: {
      title: t("ui.rowActions.void.title"),
      placeholder: t("ui.rowActions.void.placeholder"),
      cta: t("ui.rowActions.void.cta"),
    },
  } as const;

  const canEdit = Boolean(accounts && todayDate);
  const l = mode ? labels[mode] : null;
  const confirm = () =>
    run(() =>
      mode === "category"
        ? recategorize(id, value)
        : mode === "rate"
          ? overrideRate(id, value)
          : voidTransaction(id, value),
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-11"
            aria-label={t("ui.rowActions.menu", { description })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit && (
            <>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                {t("ui.rowActions.correct")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => setMode("category")}>
            {t("ui.rowActions.moveCategoryMenu")}
          </DropdownMenuItem>
          {currency !== baseCurrency && (
            <DropdownMenuItem onSelect={() => setMode("rate")}>
              {t("ui.rowActions.setRateMenu")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setMode("void")}>
            {t("ui.rowActions.voidMenu")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The three shortcuts, in the same dialog as "Correct…".
          They used to live inside the actions cell, which is 48px wide: the box
          grew 315px to the right and "Cancel" was left with ZERO visible pixels
          at 1440, at 1280 and at 390 — reachable only by discovering a
          horizontal scroll that does not exist at rest — and at 900 and 390 it
          put a horizontal bar on the whole document. A dialog cannot overflow,
          and this also makes the menu's four verbs behave alike. */}
      {mode && l && (
        <Dialog open onOpenChange={(open) => !open && setMode(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{l.title}</DialogTitle>
              <DialogDescription>{descriptions[mode]}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={`${mode}-${id}`} className="sr-only">
                {l.title}
              </Label>
              <Input
                id={`${mode}-${id}`}
                list={mode === "category" ? `cats-${id}` : undefined}
                inputMode={mode === "rate" ? "decimal" : undefined}
                placeholder={l.placeholder}
                value={value}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  // Enter confirms. Escape is closed by the dialog itself, so it no longer
                  // depends on the focus still being inside this field.
                  if (e.key === "Enter" && !pending && (mode === "void" || value)) {
                    e.preventDefault();
                    confirm();
                  }
                }}
              />
              {mode === "category" && (
                <datalist id={`cats-${id}`}>
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={pending} onClick={() => setMode(null)}>
                {t("ui.rowActions.cancel")}
              </Button>
              <Button
                variant={mode === "void" ? "destructive" : "default"}
                disabled={pending || (mode !== "void" && !value)}
                onClick={confirm}
              >
                {l.cta}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Mounted only when it opens: otherwise every row of the history would
          bring its own dialog into the DOM and a hundred rows would be a hundred
          forms. */}
      {canEdit && editing && (
        <TransactionEdit
          id={id}
          accounts={accounts!}
          categories={categories}
          places={places}
          todayDate={todayDate!}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

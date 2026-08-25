"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BudgetForm } from "@/components/budget-form";
import { useTranslations } from "next-intl";

/**
 * Creating a budget, behind a button.
 *
 * It took up a permanent third of the screen, and it is the same reason creating
 * an account and creating a financier live in a dialog: a cap is set a few times
 * a year and then only looked at. What rules the page is how what you already
 * set is going.
 */
export function AddBudget({
  categories,
  currency,
  today,
}: {
  categories: string[];
  currency: string;
  today: string;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.budgets.add")}
      </Button>
      {/* Mounted only on opening, like the other two: otherwise the whole form
          lives in the DOM of a page that is nearly always read-only. */}
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby="budget-help">
            <DialogHeader>
              <DialogTitle>{t("ui.budgets.add")}</DialogTitle>
              <DialogDescription id="budget-help">
                {t("ui.budgets.form.help", { currency })}
              </DialogDescription>
            </DialogHeader>
            <BudgetForm
              categories={categories}
              currency={currency}
              today={today}
              onSaved={() => setOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

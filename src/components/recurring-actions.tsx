"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RecurringForm } from "@/components/recurring-form";
import { useTranslations } from "next-intl";

/**
 * Creation, in the page header.
 *
 * Same pattern as creating an account, a financier and a budget: the button on
 * top, the form in a dialog, and mounted only on opening. A recurrence is
 * created a few times a year and then only looked at.
 */
export function AddRecurring({
  accounts,
  expenseCategories,
  incomeCategories,
  baseCurrency,
  todayDate,
}: {
  accounts: { name: string; currency: string }[];
  expenseCategories: string[];
  incomeCategories: string[];
  baseCurrency: string;
  todayDate: string;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.recurring.add")}
      </Button>
      {open && (
        <RecurringForm
          rule={null}
          accounts={accounts}
          expenseCategories={expenseCategories}
          incomeCategories={incomeCategories}
          baseCurrency={baseCurrency}
          todayDate={todayDate}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

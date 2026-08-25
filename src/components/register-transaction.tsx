"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TransactionForm } from "@/components/transaction-form";

/**
 * Recording by hand, on demand.
 *
 * The form took up a fixed third of the screen, and PRODUCT.md says expenses
 * come in over Telegram while you are out: the desktop is opened to consult. A
 * permanent surface for the least-used route pushed the history — what people do
 * come here for — into a lane where descriptions were cut off and accounts
 * needed two lines.
 *
 * It is still one click, not a trip: the dialog brings the same form intact.
 */
export function RegisterTransaction(
  props: React.ComponentProps<typeof TransactionForm>,
) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.register.button")}
      </Button>

      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby="registrar-help">
            <DialogHeader>
              <DialogTitle>{t("ui.register.title")}</DialogTitle>
              <DialogDescription id="registrar-help">
                {t("ui.register.help")}
              </DialogDescription>
            </DialogHeader>
            <TransactionForm {...props} onDone={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

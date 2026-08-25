"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountForm } from "@/components/account-form";
import { archiveAccountAction, unarchiveAccountAction } from "@/app/(app)/actions";

/**
 * The create button, in the page header.
 *
 * Until now accounts were only born in `scripts/seed.ts`: adding one meant
 * editing the seed and re-seeding.
 */
export function AddAccount({
  currencies,
  baseCurrency,
}: {
  currencies: string[];
  baseCurrency: string;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.accounts.add")}
      </Button>
      {/* Mounted only on opening: otherwise the whole form would live in the
          DOM of a page that is nearly always read-only. */}
      {open && (
        <AccountForm
          currencies={currencies}
          baseCurrency={baseCurrency}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

/** An account's verbs: correcting it or retiring it. */
export function AccountActions({
  id,
  name,
  currencies,
  baseCurrency,
}: {
  id: string;
  name: string;
  currencies: string[];
  baseCurrency: string;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  const archive = () =>
    startTransition(async () => {
      const result = await archiveAccountAction(id);
      // Archiving is rejected if the account has a balance, because taking it out
      // of net worth with no entry to explain it would lower the total for no
      // visible reason. The error says how much is there and what to do.
      if (result?.ok) toast.success(result.message);
      else if (result) toast.error(result.message);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            disabled={pending}
            aria-label={t("ui.accounts.menu", { name })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            {t("ui.accounts.correct")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={archive}>
            {t("ui.accounts.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing && (
        <AccountForm
          currencies={currencies}
          baseCurrency={baseCurrency}
          accountId={id}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

/** Returns an archived account to the list. */
export function UnarchiveAccount({ id, name }: { id: string; name: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await unarchiveAccountAction(id);
          if (result?.ok) toast.success(result.message);
          else if (result) toast.error(result.message);
        })
      }
    >
      {t("ui.accounts.unarchive")}
      <span className="sr-only"> {name}</span>
    </Button>
  );
}

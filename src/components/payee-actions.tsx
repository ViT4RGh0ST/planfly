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
import { PayeeForm, type BrandOption, type CategoryOption } from "@/components/payee-form";
import { archivePayeeAction, unarchivePayeeAction } from "@/app/(app)/actions";

/**
 * The create button, in the page header.
 *
 * A place used to be born as a side effect — the bot wrote one the first time it
 * read a name off a receipt — and could never be corrected.
 */
export function AddPayee({
  brands,
  categories,
  tiles,
  attribution,
  geocoder,
}: {
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
  geocoder: boolean;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.places.add")}
      </Button>
      {open && (
        <PayeeForm brands={brands} categories={categories}
          tiles={tiles}
          attribution={attribution}
        geocoder={geocoder}
           open={open} onOpenChange={setOpen} />
      )}
    </>
  );
}

/** A place's verbs: correcting it or retiring it. */
export function PayeeActions({
  id,
  name,
  brands,
  categories,
  tiles,
  attribution,
  geocoder,
}: {
  id: string;
  name: string;
  brands: BrandOption[];
  categories: CategoryOption[];
  tiles: string | null;
  attribution: string | null;
  geocoder: boolean;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  const archive = () =>
    startTransition(async () => {
      const result = await archivePayeeAction(id);
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
            aria-label={t("ui.places.menu", { name })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            {t("ui.places.correct")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={archive}>
            {t("ui.places.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing && (
        <PayeeForm
          brands={brands}
          categories={categories}
          tiles={tiles}
          attribution={attribution}
        geocoder={geocoder}
          
          payeeId={id}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

/** Returns an archived place to the list. */
export function UnarchivePayee({ id, name }: { id: string; name: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await unarchivePayeeAction(id);
          if (result?.ok) toast.success(result.message);
          else if (result) toast.error(result.message);
        })
      }
    >
      {t("ui.places.unarchive")}
      <span className="sr-only"> {name}</span>
    </Button>
  );
}

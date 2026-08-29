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
import { CategoryForm, type ParentOption } from "@/components/category-form";
import { archiveCategoryAction, unarchiveCategoryAction } from "@/app/(app)/actions";

/**
 * The create button, in the page header.
 *
 * Until now a category was only born in the seed, or invented on the fly when
 * the bot could not match one — which is how a household ends up with «comida»
 * and «Comida» both on the chart.
 */
export function AddCategory({ parents }: { parents: ParentOption[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("ui.categories.add")}
      </Button>
      {/* Mounted only on opening, like the account one: the form has no business
          living in the DOM of a page that is almost always read-only. */}
      {open && <CategoryForm parents={parents} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** A category's verbs: correcting it or retiring it. */
export function CategoryActions({
  id,
  name,
  parents,
}: {
  id: string;
  name: string;
  parents: ParentOption[];
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  const archive = () =>
    startTransition(async () => {
      const result = await archiveCategoryAction(id);
      // Archiving is refused if categories hang from it or a budget is counting
      // against it. The message says which, and what to do first.
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
            aria-label={t("ui.categories.menu", { name })}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            {t("ui.categories.correct")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={archive}>
            {t("ui.categories.archive")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing && (
        <CategoryForm
          parents={parents}
          categoryId={id}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </>
  );
}

/** Returns an archived category to the list. */
export function UnarchiveCategory({ id, name }: { id: string; name: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await unarchiveCategoryAction(id);
          if (result?.ok) toast.success(result.message);
          else if (result) toast.error(result.message);
        })
      }
    >
      {t("ui.categories.unarchive")}
      <span className="sr-only"> {name}</span>
    </Button>
  );
}

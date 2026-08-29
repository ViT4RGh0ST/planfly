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
import {
  categoryForEdit,
  createCategoryAction,
  editCategoryAction,
  type ActionState,
  type EditableCategory,
} from "@/app/(app)/actions";

/** A category that can be a parent: top level, unarchived, and of its own kind. */
export type ParentOption = { id: string; name: string; kind: "expense" | "income" };

const KINDS = ["expense", "income"] as const;

/** What the `<select>` sends for «hangs from nothing». An empty value is a choice. */
const NO_PARENT = "none";

/**
 * Creating and correcting a category.
 *
 * In a dialog for the same reason as the account one: the categories screen is
 * read far more often than it is written, and a permanent form would take half
 * of it to say nothing most days.
 *
 * The field that matters here is not the name — it is **the other names**. They
 * are what the bot matches «me gasté 300 en el super» by, and this is the only
 * place a person can see or fix them. So they are a first-class field with their
 * own explanation, never an «advanced» afterthought.
 */
export function CategoryForm({
  parents,
  categoryId,
  defaultKind = "expense",
  open,
  onOpenChange,
}: {
  parents: ParentOption[];
  /** If given, that category is edited; if not, a new one is created. */
  categoryId?: string;
  defaultKind?: "expense" | "income";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const editing = Boolean(categoryId);
  const [data, setData] = useState<EditableCategory | null>(null);
  const [failed, setFailed] = useState(false);

  const [kind, setKind] = useState<"expense" | "income">(defaultKind);
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [color, setColor] = useState("#64748b");

  const [state, action, pending] = useActionState(
    async (prev: ActionState, form: FormData) => {
      const result = editing
        ? await editCategoryAction(prev, form)
        : await createCategoryAction(prev, form);
      if (result?.ok) {
        toast.success(result.message);
        onOpenChange(false);
      }
      return result;
    },
    null,
  );

  useEffect(() => {
    if (!open || !categoryId) return;
    let alive = true;
    categoryForEdit(categoryId)
      .then((result) => {
        if (!alive) return;
        if (!result) {
          setFailed(true);
          return;
        }
        setData(result);
        setKind(result.kind);
        setParentId(result.parentId ?? NO_PARENT);
        setColor(result.color);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, categoryId]);

  /*
   * Only categories of the same kind, and never itself.
   *
   * A parent of the other kind would put income under a spending total. The
   * service refuses it anyway — it is the only place that can see the tree — but
   * offering an option that is going to be rejected is offering a mistake.
   */
  const available = parents.filter((p) => p.kind === kind && p.id !== categoryId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="category-help">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("ui.categories.form.titleEdit") : t("ui.categories.form.titleNew")}
          </DialogTitle>
          <DialogDescription id="category-help">
            {t("ui.categories.form.help")}
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t("ui.categories.form.failed")}
          </p>
        )}

        {editing && !data && !failed && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ui.edit.loading")}</p>
        )}

        {(!editing || data) && (
          <form action={action} className="grid gap-4">
            {categoryId && <input type="hidden" name="id" value={categoryId} />}
            <input type="hidden" name="kind" value={kind} />
            <input
              type="hidden"
              name="parent_id"
              value={parentId === NO_PARENT ? "" : parentId}
            />

            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="category-name">{t("ui.categories.form.name")}</Label>
                <Input
                  id="category-name"
                  name="name"
                  defaultValue={data?.name}
                  placeholder={t("ui.categories.form.namePlaceholder")}
                  required
                  autoFocus={!editing}
                />
              </div>

              {/* The colour is not decoration: it is the one the chart paints
                  this category with, so it is picked where it is understood. */}
              <div className="grid gap-2">
                <Label htmlFor="category-color">{t("ui.categories.form.color")}</Label>
                <input
                  id="category-color"
                  name="color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-9 w-16 cursor-pointer rounded-md border border-input bg-transparent p-1"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="category-kind">{t("ui.categories.form.kind")}</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    setKind(value as "expense" | "income");
                    // The parent belonged to the other kind: keeping it would
                    // send a rejection the person did not ask for.
                    setParentId(NO_PARENT);
                  }}
                  disabled={data?.kindLocked}
                >
                  <SelectTrigger
                    id="category-kind"
                    className="w-full"
                    aria-describedby={data?.kindLocked ? "kind-locked" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`domain.entryKind.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {data?.kindLocked && (
                  <p id="kind-locked" className="text-xs text-muted-foreground">
                    {t("ui.categories.form.kindLocked", { n: data.entries })}
                  </p>
                )}
              </div>

              <div className="grid min-w-0 gap-2">
                <Label htmlFor="category-parent">
                  {t("ui.categories.form.parent")}{" "}
                  <span className="text-muted-foreground">{t("ui.form.optional")}</span>
                </Label>
                <Select
                  value={parentId}
                  onValueChange={setParentId}
                  // A category with children of its own cannot become a child:
                  // that would be a third level, and no budget looks that deep.
                  disabled={data?.hasChildren}
                >
                  <SelectTrigger
                    id="category-parent"
                    className="w-full"
                    aria-describedby={data?.hasChildren ? "parent-locked" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PARENT}>{t("ui.categories.form.noParent")}</SelectItem>
                    {available.map((parent) => (
                      <SelectItem key={parent.id} value={parent.id}>
                        {parent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {data?.hasChildren && (
                  <p id="parent-locked" className="text-xs text-muted-foreground">
                    {t("ui.categories.form.parentLocked")}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="category-aliases">
                {t("ui.categories.form.aliases")}{" "}
                <span className="text-muted-foreground">{t("ui.form.optional")}</span>
              </Label>
              <Input
                id="category-aliases"
                name="aliases"
                defaultValue={data?.aliases}
                placeholder={t("ui.categories.form.aliasesPlaceholder")}
                aria-describedby="category-aliases-help"
              />
              <p id="category-aliases-help" className="text-xs text-muted-foreground">
                {t("ui.categories.form.aliasesHelp")}
              </p>
            </div>

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
                {pending
                  ? t("ui.form.saving")
                  : editing
                    ? t("ui.edit.saveChanges")
                    : t("ui.categories.form.create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

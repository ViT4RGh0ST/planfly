import { useTranslations } from "next-intl";

import { CategoryActions } from "@/components/category-actions";
import type { ParentOption } from "@/components/category-form";
import type { CategoryNode } from "@/lib/services/manage-categories";
import { cn } from "@/lib/utils";

/**
 * The categories, as the tree they are.
 *
 * A category has no balance, so the right-hand column that carries the eye on
 * /accounts is not available here. What matters on this screen is the two
 * things that decide where an expense lands: **the other names** the bot
 * matches by, and **who hangs from whom**, because a budget covers a category
 * together with its children.
 *
 * So the aliases are the row's second line rather than a detail hidden in the
 * dialog, and a category with none says so: that is not an empty field, it is a
 * category the bot can only reach by writing its name almost exactly.
 *
 * The colour square is the one the chart paints it with. It is the only place
 * where the palette of the dashboard can be seen whole and be fixed.
 */
export function CategoryList({
  categories,
  parents,
}: {
  categories: CategoryNode[];
  parents: ParentOption[];
}) {
  const t = useTranslations();

  if (categories.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("ui.categories.empty")}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {categories.map((category) => (
        <li key={category.id}>
          <Row category={category} parents={parents} />
          {category.children.length > 0 && (
            <ul className="mb-1 ml-3 border-l border-border pl-4">
              {category.children.map((child) => (
                <li key={child.id}>
                  <Row category={child} parents={parents} nested />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Row({
  category,
  parents,
  nested = false,
}: {
  category: CategoryNode;
  parents: ParentOption[];
  nested?: boolean;
}) {
  const t = useTranslations();
  // What the row counts is the whole branch, because that is what a budget on it
  // counts. A parent with six entries under it is not an unused category.
  const entries = category.entriesInTree;
  const unused = entries === 0;

  return (
    <div className={cn("flex items-start justify-between gap-4 py-3", nested && "py-2")}>
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className={cn("mt-1.5 shrink-0 rounded-[3px]", nested ? "size-2" : "size-2.5")}
          style={{ backgroundColor: category.color }}
        />
        <div className="min-w-0">
          <p className={cn("truncate text-sm", unused && "text-muted-foreground")}>
            {category.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {category.aliases.length > 0 ? (
              category.aliases.join(" · ")
            ) : (
              /* Not an empty field: a category the bot only reaches by its own
                 name. Saying so here is what makes somebody add one. */
              <span className="text-caution/80">{t("ui.categories.noAliases")}</span>
            )}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-1">
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {entries > 0 && t("ui.categories.entries", { n: entries })}
        </p>
        <CategoryActions id={category.id} name={category.name} parents={parents} />
      </div>
    </div>
  );
}

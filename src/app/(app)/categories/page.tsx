import { getTranslations } from "next-intl/server";

import { AddCategory, UnarchiveCategory } from "@/components/category-actions";
import { CategoryList } from "@/components/category-list";
import { requireSession } from "@/lib/session";
import { archivedCategories, categoryTree } from "@/lib/services/manage-categories";

export const dynamic = "force-dynamic";

/**
 * THESIS. Categories are what the bot listens with.
 *
 * WORLD. Everything else on this screen already had a home: an expense goes in
 * /transactions, a cap in /budgets. What had none was the vocabulary — the
 * names, and above all the OTHER names — that decides where each expense lands.
 * Until now it lived in the seed and in whatever the bot invented when it could
 * not match one, and correcting it meant psql.
 *
 * FORM. The same list as /accounts, because it is the same job: read the whole
 * thing at a glance, fix one row. Two groups, spending and income, because a
 * category of the wrong kind is the mistake with real consequences here. Each
 * child hangs under its parent, and the indentation is not decoration: a budget
 * on the parent covers its children.
 *
 * FIRST GLANCE. The vocabulary. Every row says its other names right under the
 * name, and the ones that have none say so.
 *
 * STORY. «The bot keeps filing the supermarket wrong» → open, find Mercado,
 * see that «super» is not among its names, add it.
 */
export default async function CategoriesPage() {
  const ctx = await requireSession();
  const t = await getTranslations();

  const [tree, archived] = await Promise.all([
    categoryTree(ctx.householdId),
    archivedCategories(ctx.householdId),
  ]);

  // Only the top level can be a parent: the hierarchy is two deep, so that a
  // budget covering a category and its children covers the whole tree.
  const parents = tree.map((node) => ({ id: node.id, name: node.name, kind: node.kind }));

  const groups = [
    { key: "expense", title: t("ui.categories.expense"), items: tree.filter((c) => c.kind === "expense") },
    { key: "income", title: t("ui.categories.income"), items: tree.filter((c) => c.kind === "income") },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{t("ui.categories.title")}</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("ui.categories.hint")}
          </p>
        </div>
        <AddCategory parents={parents} />
      </header>

      {/* A household with no categories cannot record anything, so this is the
          state of a fresh installation and not an edge case. */}
      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("ui.categories.empty")}</p>
      )}

      {groups.map((group) => (
        <section key={group.key} className="mt-10 first:mt-0" aria-labelledby={group.key}>
          <h2
            id={group.key}
            className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {group.title}
          </h2>
          <CategoryList categories={group.items} parents={parents} />
        </section>
      ))}

      {/* Archiving does not delete. With nowhere to see them, a category
          archived by mistake could only be recovered from psql. */}
      {archived.length > 0 && (
        <section className="mt-10" aria-labelledby="archived">
          <h2
            id="archived"
            className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.categories.archived")}
          </h2>
          <ul className="divide-y divide-border">
            {archived.map((category) => (
              <li key={category.id} className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-muted-foreground">
                  {category.name} · {t(`domain.entryKind.${category.kind}`)}
                </span>
                <UnarchiveCategory id={category.id} name={category.name} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

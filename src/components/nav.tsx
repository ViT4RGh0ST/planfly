"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import {
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  CalendarClock,
  ShoppingBasket,
  PiggyBank,
  Repeat,
  Receipt,
  TrendingUp,
  Upload,
  Wallet,
} from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { setLocale } from "@/app/(app)/actions";
import { LOCALES } from "@/i18n/config";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * Navigation.
 *
 * The seven destinations are NOT used alike: the dashboard is opened several
 * times a day and the importer once a month. A flat list presented them as
 * equals, so they go in three groups by intent — look, control, maintain — with
 * the group label as a reading anchor.
 *
 * On narrow screens it does not disappear: it becomes a horizontal scrollable
 * bar. It used to be `hidden md:flex`, which left the app with no navigation as
 * soon as the window dropped below 768px.
 */
/**
 * The structure carries keys, not words.
 *
 * The label of each group and of each link is looked up when it is painted, so
 * this table stays what it actually is: which sections exist, in which order and
 * with which icon.
 */
const GROUPS = [
  {
    key: "look",
    items: [
      { href: "/", key: "dashboard", icon: LayoutDashboard },
      { href: "/transactions", key: "transactions", icon: Receipt },
      { href: "/accounts", key: "accounts", icon: Wallet },
      { href: "/products", key: "products", icon: ShoppingBasket },
    ],
  },
  {
    key: "control",
    items: [
      { href: "/budgets", key: "budgets", icon: PiggyBank },
      { href: "/financing", key: "financing", icon: CalendarClock },
      { href: "/recurring", key: "recurring", icon: Repeat },
      { href: "/rates", key: "rates", icon: TrendingUp },
    ],
  },
  {
    key: "maintain",
    items: [
      { href: "/review", key: "review", icon: ClipboardCheck, showBadge: true },
      { href: "/import", key: "import", icon: Upload },
    ],
  },
];

/** Complete states in one place: default, hover, focus and active. Visible focus
 *  was missing entirely — the app could not be navigated by keyboard. */
function linkClasses(active: boolean) {
  return cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    active
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
  );
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Nav({
  pendingReview,
  householdName,
  userName,
  locale,
}: {
  pendingReview: number;
  householdName: string;
  userName: string;
  /** The household's language, which is what the switcher below changes. */
  locale: string;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();

  const quit = async () => {
    await signOut();
    router.push("/login");
  };

  return (
    <>
      {/* Narrow: a scrollable horizontal bar, with no group labels. */}
      <nav
        aria-label={t("ui.nav.sections")}
        className="flex gap-1 overflow-x-auto border-b border-sidebar-border bg-sidebar px-3 py-2 md:hidden"
      >
        {GROUPS.flatMap((group) => group.items).map(({ href, key, icon: Icon, showBadge }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(pathname, href) ? "page" : undefined}
            className={cn(linkClasses(isActive(pathname, href)), "shrink-0")}
          >
            <Icon className="size-4 shrink-0" />
            {t(`ui.nav.${key}`)}
            {showBadge && pendingReview > 0 && <ReviewCount value={pendingReview} />}
          </Link>
        ))}
      </nav>

      {/* Desktop: the real use. */}
      <nav
        aria-label={t("ui.nav.sections")}
        className="hidden h-full flex-col gap-6 bg-sidebar p-3 md:flex"
      >
        <div className="flex items-center gap-2.5 px-2 pt-2">
          <BrandMark className="size-5" />
          <span className="text-base font-semibold tracking-tight">planfly</span>
        </div>

        {GROUPS.map((group) => (
          <div key={group.key}>
            {/* No opacity and at 12px: with `/70` the contrast fell to 2.6:1
                on the sidebar's dark surface, and 11px added a fifth step to an
                already tight type scale. */}
            <p className="mb-1 px-3 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {t(`ui.nav.group.${group.key}`)}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map(({ href, key, icon: Icon, showBadge }) => {
                const active = isActive(pathname, href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={linkClasses(active)}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1">{t(`ui.nav.${key}`)}</span>
                      {showBadge && pendingReview > 0 && <ReviewCount value={pendingReview} />}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <div className="mt-auto border-t border-sidebar-border pt-3">
          <p className="truncate px-3 text-sm">{householdName}</p>
          <p className="truncate px-3 text-xs text-muted-foreground">{userName}</p>
          <LanguagePicker current={locale} />
          <button
            type="button"
            onClick={quit}
            className={cn(
              "mt-2 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm",
              "text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          >
            <LogOut className="size-4" />
            {t("ui.nav.signOut")}
          </button>
        </div>
      </nav>
    </>
  );
}

/** The pending counter does not rely on colour alone: it carries its own
 *  accessible label, because a red dot does not say what it counts. */
function ReviewCount({ value }: { value: number }) {
  const t = useTranslations();
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-caution/20 px-1.5 text-xs font-medium tabular-nums text-caution">
      {value}
      <span className="sr-only">{t("ui.nav.pendingReview", { n: value })}</span>
    </span>
  );
}

/**
 * The language, beside the household's name.
 *
 * There is no settings screen, and building one for a single choice would be a
 * whole section for two words. It goes here because that is where the household
 * already is: the language is a property of the household, not a preference of
 * the browser — the bot reads the same column.
 *
 * Two labels and not a dropdown: with exactly two options, a menu hides one of
 * them behind a click to save a line that is already there.
 */
function LanguagePicker({ current }: { current: string }) {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <div className="mt-2 flex items-center gap-1 px-3">
      <span className="sr-only" id="nav-language">
        {t("ui.nav.language")}
      </span>
      <div role="radiogroup" aria-labelledby="nav-language" className="flex gap-2">
        {LOCALES.map((option) => {
          const active = option === current;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending || active}
              onClick={() => startTransition(() => void setLocale(option))}
              className={cn(
                "rounded-sm text-xs transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "text-sidebar-foreground"
                  : "text-muted-foreground hover:text-sidebar-foreground",
              )}
            >
              {t(`ui.nav.languageName.${option}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

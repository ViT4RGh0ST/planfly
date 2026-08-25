import { asc } from "drizzle-orm";

import { AccountList } from "@/components/account-list";
import { AddAccount, UnarchiveAccount } from "@/components/account-actions";
import { NetWorth } from "@/components/net-worth";
import { db } from "@/db";
import { currencies as currenciesTable } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { today } from "@/lib/dates";
import { currentRates } from "@/lib/rates/service";
import { archivedAccounts } from "@/lib/services/manage-accounts";
import { committedInstallments, netWorth, type Valuation } from "@/lib/services/reports";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Accounts: the detail behind "how much do I have?".
 *
 * It reuses the same net position piece as the dashboard — it used to be three
 * cards with net worth, assets and liabilities, which repeated the dashboard's
 * grid and hid one of the two valuations all over again.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ rate?: string }>;
}) {
  const ctx = await requireSession();
  const t = await getTranslations();
  const params = await searchParams;
  const valuation: Valuation = params.rate === "bcv" ? "bcv" : "p2p";
  const base = ctx.baseCurrency;
  const date = today(ctx.timezone);

  const [position, committed, rates, currencyList, archived] = await Promise.all([
    netWorth(ctx.householdId, date, base),
    committedInstallments(ctx.householdId, date, base),
    currentRates(date),
    // `currencies` is a table with a foreign key: an account can only be opened
    // in a currency that exists there.
    db.select({ code: currenciesTable.code }).from(currenciesTable).orderBy(asc(currenciesTable.code)),
    archivedAccounts(ctx.householdId),
  ]);

  const currencyCodes = currencyList.map((c) => c.code);

  const spread =
    rates.bcv && rates.p2p
      ? (Number(rates.p2p.rate) / Number(rates.bcv.rate) - 1) * 100
      : null;

  const groups = [
    { key: "assets", title: t("ui.accounts.assets"), items: position.accounts.filter((a) => a.nature === "asset") },
    { key: "liabilities", title: t("ui.accounts.liabilities"), items: position.accounts.filter((a) => a.nature === "liability") },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-tight">{t("ui.accounts.title")}</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("ui.accounts.hint")}
          </p>
        </div>
        <AddAccount currencies={currencyCodes} baseCurrency={base} />
      </header>

      <NetWorth
        bcvMinor={position.totalBcvMinor}
        p2pMinor={position.totalP2pMinor}
        assetsBcvMinor={position.assetsBcvMinor}
        assetsP2pMinor={position.assetsP2pMinor}
        liabilitiesBcvMinor={position.liabilitiesBcvMinor}
        liabilitiesP2pMinor={position.liabilitiesP2pMinor}
        currency={base}
        spreadPercent={spread}
        accountCount={position.accounts.length}
        coverage={position.coverage}
        committed={committed}
      />

      {groups.map((group) => (
        <section key={group.key} className="mt-10" aria-labelledby={group.key}>
          <h2
            id={group.key}
            className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {group.title}
          </h2>
          <AccountList
            accounts={group.items}
            baseCurrency={base}
            valuation={valuation}
            currencies={currencyCodes}
          />
        </section>
      ))}

      {/* Archiving does not delete. With nowhere to see them, an account
          archived by mistake could only be recovered from psql. */}
      {archived.length > 0 && (
        <section className="mt-10" aria-labelledby="archivadas">
          <h2
            id="archivadas"
            className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
          >
            {t("ui.accounts.archived")}
          </h2>
          <ul className="divide-y divide-border">
            {archived.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-4 py-2">
                <span className="text-sm text-muted-foreground">
                  {account.name} · {account.currency}
                </span>
                <UnarchiveAccount id={account.id} name={account.name} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

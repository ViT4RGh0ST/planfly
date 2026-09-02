import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { archiveAccount, createAccount, unarchiveAccount, updateAccount } from "./manage-accounts";
import { accountBalance } from "./balances";
import { netWorth } from "./reports";
import { recordTransaction } from "./record-transaction";
import { db, pool } from "@/db";
import { accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

/** The nature that ended up stored, which is what decides whether it adds or subtracts. */
async function natureOf(id: string): Promise<string> {
  const [row] = await db.select({ nature: accounts.nature }).from(accounts).where(eq(accounts.id, id));
  return row.nature;
}

/**
 * Opening, correcting and archiving accounts, against the database.
 *
 * This is where it is decided whether something adds to or subtracts from net
 * worth. A badly inferred type does not fail: it leaves a debt counting as money
 * you have.
 */
const DATE = "2026-08-21";
const TZ = "America/Caracas";
let e: Scenario;

describe("managing accounts", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("a card is born a liability without anyone saying so", async () => {
    // The nature is inferred from the type on purpose: asking for it invites
    // marking a card as an asset, and then the debt ADDS to net worth.
    const r = await createAccount({
      householdId: e.home.id, locale: "es", timezone: TZ,
      name: "Visa", type: "credit_card", currency: "VES", openingBalance: "1.000,00",
    });
    assert.equal(await natureOf(r.id), "liability");
    assert.equal(await accountBalance(r.id), -100000, "la deuda se guarda en negativo");
  });

  it("and that's why a debt lowers net worth", async () => {
    const n = await netWorth(e.home.id, DATE, "USD");
    assert.ok(n.liabilitiesOfficialMinor < 0, "los pasivos entran negativos al total");
  });

  it("a bank account is born an asset and its opening balance adds", async () => {
    const r = await createAccount({
      householdId: e.home.id, locale: "es", timezone: TZ,
      name: "Ahorros", type: "bank", currency: "VES", openingBalance: "5.000,00",
    });
    assert.equal(await natureOf(r.id), "asset");
    assert.equal(await accountBalance(r.id), 500000);
  });

  it("a duplicate name is rejected by naming the one that already exists", async () => {
    await assert.rejects(
      () => createAccount({
        householdId: e.home.id, locale: "es", timezone: TZ, name: "Ahorros", type: "bank", currency: "VES",
      }),
      /Ahorros/,
    );
  });

  it("changing the currency of an account with entries is rejected", async () => {
    // The invariant is that a line's currency is its account's. Changing it with
    // entries inside breaks it in silence: the amounts stay as they are and start
    // being read in another currency.
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "100,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
    });
    await assert.rejects(
      () => updateAccount({
        householdId: e.home.id, locale: "es", accountId: e.cash.id, currency: "USD",
      }),
      /movimiento|moneda/i,
    );
  });

  it("archiving an account with a balance is rejected; with none it's allowed", async () => {
    // Archiving takes it out of net worth: doing so with a balance would make that
    // money vanish from the total with no entry to explain it.
    const withBalance = await createAccount({
      householdId: e.home.id, locale: "es", timezone: TZ,
      name: "Con saldo", type: "bank", currency: "VES", openingBalance: "300,00",
    });
    await assert.rejects(
      () => archiveAccount(e.home.id, withBalance.id),
      /saldo/i,
    );

    const empty = await createAccount({
      householdId: e.home.id, locale: "es", timezone: TZ, name: "Vacía", type: "bank", currency: "VES",
    });
    await archiveAccount(e.home.id, empty.id);
    await unarchiveAccount(e.home.id, empty.id);
  });
});

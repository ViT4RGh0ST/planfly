import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { pool } from "@/db";
import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import {
  archivePayee,
  createPayee,
  payeeTree,
  placeUnplaced,
  unarchivePayee,
  unplacedGroups,
  updatePayee,
} from "./manage-payees";
import { formatTaxId, normalizeTaxId } from "@/lib/tax-id";
import { resolvePayee } from "./resolve-entities";
import { recordTransaction } from "./record-transaction";

/**
 * The places you buy from, against the database.
 *
 * The mistake this screen can make is not losing a place: it is having the same
 * shop twice. Nothing fails when that happens — its price history simply gets
 * split down the middle, and neither half tells you what anything costs.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("managing places", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("the fiscal id is compared however it was typed", () => {
    assert.equal(normalizeTaxId("J-30012345-6"), "J300123456");
    assert.equal(normalizeTaxId("j 30012345 6"), "J300123456");
    assert.equal(normalizeTaxId("  "), null);
    // And read back the way the invoice prints it, which is what somebody holds
    // next to the screen.
    assert.equal(formatTaxId("J300123456"), "J-30012345-6");
    // Anything that is not that shape is printed as it was typed rather than
    // given dashes it does not have.
    assert.equal(formatTaxId("ABC123"), "ABC123");
  });

  it("a repeated fiscal id stops, and goes through when it really is another branch", async () => {
    /*
     * Both readings are real, and only the person knows which. A franchise gives
     * every branch its own company and its own fiscal id; a chain of its own
     * gives all of them the same one. So the machine may not decide: it stops,
     * names the row in the way, and can be told to go ahead.
     */
    await createPayee({
      householdId: e.home.id, locale: "es",
      name: "Farmatodo La Trinidad", taxId: "J-30012345-6",
    });

    await assert.rejects(
      () =>
        createPayee({
          householdId: e.home.id, locale: "es",
          name: "Farmatodo Chacao", taxId: "J300123456",
        }),
      /Farmatodo La Trinidad/,
      "it has to name the place already carrying it, not just refuse",
    );

    const second = await createPayee({
      householdId: e.home.id, locale: "es",
      name: "Farmatodo Chacao", taxId: "J-30012345-6", allowSharedTaxId: true,
    });
    assert.ok(second.id);
  });

  it("the address is what tells one shop written twice from two branches", async () => {
    /*
     * A branch IS a location. Same company at the same address is the row you
     * already have — writing it again halves its price history. Same company at
     * another address is a second branch, which is ordinary. The two need
     * different words, because the thing to do about them is different.
     */
    const home = (await seedScenario({ date: DATE })).home;
    await createPayee({
      householdId: home.id, locale: "es",
      name: "Excelsior Gama Plus", taxId: "J-00099887-1", address: "Av. Andrés Bello, Caracas",
    });

    await assert.rejects(
      () =>
        createPayee({
          householdId: home.id, locale: "es",
          name: "Gama Plus Bello", taxId: "J000998871", address: "av andres bello, caracas",
        }),
      /es la tienda que ya tienes/i,
      "the same address, however it was typed, is the same shop",
    );

    await assert.rejects(
      () =>
        createPayee({
          householdId: home.id, locale: "es",
          name: "Excelsior Gama Santa Eduvigis", taxId: "J000998871", address: "Av. Santa Eduvigis",
        }),
      /segunda sucursal/i,
      "another address of the same company reads as a branch, and says so",
    );
  });

  it("two branches are two places and still one total", async () => {
    const home = (await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" })).home;
    const brand = await createPayee({ householdId: home.id, locale: "es", name: "Central Madeirense" });
    const one = await createPayee({
      householdId: home.id, locale: "es", name: "Madeirense Santa Fe", parentId: brand.id,
    });
    const two = await createPayee({
      householdId: home.id, locale: "es", name: "Madeirense El Cafetal", parentId: brand.id,
    });

    for (const payeeId of [one.id, one.id, two.id]) {
      await recordTransaction({
        householdId: home.id, kind: "expense", amount: "500,00", currency: "VES",
        account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
        payeeId,
      });
    }

    const tree = await payeeTree(home.id);
    const chain = tree.find((p) => p.id === brand.id);
    assert.ok(chain, "the brand is a root");
    assert.equal(chain.branches.length, 2, "both branches hang off it");
    assert.equal(chain.entries, 0, "a brand carries no purchases of its own");
    assert.equal(chain.entriesInTree, 3, "and its total is its branches'");
  });

  it("a chain goes two levels and no more", async () => {
    const home = (await seedScenario({ date: DATE })).home;
    const brand = await createPayee({ householdId: home.id, locale: "es", name: "Excelsior Gama" });
    const branch = await createPayee({
      householdId: home.id, locale: "es", name: "Gama Express Los Palos Grandes", parentId: brand.id,
    });

    // A third level would be counted by no total: the chain's would quietly stop
    // including a shop.
    await assert.rejects(
      () =>
        createPayee({
          householdId: home.id, locale: "es", name: "Gama caja 3", parentId: branch.id,
        }),
      /Gama Express/,
    );

    // Picking a branch as the brand is refused naming the branch, which is the
    // thing the person chose wrongly.
    await assert.rejects(
      () =>
        updatePayee({
          householdId: home.id, payeeId: brand.id, locale: "es", parentId: branch.id,
        }),
      /Gama Express/,
    );

    // And a place that already has branches cannot become one, even under a
    // brand that is perfectly valid: that would be the third level again.
    const other = await createPayee({ householdId: home.id, locale: "es", name: "Supermercados Unicasa" });
    await assert.rejects(
      () =>
        updatePayee({
          householdId: home.id, payeeId: brand.id, locale: "es", parentId: other.id,
        }),
      /Excelsior Gama/,
    );
  });

  it("two places may not answer to the same other name", async () => {
    const home = (await seedScenario({ date: DATE })).home;
    await createPayee({
      householdId: home.id, locale: "es", name: "Automercado Plaza", aliases: "plaza, plazas",
    });

    await assert.rejects(
      () =>
        createPayee({
          householdId: home.id, locale: "es", name: "Plaza Merú", aliases: "plaza",
        }),
      /Automercado Plaza/,
      // Sharing one splits a shop's price history in two, alphabetically.
      "the message has to name the place that already answers to it",
    );
  });

  it("archiving takes it out of the bot's reach and leaves its purchases alone", async () => {
    const home = (await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" })).home;
    const shop = await createPayee({
      householdId: home.id, locale: "es", name: "Bodega La Esquina", aliases: "la esquina",
    });
    await recordTransaction({
      householdId: home.id, kind: "expense", amount: "80,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: DATE, source: "form",
      payeeId: shop.id,
    });

    assert.equal((await resolvePayee(home.id, "la esquina"))?.id, shop.id);

    await archivePayee(home.id, shop.id);
    assert.equal(
      await resolvePayee(home.id, "la esquina"),
      null,
      "an archived place must stop being offered — the shop closed",
    );
    assert.equal(
      (await payeeTree(home.id)).find((p) => p.id === shop.id),
      undefined,
      "and it leaves the list",
    );

    await unarchivePayee(home.id, shop.id);
    const back = (await payeeTree(home.id)).find((p) => p.id === shop.id);
    assert.equal(back?.entries, 1, "its purchase was never touched");
  });

  it("gives a place to every entry that says the same thing, and to no other", async () => {
    /*
     * The repair for months of entries whose shop only ever existed inside the
     * description. It groups so a person decides once for forty rows — and the
     * risk of that is the whole reason it is written by exact description: one
     * shop's prices landing under another does not fail, it just draws a curve
     * that is wrong and looks fine.
     */
    const home = (await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" })).home;
    const shop = await createPayee({ householdId: home.id, locale: "es", name: "Mi Super, C.A" });

    for (const [description, on] of [
      ["Compra en MI SUPER, C.A", "2026-08-17"],
      ["Compra en MI SUPER, C.A", "2026-08-21"],
      ["Compra en OTRO SITIO", "2026-08-21"],
    ] as [string, string][]) {
      await recordTransaction({
        householdId: home.id, kind: "expense", amount: "100,00", currency: "VES",
        account: "efectivo", category: "mercado", description, occurredOn: on, source: "ocr",
      });
    }

    const { groups } = await unplacedGroups(home.id);
    const mine = groups.find((g) => g.description === "Compra en MI SUPER, C.A");
    assert.equal(mine?.entries, 2, "the two that say the same thing are one decision");
    assert.ok(
      groups.some((g) => g.description === "Compra en OTRO SITIO"),
      "and the other one is its own",
    );

    const done = await placeUnplaced(home.id, "Compra en MI SUPER, C.A", shop.id);
    assert.equal(done.n, 2);

    const { groups: after } = await unplacedGroups(home.id);
    assert.equal(
      after.find((g) => g.description === "Compra en MI SUPER, C.A"),
      undefined,
      "what was placed leaves the list",
    );
    assert.ok(
      after.some((g) => g.description === "Compra en OTRO SITIO"),
      "and what was not is untouched: an exact description, never a resemblance",
    );
    assert.equal((await payeeTree(home.id)).find((p) => p.id === shop.id)?.entries, 2);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "./record-transaction";
import {
  itemsOfTransaction,
  mergeProducts,
  productCatalog,
  productHistory,
  productRawTexts,
  splitProduct,
} from "./products";
import { pool } from "@/db";

/**
 * Each thing's price over time, against the database.
 *
 * It is what answers «did flour go up?», and for that the same product has to be
 * recognised across purchases even when the receipt spells it differently every
 * time. All of that lives in fuzzy matching and in SQL: a pure test says nothing.
 */
const DATE = "2026-08-21";
let e: Scenario;

async function purchaseWith(items: Array<{ description: string; total: string; quantity?: number; unit?: string }>) {
  return recordTransaction({
    householdId: e.home.id, kind: "expense", amount: "1.000,00", currency: "VES",
    account: "efectivo", category: "mercado", occurredOn: DATE, source: "ocr", items,
  });
}

describe("products against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("the breakdown keeps the receipt's own wording, not a corrected one", async () => {
    // That text is the only thing that shows the match got it wrong.
    const r = await purchaseWith([{ description: "H.PAN 1KG", total: "80,00", quantity: 1, unit: "kg" }]);
    const items = await itemsOfTransaction(e.home.id, r.transactionId!);
    assert.equal(items.length, 1);
    assert.equal(items[0].rawText, "H.PAN 1KG");
  });

  it("the same product spelled similarly is recognised across purchases", async () => {
    await purchaseWith([{ description: "H PAN 1 KG", total: "95,00", quantity: 1, unit: "kg" }]);
    const catalog = await productCatalog(e.home.id, "p2p");
    const flour = catalog.filter((p) => /pan/i.test(p.name));
    assert.equal(flour.length, 1, `tenía que ser un solo producto, salieron ${flour.length}`);
    assert.ok(flour[0].timesBought >= 2, "con las dos compras contadas");
  });

  it("the history shows the price of each purchase", async () => {
    const catalog = await productCatalog(e.home.id, "p2p");
    const flour = catalog.find((p) => /pan/i.test(p.name))!;
    const h = await productHistory(e.home.id, flour.id);
    assert.ok(h, "el producto existe");
    assert.ok(h!.points.length >= 2, "una serie con las dos compras");
  });

  it("the line items don't have to add up to the receipt total", async () => {
    // A receipt carries VAT, discounts and line items the OCR did not read. The
    // entry is worth what the paper says; the difference is shown.
    const r = await purchaseWith([{ description: "ARROZ", total: "50,00" }]);
    assert.equal(r.amount.minor, -100000, "el total manda sobre las líneas");
    assert.ok(r.unitemizedMinor > 0, "y se dice cuánto quedó sin desglosar");
  });

  it("two variants of the same name merge on their own, even when they're different things", async () => {
    /*
     * Documents TODAY's behaviour, which is neither obvious nor free:
     * «AZUCAR MORENA» and «AZUCAR BLANCA» end up as ONE product, and their price
     * history gets mixed. The threshold is set to recognise OCR variants of the
     * same line item — «H.PAN 1KG» and «H PAN 1 KG» — and there it gets it
     * right; with two products sharing a first word, it does not.
     *
     * It is undone with `splitProduct` — the tests below — which is the reason
     * not to lower the threshold: lowering it would break the OCR variants,
     * which are the common case. If it is ever adjusted, this test will say what
     * changed instead of letting it through in silence.
     */
    await purchaseWith([{ description: "AZUCAR MORENA", total: "40,00" }]);
    await purchaseWith([{ description: "AZUCAR BLANCA", total: "45,00" }]);
    const sugars = (await productCatalog(e.home.id, "p2p")).filter((p) => /AZUCAR/i.test(p.name));
    assert.equal(sugars.length, 1, "hoy se funden; si esto cambia, revisa el listón");
    assert.equal(sugars[0].timesBought, 2, "y comparten histórico de precios");
  });

  it("merging two products joins their history without losing purchases", async () => {
    await purchaseWith([{ description: "CAFE MOLIDO", total: "40,00" }]);
    await purchaseWith([{ description: "JABON AZUL", total: "45,00" }]);
    const before = await productCatalog(e.home.id, "p2p");
    const a = before.find((p) => /CAFE/i.test(p.name))!;
    const b = before.find((p) => /JABON/i.test(p.name))!;

    await mergeProducts(e.home.id, a.id, b.id);

    const after = await productCatalog(e.home.id, "p2p");
    assert.ok(!after.some((p) => p.id === a.id), "el fusionado desaparece del catálogo");
    const destination = after.find((p) => p.id === b.id)!;
    assert.ok(destination.timesBought >= 2, "y sus compras se suman al que queda");
  });

  /*
   * Splitting: the reverse of merging.
   *
   * It is tested against the database and not in pure code because what has to
   * be shown is not that the rows move — that is an UPDATE — but that **they
   * stay apart**: the fuzzy matching that joined them is still there, and a
   * split the next purchase undoes is not a split, it is a bit of wasted work.
   */

  it("a product's lines can be seen by the wording each receipt carried", async () => {
    const sugar = (await productCatalog(e.home.id, "p2p")).find((p) => /AZUCAR/i.test(p.name))!;
    const texts = await productRawTexts(e.home.id, sugar.id);

    assert.equal(texts.length, 2, "los dos renglones distintos que cayeron aquí");
    assert.deepEqual(
      texts.map((t) => t.rawText).sort(),
      ["AZUCAR BLANCA", "AZUCAR MORENA"],
    );
    assert.ok(texts.every((t) => t.count === 1));
  });

  it("splitting pulls a line item into its own product, purchases and all", async () => {
    const before = (await productCatalog(e.home.id, "p2p")).find((p) => /AZUCAR/i.test(p.name))!;

    const r = await splitProduct(e.home.id, before.id, "AZUCAR BLANCA");
    assert.ok(r.productId !== before.id, "es un producto nuevo, no el mismo");

    const sugars = (await productCatalog(e.home.id, "p2p")).filter((p) => /AZUCAR/i.test(p.name));
    assert.equal(sugars.length, 2, "ahora son dos");
    assert.ok(sugars.every((p) => p.timesBought === 1), "una compra cada uno");
  });

  it("and the next purchase no longer lands back in the other one", async () => {
    // The test that justifies the function: if matching joins them again,
    // splitting only worked until the next receipt.
    await purchaseWith([{ description: "AZUCAR BLANCA", total: "48,00" }]);

    const sugars = (await productCatalog(e.home.id, "p2p")).filter((p) => /AZUCAR/i.test(p.name));
    assert.equal(sugars.length, 2, "siguen siendo dos");
    const white = sugars.find((p) => /BLANCA/i.test(p.name))!;
    assert.equal(white.timesBought, 2, "la compra nueva fue a la blanca");
    assert.equal(sugars.find((p) => /MORENA/i.test(p.name))!.timesBought, 1, "y la morena sigue igual");
  });

  it("splitting also undoes a hand-made merge, alias included", async () => {
    // `mergeProducts` leaves the loser's name as the winner's alias, and an
    // alias matches at 0.99: without stripping it, the next purchase would merge
    // them again by the path next door.
    const soap = (await productCatalog(e.home.id, "p2p")).find((p) => /JABON/i.test(p.name))!;

    await splitProduct(e.home.id, soap.id, "CAFE MOLIDO");
    await purchaseWith([{ description: "CAFE MOLIDO", total: "42,00" }]);

    const coffee = (await productCatalog(e.home.id, "p2p")).filter((p) => /CAFE/i.test(p.name));
    assert.equal(coffee.length, 1, "un solo café");
    assert.equal(coffee[0].timesBought, 2, "y las dos compras suyas, no del jabón");
    assert.equal(
      (await productCatalog(e.home.id, "p2p")).find((p) => /JABON/i.test(p.name))!.timesBought,
      1,
      "el jabón se queda con lo suyo",
    );
  });

  it("wording the product doesn't have is rejected instead of creating an empty product", async () => {
    const sugar = (await productCatalog(e.home.id, "p2p")).find((p) => /MORENA/i.test(p.name))!;
    await assert.rejects(
      () => splitProduct(e.home.id, sugar.id, "PAPEL HIGIENICO"),
      /ninguna línea/i,
    );
  });

  it("splitting a product from itself is rejected instead of amounting to nothing", async () => {
    // The case one finger away: the list of line items includes the one giving
    // the product its name, and tapping it would move its lines to itself.
    // Without the guard it is a success that does nothing, the worst answer possible.
    const rice = (await productCatalog(e.home.id, "p2p")).find((p) => /ARROZ/i.test(p.name))!;
    await assert.rejects(() => splitProduct(e.home.id, rice.id, "ARROZ"), /nombre de este producto/i);

    // And the other side of the same thing, with the state forced because the
    // app cannot reach it: a product whose lines ALL say something else.
    // Splitting them would leave it empty, which is renaming it the long way.
    await pool.query(`UPDATE transaction_items SET raw_text = 'ARROZ BLANCO' WHERE product_id = $1`, [
      rice.id,
    ]);
    await assert.rejects(
      () => splitProduct(e.home.id, rice.id, "ARROZ BLANCO"),
      /todas sus líneas/i,
    );
  });

  it("if the split product already exists, the lines join it instead of duplicating it", async () => {
    // Two splits in a row of the same text, or splitting something already in
    // the catalogue: creating a second "AZUCAR BLANCA" would hit the slug's
    // unique index, and the whole screen would come down with it.
    await purchaseWith([{ description: "AZUCAR MORENA", total: "41,00" }]);
    const brown = (await productCatalog(e.home.id, "p2p")).find((p) => /MORENA/i.test(p.name))!;
    // A line carrying the white one's text is forced in, as if matching had
    // failed again.
    await pool.query(
      `UPDATE transaction_items SET raw_text = 'AZUCAR BLANCA'
        WHERE product_id = $1 AND ctid = (SELECT ctid FROM transaction_items WHERE product_id = $1 LIMIT 1)`,
      [brown.id],
    );

    const r = await splitProduct(e.home.id, brown.id, "AZUCAR BLANCA");
    const white = (await productCatalog(e.home.id, "p2p")).find((p) => /BLANCA/i.test(p.name))!;
    assert.equal(r.productId, white.id, "reusa el que ya estaba");
    assert.equal(
      (await productCatalog(e.home.id, "p2p")).filter((p) => /BLANCA/i.test(p.name)).length,
      1,
      "y no deja dos con el mismo nombre",
    );
  });
});

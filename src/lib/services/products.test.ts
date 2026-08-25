import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { itemsNeedReview, itemsTotal, normalizeQuantity } from "./products";

/**
 * Normalisation is where a price chart starts lying without anything failing: if
 * 500 g comes in as 500 and 1 kg as 1, the product looks like it dropped five
 * hundredfold.
 */
describe("normalizeQuantity", () => {
  it("takes grams to kilos", () => {
    assert.deepEqual(normalizeQuantity(750, "g"), {
      baseUnit: "kg",
      baseQuantity: 0.75,
      unit: "g",
    });
  });

  it("takes millilitres to litres", () => {
    assert.deepEqual(normalizeQuantity(500, "ml"), {
      baseUnit: "l",
      baseQuantity: 0.5,
      unit: "ml",
    });
  });

  it("leaves the kilo and the litre as they are", () => {
    assert.equal(normalizeQuantity(2, "kg").baseQuantity, 2);
    assert.equal(normalizeQuantity(1.5, "L").baseQuantity, 1.5);
  });

  it("copes with the ways a receipt actually spells them", () => {
    for (const u of ["KG", "kgs", "Kilo", "kilos"]) {
      assert.equal(normalizeQuantity(1, u).baseUnit, "kg", u);
    }
    for (const u of ["GR", "grs", "gramos"]) {
      assert.equal(normalizeQuantity(1000, u).baseQuantity, 1, u);
    }
    for (const u of ["LT", "lts", "Litros"]) {
      assert.equal(normalizeQuantity(1, u).baseUnit, "l", u);
    }
  });

  it("what it doesn't recognise is counted by units, inventing no equivalences", () => {
    // A pack is neither kilos nor litres, and pretending it is dirties the one
    // series that matters.
    for (const u of ["paquete", "und", "u", "bolsa", ""]) {
      assert.equal(normalizeQuantity(3, u).baseUnit, "unit", u || "(empty)");
      assert.equal(normalizeQuantity(3, u).baseQuantity, 3, u || "(empty)");
    }
    assert.equal(normalizeQuantity(3, null).baseUnit, "unit");
  });

  it("a tiny quantity is never rounded to zero", () => {
    // Dividing by zero to get the unit price would give infinity.
    assert.ok(normalizeQuantity(0.01, "g").baseQuantity > 0);
  });

  it("comparing 500 g with 1 kg gives the right answer", () => {
    // Bs 150 for 500 g is Bs 300 a kilo; Bs 280 a kilo is CHEAPER.
    const media = normalizeQuantity(500, "g").baseQuantity;
    const entero = normalizeQuantity(1, "kg").baseQuantity;
    assert.equal(15000 / media, 30000);
    assert.equal(28000 / entero, 28000);
    assert.ok(28000 / entero < 15000 / media);
  });
});

describe("itemsTotal", () => {
  it("adds up what was itemised, which is almost never the receipt total", () => {
    assert.equal(itemsTotal([{ totalMinor: 12000 }, { totalMinor: 34550 }]), 46550);
    assert.equal(itemsTotal([]), 0);
  });
});

describe("itemsNeedReview", () => {
  const item = (over: Partial<{ created: boolean; confidence: number }>) => ({
    productId: "x",
    productName: "x",
    created: false,
    confidence: 1,
    rawText: "x",
    quantity: 1,
    unit: null,
    baseQuantity: 1,
    totalMinor: 1,
    ...over,
  });

  it("a weak match sends the purchase to review", () => {
    assert.equal(itemsNeedReview([item({ confidence: 0.4 })]), true);
  });

  it("a new product is NOT a doubt: it's the first time it's been seen", () => {
    assert.equal(itemsNeedReview([item({ created: true, confidence: 1 })]), false);
  });

  it("everything matched confidently passes unflagged", () => {
    assert.equal(itemsNeedReview([item({ confidence: 0.9 }), item({ confidence: 1 })]), false);
  });
});

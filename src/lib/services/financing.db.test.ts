import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import {
  financiersView,
  financingPlansView,
  payInstallment,
  planForTransaction,
  recordFinancedPurchase,
  removeFinancierProfile,
  saveFinancierProfile,
  unpayInstallment,
  upcomingInstallments,
  voidFinancingPlan,
} from "./financing";
import { accountBalance } from "./balances";
import { pool } from "@/db";

/**
 * Installment purchases, against the database.
 *
 * Half an installment purchase is worse than none: it fails nowhere, and the
 * debt planfly shows stops being the one you have. It is two entries and a
 * schedule that have to add up with each other, and that is not visible without
 * writing it.
 */
const DATE = "2026-08-21";
let e: Scenario;

describe("financed purchases against the database", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("the total minus the down payment is what stays financed", async () => {
    // The arithmetic the bot misread from a real receipt: the down payment leaves
    // one of your own accounts, and what is left is the debt with the financier.
    const r = await recordFinancedPurchase({
      householdId: e.home.id,
      financier: "tdc",
      total: "25.480,00",
      downPayment: "5.096,00",
      downPaymentAccount: "efectivo",
      installmentCount: 4,
      occurredOn: DATE,
      description: "Nevera",
      source: "form",
    });
    assert.match(r.summary, /25\.480,00/, "el resumen dice el precio completo");
    assert.match(r.summary, /5\.096,00/, "y la inicial");

    const plans = await financingPlansView(e.home.id);
    const plan = plans.find((p) => p.description === "Nevera")!;
    assert.equal(plan.installments.length, 4);
    // 25.480 − 5.096 = 20.384, split across four.
    const sum = plan.installments.reduce((s, c) => s + c.amountMinor, 0);
    assert.equal(sum, 2038400, "las cuotas suman exactamente lo financiado");
  });

  it("the down payment leaves the account that was named, not another", async () => {
    const before = await accountBalance(e.cash.id);
    await recordFinancedPurchase({
      householdId: e.home.id, financier: "tdc",
      total: "1.000,00", downPayment: "200,00", downPaymentAccount: "efectivo",
      installmentCount: 2, occurredOn: DATE, description: "Otra", source: "form",
    });
    assert.equal(await accountBalance(e.cash.id), before - 20000);
  });

  it("a down payment larger than the total is rejected", async () => {
    await assert.rejects(
      () => recordFinancedPurchase({
        householdId: e.home.id, financier: "tdc",
        total: "100,00", downPayment: "500,00", downPaymentAccount: "efectivo",
        installmentCount: 2, occurredOn: DATE, source: "form",
      }),
      /inicial/i,
    );
  });

  it("paying an installment lowers both the debt and the balance it came from", async () => {
    const plans = await financingPlansView(e.home.id);
    const plan = plans.find((p) => p.description === "Otra")!;
    const installment = plan.installments.find((c) => !c.paid)!;
    const balanceBefore = await accountBalance(e.cash.id);

    await payInstallment({
      householdId: e.home.id,
      installmentId: installment.id,
      fromAccount: "efectivo",
      paidOn: DATE,
    });

    assert.equal(
      await accountBalance(e.cash.id),
      balanceBefore - installment.amountMinor,
      "pagar sale de la cuenta que se dijo",
    );
    const after = await financingPlansView(e.home.id);
    const p2 = after.find((p) => p.description === "Otra")!;
    assert.ok(p2.pendingMinor < plan.pendingMinor, "y baja lo que queda por pagar");
  });

  it("a financier that doesn't exist isn't invented", async () => {
    await assert.rejects(
      () => recordFinancedPurchase({
        householdId: e.home.id, financier: "zzzqqq",
        total: "100,00", installmentCount: 2, occurredOn: DATE, source: "form",
      }),
      /zzzqqq|cuenta/i,
    );
  });

  /*
   * What was left out: undoing a payment, voiding a whole plan and each
   * financier's profile.
   *
   * They all touch debt already written. Voiding a plan halfway is the worst
   * case possible here: the purchase disappears from the list and the
   * installments keep counting, so planfly shows a debt that no longer exists
   * and nobody sees the fault until the bill arrives.
   */

  async function testPlan(descripcion: string) {
    return recordFinancedPurchase({
      householdId: e.home.id, financier: "tdc",
      total: "2.000,00", installmentCount: 2, frequency: "monthly",
      firstDueOn: "2026-09-01", occurredOn: DATE, description: descripcion, source: "form",
    });
  }

  it("undoing an installment payment gives back both the debt and the balance", async () => {
    await testPlan("Deshacer");
    const installment = (await upcomingInstallments(e.home.id, 400)).find(
      (c) => c.description === "Deshacer",
    )!;
    assert.ok(installment, "el calendario trae sus cuotas");

    const balanceBefore = await accountBalance(e.cash.id);
    await payInstallment({
      householdId: e.home.id, installmentId: installment.id, fromAccount: "efectivo", paidOn: DATE,
    });
    assert.ok(await accountBalance(e.cash.id) < balanceBefore, "pagar baja el saldo");

    await unpayInstallment(e.home.id, installment.id);
    assert.equal(await accountBalance(e.cash.id), balanceBefore, "deshacerlo lo devuelve entero");

    // And the installment goes back to pending, it does not disappear.
    const again = await upcomingInstallments(e.home.id, 400);
    assert.ok(again.some((c) => c.id === installment.id), "vuelve al calendario");
  });

  it("voiding a plan takes the purchase AND the installments, or it's worth nothing", async () => {
    const plan = await testPlan("Para anular");
    assert.equal(
      await planForTransaction(e.home.id, plan.purchaseTransactionId!),
      plan.planId,
      "la compra sabe a qué plan pertenece",
    );

    await voidFinancingPlan({
      householdId: e.home.id, planId: plan.planId, reason: "Devuelto en tienda",
    });

    const live = await financingPlansView(e.home.id);
    assert.ok(!live.some((p) => p.id === plan.planId), "el plan sale de la lista");

    const schedule = await upcomingInstallments(e.home.id, 400);
    assert.ok(
      !schedule.some((c) => c.description === "Para anular"),
      "y sus cuotas dejan de contar: si se quedaran, planfly enseñaría una deuda que ya no existe",
    );
  });

  it("a financier profile is saved, read back and removed", async () => {
    // They are the next purchase's defaults. Storing them against an account that
    // is not a liability would make no sense: nobody finances you out of your own
    // cash.
    await saveFinancierProfile({
      householdId: e.home.id, accountId: e.card.id,
      downPaymentPercent: 40, defaultInstallments: 3, defaultFrequency: "biweekly",
    });

    const withProfile = (await financiersView(e.home.id)).find((f) => f.accountId === e.card.id);
    assert.ok(withProfile, "la financiadora aparece");
    assert.equal(withProfile!.downPaymentPercent, 40);
    assert.equal(withProfile!.defaultInstallments, 3);

    await removeFinancierProfile(e.home.id, e.card.id);
    const withoutProfile = (await financiersView(e.home.id)).find((f) => f.accountId === e.card.id);
    assert.equal(withoutProfile?.downPaymentPercent ?? null, null, "quitarlo la deja sin valores por defecto");
  });

  it("an asset account gets no financier profile", async () => {
    // Whoever finances you is who you owe. With an asset account, buying in
    // installments would RAISE what you have, which is exactly backwards.
    await assert.rejects(
      () => saveFinancierProfile({ householdId: e.home.id, accountId: e.cash.id }),
      /cuenta de activo/i,
    );

    // And an impossible down-payment percentage is rejected before being stored: a
    // 100% would leave plans with nothing to finance.
    await assert.rejects(
      () =>
        saveFinancierProfile({
          householdId: e.home.id, accountId: e.card.id, downPaymentPercent: 100,
        }),
      /entre 0 y 99/i,
    );
  });
});

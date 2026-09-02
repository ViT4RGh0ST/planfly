/**
 * A household with a life, for looking at the app rather than reading about it.
 *
 * `seed.ts` leaves the structure — the household, its accounts, its categories —
 * and that is correct for somebody about to keep their own accounts: an empty
 * dashboard is the first screen a real installation shows. But it is the wrong
 * first screen for someone deciding whether this is worth their afternoon. This
 * fills it: two months of rates, a salary, the spending of a household that eats
 * out and buys medicine, a purchase in installments halfway through paying
 * itself, budgets already over, and a couple of rows the bot did not fully
 * understand.
 *
 * **It writes through the services, never with an INSERT.** That is the rule the
 * whole codebase is built on — nothing touches `transaction_entries` outside
 * `src/lib/services/` — and here it earns its keep twice over: the demo cannot
 * produce a state the application itself could not reach, and running it
 * exercises the same path the bot, the form, the CSV and the camera all use. A
 * demo built out of raw rows would be a picture of the product, not the product.
 *
 * It is deliberately a SEPARATE script from the seed, with its own guard: the
 * one thing it must never do is drop fake purchases into somebody's real
 * accounting.
 *
 *   npm run db:demo
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { db, pool } from "../src/db";
import { accounts, households, transactions, user } from "../src/db/schema";
import { addDays, startOfMonth, today } from "../src/lib/dates";
import { minorToDecimalString } from "../src/lib/money";
import { saveRate } from "../src/lib/rates/service";
import { saveBudget } from "../src/lib/services/budgets";
import { budgetUsage } from "../src/lib/services/reports";
import {
  financingPlansView,
  payInstallment,
  recordFinancedPurchase,
  saveFinancierProfile,
} from "../src/lib/services/financing";
import { recordTransaction } from "../src/lib/services/record-transaction";
import { saveRecurringRule, setRecurringActive } from "../src/lib/services/recurring";
import { saveRule } from "../src/lib/services/rules";
import { voidTransaction } from "../src/lib/services/void-transaction";

/** Steps, so the output says what was exercised and not just that it finished. */
const done: string[] = [];
function step(what: string) {
  console.log(`  · ${what}`);
  done.push(what);
}

async function main() {
  const [home] = await db.select().from(households).limit(1);
  if (!home) {
    throw new Error("There is no household. Run `npm run db:seed` first.");
  }

  const [owner] = await db.select().from(user).limit(1);
  const zone = home.timezone;
  const now = today(zone);

  /*
   * The guard.
   *
   * Fake purchases landing in real accounts is the one mistake this script can
   * make, and nothing downstream would catch it: they would look exactly like
   * entries somebody wrote, because they went through the same write path.
   */
  const [already] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.householdId, home.id))
    .limit(1);
  if (already && process.env.DEMO_FORCE !== "1") {
    throw new Error(
      `«${home.name}» already has entries, so this is somebody's accounting and not an empty demo.\n` +
        "  If it really is a throwaway database: DEMO_FORCE=1 npm run db:demo",
    );
  }

  const owned = await db
    .select({ name: accounts.name, currency: accounts.currency, nature: accounts.nature })
    .from(accounts)
    .where(and(eq(accounts.householdId, home.id), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.sortOrder));
  const has = (name: string) => owned.some((a) => a.name === name);
  const missing = ["Efectivo Bs", "Banco", "Cuenta en dólares", "Tarjeta de crédito"].filter(
    (n) => !has(n),
  );
  if (missing.length > 0) {
    throw new Error(`The seed's accounts are missing: ${missing.join(", ")}. Run \`npm run db:seed\`.`);
  }

  const record = (input: Parameters<typeof recordTransaction>[0]) =>
    recordTransaction({ ...input, createdByUserId: owner?.id, onDuplicate: "warn" });

  console.log("→ Rates, two months of them");
  /*
   * Written out and not random: a curve that wanders at random reads as noise,
   * and the point of this screen is that the two rates separate. These drift
   * apart from ~13% to ~18%, which is the spread of the originating case.
   */
  for (let back = 60; back >= 0; back--) {
    const date = addDays(now, -back);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const drift = (60 - back) / 60;
    const bcv = 735 + drift * 50;
    const p2p = bcv * (1.13 + drift * 0.05);

    // The BCV does not publish at weekends: the gap is real, and it is what
    // `connectNulls` in the chart exists for.
    if (day !== 0 && day !== 6) {
      await saveRate({
        baseCurrency: "USD",
        quoteCurrency: "VES",
        source: "official",
        variant: "official",
        value: bcv.toFixed(4),
        effectiveOn: date,
        raw: { typedBy: "demo" },
      });
    }
    await saveRate({
      baseCurrency: "USD",
      quoteCurrency: "VES",
      source: "parallel",
      variant: "parallel",
      value: p2p.toFixed(4),
      effectiveOn: date,
      raw: { typedBy: "demo" },
    });
  }
  // And one written by hand, which beats the source's for that day only. It is
  // the escape hatch that makes the app usable with no source connected.
  await saveRate({
    baseCurrency: "USD",
    quoteCurrency: "VES",
    source: "manual",
    variant: "parallel",
    value: "925.0000",
    effectiveOn: addDays(now, -3),
    raw: { typedBy: "demo", note: "what the exchange actually paid that day" },
  });
  step("60 days of BCV and P2P, with the weekends the BCV does not publish, plus one set by hand");

  console.log("→ Income");
  /*
   * In both currencies, and into the account the spending leaves from.
   *
   * Not only for realism: with the salary arriving in dollars and every expense
   * leaving in bolívares, the main account ends the demo deep in the red and the
   * dashboard reads as a household in trouble rather than as an app worth
   * trying.
   */
  for (const back of [45, 30, 15]) {
    await record({
      householdId: home.id,
      kind: "income",
      amount: "190.000,00",
      currency: "VES",
      account: "Banco",
      category: "Sueldo",
      description: "Quincena",
      occurredOn: addDays(now, -back),
      source: "form",
    });
  }
  for (const back of [40, 12]) {
    await record({
      householdId: home.id,
      kind: "income",
      amount: "220,00",
      currency: "USD",
      account: "Cuenta en dólares",
      category: "Freelance",
      description: "Pago de un cliente",
      occurredOn: addDays(now, -back),
      source: "form",
    });
  }
  step("three fortnightly wages in bolívares and two freelance payments in dollars");

  console.log("→ Moving money into the pockets it gets spent from");
  /*
   * Before the spending, not after: cash that only ever pays out ends the demo
   * at minus twenty-four thousand bolívares, and a wallet with a negative
   * balance is a thing that cannot happen. The order of these entries is part of
   * the demo being believable.
   */
  await record({
    householdId: home.id,
    kind: "transfer",
    amount: "45.000,00",
    currency: "VES",
    account: "Banco",
    toAccount: "Efectivo Bs",
    description: "Retiro del mes",
    occurredOn: addDays(now, -42),
    source: "form",
  });
  await record({
    householdId: home.id,
    kind: "transfer",
    amount: "60,00",
    currency: "USD",
    account: "Cuenta en dólares",
    toAccount: "Efectivo USD",
    description: "Efectivo para gastos",
    occurredOn: addDays(now, -28),
    source: "form",
  });
  // Into a currency whose rate does not go out of date: one stored row covers
  // it for ever, and no entry ends up asking to be given a rate by hand.
  await record({
    householdId: home.id,
    kind: "transfer",
    amount: "40,00",
    currency: "USD",
    account: "Cuenta en dólares",
    toAccount: "Cripto",
    toAmount: "40,00",
    description: "Compra de USDT",
    occurredOn: addDays(now, -26),
    source: "form",
  });
  step("cash withdrawals and a purchase of USDT, so nothing is spent from an empty pocket");

  console.log("→ Everyday spending");
  /*
   * The amounts are what a household actually spends, not round little numbers.
   *
   * At ~900 bolívares to the dollar, a «Bs. 1.850» supermarket run is two
   * dollars: it looks tidy in the table and turns every budget into 4% used and
   * every bar in the chart into a sliver. The figures below sit where they
   * belong — a grocery run is twenty-odd dollars — which is what makes the
   * budgets, the chart and the two valuations say anything at all.
   */
  const spending: Array<[number, string, string, string, string]> = [
    [40, "21.500,00", "Banco", "Mercado", "Compra del mes"],
    [38, "3.200,00", "Efectivo Bs", "Comida callejera", "Empanadas"],
    [35, "12.400,00", "Banco", "Luz", "Corpoelec"],
    [33, "8.900,00", "Efectivo Bs", "Transporte público", "Pasajes de la semana"],
    [30, "24.000,00", "Banco", "Medicinas", "Tratamiento del mes"],
    [27, "45,00", "Cuenta en dólares", "Internet", "Fibra del mes"],
    [24, "68.000,00", "Tarjeta de crédito", "Ropa", "Zapatos"],
    [21, "18.700,00", "Banco", "Mercado", "Verduras y pollo"],
    [18, "5.400,00", "Efectivo Bs", "Comida callejera", "Arepas"],
    [16, "8,50", "Cripto", "Suscripciones", "Servidor"],
    [15, "12.000,00", "Banco", "Gasolina", "Tanque lleno"],
    [12, "9.800,00", "Efectivo Bs", "Comida callejera", "Almuerzo del viernes"],
    [10, "20,00", "Efectivo USD", "Regalos", "Cumpleaños de mi sobrina"],
    [9, "15,00", "Cuenta en dólares", "Suscripciones", "Streaming"],
    [7, "25.300,00", "Banco", "Mercado", "Compra de la semana"],
    [5, "11.000,00", "Banco", "Consultas", "Consulta médica"],
    [3, "4.300,00", "Efectivo Bs", "Comida callejera", "Café y tequeños"],
    [1, "56.000,00", "Tarjeta de crédito", "Restaurante", "Cena de cumpleaños"],
  ];
  for (const [back, amount, account, category, description] of spending) {
    const acct = owned.find((a) => a.name === account)!;
    await record({
      householdId: home.id,
      kind: "expense",
      amount,
      currency: acct.currency,
      account,
      category,
      description,
      occurredOn: addDays(now, -back),
      source: back % 3 === 0 ? "telegram" : "form",
    });
  }
  step(`${spending.length} everyday expenses across nine categories, in three accounts`);

  console.log("→ A receipt with its breakdown, three times over");
  /*
   * The same products bought three times, at rising prices. One purchase leaves
   * a product with no history; three leave a price curve, which is the only way
   * /products says anything.
   */
  const basket: Array<[number, string, string, string, string]> = [
    [44, "HARINA PAN 1KG", "2", "kg", "180,00"],
    [22, "HARINA PAN 1KG", "2", "kg", "215,00"],
    [6, "HARINA PAN 1KG", "2", "kg", "260,00"],
  ];
  for (const [back, description, quantity, unit, total] of basket) {
    await record({
      householdId: home.id,
      kind: "expense",
      amount: String(Number(total.replace(".", "").replace(",", ".")) + 900),
      currency: "VES",
      account: "Banco",
      category: "Mercado",
      description: "Compra con factura",
      occurredOn: addDays(now, -back),
      source: "ocr",
      confidence: 0.94,
      items: [
        { description, quantity: Number(quantity), unit, total },
        { description: "ACEITE 1L", quantity: 1, unit: "l", total: "420,00" },
        { description: "ARROZ 1KG", quantity: 3, unit: "kg", total: "310,00" },
      ],
    });
  }
  step("three photographed receipts, so the products have a price curve");

  console.log("→ Transfers");
  await record({
    householdId: home.id,
    kind: "transfer",
    amount: "8.000,00",
    currency: "VES",
    account: "Banco",
    toAccount: "Efectivo Bs",
    description: "Retiro para la semana",
    occurredOn: addDays(now, -10),
    source: "form",
  });
  await record({
    householdId: home.id,
    kind: "transfer",
    amount: "50,00",
    currency: "USD",
    account: "Cuenta en dólares",
    toAccount: "Banco",
    // Across currencies the rate you actually got is the one that matters, and
    // it is almost never the market's: it comes from dividing the two legs.
    toAmount: "45.900,00",
    description: "Cambio de dólares",
    occurredOn: addDays(now, -8),
    source: "form",
  });
  step("a withdrawal and a currency exchange, with the rate it actually got");

  console.log("→ An adjustment");
  await record({
    householdId: home.id,
    kind: "adjustment",
    amount: "120,00",
    currency: "VES",
    account: "Efectivo Bs",
    description: "Cuadre de caja",
    occurredOn: addDays(now, -14),
    source: "form",
  });
  step("a cash adjustment");

  console.log("→ Buying in installments");
  const card = owned.find((a) => a.nature === "liability")!;
  const [cardRow] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.householdId, home.id), eq(accounts.name, card.name)))
    .limit(1);
  await saveFinancierProfile({
    householdId: home.id,
    accountId: cardRow.id,
    downPaymentPercent: 40,
    defaultInstallments: 3,
    defaultFrequency: "biweekly",
  });
  const purchase = await recordFinancedPurchase({
    householdId: home.id,
    financier: card.name,
    total: "48.000,00",
    downPayment: "19.200,00",
    downPaymentAccount: "Banco",
    category: "Hogar",
    description: "Nevera",
    occurredOn: addDays(now, -20),
    installmentCount: 3,
    frequency: "biweekly",
    source: "form",
    createdByUserId: owner?.id,
  });
  const [plan] = (await financingPlansView(home.id)).filter((p) => p.id === purchase.planId);
  const firstDue = plan?.installments.find((i) => !i.paid);
  if (firstDue) {
    await payInstallment({
      householdId: home.id,
      installmentId: firstDue.id,
      fromAccount: "Banco",
      paidOn: addDays(now, -6),
    });
  }
  step("a purchase in three installments with a deposit, and the first one already paid");

  console.log("→ What repeats on its own");
  await saveRecurringRule({
    householdId: home.id,
    timezone: zone,
    locale: home.locale,
    name: "Alquiler",
    cadence: "monthly",
    daysOfMonth: [5],
    startOn: startOfMonth(now),
    template: {
      kind: "expense",
      amount: "150",
      amountCurrency: "USD",
      currency: "VES",
      rateSource: "parallel",
      account: "Banco",
      category: "Hogar",
      description: "Alquiler",
      source: "recurring",
    },
  });
  await saveRecurringRule({
    householdId: home.id,
    timezone: zone,
    locale: home.locale,
    name: "Internet",
    cadence: "monthly",
    daysOfMonth: [20],
    startOn: startOfMonth(now),
    template: {
      kind: "expense",
      amount: "45",
      currency: "USD",
      account: "Cuenta en dólares",
      category: "Internet",
      description: "Fibra",
      source: "recurring",
    },
  });
  const paused = await saveRecurringRule({
    householdId: home.id,
    timezone: zone,
    locale: home.locale,
    name: "Gimnasio",
    cadence: "biweekly",
    startOn: startOfMonth(now),
    template: {
      kind: "expense",
      amount: "12",
      amountCurrency: "USD",
      currency: "VES",
      rateSource: "official",
      account: "Efectivo Bs",
      category: "Entretenimiento",
      description: "Gimnasio",
      source: "recurring",
    },
  });
  await setRecurringActive(home.id, paused.id, false, zone, home.locale);
  step("three recurrences — one in dollars charged in bolívares, one paused");

  console.log("→ Budgets");
  const budget = {
    householdId: home.id,
    baseCurrency: home.baseCurrency,
    timezone: zone,
    locale: home.locale,
    today: now,
  };
  await saveBudget({ ...budget, category: "Mercado", amount: "100,00", period: "monthly" });
  await saveBudget({ ...budget, category: "Comida callejera", amount: "100,00", period: "biweekly" });
  await saveBudget({ ...budget, category: "Educación", amount: "400,00", period: "yearly" });
  await saveBudget({
    ...budget,
    category: "Gasolina",
    amount: "100,00",
    period: "custom",
    periodStart: startOfMonth(now),
    periodEnd: addDays(now, 10),
  });

  /*
   * And now the caps are set from what was actually spent.
   *
   * A budget's three states — comfortable, going faster than the period, and
   * over — are the only reason the screen has a colour, and fixed numbers show
   * whichever one the calendar happens to allow: run the demo on the 3rd and
   * everything is green, on the 28th and everything is red. Reading the spend
   * back and pricing the cap against it means all three are on screen whatever
   * day this runs.
   *
   * `saveBudget` upserts, so this is the same call again with a better number.
   */
  const target: Record<string, number> = {
    // Over: spent more than the cap, whatever the date.
    Mercado: 0.8,
    // Ahead of the period: enough of the cap used to pass the pace mark.
    "Comida callejera": 1.35,
    // Comfortable, which is what most of them look like most of the time.
    Gasolina: 2.6,
  };
  for (const row of await budgetUsage(home.id, now, "parallel")) {
    const factor = target[row.category];
    if (!factor || row.spentMinor <= 0) continue;
    await saveBudget({
      ...budget,
      category: row.category,
      amount: minorToDecimalString(Math.round(row.spentMinor * factor), home.baseCurrency),
      period: row.period,
      periodStart: row.period === "custom" ? row.periodStart : undefined,
      // `periodEnd` is exclusive in the row and inclusive in the input.
      periodEnd: row.period === "custom" ? addDays(row.periodEnd, -1) : undefined,
    });
  }
  step("four budgets — monthly, fortnightly, yearly and a range of its own — one over and one ahead of its period");

  console.log("→ Rules for what gets imported");
  await saveRule({
    householdId: home.id,
    locale: home.locale,
    pattern: "farmatodo",
    category: "Medicinas",
    priority: 10,
  });
  await saveRule({
    householdId: home.id,
    locale: home.locale,
    pattern: "uber",
    field: "description",
    operator: "contains",
    category: "Transporte público",
    priority: 20,
  });
  step("two categorisation rules");

  console.log("→ The review tray");
  // What the bot recorded without being sure. Each lands here for a different
  // reason, which is what the tray explains row by row.
  await record({
    householdId: home.id,
    kind: "expense",
    amount: "1.500,00",
    currency: "VES",
    account: "Banco",
    description: "Pago sin descripción clara",
    occurredOn: addDays(now, -4),
    source: "telegram",
    confidence: 0.42,
  });
  await record({
    householdId: home.id,
    kind: "expense",
    amount: "760,00",
    currency: "VES",
    account: "Efectivo Bs",
    description: "Algo del kiosco",
    occurredOn: addDays(now, -2),
    source: "ocr",
    confidence: 0.55,
  });
  step("two entries the bot did not fully understand");

  console.log("→ Something voided");
  const voidable = await record({
    householdId: home.id,
    kind: "expense",
    amount: "999,00",
    currency: "VES",
    account: "Banco",
    category: "Otros gastos",
    description: "Cobro duplicado",
    occurredOn: addDays(now, -11),
    source: "form",
  });
  await voidTransaction({
    householdId: home.id,
    transactionId: voidable.transactionId!,
    reason: "El comercio lo cobró dos veces",
  });
  step("one voided entry, which stays in the history so as not to leave a hole");

  const [{ count } = { count: 0 }] = await db
    .select({ count: transactions.id })
    .from(transactions)
    .where(eq(transactions.householdId, home.id))
    .then((rows) => [{ count: rows.length }]);

  console.log(`\n${count} entries in «${home.name}». Exercised:`);
  for (const what of done) console.log(`  ✓ ${what}`);
  console.log("\nOpen http://localhost:3000 — the dashboard has two months behind it.");

  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${(err as Error).message}`);
  await pool.end();
  process.exit(1);
});

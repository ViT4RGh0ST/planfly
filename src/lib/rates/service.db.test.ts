import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hasDb, prepareDb } from "@/test/db";
import { seedScenario, type Scenario } from "@/test/fixtures";
import { recordTransaction } from "@/lib/services/record-transaction";
import {
  currentRates,
  isRateTooStale,
  lastSnapshotAt,
  manualRates,
  removeManualRate,
  resolveRates,
  saveManualRate,
  saveRate,
} from "./service";
import { db, pool } from "@/db";
import { currencies, exchangeRates } from "@/db/schema";

/**
 * The rate ladder, against the database.
 *
 * This file had no test at all, and the precedence between an automatic rate and
 * a hand-written one **lives in a query's ORDER BY**: there is no way to check it
 * without Postgres, and until now it was exercised by hand.
 *
 * It is the piece everything else hangs from. Every bolívar entry is stamped
 * with whatever this decides, and if it chooses wrong nothing fails: the row is
 * left with a credible, wrong dollar equivalent.
 *
 * `isToday: false` on all of them: with `true` the resolution goes out to the
 * network if a slot is missing, and a test depending on the internet does not
 * test this.
 */
const DATE = "2026-08-21";
let e: Scenario;

const pide = (date: string) =>
  resolveRates({ baseCurrency: "USD", quoteCurrency: "VES", date, isToday: false });

describe("the rate ladder", { skip: hasDb() ? false : "no Postgres available" }, () => {
  before(async () => {
    await prepareDb();
    e = await seedScenario({ date: DATE, bcvRate: "780.0000000000", p2pRate: "900.0000000000" });
  });
  after(() => pool.end());

  it("with nothing written by hand, the source's rate rules", async () => {
    const r = await pide(DATE);
    assert.equal(r.official?.value, "780.0000000000");
    assert.equal(r.parallel?.value, "900.0000000000");
    assert.equal(r.official?.manual, false);
    assert.equal(r.official?.stale, false, "es del día que se pidió");
  });

  it("on the same day, the hand-written one beats the automatic", async () => {
    // The whole rule: someone set it while looking at the screen, the automatic
    // one is a guess. It lives in a CASE inside the ORDER BY and no test touched it.
    await saveManualRate({ slot: "official", value: "500.0000000000", effectiveOn: DATE });

    const r = await pide(DATE);
    assert.equal(r.official?.value, "500.0000000000", "la de la persona");
    assert.equal(r.official?.manual, true);
    assert.equal(r.parallel?.value, "900.0000000000", "y la otra casilla no se toca");
  });

  it("but an old manual one does NOT beat today's automatic", async () => {
    // The by-hand tie-break comes AFTER the date-proximity one, and that order is
    // what matters: the other way round, a correction from three days ago would
    // stay stuck valuing this week's spending.
    await saveRate({
      baseCurrency: "USD", quoteCurrency: "VES", source: "official",
      value: "820.0000000000", effectiveOn: "2026-08-25",
    });
    await saveManualRate({ slot: "official", value: "111.0000000000", effectiveOn: "2026-08-22" });

    const r = await pide("2026-08-25");
    assert.equal(r.official?.value, "820.0000000000", "manda la del día, no la manual de tres días antes");
  });

  it("a value date in the future counts when there's nothing earlier", async () => {
    // Official sources publish ahead: on Tuesday afternoon Wednesday's is already
    // out. With a plain `<= date`, the first expense of the day on a fresh
    // install would find no rate at all even if it had just been downloaded.
    await saveRate({
      baseCurrency: "USD", quoteCurrency: "COP", source: "official",
      value: "4100.0000000000", effectiveOn: "2026-09-02",
    });
    const r = await resolveRates({
      baseCurrency: "USD", quoteCurrency: "COP", date: "2026-09-01", isToday: false,
    });
    assert.equal(r.official?.value, "4100.0000000000");
    assert.equal(r.official?.stale, true, "y se dice que no es exactamente la del día");
  });

  it("a manual rate anchors to ITS slot: a parallel one doesn't fill the official", async () => {
    await saveManualRate({
      slot: "parallel", value: "1250.0000000000", effectiveOn: "2026-10-05",
      baseCurrency: "USD", quoteCurrency: "PEN",
    });
    const r = await resolveRates({
      baseCurrency: "USD", quoteCurrency: "PEN", date: "2026-10-05", isToday: false,
    });
    assert.equal(r.parallel?.value, "1250.0000000000");
    assert.equal(r.official, null, "la casilla oficial sigue vacía, que es lo honesto");
  });

  it("a rate too far from the date is declared stale", async () => {
    const r = await pide(DATE);
    assert.equal(isRateTooStale(r.official, DATE), false);
    assert.equal(isRateTooStale(r.official, "2026-12-31"), true, "meses después ya no vale");
    assert.equal(isRateTooStale(null, DATE), true, "y no tenerla es el caso más viejo de todos");
  });

  it("hand-written rates can be listed and undone", async () => {
    const list = await manualRates(10);
    assert.ok(list.length >= 1, "las escritas a mano quedan a la vista");

    const loose = await saveManualRate({
      slot: "official", value: "333.0000000000", effectiveOn: "2027-01-15",
    });
    assert.equal(await removeManualRate(loose.id), true, "si no valoró nada, se borra");
    assert.equal(await removeManualRate(loose.id), false, "y la segunda vez ya no está");
  });

  it("a rate that has ALREADY valued entries isn't deleted: they'd be left with no provenance", async () => {
    /*
     * `rate_official_id` points here with ON DELETE SET NULL. Deleting it would leave
     * the entries with their dollar equivalent already computed and nothing
     * saying where it came from: the right amount and the provenance saying
     * "none", which is exactly the kind of lie this project avoids.
     */
    const used = await saveManualRate({
      slot: "official", value: "600.0000000000", effectiveOn: "2026-11-03",
    });
    await recordTransaction({
      householdId: e.home.id, kind: "expense", amount: "6.000,00", currency: "VES",
      account: "efectivo", category: "mercado", occurredOn: "2026-11-03", source: "form",
    });

    await assert.rejects(() => removeManualRate(used.id, "es"), /ya valoró/i);
  });

  it("the day's summary brings both slots, hand-set or not", async () => {
    const r = await currentRates(DATE);
    assert.ok(r.official, "la oficial");
    assert.ok(r.parallel, "y la paralela");
    assert.equal(r.official!.manual, true, "hoy la oficial está corregida a mano");
  });

  it("when we last went out to fetch, which is not the same as the value date", async () => {
    // `observed_at` is what we look at and not `effective_on`: a source publishing
    // with a future value date would make "there is a row dated today" true
    // without anyone having gone out to fetch it today.
    const cuando = await lastSnapshotAt();
    assert.ok(cuando instanceof Date, "hay una captura registrada");
  });

  /*
   * A pair whose rate does not go out of date.
   *
   * In the same suite as the rest so it shares the connection: the ladder and
   * the exception to the ladder have to be read together.
   */
  before(async () => {
    await db
      .insert(currencies)
      .values({ code: "USDT", name: "Tether", symbol: "₮", minorUnit: 2, rateAges: false })
      .onConflictDoNothing();
    // Written once, far back. It is the definition of a stablecoin against its
    // own currency, not a market price captured that day.
    for (const variant of ["official", "parallel"]) {
      await db.insert(exchangeRates).values({
        baseCurrency: "USD",
        quoteCurrency: "USDT",
        source: "manual",
        variant,
        rate: "1",
        effectiveOn: "2000-01-01",
      });
    }
  });

  it("is used years later without being called stale", async () => {
    /*
     * The whole point. `STALE_TOLERANCE_DAYS` is calibrated for the bolívar,
     * which moves every day; applied here it called «old» a figure that cannot
     * age, and every USDT entry landed in the review tray asking by hand for a
     * number that is always the same one.
     */
    const rates = await resolveRates({
      quoteCurrency: "USDT",
      baseCurrency: "USD",
      date: "2026-08-24",
      isToday: false,
    });

    assert.equal(Number(rates.parallel?.value), 1, "the row from the year 2000 is found");
    assert.equal(rates.parallel?.stale, false, "and it is not announced as being from another day");
    assert.equal(isRateTooStale(rates.parallel, "2026-08-24"), false, "nor is it distrusted");
  });

  it("the same figure is distrusted when the pair does move", () => {
    /*
     * The contrast, on two identical rates that differ only in whether their
     * pair moves. Written out rather than read from the table because the rows
     * the tests above leave behind would decide which one is found — and what
     * is being pinned here is the verdict, not the lookup.
     */
    const from2000 = { id: "", value: "1", effectiveOn: "2000-01-01", stale: false, manual: true };

    assert.equal(
      isRateTooStale({ ...from2000, ages: false }, "2026-08-24"),
      false,
      "a pair that does not move cannot be far from any date",
    );
    assert.equal(
      isRateTooStale({ ...from2000, ages: true }, "2026-08-24"),
      true,
      "and the bolívar's does go out of date, which is why the tolerance exists",
    );
  });
});

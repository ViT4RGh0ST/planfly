/**
 * Are the rate sources still answering?
 *
 *   npm run rates:check
 *
 * It writes nothing to the database: it just asks each configured slot and
 * checks that what comes back makes sense. It exists because a source can stop
 * working in silence — the format of the site it reads changes, or an endpoint
 * moves — and the app does not find out: it simply stores the entry without a
 * dollar equivalent and flags it for review. This says so beforehand.
 *
 * A slot with no source configured is not a failure: it is skipped. What fails
 * is a source that is set and does not answer, or answers nonsense.
 */
import { forgetProviders, isSlotConfigured, providerFor } from "../src/lib/rates/load-provider";
import { normalizeReading, RATE_SLOTS } from "../src/lib/rates/provider";
import { today } from "../src/lib/dates";
import { pool } from "../src/db";

/**
 * Sanity range. It is not fine-grained validation: it is the net that catches
 * the big one — a rate a thousand times too large, or a zero — before it gets
 * stamped onto real entries and a month has to be redone.
 */
const MIN = 1;
const MAX = 1_000_000;

const PAIR = { base: "USD", quote: "VES" };

async function main() {
  forgetProviders();
  const date = today(process.env.TZ ?? "America/Caracas");
  let failed = false;

  for (const slot of RATE_SLOTS) {
    if (!isSlotConfigured(slot)) {
      console.log(`· ${slot}: no source configured — write it by hand in /rates. Skipping.`);
      continue;
    }

    const provider = await providerFor(slot);
    if (!provider) {
      console.error(`✗ ${slot}: a source is configured but could not be loaded.`);
      failed = true;
      continue;
    }

    try {
      const ctx = { ...PAIR, date, timeoutMs: 15_000 };
      const quotes = normalizeReading(await provider.read(ctx), ctx);
      const mine = quotes.find((q) => q.base === PAIR.base && q.quote === PAIR.quote);

      if (!mine) {
        console.error(`✗ ${slot}: it answered, but without ${PAIR.base}/${PAIR.quote}.`);
        failed = true;
        continue;
      }

      const value = Number(mine.value);
      if (!(value >= MIN && value <= MAX)) {
        console.error(`✗ ${slot}: ${value} is outside the reasonable range (${MIN}–${MAX}).`);
        failed = true;
        continue;
      }

      const others = quotes.length > 1 ? ` · and ${quotes.length - 1} more currency/currencies` : "";
      console.log(`✓ ${slot}: ${value} ${PAIR.quote} per ${PAIR.base}, value date ${mine.effectiveOn}${others}`);
    } catch (err) {
      console.error(`✗ ${slot}: ${(err as Error).message}`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "\nA configured source did not answer as it should. Meanwhile the app keeps " +
        "working: the rate can be set by hand in /rates.",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    // Without this, an unexpected failure — the database not started, say — came
    // out as an uncaught rejection: a stack dump instead of the message, and with
    // exit code 0, which in a CI counts as everything having gone fine.
    console.error(`✗ ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

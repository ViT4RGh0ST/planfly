/**
 * Rate snapshot by hand.
 *
 * The app already does this on its own every 30 minutes while running
 * (src/instrumentation.ts). This is for filling in a day after having had the
 * machine off, or for hooking it to a Windows scheduled task if you want.
 *
 *   npm run rates:snapshot
 */
import { pool } from "../src/db";
import { today } from "../src/lib/dates";
import { dailySnapshot } from "../src/lib/rates/service";

const timezone = process.env.TZ ?? "America/Caracas";
const date = process.argv[2] ?? today(timezone);

dailySnapshot(date)
  .then((result) => {
    console.log(`Date ${date}`);
    console.log(
      result.official
        ? `  BCV  ${Number(result.official.value).toFixed(4)} (value date ${result.official.effectiveOn})`
        : "  BCV  failed",
    );
    console.log(result.parallel ? `  P2P  ${Number(result.parallel.value).toFixed(4)}` : "  P2P  failed");
    if (!result.official && !result.parallel) process.exitCode = 1;
  })
  .catch((err) => {
    console.error("Failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

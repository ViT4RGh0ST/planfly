import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * That the old names of the two rate slots survive in exactly two places.
 *
 * They were `bcv` and `p2p` — a Venezuelan central bank and a way of trading —
 * and what they mean is the official rate and the street's, which is the shape
 * of every dual-rate economy this product is for. The rename touched ninety
 * files, two Postgres enums and ten columns.
 *
 * A rename that big is not dangerous because it breaks: TypeScript and Postgres
 * catch what they can see. It is dangerous because of what they cannot — a
 * STRING left behind. `rate_source` is optional on every route, so a stale
 * literal does not throw: the entry is valued at the household's default instead
 * of the slot that was asked for, and the figure is wrong and looks right.
 *
 * So the old spellings are allowed only where they are deliberately understood:
 * the alias table that translates them on the way in, and the URL reader that
 * keeps a saved link meaning what it meant. Anywhere else is a leftover.
 *
 * Display text is a different matter and lives in the catalogues, not here: for
 * the bolívar pair «Oficial · BCV» is not a leftover, it is the name of the
 * institution that publishes that figure.
 */
const ROOT = join(process.cwd(), "src");

/** Where the old names are understood on purpose, each with its reason. */
const ALLOWED: Array<{ file: string; because: string }> = [
  {
    file: "src/lib/validation.ts",
    because:
      "the alias table that translates what the installed bot sends, and the schemas that use it",
  },
  {
    file: "src/lib/services/reports.ts",
    because: "the URL reader, so a bookmark saying ?rate=bcv still shows the official column",
  },
  {
    file: "src/lib/rate-slots-guard.test.ts",
    because: "this guard, which has to name what it is looking for",
  },
];

function sourceFiles(dir = ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(tsx?|css)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("the old names of the two rate slots", () => {
  it("survive only where they are understood on purpose", () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const found: string[] = [];

    for (const file of sourceFiles()) {
      const short = file.replace(process.cwd() + "/", "");
      if (allowed.has(short)) continue;

      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, i) => {
        // The identifier, not the word: «p2p» inside `fetchP2pRate` is the
        // Binance market's own name and stays — what was renamed is the slot it
        // fills, not the reader that fills it.
        /*
         * The quoted form, the identifiers, AND the bare SQL alias.
         *
         * That last one is why this list grew: `::text AS bcv` inside a template
         * literal is not a string to TypeScript and not an identifier to a
         * grep — and a column aliased to a name the code no longer reads comes
         * back `undefined`, which every total then adds as zero. The suite
         * caught it; the first version of this guard did not.
         */
        const hit = /(["'`])(bcv|p2p)\1|\bAS\s+(bcv|p2p)\b|\b(rate_bcv|rate_p2p|base_amount_bcv|base_amount_p2p|total_bcv|total_p2p|bcvMinor|p2pMinor|text-bcv|text-p2p)\b/i.exec(
          line,
        );
        if (hit) found.push(`${short}:${i + 1} ${line.trim().slice(0, 80)}`);
      });
    }

    assert.deepEqual(
      found,
      [],
      "the rename left one behind. It does not throw: a slot the code no longer " +
        "knows falls back to the household's default, and the entry is valued " +
        "with the wrong rate while looking perfectly normal.",
    );
  });

  it("keep a saved link meaning what it meant", async () => {
    /*
     * `?rate=bcv` is in somebody's bookmarks, and it does not fail: an
     * unrecognised value falls through to the parallel column, so the link
     * quietly starts showing the other figure. Seven screens read this.
     */
    const { valuationFrom } = await import("./services/reports");
    assert.equal(valuationFrom("bcv"), "official", "an old link still means the official column");
    assert.equal(valuationFrom("official"), "official");
    assert.equal(valuationFrom("p2p"), "parallel");
    assert.equal(valuationFrom("parallel"), "parallel");
    assert.equal(valuationFrom(undefined), "parallel", "the default is the street's rate");
  });

  it("are still understood where the bot and old links speak them", () => {
    // The other direction: if the alias table is ever deleted, an installed
    // plugin sending `rate_source: "bcv"` stops being understood — silently,
    // because the field is optional everywhere.
    const validation = readFileSync(join(ROOT, "lib", "validation.ts"), "utf8");
    assert.match(validation, /bcv:\s*"official"/, "the alias for the official slot is gone");
    assert.match(validation, /p2p:\s*"parallel"/, "the alias for the parallel slot is gone");

    const reports = readFileSync(join(ROOT, "lib", "services", "reports.ts"), "utf8");
    assert.match(reports, /"bcv"/, "?rate=bcv has to keep meaning the official column");
  });
});

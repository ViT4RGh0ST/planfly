import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * That nobody writes into the ledger outside the services.
 *
 * It is rule 1 of CONTRIBUTING and it was written as non-negotiable while
 * voiding existed four times over, two of them in a server action and in an API
 * route. It was not theoretical: the API's copy did not check whether the entry
 * belonged to an installment plan, so voiding through there would have left the
 * schedule pointing at an expense that no longer exists.
 *
 * Without a watchdog, a rule in a document is an intention. This is the watchdog.
 */
const TABLES = ["transactions", "transactionEntries", "transactionItems"];

/** The only authorised ones: the single write path and its siblings. */
const SERVICES = "src/lib/services";

function tsFiles(dir: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...tsFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      output.push(path);
    }
  }
  return output;
}

describe("the ledger is written from the services only", () => {
  const suspects = tsFiles("src").filter((f) => !f.startsWith(SERVICES));

  for (const table of TABLES) {
    it(`nobody inserts/updates/deletes ${table} outside ${SERVICES}`, () => {
      const offenders = suspects.filter((f) => {
        const source = readFileSync(f, "utf8");
        return new RegExp(`\\.(insert|update|delete)\\(\\s*${table}\\s*[),]`).test(source);
      });
      assert.deepEqual(
        offenders,
        [],
        `they write ${table} directly: ${offenders.join(", ")}. Use a service from ${SERVICES}.`,
      );
    });
  }
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MCP_OPERATIONS } from "@/lib/mcp/operations";

/**
 * That the confirmation table has exactly one writer.
 *
 * A confirmation is what stands between «here is what I would record» and money
 * in the ledger, and the part that makes it worth anything is the order of four
 * moves: stage the row, compare the fingerprint on the way back, claim the row
 * atomically, and only then write. Get the claim wrong and two confirms race
 * through; drop the fingerprint and the person approves one figure while another
 * is written.
 *
 * Four tools were written that each reached for the table and rewrote those
 * moves themselves — one of them staging under a name the confirm path could not
 * even look up. None of that failed to compile. This test is why it does not
 * happen again: a tool asks `previewMcpOperation` to stage and
 * `confirmMcpOperation` to commit, and if it needs something new to be
 * confirmable it adds an entry under `operations/`, where the gate can see it.
 */
const MCP_DIR = join(process.cwd(), "src/lib/mcp");

/** Where the four moves are allowed to be written. */
const THE_GATE = "src/lib/mcp/transactions.ts";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

describe("the MCP confirmation gate", () => {
  it("is the only thing that touches the confirmations table", () => {
    const files = sourceFiles(MCP_DIR);
    // Walking the disk rather than naming the files: the one this exists to
    // catch is the one nobody has written yet.
    assert.ok(files.length >= 6, "the MCP source tree was not read");

    const trespassers: string[] = [];
    for (const file of files) {
      const short = file.replace(`${process.cwd()}/`, "");
      if (short === THE_GATE) continue;
      const source = readFileSync(file, "utf8");
      /*
       * The Drizzle symbol, and the table named in raw SQL. Not the bare table
       * name anywhere at all: it is written in prose in more than one comment,
       * and a guard that fails on its own explanation gets deleted rather than
       * obeyed.
       */
      if (/\bmcpPendingOperations\b|(?:from|into|update|join)\s+mcp_pending_operations\b/i.test(source)) {
        trespassers.push(short);
      }
    }

    assert.deepEqual(
      trespassers,
      [],
      "these write the confirmations table themselves instead of going through " +
        "previewMcpOperation and confirmMcpOperation. Every copy of «claim the row before " +
        "writing» is another chance to drop the claim, and what follows is an installment " +
        "paid twice or a figure nobody approved.",
    );
  });

  it("gives every confirmable operation both halves", () => {
    const names = Object.keys(MCP_OPERATIONS);
    assert.ok(names.length > 0, "no operations are registered: nothing could be confirmed at all");

    for (const name of names) {
      const operation = MCP_OPERATIONS[name];
      assert.equal(typeof operation.run, "function", `${name} cannot be run`);
      assert.equal(
        typeof operation.fingerprint,
        "function",
        `${name} has no fingerprint, so nothing would notice that the figures moved between ` +
          "the preview and the person's yes",
      );
      /*
       * A fingerprint that ignores its argument compares every preview as equal,
       * which is the same as having none — and it would still pass the check
       * above, because it is a function.
       *
       * The probe is two foreign shapes. One that genuinely reads its preview
       * either answers differently or throws reaching for a field that is not
       * there; only one that reads nothing answers the same twice, calmly.
       */
      const read = (preview: Record<string, unknown>) => {
        try {
          return { value: operation.fingerprint(preview) };
        } catch {
          return { threw: true };
        }
      };
      const a = read({ probe: 1 });
      const b = read({ probe: 2 });
      assert.ok(
        a.threw || b.threw || a.value !== b.value,
        `${name}'s fingerprint answers the same for two different previews without ever ` +
          "reading them, so a rate or a balance moving between the preview and the yes " +
          "would go unnoticed",
      );
    }
  });
});

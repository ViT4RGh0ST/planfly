import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * That no server action writes without checking permission.
 *
 * It is a static test over the text of the files, and that is on purpose: what
 * has to be guaranteed is not that one particular action works, but that the
 * NEXT one is not born unprotected. The `viewer` role existed unchecked from day
 * one precisely because nothing was watching it.
 *
 * And it searches for the files rather than carrying them written down. This
 * test's first version had `actions.ts`'s path hard-coded and that is why it did
 * not see the second file with `"use server"`: the CSV import was left out,
 * writing the whole ledger with read permission. A test that only looks where
 * you already know something is watching nothing.
 */
const READ_ONLY = new Set([
  // They fill an edit form with what already exists.
  "transactionForEdit",
  "accountForEdit",
  "categoryForEdit",
  "payeeForEdit",
  // Reads the CSV and shows what is about to be imported. It does not write: that is commit.
  "previewImportAction",
]);

/**
 * Every file in the project with `"use server"`, tests aside.
 *
 * Walking the disk and not with `git grep`, for two reasons. The lesser: with no
 * `.git` alongside — GitHub's download ZIP, an `npm pack` — the test would not
 * even start. The one that matters: `git grep` does not see files not yet in the
 * index, which is precisely the freshly written action this exists to watch.
 *
 * And the tests are excluded because this file carries the marker written
 * several times: it appeared in its own list, and the «I found at least two»
 * check was satisfied by it plus one real file.
 */
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

function actionFiles(): string[] {
  return tsFiles("src").filter((f) =>
    /["']use server["']/.test(readFileSync(f, "utf8")),
  );
}

describe("server actions", () => {
  const files = actionFiles();

  it("it finds the action files", () => {
    assert.ok(files.length >= 2, `I only found ${files.length}: ${files.join(", ")}`);
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const blocks = source.split(/(?=^export async function )/m).slice(1);

    for (const block of blocks) {
      const name = /^export async function (\w+)/.exec(block)![1];
      const label = `${file.replace("src/app/(app)/", "")} · ${name}`;

      if (READ_ONLY.has(name)) {
        it(`${label} only reads, and says so`, () => {
          assert.match(block, /requireSession\(\)/, `${name} does not even check the session`);
        });
        continue;
      }
      it(`${label} demands write permission`, () => {
        assert.match(
          block,
          /requireWriter\(\)/,
          `${name} writes and does not go through requireWriter(). If it only reads, add it to READ_ONLY with its reason.`,
        );
      });
    }
  }
});

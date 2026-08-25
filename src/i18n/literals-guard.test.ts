import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import ts from "typescript";

/**
 * That no Spanish is left written into the code.
 *
 * `CONTRIBUTING.md` promises this: what a person reads goes out to the
 * catalogues, and a Spanish literal inside a `.tsx`, a service or a script is a
 * mistake. Without a test the promise lasts exactly until the next hurried
 * commit, and the way it fails is quiet — a screen in English with one sentence
 * in Spanish, which nobody notices because the person reading it speaks both.
 *
 * The detector is NOT a search for accents. «Cortar la lista sin decirlo hace
 * que el conteo y lo que se ve no cuadren» has not a single one, and neither
 * does «Actualizar ahora». What it does is judge each literal against the
 * catalogue's own vocabulary: a word that appears on the Spanish side and not on
 * the English one is Spanish, and the catalogue grows with the app.
 */
const ROOT = process.cwd();
const MESSAGES = join(ROOT, "src", "i18n", "messages");

/**
 * What is deliberately in Spanish, with the reason.
 *
 * They are all the same kind of thing: **input data**, not output. What the
 * person writes, what the bank prints on a statement, what a receipt says. They
 * describe the world the app reads, not what the app answers.
 */
const ALLOWED: Array<{ file: string; because: string }> = [
  {
    file: "src/lib/dates.ts",
    because: "the permanent table of Spanish period aliases the installed bot still sends",
  },
  {
    file: "src/components/import-wizard.tsx",
    because: "the words a Venezuelan bank's CSV heads its columns with: «débito», «crédito»",
  },
  {
    file: "src/app/fonts.ts",
    because: "the Archivo typeface's filenames — the name of the face, not the word",
  },
  {
    file: "scripts/seed.ts",
    because:
      "the sample accounts and categories: they are examples from the originating case, " +
      "meant to be changed, and translating them would turn a sample into a recommendation",
  },
  {
    file: "scripts/demo.ts",
    because:
      "a household's own words: what somebody writes on an expense — «Empanadas», "
      + "«Quincena», «Cena de cumpleaños». It is the same kind of thing as the seed's "
      + "accounts, and a demo of a Venezuelan household that describes its spending in "
      + "English would be a demo of nothing",
  },
  {
    file: "src/test/fixtures.ts",
    because: "test data: real Venezuelan receipt text, which the fuzzy matching is calibrated on",
  },
];

/**
 * The words to judge, with two things taken out first.
 *
 * **A quoted fragment is an example of what the PERSON says**, and it has to
 * stay in Spanish: the bot's tool descriptions teach the model that «gasté 350
 * bolos» means an expense, and translating that example would break the very
 * thing it teaches. The convention is therefore visible in the text itself —
 * quoted is input, unquoted is what the app answers. A tool description is
 * often several concatenated strings, so a quote can open in one and close in
 * the next: an unclosed one takes the rest of the fragment with it.
 *
 * **A `--` line inside a `sql` template is a comment**, not a message. It is
 * prose for whoever reads the query, and it goes through the same review as
 * every other comment.
 */
function words(text: string): string[] {
  // Its own delimiters first: a literal that IS a quoted word — "débito" — is
  // not a quotation inside a sentence.
  const inner = /^(["'`])([\s\S]*)\1$/.exec(text.trim());
  const prose = (inner ? inner[2] : text)
    .replace(/\\"/g, '"')
    // An English apostrophe is not an opening quote: without this, «the user's
    // own words: 'mercado'» pairs the possessive with the next quote and the
    // pairing slips one place along for the rest of the sentence.
    .replace(/(\w)'(s|t|re|ve|ll|d)\b/g, "$1$2")
    .replace(/«[^»]*»/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    // An unclosed quote: it opened here and closes in the next fragment.
    .replace(/['"][^'"]*$/, " ")
    .replace(/^\s*--.*$/gm, " ");
  return prose.toLowerCase().match(/[a-záéíóúüñ]{3,}/g) ?? [];
}

/** Every word, with nothing taken out: the catalogue IS quoted, all of it. */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-záéíóúüñ]{3,}/g) ?? [];
}

function vocabulary(locale: string): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(join(MESSAGES, locale))) {
    for (const w of tokens(readFileSync(join(MESSAGES, locale, file), "utf8"))) out.add(w);
  }
  return out;
}

/** Every source file under the given roots, walked rather than listed. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "messages") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Attributes that carry an identifier and not a sentence.
 *
 * An `id="a-mano"` or a `className` are plumbing: nobody reads them, and
 * renaming them to English would be churn with no reader.
 */
const PLUMBING = new Set([
  "className", "id", "htmlFor", "key", "value", "list", "name", "type", "accept",
  "autoComplete", "inputMode", "style", "variant", "size", "role", "scope", "align",
  "aria-labelledby", "aria-describedby", "defaultValue", "href", "src",
]);

describe("no Spanish is left written into the code", () => {
  const es = vocabulary("es");
  const en = vocabulary("en");
  const onlySpanish = new Set([...es].filter((w) => !en.has(w)));

  it("the catalogue has enough vocabulary for the check to mean something", () => {
    // If the Spanish side were emptied, the check would pass by saying nothing.
    assert.ok(onlySpanish.size > 300, `only ${onlySpanish.size} Spanish-only words`);
  });

  const files = [
    ...sourceFiles(join(ROOT, "src")),
    ...sourceFiles(join(ROOT, "scripts")),
    ...sourceFiles(join(ROOT, "openclaw", "planfly-plugin", "src")),
  ].filter((f) => !/\.test\.tsx?$/.test(f));

  for (const file of files) {
    const short = file.replace(`${ROOT}/`, "");
    const excuse = ALLOWED.find((a) => a.file === short);

    it(`${short}`, () => {
      const source = readFileSync(file, "utf8");
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const found: string[] = [];
      const walk = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node) ||
          ts.isJsxText(node)
        ) {
          const text = node.getText(sf);
          const parent = node.parent;
          const attribute = ts.isJsxAttribute(parent)
            ? parent
            : ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)
              ? parent.parent
              : null;
          if (attribute && PLUMBING.has(attribute.name.getText(sf))) return;
          // A bare slug is an identifier, not a sentence.
          if (/^["'`][a-z0-9_.:/-]*["'`]$/.test(text.trim())) return;

          const hits = [...new Set(words(text).filter((w) => onlySpanish.has(w)))];
          if (hits.length > 0) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            found.push(`${short}:${line} [${hits.join(" ")}] ${text.replace(/\s+/g, " ").slice(0, 90)}`);
          }
          return;
        }
        node.forEachChild(walk);
      };
      walk(sf);

      if (excuse) {
        // The exception has to keep earning its place: an allowed file that has
        // stopped having Spanish is an excuse that outlived its reason.
        assert.ok(
          found.length > 0,
          `${short} is in ALLOWED («${excuse.because}») and no longer has any Spanish. Remove it from the list.`,
        );
        return;
      }

      assert.deepEqual(
        found,
        [],
        `Spanish written into the code. It goes out to src/i18n/messages/, or into ALLOWED with its reason:\n  ${found.join("\n  ")}`,
      );
    });
  }
});

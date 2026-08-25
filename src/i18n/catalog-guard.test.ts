import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { LOCALES } from "./config";

/**
 * That no language ever ships half translated.
 *
 * It is a static test over the catalogues and over the source, in the style of
 * `actions-guard.test.ts`: what has to be guaranteed is not that today's
 * catalogue is right, but that the NEXT key added does not land in one language
 * only. Nothing at run time notices a missing key — next-intl prints the key
 * itself — so a screen would simply start saying `ui.rates.title` to somebody.
 *
 * The check that actually matters for money is the second one. A message whose
 * English lost its `{amount}` produces a grammatical, safe, figure-less
 * sentence: «Recorded in Efectivo Bs.» reads like a success and says nothing. It
 * fails nowhere, and the bot repeats it.
 */
const ROOT = join(process.cwd(), "src");
const MESSAGES = join(ROOT, "i18n", "messages");
const SPACES = ["ui", "domain", "services", "api"] as const;

/** Every key of a catalogue, flattened to `a.b.c`, paired with its message. */
function flatten(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === "string") {
    out.set(prefix, value);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      for (const [key, msg] of flatten(v, prefix ? `${prefix}.${k}` : k)) out.set(key, msg);
    }
  }
  return out;
}

function catalogue(locale: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const space of SPACES) {
    const raw = JSON.parse(readFileSync(join(MESSAGES, locale, `${space}.json`), "utf8"));
    for (const [key, msg] of flatten(raw, space)) out.set(key, msg);
  }
  return out;
}

/**
 * The message's parts, flattened: itself plus everything inside a `select` or a
 * `plural` branch.
 *
 * With the real parser and not with a regular expression. A regex cannot tell an
 * argument from a branch body: in `{kind, select, income {ingreso} other
 * {gasto}}` it reads `{ingreso}` as an argument named «ingreso», so the same
 * message «takes» different arguments in each language purely because the two
 * translations chose different words. The check that protects the figures cannot
 * be the one crying wolf.
 */
function elements(message: string, key: string): MessageFormatElement[] {
  let tree: MessageFormatElement[];
  try {
    tree = parse(message);
  } catch (err) {
    assert.fail(`«${key}» is not valid ICU: ${(err as Error).message}`);
  }
  const out: MessageFormatElement[] = [];
  const walk = (nodes: MessageFormatElement[]) => {
    for (const node of nodes) {
      out.push(node);
      if (node.type === TYPE.select || node.type === TYPE.plural) {
        for (const option of Object.values(node.options)) walk(option.value);
      }
      if (node.type === TYPE.tag) walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * The ICU arguments of a message, at any depth.
 *
 * Inside a `plural` or a `select` there are more arguments, and those are
 * exactly the ones that get lost: the outer `{amount}` is visible and the one in
 * the `other {}` branch is not.
 */
function icuArgs(message: string, key = "?"): Set<string> {
  const out = new Set<string>();
  for (const node of elements(message, key)) {
    if ("value" in node && node.type !== TYPE.literal) out.add(String(node.value));
  }
  return out;
}

/** Every `.ts`/`.tsx` under src/, walked rather than listed. */
function sourceFiles(dir = ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the message catalogues", () => {
  it("every language has exactly the same keys", () => {
    const [first, ...rest] = LOCALES;
    const base = catalogue(first);
    for (const locale of rest) {
      const other = catalogue(locale);
      const missing = [...base.keys()].filter((k) => !other.has(k));
      const extra = [...other.keys()].filter((k) => !base.has(k));
      assert.deepEqual(
        { missing, extra },
        { missing: [], extra: [] },
        `${locale} does not match ${first}. Missing: ${missing.join(", ") || "—"}. ` +
          `Only in ${locale}: ${extra.join(", ") || "—"}.`,
      );
    }
  });

  it("every language passes the same arguments to the same message", () => {
    /*
     * This is the one that protects the figures.
     *
     * An English message that dropped `{amount}` still renders. It renders a
     * grammatical sentence with no number in it, the bot repeats it verbatim,
     * and nobody finds out until the month does not add up. And swapping
     * `{account}` for `{toAccount}` would produce a perfect sentence saying the
     * opposite of what happened — ICU binds by name, so this check is the only
     * thing standing between that and a shipped release.
     */
    const [first, ...rest] = LOCALES;
    const base = catalogue(first);
    for (const locale of rest) {
      for (const [key, message] of catalogue(locale)) {
        const mine = [...icuArgs(message, `${key} (${locale})`)].sort();
        const theirs = [...icuArgs(base.get(key) ?? "", `${key} (${first})`)].sort();
        assert.deepEqual(
          mine,
          theirs,
          `«${key}» takes ${theirs.join(", ") || "no arguments"} in ${first} and ` +
            `${mine.join(", ") || "none"} in ${locale}.`,
        );
      }
    }
  });

  it("no money is formatted by ICU", () => {
    /*
     * `money.ts` is the one place in the system where an amount becomes text,
     * and that is what keeps the figure written the same way in both languages.
     * An innocent-looking `{amount, number, currency}` — which is what every
     * i18n tutorial teaches — would print `$1,234.56` next to a `Bs. 1.234,56`
     * produced by `formatAmount` on the very same screen.
     *
     * Money reaches a message ALREADY formatted, as a plain text argument.
     */
    const money = /(amount|total|minor|balance|rate|price)/i;
    for (const locale of LOCALES) {
      for (const [key, message] of catalogue(locale)) {
        for (const node of elements(message, `${key} (${locale})`)) {
          if (node.type === TYPE.number) {
            assert.ok(
              !money.test(String(node.value)),
              `«${key}» (${locale}) puts «${node.value}» through ICU's number. ` +
                `Money is formatted by money.ts and arrives here as text.`,
            );
          }
          if (node.type === TYPE.plural) {
            const usesPound = Object.values(node.options).some((o) =>
              o.value.some((n) => n.type === TYPE.pound),
            );
            assert.ok(
              !(usesPound && money.test(String(node.value))),
              `«${key}» (${locale}) prints «${node.value}» with ICU's #, which formats it. ` +
                `Use a counter for the plural and pass the amount as text.`,
            );
          }
        }
      }
    }
  });

  it("no message carries markup inside it", () => {
    /*
     * ICU reads `<b>…</b>` as a rich-text tag and demands a handler for it. With
     * none, `t()` gives back the KEY, and the message goes out to the chat
     * reading «services.installmentReminders.line» — which is exactly what
     * happened, and it does not throw anywhere.
     *
     * Telegram's markup is not a translatable part of the sentence anyway: it
     * wraps the argument in the code that assembles it.
     */
    for (const locale of LOCALES) {
      for (const [key, message] of catalogue(locale)) {
        for (const node of elements(message, `${key} (${locale})`)) {
          assert.notEqual(
            node.type,
            TYPE.tag,
            `«${key}» (${locale}) carries a <${"value" in node ? node.value : "?"}> tag. ` +
              `ICU would demand a handler and give the key back instead. Wrap the ` +
              `argument in the code that assembles the message.`,
          );
        }
      }
    }
  });

  it("no translation is trimmed with a string operation", () => {
    /*
     * `products/[id]/page.tsx` did `UNIT_LABEL[...]?.replace("el ", "")` to turn
     * «el kilo» into «kilo». It did not match «la unidad», so the screen said
     * «3 la unidad» — in Spanish, before any of this existed.
     *
     * Cutting a translation with a string operation is always a bug waiting for
     * a language. If two forms are needed, they are two keys.
     */
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const bad of [/\bt\([^)]*\)\s*[?!]?\.\s*replace\(/, /\bt\([^)]*\)\s*[?!]?\.\s*endsWith\(/]) {
        assert.ok(
          !bad.test(source),
          `${file.replace(ROOT, "src")} operates on the result of a t(...) with a string ` +
            `method. If two forms are needed, they are two keys.`,
        );
      }
    }
  });

  it("the server-only catalogues never cross to the browser", () => {
    /*
     * `services` and `api` are ~250 messages worded on the server, which travel
     * to the client already rendered. Importing them from a `"use client"` file
     * would put all of them into every page's payload for nothing.
     *
     * And nothing outside `src/i18n` imports `next-intl` in a plain `.ts`: its
     * `exports` resolves to the client build with no `react-server` condition,
     * which is what `tsx --test`, the heartbeat and the seed all run under.
     */
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      const short = file.replace(ROOT, "src");
      if (/^\s*["']use client["']/m.test(source)) {
        assert.ok(
          !/messages\/\w+\/(services|api)\.json|@\/i18n\/translator/.test(source),
          `${short} is a client file and reaches for a server-only catalogue.`,
        );
      }
      if (file.endsWith(".ts") && !short.startsWith("src/i18n")) {
        assert.ok(
          !/from "next-intl(\/server)?"/.test(source),
          `${short} imports next-intl outside the React tree. Use use-intl/core ` +
            `through @/i18n/translator: next-intl resolves to its client build here.`,
        );
      }
    }
  });
});

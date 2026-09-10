import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

/**
 * That everything a person can do from the screen can be done from the chat.
 *
 * The goal is a subtraction:
 *
 *   reachable_from_the_web \ reachable_from_the_MCP_catalogue = ∅
 *
 * It is written as a guard and not as a promise because the gap does not
 * announce itself. `manage-payees` went without a door from the day it was
 * written, and what finally said so was a bot answering «planfly does not seem
 * to have tools for places» — after months in which every purchase recorded from
 * a chat lost its shop. Eleven entries of a hundred and nine carried one.
 *
 * **What this proves and what it does not.** It proves a door EXISTS, not that
 * the door opens: a multiplexing route reachable through one branch counts as
 * covered even if the branch nobody calls is the one that matters. That half is
 * `tool-actions.test.ts`'s, and either alone reassures more than it should.
 *
 * It is deliberately NOT a manifest of `resource → tool`. A manifest is a COPY
 * of the truth, and a copy that drifts does not fail: it says «covered» while
 * the tool no longer calls that function. Nor is it a grep for the name, which
 * would repeat the mistake `registry-guard` already makes with `requireScope(` —
 * a check satisfied by the mention.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Where a resource's write path lives. Everything here is in the universe. */
const SERVICE_DIRS = [join(SRC, "lib/services")];
const SERVICE_FILES = [join(SRC, "lib/rates/service.ts")];

/** The catalogue is the only door the MCP has. Both gateway tools hang off it. */
const MCP_ROOTS = [join(SRC, "lib/mcp/catalog.ts"), join(SRC, "lib/mcp/tools/gateway.ts")];

/**
 * The screen's roots, kept separate from the MCP's on purpose.
 *
 * It is precisely because a server action calls a service directly that the
 * subtraction can see «the web can and the chat cannot». Sharing a root would
 * make every gap disappear into the union.
 */
const WEB_DIRS = [join(SRC, "app/(app)"), join(SRC, "components")];

type Kind =
  | "needs-upload"
  | "heartbeat"
  | "resolver-helper"
  | "pure-helper"
  | "ui-projection"
  | "by-design"
  | "internal";

/**
 * Permanently out, each with its reason. NOT a place to park work.
 *
 * The `kind` is a closed union so that a new category has to be invented in the
 * type and not in a sentence — the way a list like this turns into a bin is one
 * plausible excuse at a time.
 */
const EXEMPT: Array<{ fn: string; kind: Kind; because: string }> = [
  // Needs a file. MCP carries no bytes, and a CSV wizard is a screen.
  { fn: "previewImport", kind: "needs-upload", because: "reads an uploaded CSV and shows what would be imported" },
  { fn: "commitImport", kind: "needs-upload", because: "writes what that upload previewed" },
  { fn: "applyRules", kind: "internal", because: "only commitImport calls it" },
  { fn: "rowHash", kind: "pure-helper", because: "the import's deduplication key" },

  // The heartbeat. Firing either by hand duplicates entries or notifications.
  { fn: "runDueRecurrences", kind: "heartbeat", because: "the tick that posts due recurrences; calling it twice posts twice" },
  { fn: "sendDueInstallmentReminders", kind: "heartbeat", because: "the tick that warns about instalments; calling it twice warns twice" },

  // Fuzzy resolution. Already runs INSIDE every route and tool — that is why
  // they all take names instead of ids. Exposing it would duplicate the surface.
  { fn: "resolveIn", kind: "resolver-helper", because: "the trigram match every resolver is built on" },
  { fn: "resolveAccount", kind: "resolver-helper", because: "runs inside the routes that take an account by name" },
  { fn: "resolveCategory", kind: "resolver-helper", because: "same, for categories" },
  { fn: "resolvePayee", kind: "resolver-helper", because: "same, for places" },
  { fn: "resolveProduct", kind: "resolver-helper", because: "same, for products" },
  { fn: "normalize", kind: "pure-helper", because: "strips accents and case so two spellings match" },
  { fn: "toSlug", kind: "pure-helper", because: "turns a name into the key an alias is matched on" },

  // A product is born when a purchase brings its breakdown. Written into the
  // tool's own description: «they are not created here».
  { fn: "ensureProducts", kind: "by-design", because: "products appear from a purchase's breakdown, never on their own" },
  { fn: "prepareItems", kind: "internal", because: "record/update call it while building a breakdown" },

  // Pure. Nothing to reach.
  { fn: "parseAliases", kind: "pure-helper", because: "splits a comma-separated list" },
  { fn: "natureOf", kind: "pure-helper", because: "asset or liability, from the account type" },
  { fn: "storedBalance", kind: "pure-helper", because: "a SQL fragment the balance query is built from" },
  { fn: "balanceExpression", kind: "pure-helper", because: "a SQL fragment shared by the balance queries" },
  { fn: "valuationFrom", kind: "pure-helper", because: "reads a query-string value" },
  { fn: "daysFor", kind: "pure-helper", because: "the days a cadence falls on" },
  { fn: "isRateTooStale", kind: "pure-helper", because: "compares two dates" },
  { fn: "inferPaymentMethod", kind: "pure-helper", because: "guesses a payment method from the account type" },
  { fn: "itemsTotal", kind: "pure-helper", because: "adds a breakdown up" },
  { fn: "itemsNeedReview", kind: "pure-helper", because: "decides whether a breakdown is doubtful" },
  { fn: "normalizeQuantity", kind: "pure-helper", because: "text primitive for quantities" },
  { fn: "localeOf", kind: "internal", because: "the principal already carries the household's language" },
  { fn: "accountBalance", kind: "internal", because: "its result already leaves through /api/v1/context" },

  // Wrapped by something that IS reachable.
  { fn: "saveRate", kind: "internal", because: "saveManualRate and dailySnapshot wrap it" },
  { fn: "refreshSlot", kind: "internal", because: "dailySnapshot drives it" },
  { fn: "resolveRates", kind: "internal", because: "the rate engine, used while recording" },
  { fn: "lastSnapshotAt", kind: "ui-projection", because: "the rates screen's freshness line" },
  { fn: "pairsInUse", kind: "internal", because: "what the heartbeat asks before capturing" },
  { fn: "p2pTopOfDay", kind: "ui-projection", because: "the who-pays-that panel" },
  { fn: "planForTransaction", kind: "ui-projection", because: "the voiding dialog's warning" },

  // Paging and facets of /transactions.
  { fn: "countTransactions", kind: "ui-projection", because: "the pager's total" },
  { fn: "filteredTotals", kind: "ui-projection", because: "the filtered sum shown above the table" },
  { fn: "transactionFacets", kind: "ui-projection", because: "the counts beside each filter" },
  { fn: "pendingReviewCount", kind: "ui-projection", because: "the badge in the navigation" },
];

/**
 * The debt. Every entry is a door somebody can open from the screen and not from
 * the chat, and every one of them has a PR that closes it.
 *
 * An entry that stops being a gap makes this test FAIL, naming it. That is what
 * makes each PR delete its own line — it is not discipline, it is the CI.
 */
const GAPS: Array<{ fn: string; plan: string; because: string }> = [
  // Places. The most conversational of the lot.
  { fn: "createPayee", plan: "places", because: "«lo compré en la Farmatodo» cannot create the shop" },
  { fn: "updatePayee", plan: "places", because: "renaming or re-aliasing a shop" },
  { fn: "archivePayee", plan: "places", because: "retiring a shop that closed" },
  { fn: "unarchivePayee", plan: "places", because: "a shop that reopened, or was retired by mistake" },
  { fn: "placeUnplaced", plan: "places", because: "«esto de PAGO C31 FARMATODO es Farmatodo»" },
  { fn: "payeeTree", plan: "places", because: "the chat cannot see a single shop" },
  { fn: "unplacedGroups", plan: "places", because: "what is still unplaced" },
  { fn: "archivedPayees", plan: "places", because: "what was retired" },

  // Categories. The chat resolves them by name and cannot create one.
  { fn: "createCategory", plan: "categories", because: "the chat matches categories but cannot add one" },
  { fn: "updateCategory", plan: "categories", because: "renaming, aliases, parent" },
  { fn: "archiveCategory", plan: "categories", because: "accounts have this and categories do not" },
  { fn: "unarchiveCategory", plan: "categories", because: "a category retired by mistake, or needed again" },
  { fn: "categoryTree", plan: "categories", because: "/api/v1/context lists them flat, without the tree" },
  { fn: "archivedCategories", plan: "categories", because: "what was retired" },

  // Currencies. Blocks a flow planfly_account describes and cannot complete.
  { fn: "createCurrency", plan: "currencies", because: "planfly_account demands a known currency and nothing can add one" },
  { fn: "updateCurrency", plan: "currencies", because: "whether it has an official rate" },
  { fn: "removeCurrency", plan: "currencies", because: "dropping one nothing is held in" },
  { fn: "listCurrencies", plan: "currencies", because: "context returns them, but not their decimals or flags" },

  // Rates written by hand. What makes planfly useful with no source connected.
  { fn: "saveManualRate", plan: "rates", because: "«la tasa de hoy es 300» has no door at all" },
  { fn: "removeManualRate", plan: "rates", because: "undoing a rate written by hand, so the source rules again" },
  { fn: "manualRates", plan: "rates", because: "what was written by hand" },
  { fn: "dailySnapshot", plan: "rates", because: "has a route, no tool: refreshing on demand" },

  // Automatic categorisation rules.
  { fn: "saveRule", plan: "rules", because: "«cuando diga FARMATODO, categoría Salud»" },
  { fn: "removeRule", plan: "rules", because: "retiring a rule that stopped matching what it meant" },
  { fn: "listRules", plan: "rules", because: "seeing what is in force" },

  // Lending. Built, tested, and reachable from nowhere at all.
  { fn: "recordLoanMade", plan: "lending", because: "money you lend: the service exists and NOTHING calls it" },

  // Financier profiles: what Cashea asks up front and in how many instalments.
  { fn: "saveFinancierProfile", plan: "financiers", because: "the context planfly_financing needs and cannot set" },
  { fn: "removeFinancierProfile", plan: "financiers", because: "when somebody stops financing you" },
  { fn: "financiersView", plan: "financiers", because: "the chat cannot list who finances you" },

  // The review tray: the agent approves blind and learns from the error.
  { fn: "reviewReasons", plan: "review", because: "why a row is in the tray" },
  { fn: "canBeApproved", plan: "review", because: "whether approving would even clear it" },

  // Small reads with no way out.
  { fn: "archivedAccounts", plan: "small-reads", because: "unarchiving is possible; listing what is archived is not" },
  { fn: "committedInstallments", plan: "small-reads", because: "how much is already committed to instalments" },
  { fn: "itemsOfTransaction", plan: "small-reads", because: "«¿qué traía la compra del martes?»" },
  { fn: "upcomingInstallments", plan: "small-reads", because: "what falls due soon" },
];

/** Raise this and you are declaring a new gap in a diff. Lower it and you closed one. */
const CEILING = 35;

// ── Reading the tree ────────────────────────────────────────────────────────

function walkDir(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkDir(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** `@/x` → `src/x`, `./x` → beside the file. Never leaves the repo. */
function resolveSpecifier(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

type Module = {
  /** local name → the file it was imported from */
  imports: Map<string, string>;
  /** every identifier that appears as the callee of a call */
  called: Set<string>;
};

const cache = new Map<string, Module>();

function read(file: string): Module {
  const hit = cache.get(file);
  if (hit) return hit;

  const sf = parse(file);
  const imports = new Map<string, string>();
  const called = new Set<string>();

  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      const bindings = node.importClause?.namedBindings;
      if (target && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imports.set(element.name.text, target);
      }
    }
    /*
     * A call, not a mention. A module that imports a service and never calls it
     * proves nothing — and that difference is the whole reason this is not a
     * grep.
     */
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) called.add(callee.text);
    }
    node.forEachChild(walk);
  };
  walk(sf);

  const parsed: Module = { imports, called };
  cache.set(file, parsed);
  return parsed;
}

/** Every service function called from anything reachable from these roots. */
function reachableFrom(roots: string[], services: Set<string>): Set<string> {
  const seen = new Set<string>();
  const found = new Set<string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    const { imports, called } = read(file);
    for (const [local, target] of imports) {
      if (services.has(target) && called.has(local)) found.add(local);
      if (target.startsWith(SRC) && !seen.has(target)) queue.push(target);
    }
  }
  return found;
}

// ── The test ────────────────────────────────────────────────────────────────

describe("what the screen can do and the chat cannot", () => {
  const serviceFiles = new Set([...SERVICE_DIRS.flatMap((d) => walkDir(d)), ...SERVICE_FILES]);

  /** Every exported function of a service. The universe being measured. */
  const universe = new Map<string, string>();
  for (const file of serviceFiles) {
    const sf = parse(file);
    for (const statement of sf.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) universe.set(statement.name.text, relative(ROOT, file));
    }
  }

  const fromMcp = reachableFrom(MCP_ROOTS, serviceFiles);
  const fromWeb = reachableFrom(WEB_DIRS.flatMap((d) => walkDir(d)), serviceFiles);

  it("measured anything at all", () => {
    /*
     * The floors come first, and they are not ceremony.
     *
     * If the specifier resolver silently stops resolving `@/…`, every set comes
     * back empty and the whole file goes green — a guard that checks nothing
     * while reporting success is worse than no guard. These numbers are what
     * make that failure loud.
     */
    assert.ok(universe.size >= 90, `only ${universe.size} service functions found`);
    assert.ok(fromMcp.size >= 20, `only ${fromMcp.size} reachable from the catalogue`);
    assert.ok(fromWeb.size >= 30, `only ${fromWeb.size} reachable from the screen`);
  });

  it("has a door for everything a person can do from the screen", () => {
    const declared = new Set([...EXEMPT.map((e) => e.fn), ...GAPS.map((g) => g.fn)]);
    const undeclared = [...fromWeb]
      .filter((fn) => universe.has(fn) && !fromMcp.has(fn) && !declared.has(fn))
      .sort();

    assert.deepEqual(
      undeclared,
      [],
      "these can be done from the screen and not from the chat, and nobody said so.\n" +
        "  Give each one a door — schema in validation.ts, route under api/v1, tool in\n" +
        "  the catalogue — or declare it in EXEMPT with the reason it does not want one:\n" +
        undeclared.map((fn) => `    ${fn}  (${universe.get(fn)})`).join("\n"),
    );
  });

  it("has no service nobody can reach at all", () => {
    /*
     * The cube with no third option. A write path reachable from neither surface
     * is either a door somebody forgot to open or code nobody asked for, and
     * both are answered by doing something — not by adding a line here.
     */
    const declared = new Set([...EXEMPT.map((e) => e.fn), ...GAPS.map((g) => g.fn)]);
    const orphans = [...universe.keys()]
      .filter((fn) => !fromMcp.has(fn) && !fromWeb.has(fn) && !declared.has(fn))
      .sort();

    assert.deepEqual(
      orphans,
      [],
      "no surface reaches these. Give them a door or delete them:\n" +
        orphans.map((fn) => `    ${fn}  (${universe.get(fn)})`).join("\n"),
    );
  });

  it("keeps the debt honest and shrinking", () => {
    const closed = GAPS.filter((g) => fromMcp.has(g.fn)).map((g) => g.fn);
    assert.deepEqual(
      closed,
      [],
      `these are reachable from the chat now: delete their line from GAPS and drop CEILING to ${GAPS.length - closed.length}.\n` +
        "  A debt list that keeps a paid entry stops being read.",
    );

    const gone = GAPS.filter((g) => !universe.has(g.fn)).map((g) => g.fn);
    assert.deepEqual(gone, [], "these no longer exist: delete their line from GAPS");

    assert.ok(
      GAPS.length <= CEILING,
      `GAPS has ${GAPS.length} entries and the ceiling is ${CEILING}. Raising it is ` +
        "declaring a new gap, which is a thing to do on purpose and in a diff.",
    );
  });

  it("never lets an exemption and a debt be the same thing", () => {
    // Two lists, never one. Mixing them is how a debt becomes a design decision
    // without anyone noticing it happened.
    const both = EXEMPT.filter((e) => GAPS.some((g) => g.fn === e.fn)).map((e) => e.fn);
    assert.deepEqual(both, [], "declared as permanently out AND as pending work");

    for (const entry of [...EXEMPT, ...GAPS]) {
      assert.ok(entry.because.length > 15, `${entry.fn} has no real reason written`);
    }
  });
});

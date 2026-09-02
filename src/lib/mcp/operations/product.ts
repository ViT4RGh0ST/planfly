import { NextRequest } from "next/server";
import type { z } from "zod";

import { GET as productsRead, POST as productsWrite } from "@/app/api/v1/products/route";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import type { McpOperation } from "@/lib/mcp/operation";
import { RouteRefusal } from "@/lib/mcp/tools/context";
import { resolveProduct } from "@/lib/services/products";
import { normalize, toSlug } from "@/lib/services/resolve-entities";
import { mergeProductsSchema, splitProductSchema } from "@/lib/validation";

/**
 * The two writes of the product catalogue, as confirmable operations.
 *
 * Neither service can simulate itself. `recordTransaction` is the only one that
 * can: `mergeProducts` and `splitProduct` are an UPDATE over `transaction_items`
 * inside a transaction, and asking them for a dry run would mean writing that
 * update twice. So `run` with `dryRun` returns, instead, a DESCRIPTION of what
 * is about to change, read from the state each one depends on — which rows the
 * free text resolves to, and how many line items carry the price series that
 * moves. The fingerprint is over that state, and that is what makes the yes
 * mean something: a merge rewrites which product every past line item points at
 * and there is no route back from here.
 *
 * The confirmation id is not carried into either write. A merge has no
 * idempotency key — nothing lands in the ledger to key it by — so what stops a
 * second one is the gate's atomic claim, which is exactly why these two must
 * never be run outside `confirmMcpOperation`.
 */

const PATH = "/api/v1/products";

type MergeDraft = z.infer<typeof mergeProductsSchema>;
type SplitDraft = z.infer<typeof splitProductSchema>;

type RawTextGroup = { text: string; times: number };
type CatalogueEntry = { name: string; times_bought: number };

/**
 * A read of the products route, with the route's own refusal preserved.
 *
 * A tool has `ctx.callRoute` for this; an operation runs inside the gate and has
 * no context — what it has is the principal the confirmation was staged with.
 * It goes through the route and not through the services on purpose: `GET` is
 * wrapped in `reports:read`, so the refresh the gate performs on the way to the
 * write is checked against the credential again, rather than trusting that
 * whoever staged it had checked.
 */
async function readProducts(
  principal: Principal,
  params: { product?: string },
): Promise<Record<string, unknown>> {
  const query = params.product ? `?${new URLSearchParams({ product: params.product })}` : "";
  const response = await productsRead(
    withInternalPrincipal(new NextRequest(`http://planfly.internal${PATH}${query}`), principal),
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new RouteRefusal(payload, response.status);
  return payload;
}

/**
 * The write goes through v1 and not through the service.
 *
 * `POST /api/v1/products` runs `rejectUnknownKeys` and resolves both names
 * again with the same matcher the preview used; the service underneath takes
 * ids and would happily merge a pair nobody named. The principal travels in the
 * request-identity map — `withInternalPrincipal` — and never in a header a
 * caller could forge.
 *
 * A refusal is thrown rather than returned: the gate releases its claim when
 * `run` throws, so an approval the route turned down is given back instead of
 * spent.
 */
async function writeProducts(
  principal: Principal,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await productsWrite(
    withInternalPrincipal(
      new NextRequest(`http://planfly.internal${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      principal,
    ),
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new RouteRefusal(payload, response.status);
  return payload;
}

/**
 * One point is one line item that a purchase brought.
 *
 * It is what the price history shows, so it is the number a person can check.
 * Lines of a voided entry are not in it and they do move with the product; they
 * carry no price and no series, which is why this is still the honest count.
 */
function lineItems(body: Record<string, unknown>): number {
  return Array.isArray(body.points) ? body.points.length : 0;
}

function rawTextGroups(body: Record<string, unknown>): RawTextGroup[] {
  return Array.isArray(body.raw_texts) ? (body.raw_texts as RawTextGroup[]) : [];
}

function catalogueEntries(body: Record<string, unknown>): CatalogueEntry[] {
  return Array.isArray(body.products) ? (body.products as CatalogueEntry[]) : [];
}

/**
 * The letters `unaccent` transliterates and NFD does not decompose.
 *
 * They are two different things: NFD splits a letter from its combining mark, so
 * it covers á and ñ; `unaccent` reads a dictionary, so it also turns ª into a
 * and ß into ss, which carry no mark to split off. Every one of those is a place
 * where the key below and the split's own SQL key stop agreeing, and here a
 * disagreement is not a miss but a count.
 *
 * These are all of them up to U+017F — Latin-1 and Latin Extended-A, everything
 * a Spanish keyboard or a receipt scanner can put in a line item. Past that the
 * dictionary is IPA and African Latin, and a divergence there ends as a count of
 * zero, which is refused rather than approved.
 */
const UNACCENT_LETTERS: Record<string, string> = {
  "ª": "a", "µ": "μ", "º": "o", "ß": "ss", "æ": "ae", "ð": "d", "ø": "o", "þ": "th",
  "đ": "d", "ħ": "h", "ı": "i", "ĳ": "ij", "ĸ": "q", "ŀ": "l", "ł": "l", "ŋ": "n",
  "œ": "oe", "ŧ": "t", "ſ": "s",
};

const UNACCENT_LETTER = new RegExp(`[${Object.keys(UNACCENT_LETTERS).join("")}]`, "gu");

/**
 * A receipt line as the split's own SQL compares it: lowercased and unaccented,
 * with its punctuation intact.
 *
 * The two sides are deliberately asymmetric — the text given is compared through
 * `normalize`, which also drops punctuation — and reproducing that asymmetry is
 * what makes the previewed count the count the split will really move, rather
 * than the count it ought to move.
 *
 * It APPROXIMATES `unaccent`: NFD for what carries a mark, the table above for
 * the letters that do not, and nothing for the rest of a 2,600-line dictionary.
 * What keeps the approximation from lying is that it can only ever match less
 * than the SQL does, and a preview that matches nothing is refused.
 */
function receiptKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(UNACCENT_LETTER, (letter) => UNACCENT_LETTERS[letter]);
}

type ProductSide = {
  id: string;
  /** The name it resolved to, which is rarely the name that was asked for. */
  name: string;
  lineItems: number;
  body: Record<string, unknown>;
};

/**
 * Which row a free text lands on, and how much history that row carries.
 *
 * The id is read separately because the route answers with the name and never
 * with the id, and a name is not an identity: it can be edited, and what is
 * being approved is that these two ROWS are joined. Both resolutions run on the
 * same text against the same matcher in the same instant, so they agree; if the
 * row disappeared between them, that is the one case below.
 */
async function productSide(principal: Principal, text: string): Promise<ProductSide> {
  const [body, match] = await Promise.all([
    readProducts(principal, { product: text }),
    // `create: false`: describing a merge must never seed the catalogue with
    // the product it failed to find.
    resolveProduct(principal.householdId, text, "unit", false),
  ]);

  if (!match) {
    throw new RouteRefusal(
      {
        ok: false,
        error: "product_not_found",
        message: `Planfly no longer finds a product for «${text}»; nothing was changed.`,
      },
      404,
    );
  }

  return { id: match.id, name: match.name, lineItems: lineItems(body), body };
}

async function mergePreview(
  principal: Principal,
  draft: MergeDraft,
): Promise<Record<string, unknown>> {
  const [from, into] = await Promise.all([
    productSide(principal, draft.from),
    productSide(principal, draft.into),
  ]);
  const moving = from.lineItems;

  return {
    operation: "merge_products",
    from: { product_id: from.id, product: from.name, line_items: moving },
    into: { product_id: into.id, product: into.name, line_items: into.lineItems },
    line_items_moving: moving,
    /** There is no route back: the origin's row is deleted, series and all. */
    reversible: false,
  };
}

async function splitPreview(
  principal: Principal,
  draft: SplitDraft,
): Promise<Record<string, unknown>> {
  const [source, catalogue] = await Promise.all([
    productSide(principal, draft.product),
    readProducts(principal, {}),
  ]);
  const cleaned = draft.raw_text.trim();
  const lineKey = normalize(cleaned);
  const groups = rawTextGroups(source.body);
  /*
   * Lines of a voided entry are not in these counts and they do move with the
   * split, for the same reason as in a merge: what is being approved is a price
   * series, and a voided line carries none.
   */
  const moving = groups
    .filter((group) => receiptKey(group.text) === lineKey)
    .reduce((total, group) => total + group.times, 0);

  /*
   * Nothing to move is refused here, not previewed as zero.
   *
   * The write refuses it as well — `splitProduct` throws when no line matches —
   * so a zero can at best be approved into an error. At worst it is not a zero:
   * `receiptKey` only approximates `unaccent`, and where the two part company
   * the preview counts none while the SQL matches every one of them, so the
   * person approves «no line item moves» and a price series leaves the product.
   * Refusing makes both cases the same refusal, carrying the list the text has
   * to be copied from.
   */
  if (moving === 0) {
    throw new RouteRefusal(
      {
        ok: false,
        error: "invalid_product",
        // The route sends no list at all when the product has fewer than two
        // distinct line items, and then «that text is not on the list» would
        // point at a list that was never shown. It is the other refusal: a split
        // pulls one line item out and leaves the rest, so it needs two.
        message:
          groups.length === 0
            ? `Planfly knows of no second line item on «${source.name}»: a split pulls one ` +
              "out and leaves the rest, so it needs at least two. Nothing was changed."
            : `«${cleaned}» is not one of the line items «${source.name}» has arrived under, ` +
              "so there is nothing to pull out; nothing was changed.",
        known_raw_texts: groups,
      },
      422,
    );
  }

  /*
   * Where the lines land, decided the way the write decides it: `splitProduct`
   * reuses the row whose SLUG is this text's, and un-archives it. A product's
   * slug is its name's — nothing renames a product once it exists — so the
   * catalogue's names are enough to recognise it, EXCEPT that the catalogue
   * hides what is archived, and that one this cannot see at all.
   */
  const destinationSlug = toSlug(cleaned);
  const target = catalogueEntries(catalogue).find(
    (entry) => toSlug(entry.name) === destinationSlug,
  );

  return {
    operation: "split_product",
    from: { product_id: source.id, product: source.name, line_items: source.lineItems },
    raw_text: draft.raw_text,
    line_items_moving: moving,
    into: {
      product: target?.name ?? cleaned,
      /*
       * Null, and not zero, when it is not in the catalogue.
       *
       * Zero would be a figure, and the figure is sometimes forty: a product
       * archived under this name is revived by the write and the lines join the
       * series it already had. Nothing readable from here can tell the two
       * apart, so the preview says it does not know instead of saying none.
       */
      line_items: target?.times_bought ?? null,
      in_catalogue: target != null,
      ...(target
        ? {}
        : {
            note:
              `«${cleaned}» is not in the catalogue, and the catalogue hides archived ` +
              "products: these lines start a new product UNLESS one was archived under that " +
              "name, in which case it comes back and they join the price history it already " +
              "has. Say so before the person approves it.",
          }),
    },
    /** What the source has really arrived under, so a text that matched nothing shows why. */
    known_raw_texts: groups,
  };
}

/**
 * A branch of the preview, refusing a preview that is not this operation's.
 *
 * It throws instead of reading `undefined` because a fingerprint that answers
 * calmly for a shape it has never seen answers the same for every shape, and
 * that is the same as having no gate at all.
 */
function branch(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (value == null || typeof value !== "object") {
    throw new Error(`This preview carries no ${field}, so it was not built by this operation.`);
  }
  const row = value as Record<string, unknown>;
  // Picked and ordered by hand: `jsonb` does not preserve key order and the
  // comparison is over the serialization, so the stored preview and the fresh
  // one have to be walked in the same order.
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/**
 * Everything that decides WHICH merge this is.
 *
 * The two ids, because the pair is what is being approved and the names that
 * resolve to them are not an identity — a product renamed, archived or merged
 * elsewhere while the person was reading turns the same two words into a
 * different pair, and the merge does not undo. The two counts and the number
 * moving, because «12 line items join these 30» is the figure the person is
 * answering: a purchase recorded in between moves a series nobody looked at.
 */
function mergeFingerprint(preview: Record<string, unknown>): string {
  return JSON.stringify({
    operation: preview.operation,
    from: branch(preview.from, "from", ["product_id", "product", "line_items"]),
    into: branch(preview.into, "into", ["product_id", "product", "line_items"]),
    line_items_moving: preview.line_items_moving,
  });
}

/**
 * Everything that decides WHICH split this is.
 *
 * The source row and its text, and how many lines that text matches: a new
 * purchase arriving under the same line item between the preview and the yes
 * pulls out more history than was shown. And the destination, because whether
 * the lines start a new product or join one that already exists is a different
 * outcome under the same words — an archived row un-archived while the person
 * was reading turns the second into the first, and the count under it goes from
 * unknown to a number.
 *
 * `known_raw_texts` is deliberately NOT in here. It is context for the person,
 * and another variant appearing on the source changes neither which lines move
 * nor where they land; fingerprinting it would spend the approval on a change
 * that is not the one being approved.
 */
function splitFingerprint(preview: Record<string, unknown>): string {
  return JSON.stringify({
    operation: preview.operation,
    from: branch(preview.from, "from", ["product_id", "product", "line_items"]),
    raw_text: preview.raw_text,
    line_items_moving: preview.line_items_moving,
    into: branch(preview.into, "into", ["product", "line_items", "in_catalogue"]),
  });
}

/** Two products that were left apart, joined: the first disappears inside the second. */
export const mergeProductsOperation: McpOperation = {
  run: async (principal, input, _confirmationId, dryRun) => {
    /*
     * Parsed again on the way out of the confirmation, not trusted.
     *
     * `payload.input` is whatever was staged, and the branch it belongs to is
     * decided by v1 on the presence of `raw_text`: a stray key surviving into
     * the body would turn this merge into a split that resolves one of the two
     * names and silently ignores the other.
     */
    const draft = mergeProductsSchema.parse(input);
    return dryRun ? mergePreview(principal, draft) : writeProducts(principal, draft);
  },
  fingerprint: mergeFingerprint,
};

/** One line item pulled out of a product it was never the same thing as. */
export const splitProductOperation: McpOperation = {
  run: async (principal, input, _confirmationId, dryRun) => {
    const draft = splitProductSchema.parse(input);
    return dryRun ? splitPreview(principal, draft) : writeProducts(principal, draft);
  },
  fingerprint: splitFingerprint,
};

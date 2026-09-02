import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { z } from "zod";

import { GET as productsRead, POST as productsWrite } from "@/app/api/v1/products/route";
import { db } from "@/db";
import { withInternalPrincipal } from "@/lib/api/handler";
import type { Principal } from "@/lib/api-token";
import type { McpOperation } from "@/lib/mcp/operation";
import { RouteRefusal } from "@/lib/mcp/tools/context";
import { productRawTexts, resolveProduct } from "@/lib/services/products";
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
 * free text resolves to, and how many line items each write will really move.
 * The fingerprint is over that state, and that is what makes the yes mean
 * something: a merge rewrites which product every past line item points at and
 * there is no route back from here.
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
 * One point is one line item a LIVE purchase brought.
 *
 * It is what the price history shows, so it is the number a person can check
 * against the screen. It is NOT the number either write moves: both move every
 * row, and a voided entry's lines are rows.
 */
function pricedLineItems(body: Record<string, unknown>): number {
  return Array.isArray(body.points) ? body.points.length : 0;
}

function catalogueEntries(body: Record<string, unknown>): CatalogueEntry[] {
  return Array.isArray(body.products) ? (body.products as CatalogueEntry[]) : [];
}

/**
 * The line items as the two writes count them, asked of Postgres in their words.
 *
 * `splitProduct` selects EVERY row of `transaction_items` carrying the product —
 * there is no join to `transactions`, so a voided entry's lines are in it — and
 * moves the ones whose `lower(unaccent(btrim(raw_text)))` equals the key,
 * answering «{n} purchases moved». `mergeProducts` moves the same set, all of
 * it. The route and the price history count only live lines, and previewing
 * THAT number is the false figure this exists to kill: the person approves «3
 * line items move», the write answers «23 purchases moved», and nothing on the
 * screen reconciles the two.
 *
 * It is the same expression and not an approximation of it. What stood here
 * before rebuilt `unaccent` in TypeScript from a table of letters, and its JS
 * `trim()` stripped a tab or a non-breaking space that `btrim()`'s default set —
 * the plain space, and nothing else — leaves in place: the preview then counted
 * a line the write would not move, and the split moved fewer than were approved.
 *
 * `total` also decides a refusal. `splitProduct` throws «that is all of its
 * lines» when every row matches, and only this count can see it coming: the
 * rows it counts include the ones no read of the price history can show.
 */
async function lineItemCounts(
  householdId: string,
  productId: string,
  key?: string,
): Promise<{ total: number; matching: number }> {
  const matches =
    key === undefined ? sql`false` : sql`lower(unaccent(btrim(i.raw_text))) = ${key}`;
  const { rows } = await db.execute<{ total: string; matching: string }>(sql`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE ${matches})::text AS matching
      FROM transaction_items i
     WHERE i.household_id = ${householdId} AND i.product_id = ${productId}
  `);
  return { total: Number(rows[0]?.total ?? 0), matching: Number(rows[0]?.matching ?? 0) };
}

type ProductSide = {
  id: string;
  /** The name it resolved to, which is rarely the name that was asked for. */
  name: string;
  /** Every line item on it: what a merge moves, and what a split counts against. */
  lineItems: number;
  /** Of those, the ones a split by this text would carry. Zero when no text was given. */
  matching: number;
  /** Those a live purchase brought — the size of the price history. */
  priced: number;
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
async function productSide(
  principal: Principal,
  text: string,
  /** The split's key, when there is one. Both counts come from ONE read for a reason. */
  key?: string,
): Promise<ProductSide> {
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

  /*
   * One read, not two. Asking for the total and for the matching count
   * separately lets a purchase recorded in between answer a different total to
   * each, and the preview would then show «3 of 5 move» over counts that never
   * held at the same instant.
   */
  const counts = await lineItemCounts(principal.householdId, match.id, key);
  return {
    id: match.id,
    name: match.name,
    lineItems: counts.total,
    matching: counts.matching,
    priced: pricedLineItems(body),
    body,
  };
}

/**
 * A product as the person has to be told it, with both counts and why they part.
 *
 * Two numbers because there are two, and giving only one lies whichever is
 * chosen: `line_items` is what the write moves and answers with, and
 * `line_items_with_price` is what the price history shows, which is the one the
 * person can check against the screen. When they differ the difference is said
 * out loud, in the payload and not in a comment: a comment reaches whoever opens
 * this file next, never the model that has to explain the figure.
 */
function sidePayload(side: ProductSide): Record<string, unknown> {
  const voided = side.lineItems - side.priced;
  return {
    product_id: side.id,
    product: side.name,
    line_items: side.lineItems,
    line_items_with_price: side.priced,
    ...(voided > 0
      ? {
          note:
            `${voided} of «${side.name}»'s ${side.lineItems} line items belong to voided ` +
            `entries: they carry no price, so the history shows ${side.priced}. They move ` +
            "with the rest all the same, and the count Planfly answers with includes them.",
        }
      : {}),
  };
}

async function mergePreview(
  principal: Principal,
  draft: MergeDraft,
): Promise<Record<string, unknown>> {
  const [from, into] = await Promise.all([
    productSide(principal, draft.from),
    productSide(principal, draft.into),
  ]);

  return {
    operation: "merge_products",
    from: sidePayload(from),
    into: sidePayload(into),
    /** Every row of the origin, because that is what the UPDATE moves. */
    line_items_moving: from.lineItems,
    /** There is no route back: the origin's row is deleted, series and all. */
    reversible: false,
  };
}

/** A refusal worded for whoever asked, carrying the list the text has to come from. */
function splitRefusal(message: string, groups: RawTextGroup[]): RouteRefusal {
  return new RouteRefusal(
    { ok: false, error: "invalid_product", message, known_raw_texts: groups },
    422,
  );
}

async function splitPreview(
  principal: Principal,
  draft: SplitDraft,
): Promise<Record<string, unknown>> {
  const cleaned = draft.raw_text.trim();
  const lineKey = normalize(cleaned);
  const destinationSlug = toSlug(cleaned);

  /*
   * `splitProduct` refuses a text with no letter or digit — there is no name to
   * give the new product — and it would refuse it AFTER the yes. Worse, the key
   * of such a text is the empty string, which is what a line item with a blank
   * `raw_text` compares equal to, so the count below could even be a number.
   */
  if (!destinationSlug) {
    throw splitRefusal(
      `«${draft.raw_text}» has no letter or digit in it, so there is no product to split ` +
        "into. Copy the line item exactly as it came out on the receipt. Nothing was changed.",
      [],
    );
  }

  const [source, catalogue] = await Promise.all([
    productSide(principal, draft.product, lineKey),
    readProducts(principal, {}),
  ]);

  /*
   * The list comes from the service and not from the route's answer.
   *
   * `GET` omits `raw_texts` entirely when the product has fewer than two
   * distinct line items — reasonable on a price question, wrong here: it left
   * the preview unable to tell «that text is not on the list» from «no list was
   * sent», and the refusal it wrote then blamed a shortage of line items for a
   * split the service would have accepted.
   */
  const rawTexts = await productRawTexts(principal.householdId, source.id);
  const groups: RawTextGroup[] = rawTexts.map((r) => ({ text: r.rawText, times: r.count }));

  /*
   * The product's own name is not one of its line items.
   *
   * `splitProduct` compares the slug it would create against the source's and
   * throws, because that is a rename and not a split. Nothing ever renames a
   * product — `products.name` is written on insert and never updated — so its
   * slug is its name's, and the check can be made here, before the approval is
   * spent on a refusal.
   */
  if (destinationSlug === toSlug(source.name)) {
    throw splitRefusal(
      `«${cleaned}» is the name of «${source.name}» itself, not one of the line items it has ` +
        "arrived under. A split pulls a line item out and leaves the product behind; renaming " +
        "it is another thing. Nothing was changed.",
      groups,
    );
  }

  /*
   * Nothing to move is refused here, not previewed as zero.
   *
   * The write refuses it as well — `splitProduct` throws when no line matches —
   * so a zero can at best be approved into an error, and the person reads that
   * error as their yes having failed. Refusing here carries the list the text
   * has to be copied from, which is the only way out of it.
   */
  if (source.matching === 0) {
    throw splitRefusal(
      groups.length === 0
        ? `No line item of «${source.name}» reads «${cleaned}», and none of its purchases ` +
            "recorded the receipt's text at all, so there is nothing to pull out by. Nothing " +
            "was changed."
        : `«${cleaned}» is not one of the line items «${source.name}» has arrived under, ` +
            "so there is nothing to pull out; nothing was changed.",
      groups,
    );
  }

  /*
   * And everything moving is refused too, for the same reason: `splitProduct`
   * throws «that is all of its lines» and would throw it after the yes. It is
   * `total` and not the history's count that decides it — the write counts the
   * voided entries' lines on both sides of that comparison, and they are the
   * ones that can make the difference between a rename and a split.
   */
  if (source.matching === source.lineItems) {
    throw splitRefusal(
      `«${cleaned}» is every one of «${source.name}»'s ${source.lineItems} line items: pulling ` +
        "them all out would leave it empty, which is renaming it and not splitting it. " +
        "Nothing was changed.",
      groups,
    );
  }

  /*
   * Where the lines land, decided the way the write decides it: `splitProduct`
   * reuses the row whose SLUG is this text's, and un-archives it. A product's
   * slug is its name's — nothing renames a product once it exists — so the
   * catalogue's names are enough to recognise it, EXCEPT that the catalogue
   * hides what is archived, and that one this cannot see at all.
   */
  const target = catalogueEntries(catalogue).find(
    (entry) => toSlug(entry.name) === destinationSlug,
  );

  return {
    operation: "split_product",
    from: sidePayload(source),
    raw_text: draft.raw_text,
    /** Exactly the rows the UPDATE will carry, so it is the number the write answers with. */
    line_items_moving: source.matching,
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
      line_items_with_price: target?.times_bought ?? null,
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
 *
 * `line_items_with_price` is deliberately NOT in here: an entry voided between
 * the preview and the yes moves that number and moves nothing else — the same
 * rows still join the same product — and spending the approval on it would send
 * the person back to approve an identical merge.
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
 * that is not the one being approved. Neither is the source's
 * `line_items_with_price`, for the reason given above the merge's.
 */
function splitFingerprint(preview: Record<string, unknown>): string {
  return JSON.stringify({
    operation: preview.operation,
    from: branch(preview.from, "from", ["product_id", "product", "line_items"]),
    raw_text: preview.raw_text,
    line_items_moving: preview.line_items_moving,
    into: branch(preview.into, "into", ["product", "line_items_with_price", "in_catalogue"]),
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

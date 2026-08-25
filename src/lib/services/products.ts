import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { getTranslator } from "@/i18n/translator";
import { localeOf } from "./household-locale";
import { products, transactionItems } from "@/db/schema";
import { parseAmountToMinor } from "@/lib/money";
import { normalize, resolveIn, toSlug } from "./resolve-entities";

/**
 * Products: what you bought inside a purchase, and how its price moves.
 *
 * What makes this useful is not the breakdown itself, it is being able to answer
 * «did flour go up?». And that question, here, is not answered in bolívares:
 * they rise from inflation and they rise because the rate moved. That is why
 * every line stores its dollar equivalent at that day's rate, and the comparison
 * runs through there.
 */

export type BaseUnit = "kg" | "l" | "unit";

/**
 * What can be said to whoever is looking at the screen.
 *
 * Merging and splitting throw these already worded — what happened and what to
 * do — and without a class of their own `messageForScreen` would replace them
 * with the generic sentence: whoever hits «split» would see "I couldn't complete
 * it" instead of "no line says that".
 */
export class InvalidProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProductError";
  }
}

/**
 * How each receipt unit is carried to the base unit.
 *
 * The factor multiplies the quantity read: 750 g × 0.001 = 0.75 kg. Anything not
 * listed here is treated as a count — a pack, a unit — and left as-is, which is
 * more honest than inventing an equivalence.
 */
const UNIT_FACTORS: Record<string, { base: BaseUnit; factor: number }> = {
  kg: { base: "kg", factor: 1 },
  kgs: { base: "kg", factor: 1 },
  kilo: { base: "kg", factor: 1 },
  kilos: { base: "kg", factor: 1 },
  g: { base: "kg", factor: 0.001 },
  gr: { base: "kg", factor: 0.001 },
  grs: { base: "kg", factor: 0.001 },
  gramo: { base: "kg", factor: 0.001 },
  gramos: { base: "kg", factor: 0.001 },
  l: { base: "l", factor: 1 },
  lt: { base: "l", factor: 1 },
  lts: { base: "l", factor: 1 },
  litro: { base: "l", factor: 1 },
  litros: { base: "l", factor: 1 },
  ml: { base: "l", factor: 0.001 },
  cc: { base: "l", factor: 0.001 },
};

export type NormalizedQuantity = {
  baseUnit: BaseUnit;
  baseQuantity: number;
  /** The unit exactly as it arrived, already cleaned. Stored as provenance. */
  unit: string | null;
};

/**
 * Carries "750 g" to 0.75 kg, and leaves "2 packs" at 2 units.
 *
 * It never invents an equivalence: if the unit isn't recognised, the product is
 * tracked by count. A litre and a pack are not comparable, and pretending they
 * are dirties the one series that matters.
 */
export function normalizeQuantity(
  quantity: number,
  unit: string | null | undefined,
): NormalizedQuantity {
  const clean = unit ? normalize(unit).replace(/\./g, "").trim() : "";
  const known = clean ? UNIT_FACTORS[clean] : undefined;

  if (!known) {
    return { baseUnit: "unit", baseQuantity: quantity, unit: clean || null };
  }
  // Four decimals, which is what the column holds: 1 g in kilos is 0.001 and
  // half a dozen grams must not round to zero.
  const baseQuantity = Math.round(quantity * known.factor * 10_000) / 10_000;
  return {
    baseUnit: known.base,
    // A quantity that rounds to zero could no longer be divided to get the unit
    // price. The smallest representable value is stored instead.
    baseQuantity: baseQuantity > 0 ? baseQuantity : 0.0001,
    unit: clean,
  };
}

/** How much confidence is needed not to flag the line as doubtful. */
export const PRODUCT_MATCH_THRESHOLD = 0.62;

export type ProductMatch = {
  id: string;
  name: string;
  score: number;
  created: boolean;
};

/**
 * Finds the product for a receipt line, or creates it.
 *
 * The same three passes as accounts and categories — exact slug, exact alias and
 * trigram similarity — because the problem is identical: human text (here, read
 * by a camera) that has to land on the right row.
 *
 * What it does NOT do is reject: an unknown product gets created. With a badly
 * read thermal receipt, refusing to store the line would lose the whole
 * purchase; one product too many is merged away later in one click.
 */
export async function resolveProduct(
  householdId: string,
  text: string,
  baseUnit: BaseUnit,
  /**
   * In simulation NOTHING is created.
   *
   * The bot shows what it read before saving, and if you say no, the catalogue
   * cannot be left seeded with products from a purchase that never happened.
   */
  create = true,
): Promise<ProductMatch | null> {
  const cleaned = text.trim();
  const slug = toSlug(cleaned);

  if (!slug) {
    throw new Error(
      getTranslator(await localeOf(householdId))("services.products.noText"),
    );
  }

  /*
   * The same matching as accounts and categories, not a copy.
   *
   * `resolveIn` already did the three passes — exact slug, exact alias and
   * trigram similarity — parameterised by table. I wrote those same 25 lines of
   * SQL again here; now `products` is one more table in that union, which is
   * what it was from the start: id, name, slug and aliases.
   */
  const hit = await resolveIn("products", householdId, cleaned);
  if (hit) return { id: hit.id, name: hit.name, score: hit.score, created: false };
  if (!create) return null;

  const [created] = await db
    .insert(products)
    .values({ householdId, name: cleaned, slug, baseUnit })
    .onConflictDoUpdate({
      target: [products.householdId, products.slug],
      set: { updatedAt: new Date() },
    })
    .returning({ id: products.id, name: products.name });

  return { id: created.id, name: created.name, score: 1, created: true };
}

export type ItemInput = {
  /** What the receipt says. Used to match, and stored as provenance. */
  description: string;
  quantity?: number;
  unit?: string;
  /**
   * What the whole line cost, in MAJOR units: "1.234,56".
   *
   * In major and not minor because that is how it comes from whoever writes it —
   * or from the camera — and because converting it requires knowing the
   * currency, which is only known once the account has been resolved.
   */
  total: string | number;
};

export type PreparedItem = {
  /** Empty in simulation while the product does not exist yet. */
  productId: string;
  productName: string;
  created: boolean;
  confidence: number;
  rawText: string;
  quantity: number;
  unit: string | null;
  baseQuantity: number;
  totalMinor: number;
};

/**
 * Resolves a purchase's lines without writing them yet.
 *
 * It is separate from saving because the bot first shows what it read and waits
 * for a yes: without this you would have to write fourteen rows in order to
 * describe them, and delete them if you say no.
 */
export async function prepareItems(
  householdId: string,
  items: ItemInput[],
  currency: string,
  create = true,
): Promise<PreparedItem[]> {
  const prepared: PreparedItem[] = [];

  for (const item of items) {
    const quantity = item.quantity != null && item.quantity > 0 ? item.quantity : 1;
    const norm = normalizeQuantity(quantity, item.unit);
    const match = await resolveProduct(householdId, item.description, norm.baseUnit, create);

    prepared.push({
      productId: match?.id ?? "",
      productName: match?.name ?? item.description.trim(),
      created: match?.created ?? true,
      // A freshly created product is not a doubt: it is the first time it is seen.
      confidence: match && !match.created ? match.score : 1,
      rawText: item.description.trim(),
      quantity,
      unit: norm.unit,
      baseQuantity: norm.baseQuantity,
      totalMinor: Math.abs(parseAmountToMinor(item.total, currency)),
    });
  }

  return prepared;
}

/**
 * Creates the missing products, inside the transaction that will use them.
 *
 * `prepareItems` resolves without creating — needed to describe a simulation
 * without dirtying the catalogue — and this finishes the job right before the
 * lines are written. On the same connection: if the write fails, no loose
 * products can be left from a purchase that never happened.
 */
export async function ensureProducts(
  householdId: string,
  items: PreparedItem[],
  conn: { insert: typeof db.insert } = db,
): Promise<PreparedItem[]> {
  const out: PreparedItem[] = [];
  for (const item of items) {
    if (item.productId) {
      out.push(item);
      continue;
    }
    const [created] = await conn
      .insert(products)
      .values({
        householdId,
        name: item.rawText,
        slug: toSlug(item.rawText),
        baseUnit: item.unit && UNIT_FACTORS[item.unit] ? UNIT_FACTORS[item.unit].base : "unit",
      })
      .onConflictDoUpdate({
        target: [products.householdId, products.slug],
        set: { updatedAt: new Date() },
      })
      .returning({ id: products.id, name: products.name });
    out.push({ ...item, productId: created.id, productName: created.name, created: true });
  }
  return out;
}

/** What the lines add up to, so we can say how much is still unitemised. */
export function itemsTotal(items: { totalMinor: number }[]): number {
  return items.reduce((sum, i) => sum + i.totalMinor, 0);
}

/** Did any line match with low confidence? Then the purchase goes to review. */
export function itemsNeedReview(items: PreparedItem[]): boolean {
  return items.some((i) => !i.created && i.confidence < PRODUCT_MATCH_THRESHOLD);
}

/**
 * Merges two products: matching gets it wrong and that has to be undoable.
 *
 * The loser's lines move to the winner and its name stays on as an alias, so the
 * next time a receipt spells it that way they don't come apart again.
 */
export async function mergeProducts(householdId: string, fromId: string, intoId: string) {
  const t = getTranslator(await localeOf(householdId));
  if (fromId === intoId) throw new InvalidProductError(t("services.products.mergeWithItself"));

  const [from] = await db
    .select({ name: products.name, aliases: products.aliases })
    .from(products)
    .where(and(eq(products.id, fromId), eq(products.householdId, householdId)))
    .limit(1);
  const [into] = await db
    .select({ name: products.name, aliases: products.aliases })
    .from(products)
    .where(and(eq(products.id, intoId), eq(products.householdId, householdId)))
    .limit(1);

  if (!from || !into) throw new InvalidProductError(t("services.products.oneNotFound"));

  const aliases = [...new Set([...into.aliases, ...from.aliases, normalize(from.name)])];

  await db.transaction(async (tx) => {
    await tx
      .update(transactionItems)
      .set({ productId: intoId })
      .where(
        and(
          eq(transactionItems.productId, fromId),
          eq(transactionItems.householdId, householdId),
        ),
      );
    await tx.update(products).set({ aliases, updatedAt: new Date() }).where(eq(products.id, intoId));
    await tx.delete(products).where(eq(products.id, fromId));
  });

  return { ok: true, summary: `${from.name} fusionado en ${into.name}.` };
}

export type RawTextGroup = {
  /** The line item as the receipt wrote it, in its most frequent form. */
  rawText: string;
  count: number;
  lastSeenOn: string;
};

/**
 * Which distinct line items this product arrived under.
 *
 * This is what makes splitting possible without guessing: fuzzy matching joins
 * by resemblance and afterwards there is no record of what it joined, except
 * here. Two entries on this list are two things the threshold judged the same,
 * and only whoever made the purchase knows whether it was right.
 *
 * They are grouped by their normalised form — the same one matching uses — and
 * the most repeated literal is shown: «H.PAN 1KG» and «h.pan 1kg» are one line
 * item, not two.
 */
export async function productRawTexts(
  householdId: string,
  productId: string,
): Promise<RawTextGroup[]> {
  const { rows } = await db.execute<{ raw_text: string; count: string; last_seen_on: string }>(sql`
    SELECT (array_agg(i.raw_text ORDER BY veces DESC, i.raw_text ASC))[1] AS raw_text,
           sum(veces)::text AS count,
           max(ultima)::text AS last_seen_on
      FROM (
        SELECT i.raw_text,
               lower(unaccent(btrim(i.raw_text))) AS clave,
               count(*) AS veces,
               max(t.occurred_on) AS ultima
          FROM transaction_items i
          JOIN transactions t ON t.id = i.transaction_id
         WHERE i.household_id = ${householdId}
           AND i.product_id = ${productId}
           AND t.voided_at IS NULL
           AND btrim(coalesce(i.raw_text, '')) <> ''
         GROUP BY i.raw_text
      ) i
     GROUP BY i.clave
     ORDER BY sum(veces) DESC, max(ultima) DESC
  `);

  return rows.map((r) => ({
    rawText: r.raw_text,
    count: Number(r.count),
    lastSeenOn: r.last_seen_on,
  }));
}

/**
 * Splitting: pulls a line item out of a product and gives it its own.
 *
 * It is the reverse of `mergeProducts`, and it is needed because of how matching
 * works: the threshold is set to recognise OCR variants of the same line item —
 * «H.PAN 1KG» and «H PAN 1 KG» — and there it gets it right, but two products
 * sharing a first word fall together. «AZUCAR MORENA» and «AZUCAR BLANCA» end up
 * sharing a price series that describes neither. Lowering the threshold would
 * fix that case and break the common one; splitting fixes the rare case without
 * touching the common one.
 *
 * What actually has to be achieved is not moving the rows, it is that **they
 * stay apart**. That is why two non-obvious things happen:
 *
 * - The new product is named exactly like the line item, so its slug matches the
 *   next purchase EXACTLY, and exact beats resemblance.
 * - The alias is stripped from the origin. `mergeProducts` leaves the loser's
 *   name as the winner's alias, and an alias matches at 0.99: without stripping
 *   it, the next purchase would merge them again by the path next door and this
 *   would have been for nothing.
 */
export async function splitProduct(householdId: string, productId: string, rawText: string) {
  const t = getTranslator(await localeOf(householdId));
  const cleaned = rawText.trim();
  const slug = toSlug(cleaned);
  const key = normalize(cleaned);

  if (!slug) throw new InvalidProductError(t("services.products.splitNoText"));

  const [source] = await db
    .select({ id: products.id, name: products.name, slug: products.slug, aliases: products.aliases })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.householdId, householdId)))
    .limit(1);
  if (!source) throw new InvalidProductError(t("services.products.notFound"));

  if (source.slug === slug) {
    throw new InvalidProductError(t("services.products.isTheName", { text: cleaned }));
  }

  const { rows: lines } = await db.execute<{ id: string; unit: string | null; total: string }>(sql`
    SELECT i.id, i.unit,
           (lower(unaccent(btrim(i.raw_text))) = ${key})::text AS total
      FROM transaction_items i
     WHERE i.household_id = ${householdId} AND i.product_id = ${productId}
  `);

  const ours = lines.filter((l) => l.total === "true");
  if (ours.length === 0) {
    throw new InvalidProductError(
      t("services.products.noMatchingLines", { product: source.name, text: cleaned }),
    );
  }
  if (ours.length === lines.length) {
    throw new InvalidProductError(
      t("services.products.allItsLines", { text: cleaned, product: source.name }),
    );
  }

  // The new product's unit comes from its own lines, it is not inherited: the
  // origin may be tracked by kilo while the line item that leaves always comes
  // in packs, and dragging the wrong unit along falsifies its unit price.
  const unit = ours.map((l) => l.unit).find((u) => u && UNIT_FACTORS[u]);
  const baseUnit: BaseUnit = unit ? UNIT_FACTORS[unit].base : "unit";

  const ids = ours.map((l) => l.id);
  const sourceAliases = source.aliases.filter((a) => normalize(a) !== key);

  let createdRow = false;
  const destination = await db.transaction(async (tx) => {
    /*
     * The one already carrying that slug is reused instead of inserting a new one.
     *
     * This is not an optimisation: `products` has a unique (household_id, slug),
     * so splitting the same line item twice — or splitting something already in
     * the catalogue — would blow up the INSERT. And unarchiving it is what the
     * action asks for: it is being said that this product is in use again.
     */
    const [existente] = await tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.householdId, householdId), eq(products.slug, slug)))
      .limit(1);

    const [row] = existente
      ? await tx
          .update(products)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(products.id, existente.id))
          .returning({ id: products.id, name: products.name })
      : await tx
          .insert(products)
          .values({ householdId, name: cleaned, slug, baseUnit })
          .onConflictDoUpdate({
            target: [products.householdId, products.slug],
            set: { archivedAt: null, updatedAt: new Date() },
          })
          .returning({ id: products.id, name: products.name });

    createdRow = !existente;

    if (row.id === productId) {
      throw new InvalidProductError(t("services.products.alreadyThis", { text: cleaned }));
    }

    await tx
      .update(transactionItems)
      .set({ productId: row.id })
      .where(
        and(
          inArray(transactionItems.id, ids),
          eq(transactionItems.householdId, householdId),
        ),
      );

    if (sourceAliases.length !== source.aliases.length) {
      await tx
        .update(products)
        .set({ aliases: sourceAliases, updatedAt: new Date() })
        .where(eq(products.id, productId));
    }

    return row;
  });

  return {
    ok: true as const,
    productId: destination.id,
    /**
     * If the product is new, its lines are EXACTLY the ones that left here, and
     * only then can undo be offered: merging it back takes all of its own, and
     * if an existing one was reused it would drag along purchases that were
     * never in the origin.
     */
    created: createdRow,
    fromId: productId,
    moved: ours.length,
    summary: t("services.products.split", {
      n: ours.length,
      from: source.name,
      to: destination.name,
    }),
  };
}

export type PricePoint = {
  occurredOn: string;
  /** Price per base unit, in the purchase currency. */
  unitPriceMinor: number;
  currency: string;
  /** The same unit price in base currency, at THAT day's rate. */
  unitPriceBcvMinor: number | null;
  unitPriceP2pMinor: number | null;
  quantity: number;
  unit: string | null;
  transactionId: string;
  description: string;
};

export type ProductHistory = {
  id: string;
  name: string;
  baseUnit: BaseUnit;
  points: PricePoint[];
};

/**
 * How a product's price has moved.
 *
 * The price is **per base unit**, not what the line cost: buying two kilos
 * instead of one is not cheese doubling. And it goes in both currencies, at the
 * rate of the purchase day and not today's, because revaluing a March purchase
 * with August's rate describes no price that ever existed.
 */
export async function productHistory(
  householdId: string,
  productId: string,
): Promise<ProductHistory | null> {
  const [product] = await db
    .select({ id: products.id, name: products.name, baseUnit: products.baseUnit })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.householdId, householdId)))
    .limit(1);

  if (!product) return null;

  const { rows } = await db.execute<{
    occurred_on: string;
    unit_price: string;
    currency: string;
    unit_price_bcv: string | null;
    unit_price_p2p: string | null;
    quantity: string;
    unit: string | null;
    transaction_id: string;
    description: string;
  }>(sql`
    SELECT t.occurred_on, t.id AS transaction_id, t.description, i.currency, i.unit,
           i.base_quantity::text AS quantity,
           round(i.total_minor / i.base_quantity)::text AS unit_price,
           round(i.base_amount_bcv_minor / i.base_quantity)::text AS unit_price_bcv,
           round(i.base_amount_p2p_minor / i.base_quantity)::text AS unit_price_p2p
      FROM transaction_items i
      JOIN transactions t ON t.id = i.transaction_id
     WHERE i.household_id = ${householdId}
       AND i.product_id = ${productId}
       AND t.voided_at IS NULL
     ORDER BY t.occurred_on ASC, t.created_at ASC
  `);

  return {
    id: product.id,
    name: product.name,
    baseUnit: product.baseUnit as BaseUnit,
    points: rows.map((r) => ({
      occurredOn: r.occurred_on,
      unitPriceMinor: Number(r.unit_price),
      currency: r.currency,
      unitPriceBcvMinor: r.unit_price_bcv == null ? null : Number(r.unit_price_bcv),
      unitPriceP2pMinor: r.unit_price_p2p == null ? null : Number(r.unit_price_p2p),
      quantity: Number(r.quantity),
      unit: r.unit,
      transactionId: r.transaction_id,
      description: r.description,
    })),
  };
}

export type ProductSummary = {
  id: string;
  name: string;
  baseUnit: BaseUnit;
  timesBought: number;
  lastSeenOn: string | null;
  lastUnitPriceMinor: number | null;
  lastUnitPriceBaseMinor: number | null;
  firstUnitPriceBaseMinor: number | null;
  currency: string | null;
  /** Percentage change in base currency between the first time and the last. */
  changePercent: number | null;
};

/**
 * The catalogue with what is needed to decide where to look.
 *
 * The variation is computed in BASE currency and not in bolívares: in bolívares
 * everything always goes up, so sorting by that would only say in which order
 * the rate moved. In dollars, a +40% means that product genuinely got dearer.
 */
export async function productCatalog(
  householdId: string,
  valuation: "bcv" | "p2p" = "p2p",
): Promise<ProductSummary[]> {
  const column = valuation === "bcv" ? sql`base_amount_bcv_minor` : sql`base_amount_p2p_minor`;

  const { rows } = await db.execute<{
    id: string;
    name: string;
    base_unit: BaseUnit;
    times: string;
    last_seen: string | null;
    last_price: string | null;
    last_base: string | null;
    first_base: string | null;
    currency: string | null;
  }>(sql`
    WITH puntos AS (
      SELECT i.product_id, t.occurred_on, t.created_at, i.currency,
             round(i.total_minor / i.base_quantity) AS unit_price,
             round(i.${column} / i.base_quantity) AS unit_base,
             row_number() OVER (PARTITION BY i.product_id
                                ORDER BY t.occurred_on DESC, t.created_at DESC) AS mas_reciente,
             row_number() OVER (PARTITION BY i.product_id
                                ORDER BY t.occurred_on ASC, t.created_at ASC) AS mas_antiguo
        FROM transaction_items i
        JOIN transactions t ON t.id = i.transaction_id
       WHERE i.household_id = ${householdId} AND t.voided_at IS NULL
    )
    SELECT p.id, p.name, p.base_unit,
           (SELECT count(*)::text FROM puntos x WHERE x.product_id = p.id) AS times,
           (SELECT x.occurred_on::text FROM puntos x WHERE x.product_id = p.id AND x.mas_reciente = 1) AS last_seen,
           (SELECT x.unit_price::text FROM puntos x WHERE x.product_id = p.id AND x.mas_reciente = 1) AS last_price,
           (SELECT x.unit_base::text FROM puntos x WHERE x.product_id = p.id AND x.mas_reciente = 1) AS last_base,
           (SELECT x.unit_base::text FROM puntos x WHERE x.product_id = p.id AND x.mas_antiguo = 1) AS first_base,
           (SELECT x.currency FROM puntos x WHERE x.product_id = p.id AND x.mas_reciente = 1) AS currency
      FROM products p
     WHERE p.household_id = ${householdId} AND p.archived_at IS NULL
     ORDER BY p.name
  `);

  return rows.map((r) => {
    const last = r.last_base == null ? null : Number(r.last_base);
    const first = r.first_base == null ? null : Number(r.first_base);
    return {
      id: r.id,
      name: r.name,
      baseUnit: r.base_unit,
      timesBought: Number(r.times),
      lastSeenOn: r.last_seen,
      lastUnitPriceMinor: r.last_price == null ? null : Number(r.last_price),
      lastUnitPriceBaseMinor: last,
      firstUnitPriceBaseMinor: first,
      currency: r.currency,
      // With a single purchase there is no variation to compute, and a 0% would
      // suggest it was checked and had not changed.
      changePercent:
        last != null && first != null && first > 0 && Number(r.times) > 1
          ? ((last - first) / first) * 100
          : null,
    };
  });
}

/** The breakdown of one specific purchase. */
export async function itemsOfTransaction(householdId: string, transactionId: string) {
  return db
    .select({
      id: transactionItems.id,
      productId: transactionItems.productId,
      product: products.name,
      rawText: transactionItems.rawText,
      quantity: transactionItems.quantity,
      unit: transactionItems.unit,
      baseQuantity: transactionItems.baseQuantity,
      baseUnit: products.baseUnit,
      totalMinor: transactionItems.totalMinor,
      currency: transactionItems.currency,
      confidence: transactionItems.confidence,
    })
    .from(transactionItems)
    .innerJoin(products, eq(products.id, transactionItems.productId))
    .where(
      and(
        eq(transactionItems.householdId, householdId),
        eq(transactionItems.transactionId, transactionId),
      ),
    )
    .orderBy(transactionItems.sortOrder);
}

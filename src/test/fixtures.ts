import { db } from "@/db";
import {
  accounts,
  apiTokens,
  categories,
  currencies,
  exchangeRates,
  households,
  householdMembers,
  user,
} from "@/db/schema";
import { generateToken } from "@/lib/api-token";

/**
 * The minimum for an entry to be recordable.
 *
 * Deliberately small and explicit: every test says which rates exist, because
 * almost everything that can go wrong in this project depends on that. A large
 * shared seed hides what each case depended on.
 */
export type Scenario = Awaited<ReturnType<typeof seedScenario>>;

export async function seedScenario(opts: { bcvRate?: string; p2pRate?: string; date: string }) {
  await db
    .insert(currencies)
    .values([
      { code: "USD", name: "Dólar", symbol: "$", minorUnit: 2 },
      { code: "VES", name: "Bolívar", symbol: "Bs.", minorUnit: 2 },
      // A currency whose rate does not go out of date, so the tests can tell
      // «there is no rate» from «the rate does not expire».
      { code: "USDT", name: "Tether", symbol: "₮", minorUnit: 2, rateAges: false },
      // One that ages and has no rate at all: the honest hole, which is a
      // different state from «its rate does not expire».
      { code: "EUR", name: "Euro", symbol: "€", minorUnit: 2 },
    ])
    .onConflictDoNothing();

  const [home] = await db
    .insert(households)
    .values({
      name: "Casa de prueba",
      baseCurrency: "USD",
      timezone: "America/Caracas",
      defaultRateSource: "p2p",
      /*
       * Explicit, and this is the line that keeps sixteen `.db.test.ts` files
       * green.
       *
       * The column's default is `en`, so leaving it out would flip every
       * assertion that reads a Spanish summary at once — and the failure would
       * look like a translation bug rather than a fixture that stopped saying
       * which language it wanted.
       */
      locale: "es",
    })
    .returning();

  const [cash] = await db
    .insert(accounts)
    .values({
      householdId: home.id,
      name: "Efectivo Bs",
      slug: "efectivo-bs",
      type: "cash",
      nature: "asset",
      currency: "VES",
      openingDate: opts.date,
      aliases: ["efectivo", "bolos"],
    })
    .returning();

  const [card] = await db
    .insert(accounts)
    .values({
      householdId: home.id,
      name: "Tarjeta",
      slug: "tarjeta",
      type: "credit_card",
      // Liability: it subtracts from net worth. It is what turns the net position
      // into net worth and not "what I have on me".
      nature: "liability",
      currency: "VES",
      openingDate: opts.date,
      aliases: ["tdc"],
    })
    .returning();

  const [groceries] = await db
    .insert(categories)
    .values({
      householdId: home.id,
      name: "Mercado",
      slug: "mercado",
      kind: "expense",
      aliases: ["super", "supermercado"],
    })
    .returning();

  for (const [source, value] of [
    ["bcv", opts.bcvRate],
    ["p2p", opts.p2pRate],
  ] as const) {
    if (!value) continue;
    // No conflict: `exchange_rates` has NO household column — rates belong to the
    // installation, not to each person — so seeding a second household for the
    // same day hits the unique index. It is a property of the schema, not an
    // oversight of the seed.
    await db
      .insert(exchangeRates)
      .values({
        baseCurrency: "USD",
        quoteCurrency: "VES",
        source,
        variant: source === "p2p" ? "median" : "default",
        rate: value,
        effectiveOn: opts.date,
      })
      .onConflictDoNothing();
  }

  return { home, cash, card, groceries, date: opts.date };
}

/** A real household user. Several tables demand one by foreign key. */
export async function userOf(home: { id: string }, label = "prueba"): Promise<string> {
  const id = `u-${label}-${Math.floor(Math.random() * 1e9)}`;
  await db.insert(user).values({
    id,
    name: "Prueba",
    email: `${id}@planfly.test`,
    emailVerified: false,
  });
  await db
    .insert(householdMembers)
    .values({ householdId: home.id, userId: id, role: "owner" })
    .onConflictDoNothing();
  return id;
}

/**
 * An API token for exercising the routes.
 *
 * With explicit scopes because that is what has to be checkable: that a route
 * rejects whoever lacks them. A token that can always do everything proves
 * nothing about access control.
 */
export async function tokenFor(
  home: { id: string },
  scopes: string[] = [
    "context:read",
    "transactions:read",
    "transactions:write",
    "reports:read",
    "accounts:write",
    "budgets:write",
    "financing:write",
    "recurring:write",
  ],
): Promise<string> {
  const userId = await userOf(home, `tok${scopes.length}`);

  const { plain, hash, prefix } = generateToken();
  await db.insert(apiTokens).values({
    householdId: home.id,
    userId,
    name: `prueba-${scopes.length}`,
    tokenHash: hash,
    prefix,
    scopes,
  });
  return plain;
}

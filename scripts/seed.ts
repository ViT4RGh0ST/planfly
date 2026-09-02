/**
 * Initial seed.
 *
 * Creates the household, the user, the currencies, and a set of example accounts
 * and categories meant to be changed: the names and aliases are what let the bot
 * understand «el super» or «pago móvil», so it is worth putting your own in.
 *
 * It is idempotent: it can be re-run without duplicating anything.
 * The environment is loaded by `tsx --env-file=.env.local` (see package.json).
 */
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { and, eq } from "drizzle-orm";

import { CURRENCIES } from "../src/lib/currencies";

import { db, pool } from "../src/db";
import {
  accounts,
  apiTokens,
  categories,
  currencies,
  exchangeRates,
  householdMembers,
  households,
  user,
} from "../src/db/schema";
import { auth } from "../src/lib/auth";
import { generateToken } from "../src/lib/api-token";
import { toSlug } from "../src/lib/services/resolve-entities";
import { normalizeLocale } from "@/i18n/config";

function required(name: string, what: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is missing. ${what}\n` +
        `  Put it in .env.local or in front of the command: ${name}="..." npm run ...`,
    );
  }
  return value;
}

// Lowercased because better-auth stores the email that way, and reading it
// back with the capitals as typed would not find the row just created.
const EMAIL = required("SEED_EMAIL", "It is the email you will sign in with.").toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD ?? "";
const NAME = process.env.SEED_NAME ?? "Yo";

/**
 * `rateAges: false` says the rate does not expire, not that it can be left out.
 * Tether against the dollar is worth what it is worth by construction, so its
 * row is written once below; the bolívar moves every day, which is the reason
 * this whole product exists.
 */
const ACCOUNTS = [
  { name: "Efectivo Bs", type: "cash", currency: "VES", aliases: ["efectivo", "bolos", "cash bs", "bolivares", "bs"], sortOrder: 1 },
  { name: "Efectivo USD", type: "cash", currency: "USD", aliases: ["efectivo dolares", "cash", "verdes", "dolares"], sortOrder: 2 },
  // The aliases are what let the bot understand «pagué con el banco» or «lo
  // mandé por pago móvil» without anyone typing the exact name. Swap them for
  // your own: they are examples, not a recommended configuration.
  { name: "Banco", type: "bank", currency: "VES", aliases: ["banco", "pago movil", "pagomovil", "transferencia bs"], sortOrder: 3 },
  { name: "Cuenta en dólares", type: "bank", currency: "USD", aliases: ["banco usd", "transferencia usd", "dolares banco"], sortOrder: 4 },
  { name: "Cripto", type: "crypto", currency: "USDT", aliases: ["usdt", "cripto", "tether"], sortOrder: 5 },
  // Liability: it subtracts from the net position, which is what turns it into
  // net worth and not "the money I have on me".
  { name: "Tarjeta de crédito", type: "credit_card", nature: "liability", currency: "VES", aliases: ["tarjeta", "credito", "tdc"], sortOrder: 6 },
] as const;

const CATEGORIES: Array<{
  name: string;
  kind: "expense" | "income";
  aliases?: string[];
  color?: string;
  children?: Array<{ name: string; aliases?: string[] }>;
}> = [
  {
    name: "Comida",
    kind: "expense",
    color: "#f97316",
    aliases: ["comida", "alimentacion"],
    children: [
      { name: "Mercado", aliases: ["mercado", "super", "supermercado", "compras", "viveres"] },
      { name: "Comida callejera", aliases: ["comida callejera", "calle", "empanada", "arepa", "perro caliente"] },
      { name: "Restaurante", aliases: ["restaurante", "restorán", "salir a comer"] },
      { name: "Delivery", aliases: ["delivery", "pedido", "yummy", "pedidosya"] },
    ],
  },
  {
    name: "Salud",
    kind: "expense",
    color: "#ef4444",
    // No "medico", "doctor" or "farmacia": the children have those and the parent
    // was winning them on an alphabetical tie-break.
    aliases: ["salud", "medicinas"],
    children: [
      { name: "Medicinas", aliases: ["medicina", "farmacia", "pastillas", "remedios"] },
      { name: "Consultas", aliases: ["consulta", "medico", "doctor", "examenes"] },
    ],
  },
  { name: "Veterinario", kind: "expense", color: "#84cc16", aliases: ["veterinario", "veterinaria", "vet", "perro", "gato", "mascota", "mascotas"] },
  { name: "Regalos", kind: "expense", color: "#ec4899", aliases: ["regalo", "regalos", "obsequio"] },
  {
    name: "Transporte",
    kind: "expense",
    color: "#3b82f6",
    // No "gasolina" or "pasaje": they belong to the children. When parent and
    // child share an alias, both tie at 0.99 and alphabetical order breaks it,
    // so "pasaje" landed in Transporte instead of Transporte público.
    aliases: ["transporte", "taxi", "uber"],
    children: [
      { name: "Gasolina", aliases: ["gasolina", "bomba", "combustible"] },
      {
        name: "Mantenimiento del carro",
        // No "reparacion" or "servicio": Hogar and Servicios already use them, and a
        // repeated alias makes the bot's matching depend on luck.
        aliases: [
          "mantenimiento",
          "carro",
          "mecanico",
          "taller",
          "repuesto",
          "repuestos",
          "caucho",
          "cauchos",
          "aceite",
          "frenos",
          "bateria",
          "alineacion",
          "balanceo",
          "seguro del carro",
        ],
      },
      { name: "Transporte público", aliases: ["pasaje", "metro", "camionetica", "autobus"] },
    ],
  },
  {
    name: "Servicios",
    kind: "expense",
    color: "#8b5cf6",
    aliases: ["servicios", "recibos"],
    children: [
      { name: "Luz", aliases: ["luz", "corpoelec", "electricidad"] },
      { name: "Agua", aliases: ["agua", "hidrocapital"] },
      { name: "Internet", aliases: ["internet", "wifi", "cantv", "inter", "fibra"] },
      { name: "Teléfono", aliases: ["telefono", "celular", "recarga", "movistar", "digitel"] },
      { name: "Suscripciones", aliases: ["suscripcion", "netflix", "spotify", "claude", "openai"] },
    ],
  },
  { name: "Hogar", kind: "expense", color: "#14b8a6", aliases: ["hogar", "casa", "limpieza", "ferreteria", "reparacion"] },
  { name: "Ropa", kind: "expense", color: "#a855f7", aliases: ["ropa", "zapatos", "vestimenta"] },
  { name: "Entretenimiento", kind: "expense", color: "#06b6d4", aliases: ["entretenimiento", "cine", "salida", "fiesta", "diversion"] },
  { name: "Educación", kind: "expense", color: "#eab308", aliases: ["educacion", "curso", "libro", "estudio"] },
  { name: "Comisiones", kind: "expense", color: "#64748b", aliases: ["comision", "banco", "cambio", "fee"] },
  { name: "Otros gastos", kind: "expense", color: "#94a3b8", aliases: ["otros", "varios", "misc"] },

  { name: "Sueldo", kind: "income", color: "#22c55e", aliases: ["sueldo", "salario", "quincena", "nomina"] },
  { name: "Freelance", kind: "income", color: "#10b981", aliases: ["freelance", "proyecto", "trabajo extra", "cliente"] },
  { name: "Venta", kind: "income", color: "#34d399", aliases: ["venta", "vendi"] },
  { name: "Otros ingresos", kind: "income", color: "#6ee7b7", aliases: ["otros ingresos", "regalo", "reembolso"] },
];

/**
 * Creates the account through better-auth's internal path.
 *
 * Not through `signUpEmail`: form sign-up is deliberately closed
 * (`disableSignUp` in src/lib/auth.ts), and it has to stay that way — the seed
 * working cannot cost leaving registration open to anyone who reaches the port.
 * The hash is done by `ctx.password` itself, so the password works for logging
 * in all the same.
 */
async function createUser(email: string, password: string, name: string) {
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser({
    email,
    name,
    emailVerified: false,
  }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    accountId: created.id,
    password: await ctx.password.hash(password),
  });
  return created;
}

async function main() {
  console.log("→ Currencies");
  for (const currency of CURRENCIES) {
    await db.insert(currencies).values(currency).onConflictDoNothing();
  }

  /*
   * The rate of whatever does not age, written once.
   *
   * A currency whose rate does not expire still needs its row: the flag says
   * the figure does not go out of date, not that it can be absent. Keeping it in
   * the table — rather than as a peg in the code — is what leaves ONE way of
   * answering «what is this worth in the base», with its date and its
   * provenance on screen.
   *
   * Two rows because a slot is filled per variant, and `1` because a stablecoin
   * against its own currency is worth one. If it ever comes off its peg, the
   * rate written by hand for that day wins, as it does for every other pair.
   */
  const base = process.env.SEED_BASE_CURRENCY ?? "USD";
  for (const currency of CURRENCIES.filter((c) => c.rateAges === false)) {
    for (const variant of ["bcv", "p2p"]) {
      await db
        .insert(exchangeRates)
        .values({
          baseCurrency: base,
          quoteCurrency: currency.code,
          source: "manual",
          variant,
          rate: "1",
          effectiveOn: "2000-01-01",
          raw: { typedBy: "seed", note: "pegged: a stablecoin against its own currency" },
        })
        .onConflictDoNothing();
    }
  }

  console.log("→ User");
  let [account] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);

  if (!account) {
    if (!PASSWORD) {
      throw new Error(
        "The user does not exist and you gave no password.\n" +
          "  Run: SEED_PASSWORD='your-key-of-10-or-more' npm run db:seed",
      );
    }
    await createUser(EMAIL, PASSWORD, NAME);
    [account] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);
    console.log(`  created ${EMAIL}`);
  } else {
    console.log(`  ${EMAIL} already existed`);
  }

  console.log("→ Household");
  let [household] = await db.select().from(households).limit(1);
  if (!household) {
    [household] = await db
      .insert(households)
      .values({
        name: "Casa",
        baseCurrency: "USD",
        // P2P by default: in Venezuela it is the rate you actually buy at, and
        // valuing at BCV systematically inflates what you think you have.
        defaultRateSource: "p2p",
        // From the environment: the household inherits the installation's timezone.
        // With the wrong one, a 21:00 expense is booked on the following day.
        timezone: process.env.TZ ?? "America/Caracas",
        /*
         * The language, from `SEED_LOCALE`.
         *
         * It defaults to the column's own default — English — because that is
         * what whoever clones the repository gets. The accounts and categories
         * below stay in Spanish whatever this says: they are examples from the
         * originating case, meant to be changed, and translating them would
         * turn them into a recommended configuration rather than a sample.
         */
        locale: normalizeLocale(process.env.SEED_LOCALE),
      })
      .returning();
    console.log(`  created household ${household.id}`);
  }

  await db
    .insert(householdMembers)
    .values({ householdId: household.id, userId: account.id, role: "owner" })
    .onConflictDoNothing();

  console.log("→ Accounts");
  for (const item of ACCOUNTS) {
    const slug = toSlug(item.name);
    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.householdId, household.id), eq(accounts.slug, slug)))
      .limit(1);
    if (existing.length > 0) continue;

    await db.insert(accounts).values({
      householdId: household.id,
      name: item.name,
      slug,
      type: item.type,
      nature: "nature" in item ? item.nature : "asset",
      currency: item.currency,
      openingDate: new Date().toISOString().slice(0, 10),
      // The institution is optional and the seed does not use it: these are example
      // accounts, and putting real bank names here helps nobody.
      institution: null,
      aliases: [...item.aliases],
      sortOrder: item.sortOrder,
    });
    console.log(`  + ${item.name} (${item.currency})`);
  }

  console.log("→ Categories");
  let sortOrder = 0;
  for (const category of CATEGORIES) {
    const slug = toSlug(category.name);
    let [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, household.id), eq(categories.slug, slug)))
      .limit(1);

    if (!row) {
      [row] = await db
        .insert(categories)
        .values({
          householdId: household.id,
          name: category.name,
          slug,
          kind: category.kind,
          color: category.color ?? "#64748b",
          aliases: category.aliases ?? [],
          sortOrder: sortOrder++,
        })
        .returning({ id: categories.id });
      console.log(`  + ${category.name}`);
    } else {
      // The aliases DO get refreshed even if the category already exists: they are
      // the only part of the seed corrected by use (parent/child collisions, new
      // words). The name, the colour and the order are left alone, because those
      // may well have been edited by hand.
      await db
        .update(categories)
        .set({ aliases: category.aliases ?? [] })
        .where(eq(categories.id, row.id));
    }

    for (const child of category.children ?? []) {
      const childSlug = toSlug(child.name);
      const existing = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.householdId, household.id), eq(categories.slug, childSlug)))
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(categories)
          .set({ aliases: child.aliases ?? [] })
          .where(eq(categories.id, existing[0].id));
        continue;
      }

      await db.insert(categories).values({
        householdId: household.id,
        name: child.name,
        slug: childSlug,
        kind: category.kind,
        parentId: row.id,
        color: category.color ?? "#64748b",
        aliases: child.aliases ?? [],
        sortOrder: sortOrder++,
      });
      console.log(`    + ${category.name} › ${child.name}`);
    }
  }

  console.log("→ API token for openclaw");
  const existingTokens = await db
    .select({ id: apiTokens.id, prefix: apiTokens.prefix })
    .from(apiTokens)
    .where(and(eq(apiTokens.householdId, household.id), eq(apiTokens.name, "openclaw-telegram")))
    .limit(1);

  if (existingTokens.length > 0) {
    console.log(`  one already exists (${existingTokens[0].prefix}…). To rotate it: npm run token:create`);
  } else {
    const { plain, hash, prefix } = generateToken();
    await db.insert(apiTokens).values({
      householdId: household.id,
      userId: account.id,
      name: "openclaw-telegram",
      tokenHash: hash,
      prefix,
    });
    console.log("\n  ┌─────────────────────────────────────────────────────────────");
    console.log("  │ TOKEN (shown ONCE only — save it now):");
    console.log(`  │ ${plain}`);
    console.log("  │");
    console.log("  │ It goes in ~/.openclaw/openclaw.json, as the bearer of");
    console.log("  │ the planfly MCP server: mcp.servers.planfly.headers");
    console.log("  └─────────────────────────────────────────────────────────────\n");
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("\nThe seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

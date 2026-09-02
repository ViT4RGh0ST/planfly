/**
 * The currencies a planfly knows, declared once.
 *
 * It lived inside `scripts/seed.ts`, so it described what a NEW installation
 * gets and nothing else: a currency added later by a migration existed in one
 * database and not in the list, and the two answers to «which currencies are
 * there» drifted apart without anybody being able to see it. The peso was
 * exactly that — added to an existing installation, missing from every new one.
 *
 * Here it is one list: the seed fills a fresh database from it, a migration
 * catches up the ones already running, and `currencies-guard.test.ts` refuses to
 * let it disagree with `money.ts`.
 *
 * **Adding one is still a migration**, because existing installations have to be
 * caught up. What this removes is the second list, not the migration.
 */
export type CurrencyRow = {
  code: string;
  /**
   * The currency's name, in English like the rest of the code.
   *
   * Nothing shows it: the screen prints the CODE beside a balance, and the
   * symbol comes from `money.ts`. If it is ever displayed it goes out to the
   * catalogues first, like every other sentence a person reads.
   */
  name: string;
  /** What the amount is printed with. See `SYMBOLS` in money.ts: it must agree. */
  symbol: string;
  /** Decimals. It must agree with `MINOR_UNITS` or every amount is out by a power of ten. */
  minorUnit: number;
  isCrypto?: boolean;
  /**
   * Whether its rate expires. A stablecoin against its own currency does not:
   * its row is written once and never goes stale.
   */
  rateAges?: boolean;
  /**
   * Whether an official rate exists for it at all.
   *
   * The product's whole shape is two answers at once — the official one and the
   * street's — and that is the shape of Venezuela. Colombia has no official
   * peso rate to ask for: there is one market and that is all. Saying so lets
   * the screen show one figure instead of an empty column that looks like a
   * source that failed.
   */
  hasOfficial?: boolean;
};

export const CURRENCIES: CurrencyRow[] = [
  { code: "USD", name: "US dollar", symbol: "$", minorUnit: 2, isCrypto: false },
  { code: "VES", name: "Venezuelan bolívar", symbol: "Bs.", minorUnit: 2, isCrypto: false },
  // The ticker and not «₮»: in a table where dollar and Tether balances sit
  // side by side, a glyph nobody reads made two amounts that are not valued
  // alike indistinguishable. `money.ts` already prints it this way.
  { code: "USDT", name: "Tether", symbol: "USDT", minorUnit: 2, isCrypto: true, rateAges: false },
  { code: "EUR", name: "Euro", symbol: "€", minorUnit: 2, isCrypto: false },
  // The peso's own sign is the dollar's, so it prints its code instead: the
  // screen shows an account's balance beside its equivalent in the base, and two
  // amounts that are not worth the same would have looked identical.
  { code: "COP", name: "Colombian peso", symbol: "COP", minorUnit: 2, hasOfficial: false },
];

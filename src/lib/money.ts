/**
 * Money in planfly.
 *
 * One rule, non-negotiable: **an amount never lives in a `number` with decimals.**
 * JavaScript has no native decimal — `0.1 + 0.2 !== 0.3` — so every amount is
 * stored and operated on as an integer of minor units (cents), and only becomes
 * text at the edge of the UI.
 *
 * Exchange rates are NOT money: they are ratios, they live in `NUMERIC(24,10)`
 * and are handled as strings. Never put one through `parseFloat` to store it.
 */

/**
 * Minor units per currency. VES and USD use 2; USDT is deliberately treated as 2
 * (the balance is carried in dollars rounded to the cent, not in the chain's 6
 * decimals) so that it adds up with the rest without odd conversions.
 *
 * This map and the `currencies` table say the same thing twice, and they are
 * kept honest by `currencies-guard.db.test.ts` rather than by care. They cannot
 * be collapsed into one: this file is pure and synchronous — a client component
 * formats with it — and making it ask the database would drag a connection into
 * the browser.
 *
 * The fallback of 2 is what makes a disagreement silent: a currency with none of
 * its own is formatted and parsed with two decimals whatever the table says, so
 * a currency written with zero — the Chilean peso, the yen — would be out by a
 * hundred in both directions with nothing failing.
 */
export const MINOR_UNITS: Record<string, number> = {
  VES: 2,
  USD: 2,
  USDT: 2,
  EUR: 2,
};

export function minorUnit(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/**
 * Safety ceiling for `bigint({ mode: 'number' })`.
 *
 * We read Postgres BIGINTs as `number` because JS `bigint` doesn't serialise to
 * JSON, and that would poison every `/api/v1` response and every prop crossing
 * from Server to Client Component. In exchange, a CHECK in the database
 * guarantees no amount exceeds JS's safe integer, so the read is exact. With 2
 * decimals the ceiling is ~90 quadrillion bolívares on a single line.
 */
export const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991

/**
 * What could not be read, and why — as data, not as a sentence.
 *
 * `money.ts` has no language: it is the module that turns text into integers,
 * and it is imported by the seed, by the heartbeat and by the tests. The
 * sentence is composed where the household is known — `messageForScreen` for
 * the screen, `handleError` for the API — the same way as the two API errors.
 *
 * `message` stays for the log, in English and with no interpolation to
 * translate.
 */
export class InvalidAmountError extends Error {
  constructor(
    readonly input: string,
    /** A key under `services.amount`, never a written sentence. */
    readonly reason: string,
    /** For the reasons that name a figure: the suggestion, the ceiling. */
    readonly detail?: Record<string, string>,
  ) {
    super(`invalid amount ${JSON.stringify(input)}: ${reason}`);
    this.name = "InvalidAmountError";
  }
}

/**
 * Converts an amount written by a person (or by an LLM) into minor units.
 *
 * Works on the **string**, never on an intermediate float: `Math.round(parseFloat(x) * 100)`
 * loses cents in cases like 1,005 and is the classic bug of this kind of app.
 *
 * It accepts what people actually write:
 *   "350,50"     -> 35050   (decimal comma, Venezuelan format)
 *   "1.234,56"   -> 123456  (thousands dot + decimal comma)
 *   "350.50"     -> 35050   (decimal point, English format)
 *   "1.234"      -> 123400  (thousands dot: 3 digits after it and no other separator)
 *   "Bs. 1.500"  -> 150000
 *   "$12.99"     -> 1299
 *   "-350,5"     -> -35050
 *   1234.5       -> 123450  (number: passed through String() and down the same path)
 */
/**
 * Splits the integer part from the decimal one in a number written by a person.
 *
 * This is the hard part of reading figures in Spanish: "1.234" is one thousand
 * two hundred thirty-four and "350.50" is three hundred fifty and fifty, with
 * the same separator. It lives on its own because two readers use it — amounts
 * and rates — and duplicating this rule guarantees they diverge some day.
 */
function splitDecimal(s: string): { integerPart: string; fractionPart: string } {
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSeparator: "." | "," | null = null;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both are present: the rightmost one wins.
    decimalSeparator = lastDot > lastComma ? "." : ",";
  } else if (lastComma !== -1) {
    // Comma only. In Spanish the comma is decimal unless it separates exact
    // groups of 3 and appears more than once ("1,234,567" is English format).
    const parts = s.split(",");
    const isEnglishThousands = parts.length > 2 && parts.slice(1).every((p) => p.length === 3);
    decimalSeparator = isEnglishThousands ? null : ",";
  } else if (lastDot !== -1) {
    // Dot only. With exactly 3 digits after it we read it as a thousands
    // separator ("1.234" = one thousand two hundred thirty-four, which is what
    // someone in Venezuela writes); with any other count, it is decimal ("350.50").
    const parts = s.split(".");
    const allGroupsOf3 = parts.slice(1).every((p) => p.length === 3);
    decimalSeparator = allGroupsOf3 ? null : ".";
  }

  if (decimalSeparator === null) {
    return { integerPart: s.replace(/[.,]/g, ""), fractionPart: "" };
  }
  const cut = s.lastIndexOf(decimalSeparator);
  return {
    integerPart: s.slice(0, cut).replace(/[.,]/g, ""),
    fractionPart: s.slice(cut + 1).replace(/[.,]/g, ""),
  };
}

export function parseAmountToMinor(input: string | number, currency: string): number {
  const decimals = minorUnit(currency);
  const original = typeof input === "number" ? String(input) : input;

  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new InvalidAmountError(original, "notFinite");
  }

  /*
   * A sum typed into the field: "31*0,5" is 31 litres at 0,50.
   *
   * It is resolved here and not only in the form so that it holds across all
   * four routes in: over Telegram you can say "I spent 31*0,5 on petrol", and a
   * CSV may carry a formula. Same principle as the single write path.
   *
   * It only kicks in when there is an operator, so "1.234,56" follows the usual
   * path. Rounding to the cent happens here, and not earlier: the result of a
   * division can carry decimals that don't exist in the currency.
   */
  if (typeof input === "string" && looksLikeExpression(original)) {
    const value = evaluateExpression(original);
    if (value == null) {
      throw new InvalidAmountError(original, "badExpression");
    }
    const minor = Math.round(value * 10 ** decimals);
    if (!Number.isSafeInteger(minor) || Math.abs(minor) > MAX_SAFE_AMOUNT) {
      throw new InvalidAmountError(original, "tooLarge");
    }
    return Object.is(minor, -0) ? 0 : minor;
  }

  // Strip symbols, spaces (thin thousands space included) and the currency code.
  let s = original
    .trim()
    .replace(/[\s  ]/g, "")
    .replace(/^(bs\.?|bss\.?|ves|usd|usdt|eur|\$|€)/i, "")
    .replace(/(bs\.?|bss\.?|ves|usd|usdt|eur|\$|€)$/i, "");

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // Accounting: (350,50) also means negative.
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  if (s === "") throw new InvalidAmountError(original, "empty");
  if (!/^[\d.,]+$/.test(s)) {
    throw new InvalidAmountError(original, "badCharacters");
  }

  const { integerPart, fractionPart } = splitDecimal(s);

  if (integerPart === "" && fractionPart === "") {
    throw new InvalidAmountError(original, "noDigits");
  }

  // Truncate or pad the fraction up to the currency's minor units.
  // Truncating (not rounding) is deliberate: if someone writes more decimals than
  // the currency admits, inventing a rounding would be guessing.
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");

  const whole = integerPart === "" ? 0 : Number.parseInt(integerPart, 10);
  const frac = fraction === "" ? 0 : Number.parseInt(fraction, 10);
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) {
    throw new InvalidAmountError(original, "notAnInteger");
  }

  const minor = whole * 10 ** decimals + frac;
  if (!Number.isSafeInteger(minor) || minor > MAX_SAFE_AMOUNT) {
    throw new InvalidAmountError(original, "tooLarge");
  }

  return negative ? -minor : minor;
}

/** Minor units -> plain decimal string ("35050", VES -> "350.50").
 *  For sending to Postgres as NUMERIC without going through a float. */
export function minorToDecimalString(minor: number, currency: string): string {
  const decimals = minorUnit(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals);
  const fraction = decimals > 0 ? "." + abs.slice(abs.length - decimals) : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

// USDT carries its own name and not `$`: in a table where dollar and Tether
// accounts live side by side, the same symbol made two balances that are not
// valued alike indistinguishable — USDT has no rate against the base.
export const SYMBOLS: Record<string, string> = { VES: "Bs.", USD: "$", USDT: "USDT", EUR: "€" };

/** Display format. The one point in the system where an amount becomes text. */
export function formatAmount(
  minor: number,
  currency: string,
  options: { withSymbol?: boolean; showPlus?: boolean } = {},
): string {
  const { withSymbol = true, showPlus = false } = options;
  const decimals = minorUnit(currency);
  const code = currency.toUpperCase();

  // Divide only to format: the value is not operated on after this point.
  const value = minor / 10 ** decimals;
  const text = new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(value));

  const symbol = withSymbol ? `${SYMBOLS[code] ?? code} ` : "";
  const prefix = minor < 0 ? "-" : showPlus && minor > 0 ? "+" : "";
  return `${prefix}${symbol}${text}`;
}

/**
 * Converts an amount to the base currency applying a **quoted-per-base** rate
 * (e.g. 859.00 VES per 1 USD).
 *
 * The direction is this app's classic silent bug: inverting it on USD/VES gives
 * a number ~738,000 times off. That is why the convention is pinned here, in the
 * migration and in a test. We divide by the rate because `minor` is in the
 * quoted currency and we want the base.
 *
 * Returns `null` when there is no rate, which is a legitimate state: the entry
 * is stored anyway and flagged for review.
 */
export function convertToBase(
  minor: number,
  fromCurrency: string,
  baseCurrency: string,
  quotePerBaseRate: string | null | undefined,
): number | null {
  if (fromCurrency.toUpperCase() === baseCurrency.toUpperCase()) return minor;
  if (quotePerBaseRate == null || quotePerBaseRate === "") return null;

  const rate = Number(quotePerBaseRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const fromDecimals = minorUnit(fromCurrency);
  const baseDecimals = minorUnit(baseCurrency);

  // minor(from) / 10^fromDecimals / rate * 10^baseDecimals, rounded to the cent.
  const inBase = (minor / 10 ** fromDecimals / rate) * 10 ** baseDecimals;
  if (!Number.isFinite(inBase)) return null;

  const rounded = Math.round(inBase);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Evaluates a sum typed into the amount field: "31*0,5", "1200+300", "(2+3)*4".
 *
 * It exists because very often you know the quantity and the price, not the
 * total: 31 litres of petrol, three kilos at so much. Forcing someone to open a
 * separate calculator and paste the result is exactly the friction that makes an
 * expense go unrecorded.
 *
 * Numbers are read with the same rules as `parseAmountToMinor` — decimal comma,
 * thousands dot — because this is written in Venezuelan, not in spreadsheet
 * format. `2,5*4` is ten.
 *
 * Returns `null` when it isn't a valid expression: mid-typing, "31*" is not an
 * error worth shouting about, just something that can't be computed yet.
 *
 * It uses neither `eval` nor `Function`: it is a recursive-descent parser over
 * tokens, so the only thing that can happen is arithmetic.
 */
export function evaluateExpression(input: string): number | null {
  const text = input.trim();
  if (text === "") return null;

  // Venezuelan numbers: 1.234,56 and 0,5. The dot is only decimal when there is
  // no comma and fewer than three digits follow — the parser's same rule.
  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === " ") {
      i++;
      continue;
    }
    if ("+-*/()".includes(char)) {
      tokens.push(char);
      i++;
      continue;
    }
    const match = /^[\d.,]+/.exec(text.slice(i));
    if (!match) return null;
    const raw = match[0];
    i += raw.length;

    const hasComma = raw.includes(",");
    let normalized: string;
    if (hasComma) {
      normalized = raw.replace(/\./g, "").replace(",", ".");
    } else {
      const parts = raw.split(".");
      // "1.234" is one thousand two hundred thirty-four; "0.5" is a half.
      normalized =
        parts.length > 1 && parts[parts.length - 1].length === 3
          ? parts.join("")
          : raw;
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    tokens.push(value);
  }

  let pos = 0;
  const peek = () => tokens[pos];

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left == null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right == null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left == null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++];
      const right = parseFactor();
      if (right == null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number | null {
    if (peek() === "-") {
      pos++;
      const value = parseFactor();
      return value == null ? null : -value;
    }
    if (peek() === "(") {
      pos++;
      const value = parseExpr();
      if (value == null || tokens[pos] !== ")") return null;
      pos++;
      return value;
    }
    const token = tokens[pos];
    if (typeof token !== "number") return null;
    pos++;
    return token;
  }

  const result = parseExpr();
  if (result == null || pos !== tokens.length) return null;
  return Number.isFinite(result) ? result : null;
}

/**
 * Does the text carry an operation, or is it just an amount?
 *
 * A real operator is required. Two traps:
 *
 * - **A leading minus is a sign, not a subtraction**: "-350" is a negative amount.
 * - **A lone parenthesis is accounting, not arithmetic**: "(350,50)" means
 *   −350,50 on any bank statement, and that convention was already written and
 *   tested here. A parenthesis only counts as an expression when there is
 *   something to compute inside, as in "(2+3)*4".
 */
export function looksLikeExpression(input: string): boolean {
  return /[+*/]/.test(input) || /\d\s*-\s*\d/.test(input);
}

const RATE_FORMAT = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A rate as it is written here: "877,50", not "877.50".
 *
 * With a decimal point, `757.54` reads as seven hundred fifty-seven thousand in
 * Venezuela, which is three orders of magnitude away from the figure that
 * converts everything else. It was solved in four components separately and
 * unsolved on `/rates`, which was precisely the screen that exists to read them.
 */
export function formatRate(rate: number | string): string {
  return RATE_FORMAT.format(Number(rate));
}

/**
 * A percentage with a decimal comma: "14,4", not "14.4".
 *
 * Same reason as `formatRate`, and it shows up in three places — the spread
 * between rates, a product's variation and how much of a budget is used — which
 * until now each called `toFixed` on their own.
 */
export function formatPercent(value: number, decimals = 0): string {
  return new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}


/** How many decimals the `rate` column keeps: NUMERIC(24,10). */
const RATE_DECIMALS = 10;

/** The same ceiling `rates:check` applies to the automatic sources. */
const MAX_RATE = 1_000_000;

/**
 * Reads a rate written by a person: «859,4321» → "859.4321".
 *
 * Separate from `parseAmountToMinor` because a rate is not an amount: it has no
 * currency, it admits neither negatives nor accounting parentheses, and it keeps
 * ten decimals instead of the currency's two. Truncating a rate to cents, which
 * is what reusing the amount reader would do, changes the value of an entire net
 * worth.
 *
 * It returns text and not a number on purpose: the destination is a
 * NUMERIC(24,10), and a float along the way is exactly where the decimals that
 * column exists to keep get lost.
 */
export function parseRate(input: string | number): string {
  const original = typeof input === "number" ? String(input) : input;

  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new InvalidAmountError(original, "notFinite");
  }

  const s = original.trim().replace(/[\s  ]/g, "");
  if (s === "") throw new InvalidAmountError(original, "rateEmpty");
  if (!/^[\d.,]+$/.test(s)) {
    throw new InvalidAmountError(original, "rateBadCharacters");
  }

  /*
   * A dot with exactly three digits after it is AMBIGUOUS in a rate.
   *
   * In an amount, "1.234" is one thousand two hundred thirty-four and there is
   * no doubt. In a rate, "859.432" is what anyone types on a numeric keypad
   * meaning 859,432 — and reading it as a thousands separator stores it as
   * 859.432, a thousand times larger, valuing the whole day with a false figure
   * that fails nowhere.
   *
   * When in doubt we don't guess: we ask for it to be written unambiguously.
   */
  if (/^\d+\.\d{3}$/.test(s)) {
    throw new InvalidAmountError(original, "rateAmbiguous", {
      suggestion: s.replace(".", ","),
    });
  }

  const { integerPart, fractionPart } = splitDecimal(s);
  if (integerPart === "" && fractionPart === "") {
    throw new InvalidAmountError(original, "noDigits");
  }

  // It truncates, it does not round: if someone writes eleven decimals, inventing
  // the tenth would be guessing. Same decision as with amounts.
  const fraction = fractionPart.slice(0, RATE_DECIMALS).padEnd(RATE_DECIMALS, "0");
  const whole = integerPart === "" ? "0" : integerPart.replace(/^0+(?=\d)/, "");

  if (!/^\d+$/.test(whole) || whole.length > 14) {
    throw new InvalidAmountError(original, "rateTooPrecise");
  }
  if (Number(whole) === 0 && Number(fraction) === 0) {
    throw new InvalidAmountError(original, "rateZero");
  }

  /*
   * Sanity net, the same one `rates:check` already applied to the sources and
   * that writing by hand didn't have. It doesn't claim to validate the figure:
   * it catches the big one — an extra zero, a finger on the wrong key — before
   * it gets stamped onto real entries and a month has to be redone.
   */
  const value = Number(`${whole}.${fraction}`);
  if (value > MAX_RATE) {
    throw new InvalidAmountError(original, "rateTooHigh", {
      max: MAX_RATE.toLocaleString("es-VE"),
    });
  }

  return `${whole}.${fraction}`;
}

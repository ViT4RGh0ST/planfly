import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  convertToBase,
  parseRate,
  formatAmount,
  InvalidAmountError,
  minorToDecimalString,
  parseAmountToMinor,
  evaluateExpression,
} from "./money";

describe("parseAmountToMinor", () => {
  it("understands the decimal comma of the Venezuelan format", () => {
    assert.equal(parseAmountToMinor("350,50", "VES"), 35050);
    assert.equal(parseAmountToMinor("0,05", "VES"), 5);
  });

  it("understands the thousands dot alongside the decimal comma", () => {
    assert.equal(parseAmountToMinor("1.234,56", "VES"), 123456);
    assert.equal(parseAmountToMinor("1.500", "VES"), 150000);
  });

  it("understands the decimal point of the English format", () => {
    assert.equal(parseAmountToMinor("350.50", "USD"), 35050);
    assert.equal(parseAmountToMinor("12.99", "USD"), 1299);
  });

  it("tells thousands from decimals by how many digits follow", () => {
    // 3 digits after the dot and no other separator -> thousands
    assert.equal(parseAmountToMinor("1.234", "VES"), 123400);
    // 2 digits -> decimal
    assert.equal(parseAmountToMinor("1.23", "VES"), 123);
  });

  it("strips currency symbols and codes", () => {
    assert.equal(parseAmountToMinor("Bs. 1.500", "VES"), 150000);
    assert.equal(parseAmountToMinor("$12.99", "USD"), 1299);
    assert.equal(parseAmountToMinor("350,50 Bs", "VES"), 35050);
  });

  it("honours the sign, accounting parentheses included", () => {
    assert.equal(parseAmountToMinor("-350,5", "VES"), -35050);
    assert.equal(parseAmountToMinor("(350,50)", "VES"), -35050);
  });

  it("does NOT lose cents the way Math.round(parseFloat(x) * 100) would", () => {
    // The classic floating-point case: 1.005 * 100 gives 100.49999999999999, so
    // `Math.round(parseFloat(x) * 100)` returns 100 sometimes and 101 others
    // depending on the value. Working on the string makes it deterministic.
    // The decimal comma is used because in this locale it is unambiguous (see below).
    assert.equal(parseAmountToMinor("1,005", "USD"), 100);
    assert.equal(parseAmountToMinor("8,165", "USD"), 816);
    assert.equal(parseAmountToMinor("0,145", "USD"), 14);
  });

  it("resolves the ambiguous dot in favour of the local format", () => {
    // "1.005" is genuinely ambiguous: one thousand and five in Spanish, one point
    // zero zero five in English. Spanish rules here, which is how whoever uses
    // this writes. That is why a dot with exactly 3 digits after it is a thousands
    // separator, and whoever wants decimals writes a comma.
    assert.equal(parseAmountToMinor("1.005", "VES"), 100500); // one thousand and five bolívares
    assert.equal(parseAmountToMinor("1,005", "VES"), 100); // one and change
  });

  it("accepts numbers as well as strings", () => {
    assert.equal(parseAmountToMinor(1234.5, "USD"), 123450);
  });

  it("rejects what isn't an amount", () => {
    assert.throws(() => parseAmountToMinor("", "VES"), InvalidAmountError);
    assert.throws(() => parseAmountToMinor("abc", "VES"), InvalidAmountError);
  });
});

describe("minorToDecimalString", () => {
  it("never goes through a float on the way", () => {
    assert.equal(minorToDecimalString(35050, "VES"), "350.50");
    assert.equal(minorToDecimalString(5, "USD"), "0.05");
    assert.equal(minorToDecimalString(-35050, "VES"), "-350.50");
    assert.equal(minorToDecimalString(0, "USD"), "0.00");
  });
});

describe("convertToBase — which way the rate goes", () => {
  // This is THE test that matters. The rate is quoted-per-base: 859 bolívares
  // per dollar. Inverting the division gives a number ~738,000 times off, and
  // on USD/EUR the error would be small enough to go unnoticed.
  it("divides by the rate: bolívares -> dollars", () => {
    // 350,00 Bs at 859,00 Bs/USD = 0,41 USD
    assert.equal(convertToBase(35000, "VES", "USD", "859.0000000000"), 41);
  });

  it("an inverted rate would give an absurdity, not a plausible number", () => {
    const correct = convertToBase(35000, "VES", "USD", "859.0")!;
    const inverted = convertToBase(35000, "VES", "USD", (1 / 859).toFixed(10))!;
    // 0,41 USD against more than 300,000 USD: it fails loudly, which is the point.
    assert.ok(Math.abs(inverted) > Math.abs(correct) * 100_000);
  });

  it("keeps the sign", () => {
    assert.equal(convertToBase(-35000, "VES", "USD", "859.0"), -41);
  });

  it("leaves the amount alone when it's already in the base currency", () => {
    assert.equal(convertToBase(1299, "USD", "USD", null), 1299);
  });

  it("returns null with no rate, instead of inventing a zero", () => {
    // It is the difference between "I don't know what it is worth" and "it is
    // worth zero". A silent zero would vanish into any sum without a trace.
    assert.equal(convertToBase(35000, "VES", "USD", null), null);
    assert.equal(convertToBase(35000, "VES", "USD", "0"), null);
  });
});

describe("formatAmount", () => {
  it("uses the Spanish format", () => {
    assert.equal(formatAmount(123456, "VES"), "Bs. 1.234,56");
    assert.equal(formatAmount(1299, "USD"), "$ 12,99");
  });

  it("puts the sign before the symbol", () => {
    assert.equal(formatAmount(-35050, "VES"), "-Bs. 350,50");
  });

  it("shows the + only when asked", () => {
    assert.equal(formatAmount(1299, "USD", { showPlus: true }), "+$ 12,99");
    assert.equal(formatAmount(1299, "USD"), "$ 12,99");
  });
});

describe("sums typed into the amount field", () => {
  it("multiplies: 31 litres at 0,50", () => {
    assert.equal(parseAmountToMinor("31*0,5", "USD"), 1550);
  });

  it("accepts the decimal point when it can't be a thousands separator", () => {
    assert.equal(parseAmountToMinor("31*0.5", "USD"), 1550);
  });

  it("and still reads the thousands dot as thousands", () => {
    // With no operator it is not a sum: it is an ordinary amount.
    assert.equal(parseAmountToMinor("1.234,56", "VES"), 123456);
    // With an operator, "1.500" is still one thousand five hundred.
    assert.equal(parseAmountToMinor("1.500*2", "VES"), 300000);
  });

  it("adds, subtracts, divides and honours the parentheses", () => {
    assert.equal(parseAmountToMinor("1200+300", "VES"), 150000);
    assert.equal(parseAmountToMinor("(2+3)*4", "VES"), 2000);
    assert.equal(parseAmountToMinor("100/4", "VES"), 2500);
  });

  it("a lone negative is still an amount, not a subtraction", () => {
    assert.equal(parseAmountToMinor("-350,50", "VES"), -35050);
  });

  it("and accounting parentheses still mean negative, not grouping", () => {
    // "(350,50)" is -350,50 on any statement. It is only arithmetic when there is
    // something to compute inside.
    assert.equal(parseAmountToMinor("(350,50)", "VES"), -35050);
    assert.equal(parseAmountToMinor("(2+3)*4", "VES"), 2000);
  });

  it("rounds to the cent what division leaves long", () => {
    // 100/3 = 33,333… and there is no third of a cent.
    assert.equal(parseAmountToMinor("100/3", "VES"), 3333);
  });

  it("what can't be computed fails instead of inventing", () => {
    for (const bad of ["31*", "*5", "1//2", "2++", "10/0"]) {
      assert.throws(() => parseAmountToMinor(bad, "VES"), InvalidAmountError, bad);
    }
  });
});

describe("evaluateExpression", () => {
  it("returns null while you're still typing, without shouting", () => {
    assert.equal(evaluateExpression("31*"), null);
    assert.equal(evaluateExpression(""), null);
  });

  it("honours operator precedence", () => {
    assert.equal(evaluateExpression("2+3*4"), 14);
  });
});

describe("parseRate", () => {
  it("reads the Venezuelan decimal comma", () => {
    assert.equal(parseRate("859,4321"), "859.4321000000");
  });

  it("a dot with three digits after it is rejected rather than guessed", () => {
    // In an AMOUNT "1.234" is one thousand two hundred thirty-four beyond doubt. In
    // a rate the same string may mean 1,234, and both readings are plausible: one
    // is a thousand times the other. It is asked to be disambiguated.
    assert.throws(() => parseRate("1.234"), { reason: "rateAmbiguous" });
  });

  it("keeps the column's ten decimal places", () => {
    // Truncating to cents here would move an entire net worth.
    assert.equal(parseRate("775,3356789012"), "775.3356789012");
  });

  it("truncates rather than rounds what doesn't fit", () => {
    assert.equal(parseRate("1,12345678999"), "1.1234567899");
  });

  it("accepts a number", () => {
    assert.equal(parseRate(877), "877.0000000000");
  });

  it("rejects zero, which would value everything at nothing", () => {
    assert.throws(() => parseRate("0"), { reason: "rateZero" });
    assert.throws(() => parseRate("0,0"), { reason: "rateZero" });
  });

  it("rejects what isn't a figure", () => {
    assert.throws(() => parseRate(""));
    assert.throws(() => parseRate("ochocientos"));
    assert.throws(() => parseRate("-5"));
  });
});

describe("parseRate · the net that catches the big one", () => {
  it("rejects the ambiguous dot instead of guessing", () => {
    // "859.432" on the numeric keypad means 859,432. Reading it as a thousands
    // separator stored it a thousand times too large, valuing the whole day with a
    // false figure that fails nowhere.
    assert.throws(() => parseRate("859.432"), { reason: "rateAmbiguous" });
  });

  it("but an unambiguous decimal point does get through", () => {
    assert.equal(parseRate("859.4321"), "859.4321000000");
    assert.equal(parseRate("859.43"), "859.4300000000");
  });

  it("rejects a rate that's impossibly high", () => {
    assert.throws(() => parseRate("2000000"), { reason: "rateTooHigh" });
  });

  it("and lets through the ones actually in use", () => {
    assert.equal(parseRate("1.234,56"), "1234.5600000000");
    assert.equal(parseRate("775,3356"), "775.3356000000");
  });
});

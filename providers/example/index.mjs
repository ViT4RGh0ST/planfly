/**
 * Example rate source. It queries NOTHING: it returns a fixed number.
 *
 * It is here to show the exact shape, not to be used for real. Copy this folder,
 * give it another name and change the body of the function:
 *
 *   cp -r providers/example providers/my-source
 *   RATES_PROVIDER_BCV=my-source        # in .env and in .env.local
 *
 * If your source needs dependencies, install them IN HERE:
 *
 *   cd providers/my-source && npm init -y && npm i whatever-you-need
 *
 * Do not touch planfly's package.json. Its install and its build have to keep
 * working without your source — that is what lets someone clone the repository
 * and start it up without installing any of this.
 */

/**
 * @param {{ base: string, quote: string, date: string, timeoutMs: number }} ctx
 *   base      the currency being quoted, "USD"
 *   quote     the currency the price is expressed in, "VES"
 *   date      the household's day, YYYY-MM-DD
 *   timeoutMs how long you may take. Honour it: if you hang, you also delay the
 *             installment reminders and the recurring operations, which run on
 *             the same heartbeat.
 */
export default async function read({ base, quote, date }) {
  const value = Number(process.env.RATES_EXAMPLE_VALUE ?? 100);

  return {
    capturedAt: new Date().toISOString(),
    quotes: [
      {
        base,
        quote,
        // How many units of `quote` ONE of `base` costs. That direction matters:
        // inverting it gives the reciprocal figure, and with rates close to 1
        // the error is invisible until the month does not add up.
        value,
        // The date it is valid for. It may run AHEAD of today: there are
        // official sources that publish Monday's on Friday, and planfly expects
        // that. If you omit it, the day it was asked for is used.
        effectiveOn: date,
      },
    ],
    // What your source returned, untouched. It is stored so an odd figure can be
    // audited months later.
    raw: { provider: "example", value },
  };
}

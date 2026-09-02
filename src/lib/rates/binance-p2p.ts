/**
 * Parallel rate via Binance P2P.
 *
 * Ported from openclaw's `p2p-rates` plugin. It returns the **median** of the
 * ads surviving the filter, plus a sample of the top merchants.
 *
 * Note that the median is no longer what values entries: `p2p-quote.ts` takes
 * the FIRST ad, because the question the product answers is "what would I be
 * paid to sell right now", and that is the top of the book — see the reasoning
 * there. The median stays because it is a useful summary of the market and it
 * travels in `raw`, where it can be audited afterwards.
 */

const BINANCE_P2P_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";

/** The same aliases your plugin already uses, so that "provincial" means the
 *  same thing in the bot and on the dashboard. */
/**
 * The rail each market's reference rate is read on.
 *
 * A P2P median is not one number: it is the number for a way of paying. In
 * Venezuela the reference is a transfer to Provincial; in Colombia it is
 * Bancolombia. Reading pesos with the Venezuelan rail returns nothing at all —
 * which is the good failure, but it is a failure — and reading them with no rail
 * mixes cash, Nequi and bank transfer into one median that describes no
 * transaction anybody makes.
 *
 * It lives here, with the reader that understands what a payType is, and not on
 * the `currencies` table: which rail is the reference in a market is knowledge
 * about Binance, not a property of the money.
 *
 * A fiat that is not here reads the whole market, unfiltered, and says so by
 * being absent rather than by silently using somebody else's bank.
 */
const RAIL_BY_FIAT: Record<string, string> = {
  VES: "provincial",
  COP: "bancolombia",
};

/** The rail to read a market on, or the whole market when none is set for it. */
export function railFor(fiat: string): string {
  return RAIL_BY_FIAT[fiat.toUpperCase()] ?? "any";
}

const PAY_TYPE_ALIASES: Record<string, string> = {
  provincial: "Provincial",
  banesco: "Banesco",
  mercantil: "Mercantil",
  bdv: "BancoDeVenezuela",
  bancamiga: "Bancamiga",
  bancaribe: "Bancaribe",
  bnc: "BNCBancoNacional",
  pagomovil: "PagoMovil",
  zinli: "Zinli",
  zelle: "Zelle",
  bank: "BANK",
  /*
   * Colombia. The identifier is «BancolombiaSA», not the bank's name.
   *
   * Asked with «Bancolombia» the market answered with zero ads even with every
   * threshold switched off — which reads exactly like «there is no market in
   * pesos», and there is: 17 ads and a median of 3.139 the moment the rail is
   * named the way Binance names it. The identifiers came out of the ads
   * themselves; guessing them from the bank's name is how this looked broken.
   */
  bancolombia: "BancolombiaSA",
  nequi: "Nequi",
  daviplata: "Daviplata",
  davivienda: "DaviviendaSA",
  bancogota: "BancodeBogota",
};

export type P2pOptions = {
  fiat?: string;
  bank?: string;
  /** SELL = you sell USDT (you see buyers). It is the right direction for
   *  valuing bolívares in dollars. */
  tradeType?: "SELL" | "BUY";
  minOrders?: number;
  minFinishRate?: number;
  verifiedOnly?: boolean;
  rows?: number;
  timeoutMs?: number;
};

export type P2pResult = {
  /** Median of the filtered ads: bolívares per USDT. */
  median: number;
  best: number;
  worst: number;
  adCount: number;
  capturedAt: string;
  /** A sample of merchants, so an odd rate can be audited afterwards. */
  sample: Array<{ nick: string; rate: number; orders: number; finishRate: number | null }>;
};

type BinanceAd = {
  adv: { price: string; isTradable?: boolean; minSingleTransAmount?: string };
  advertiser: {
    nickName: string;
    monthOrderCount?: number;
    monthFinishRate?: number;
    proMerchant?: boolean;
    userType?: string;
    userIdentity?: string;
  };
};

function isVerifiedMerchant(ad: BinanceAd): boolean {
  const a = ad.advertiser;
  if (a.proMerchant === true) return true;
  if (typeof a.userIdentity === "string" && a.userIdentity.toUpperCase() === "MERCHANT") return true;
  if (typeof a.userType === "string" && a.userType.toLowerCase() === "merchant") return true;
  return false;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function fetchP2pRate(options: P2pOptions = {}): Promise<P2pResult> {
  const {
    fiat = "VES",
    // The rail follows the market, not the other way round: defaulting every
    // fiat to a Venezuelan bank is how pesos came back with no ads at all.
    bank = railFor(options.fiat ?? "VES"),
    tradeType = "SELL",
    // The same thresholds you already have configured in the plugin: they exclude
    // the occasional merchant publishing a rate nobody can take.
    minOrders = 100,
    minFinishRate = 0.98,
    verifiedOnly = true,
    rows = 20,
    timeoutMs = 15_000,
  } = options;

  const payload: Record<string, unknown> = {
    asset: "USDT",
    tradeType,
    fiat,
    page: 1,
    rows,
    publisherType: verifiedOnly ? "merchant" : null,
    merchantCheck: verifiedOnly,
  };

  const payType = PAY_TYPE_ALIASES[bank.toLowerCase()] ?? bank;
  if (bank.toLowerCase() !== "any") payload.payTypes = [payType];

  const res = await fetch(BINANCE_P2P_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (planfly)",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Binance P2P answered HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { data?: BinanceAd[] };
  const ads = data.data ?? [];

  const valid: P2pResult["sample"] = [];
  for (const item of ads) {
    const orders = Number(item.advertiser.monthOrderCount ?? 0);
    if (orders < minOrders) continue;

    const rate = Number(item.adv.price);
    if (!Number.isFinite(rate) || rate <= 0) continue;

    const finishRate =
      typeof item.advertiser.monthFinishRate === "number" ? item.advertiser.monthFinishRate : null;
    if (minFinishRate > 0 && (finishRate == null || finishRate < minFinishRate)) continue;

    if (item.adv.isTradable === false) continue;
    if (verifiedOnly && !isVerifiedMerchant(item)) continue;

    valid.push({ nick: item.advertiser.nickName, rate, orders, finishRate });
  }

  if (valid.length === 0) {
    throw new Error(
      `Binance P2P returned no ad passing the filter (${minOrders}+ orders, ${(minFinishRate * 100).toFixed(0)}%+ completion).`,
    );
  }

  const rates = valid.map((v) => v.rate);
  return {
    median: Number(median(rates).toFixed(4)),
    best: Math.max(...rates),
    worst: Math.min(...rates),
    adCount: valid.length,
    capturedAt: new Date().toISOString(),
    sample: valid.slice(0, 8),
  };
}

# Rate sources

planfly does not know where an exchange rate comes from. It knows someone hands
it over in a particular shape, and that shape is the only thing here.

This exists because the problem planfly solves — keeping accounts in an economy
with two currencies and two rates — is the same in Venezuela, Argentina, Lebanon
or Turkey, but the source of the number is not. Instead of shipping one specific
integration, the project ships the point where you plug in your own.

**With no source connected planfly works just the same.** The day's rate is
written by hand in `/rates` and everything else — the dollar equivalents, net
worth, the budgets — comes from there. Connecting a source is a convenience, not
a requirement.

## Plugging one in

There are two slots, which are the two rates the product knows how to handle:

| Slot | What it is | Variable |
|---|---|---|
| `bcv` | Your country's official rate | `RATES_PROVIDER_BCV` |
| `p2p` | The parallel market's | `RATES_PROVIDER_P2P` |

The `p2p` slot ships a built-in reader that queries Binance's public ads API and
takes the **first ad** that survives the filters — minimum order count,
completion rate, verified merchant. That is what you would genuinely be paid if
you sold right now. If you set the variable, your module replaces it.

**That reader goes out to the internet even if you configure nothing** — on the
heartbeat and also when recording an expense with no fresh rate for the day —
and it filters ads for Venezuela. Outside there it will give you nothing
representative.

To switch it off without putting anything in its place:

```
RATES_PROVIDER_P2P=none
```

`none` leaves the slot genuinely empty: no external module and no built-in
reader. The rate is written by hand in `/rates`.

A slot is not a source: it is a hole. It gets filled by a module, by the built-in
reader, or by a person typing the figure.

```
cp -r providers/example providers/my-source
cd providers/my-source && npm init -y && npm i whatever-you-need
```

And in `.env` and `.env.local`:

```
RATES_PROVIDER_BCV=my-source
```

The value takes three forms: a bare name (`my-source` → this folder), a relative
path (`./somewhere-else/x.mjs`) or an absolute one. **Use the bare name**: it is
the only one that means the same in `npm run dev` and inside the container, where
the directory is mounted at `/app/providers`. With absolute paths you end up with
two different values in two files that drift apart.

## The contract

Your module exports a function, as `default` or as `read`:

```js
export default async function read({ base, quote, date, timeoutMs }) {
  return {
    capturedAt: new Date().toISOString(),
    quotes: [{ base, quote, value: 123.45, effectiveOn: date }],
    raw: { whateverYourSourceReturned: true },
  };
}
```

| Field of a quote | |
|---|---|
| `base` | The currency being quoted: `"USD"` in «859,00 Bs per dollar» |
| `quote` | The currency the price is expressed in: `"VES"` |
| `value` | How many units of `quote` **one** of `base` costs. Finite and greater than zero |
| `effectiveOn` | The day it is valid for, `YYYY-MM-DD`. Optional |
| `variant` | To tell apart two figures from the same source on the same day: `"median"`, `"official"`. Optional |
| `preferred` | Which of your variants values the entry being recorded right then. Optional |

Five things worth knowing before writing your own:

- **`effectiveOn` may run ahead.** There are official sources that publish
  Monday's rate on Friday. planfly stores that date, not the capture one, and
  knows how to handle it. If you omit it, the day it was asked for is used.
- **You can return more currencies than you were asked for.** If your source
  publishes five, send them: storing them is free and a rate history cannot be
  reconstructed afterwards.
- **Send ONE variant per pair and day.** You can send more and they all get
  stored, but only the one marked `preferred: true` values the entry being
  recorded right then; when the rate is read back later, planfly breaks the tie
  by variant name, which is stable but arbitrary. If your source publishes buy
  and sell, pick which one is «the rate» and send that: between the two there is
  no answer planfly can guess for you.
- **Honour `timeoutMs`.** If you hang, you also delay the installment reminders
  and the recurring operations, which run on the same heartbeat. planfly cuts you
  off on its own, but do not rely on that.
- **To signal a failure, throw.** planfly catches it, leaves the slot empty and
  carries on. It never goes down because a source is down, and an expense can
  always be recorded — it will be flagged for review until there is a rate.

What you return is validated before it touches the database: a quote with an
impossible value discards itself, and if none usable is left the slot stays
empty. A foreign module cannot put an absurd number into your accounts.

## What is versioned and what is not

This file and `example/` are in the repository. Everything else you put here is
ignored, on purpose: your source is yours, with its own `node_modules`, and
planfly's `package.json` never learns it exists. That is why `npm ci` and
`npm run build` work on a clone that has none.

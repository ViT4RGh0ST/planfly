# Contributing

Thanks for looking. This is a small project with strong opinions; it is worth
knowing them before writing code.

## Getting it running

It is in the [README](README.md). In short: `npm ci`, the two env files,
`docker compose up -d`, migrations and seed.

Before sending anything:

```bash
npm test          # unit tests
npm run lint
npx tsc --noEmit
```

## Two rules that are not negotiable

**1. Nothing writes into the ledger outside `recordTransaction()`.**

Every way in — the form, the bot, the CSV, a photo of a receipt, whatever fires
on its own — goes through `src/lib/services/record-transaction.ts` and its
siblings `updateTransaction`, `manage-accounts`, `financing`, `budgets` and
`recurring`. It is what guarantees that rates get stamped, that the invariants
hold and that the four routes do not diverge. A loose `INSERT` into
`transaction_entries` is not accepted, however small the case.

**2. All the code in English. What a person sees, in their language.**

Identifiers, comments, test names, log messages and documentation: English, no
exceptions. It is what lets someone from outside understand **why** the code
does what it does, which here is half the value.

What whoever uses the app reads does not live in the code: it goes out to the
catalogues in `src/i18n/messages/`, in Spanish and in English. A Spanish literal
inside a `.tsx`, a service or a script is a mistake, and `literals-guard` catches
it — judging each literal against the catalogue's own vocabulary, not by looking
for accents: «Actualizar ahora» has none.

The one exception is written into the code and visible in it: **a quoted
fragment is an example of what the person says**, and it stays in Spanish. The
bot's tool descriptions teach the model that «gasté 350 bolos» is an expense, and
translating that example would break the very thing it teaches. Quoted is input;
unquoted is what the app answers.

Comments explain **why**, not what: if the code already says what it does, the
comment is redundant.

## The money

- Amounts are integers of minor units. Never a `float`, never operating on text
  that has already been formatted.
- Rates are `NUMERIC(24,10)` and travel as text all the way to the database.
- Liabilities are stored negative, so that net worth is a sum.
- A missing rate is stated; it is neither invented nor interpolated.

A sign error or a mixed currency **does not fail**: it returns a false figure
nobody notices. That is why there are so many tests around `money.ts` and why
any change there needs its own.

## Before opening a PR

- One thing per PR. A fix and a redesign together cannot be reviewed.
- If you change behaviour, say so in the commit message: what it did before,
  what it does now and why. This project's history is used as documentation.
- If you touch a screen, look at them. Two prior steps, once only:

  ```bash
  npx puppeteer browsers install chrome   # the install deliberately skips it
  npm run scan:user                       # creates the scan user and prints its password
  ```

  With `SCAN_PASSWORD` in `.env.local`, `node scripts/screenshot.mjs <folder>`
  logs in and saves one PNG per route and width. Compiling does not tell you
  whether a figure lies or whether a field spills out of its column.
- If you touch anything with money, add the test. `npm test` runs `node:test`
  with no configuration: look at `src/lib/money.test.ts` for the style.

## Where things are

- [`docs/api.md`](docs/api.md) — the HTTP API, the way any bot comes in.
- [`providers/README.md`](providers/README.md) — how to connect a rate source.
- [`openclaw/`](openclaw/) — the reference adapter for one particular framework.

## What probably will not be accepted

- Adding one country's specific integration to the core. That is what the
  [pluggable sources](providers/README.md) are for.
- Changing the number format to something other than `es-VE`. It deliberately
  does not follow the language: the currency is data, and when reconciling
  against a Venezuelan bank statement the screen has to write the figure the
  same way the paper does.
- A new language that translates only half. `catalog-guard` demands parity of
  keys and of arguments across every language, and it is blocking.
- New dependencies for something the standard library already does.

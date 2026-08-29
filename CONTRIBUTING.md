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

## Four questions before writing the design

Not before writing the code — before deciding what to build. Answer them out
loud, in the issue or in the PR description, and the answer is the design's
justification rather than a formality afterwards.

**1. If this breaks, does it fail or does it lie?**

This one goes first, and it is the only one that can rule an option out on its
own. The others grade a design; this one grades the consequence, and here the
consequence is the whole point. A crash is cheap: somebody sees it and fixes it
in a minute. A wrong figure is expensive, because nothing shouts and the month
simply does not add up.

Two from this repository's own history, both of which passed every other check:

- A budget on a parent category counted only what pointed at the parent itself.
  Every expense lands on a child, so a cap on «Comida» read **0% used for the
  whole month** — a calm green figure saying the opposite of the truth.
- An auth plugin was wired up whose signing keys live in a table that nobody had
  created. The types, the lint, the whole suite and the production build all
  passed — none of them renders a page against the real adapter — and the
  application did not open at all.

If the honest answer is «it lies», the design is not finished until you can name
what catches it: a guard test, a database constraint, or a screenshot. Naming it
is part of the answer.

**2. Is it the best practice, or a patch?**

A patch is anything that works today by adding a second way to answer a question
something already answers. Two mechanisms for one truth diverge sooner or later,
and here they diverge into a figure.

The example that made this rule: a `pegged_to` column, so a dollar stablecoin
would not ask for a rate. It worked — and it was a second path to «what is X
worth in the base currency», parallel to the rates table that already answered
it. What did not scale was not the conversion: it was that a rate's expiry was a
global constant. The fix was `currencies.rate_ages`, which is smaller **and**
more correct.

**3. Does it scale?**

Not «will it survive a million rows» — that is not this product's problem. It is
whether the second case, and the fifth, fit without a migration and without a
special branch. A schedule of installments that models Cashea and cannot express
a loan between family is one case dressed as a design.

**4. Is it DRY — and is it the least that solves today's case?**

The two halves pull against each other on purpose. Questions 2 and 3 both reward
more structure and more foresight; nothing else pushes back, and unopposed they
end in a field that looks like it does something and does not.

That phrase is in the code, at `manage-accounts.ts`, explaining why an account
is never asked for its opening date. The categories screen does not offer the
`icon` column for the same reason: it exists in the database and nothing reads
it.

Four is what fits in a head. Everything else worth asking is already written
somewhere else and does not need repeating here: empty states are principle 5 of
[PRODUCT.md](PRODUCT.md), looking at the screen is under «Before opening a PR»
below, and archiving instead of deleting is in the code with its reason.

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

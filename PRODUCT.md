# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People keeping their personal or household finances in an economy where **money
lives in two currencies at once** and the rate moves every day. Venezuela is the
originating case; Argentina, Lebanon, Turkey or Nigeria pose the same problem.

The schema supports several people per household (`households` +
`household_members`, with roles), but the product is designed for a small
household: one or two people sharing accounts, not an organisation.

Two usage scenes, very different from each other:

1. **Recording, on the move.** You tell a messaging bot about the expense in
   natural language — «gasté 350 bolos en el mercado» — from the street, or you
   send it a photo of the receipt. The web is not opened for this.
2. **Consulting, at the desktop.** The dashboard is opened several times a day.
   It is a glance, not an analysis session.

The question it exists to answer is **«how much do I have?»** — the net position
rules; spending by category is context, not the lead.

## Product Purpose

Knowing how much you have and where it goes, when that cannot be answered with a
single figure because there are two legitimate rates at the same time.

Success is that recording an expense costs no effort — hence the bot — and that
the dashboard figure is credible without having to reconstruct it in your head.

## Positioning

**The double valuation.** Every entry in local currency stores both rates of the
day and both equivalents already computed. The dashboard selector recalculates
nothing: it changes which column gets added up.

An ordinary finance app stores one currency and one rate. Here the question «how
much do I have?» has **two legitimate answers at once** — at the official rate
and at the parallel one — and the product refuses to choose on behalf of whoever
uses it. That tension is the product, not an implementation detail.

Design consequence: **a lone net worth figure is a half-truth.** The other
valuation has to be visible, not hidden behind a click.

Where the rates come from is not the product's decision: sources are plugged in,
and with none connected they are written by hand. Tying itself to one country's
integration would turn this into a local tool instead of an answer to the problem.

## Operating Context

- **It is self-hosted.** It runs on the machine of whoever uses it, with its own
  database. There is no cloud, no service, no access from outside unless one is
  set up on purpose.
- The app is reached at `localhost:3000`, or through a domain of your own with a
  proxy in front.
- The bot only works with the machine switched on. That is the consequence of
  self-hosting.
- Rates are brought in by pluggable sources, twice a day. Every source is
  fragile: it may be missing, and the product assumes that state.
- The household's timezone is a household datum, not the server's: a 21:00
  expense recorded in another timezone lands on the following day.

## Capabilities and Constraints

Confirmed and working:

- Expenses, income, transfers between accounts (across different currencies too)
  and adjustments.
- **Asset and liability** accounts: credit cards and loans subtract, so the net
  position is net worth and not «what I have on me».
- Hierarchical categories with aliases, so the bot matches «super» to Mercado.
- Budgets by month, fortnight, year or a custom range, with an expected-pace mark.
- Installment purchases: their schedule, each installment's payment and what is
  already committed.
- Recurring operations, fired on their own, valued in another currency if needed.
- Product prices over time, taken from the breakdown of the receipts.
- A review tray: whatever the AI did not interpret confidently lands there with
  the reason spelled out.
- CSV statement import with deduplication.
- Four ways in (bot, form, CSV, photo of a receipt) converging on a single write
  path.

Constraints the design cannot break:

- Money is an integer of minor units; rates are `NUMERIC(24,10)`. Nothing is ever
  formatted twice, and nothing is operated on after being formatted.
- **Empty states are the normal case, not the exception**: no rate for the day,
  no budgets, no entries in the period, no base-currency equivalent. Each one has
  to say *why* it is empty.
- Only the pair between the local currency and the base is solved by a source.
  Other currencies are stored unvalued unless someone writes their rate — and a
  currency whose rate does not go out of date, like a dollar stablecoin against
  the dollar, needs that written once and never again.

## Brand Commitments

- Name: **planfly**, lower case.
- **Two interface languages: Spanish and English**, at the household's choice.
  The code is entirely in English — comments included; what whoever uses the app
  sees comes from catalogues, never from a loose literal.
- `es-VE` number formatting in both languages: decimal comma, thousands dot,
  `Bs.` and `$` as symbols. **It does not follow the language**, and that is
  deliberate: the currency is data, and a figure gets compared against a
  Venezuelan bank statement. Dates do follow the language.
- The summary the bot repeats is worded by the server and shown verbatim. The
  voice there is direct and unadorned: «Gasto de Bs. 350,00 (≈ $ 0,41 P2P) en
  Mercado desde Efectivo Bs.».

## Evidence on Hand

- **A fresh installation starts empty.** The dashboard with no entries, no
  budgets and no rate is the first screen anyone sees, and it has to be designed
  as such.
- The seed's accounts and categories are **examples from the originating case,
  meant to be changed**: they show what the aliases are for, they are neither a
  recommended configuration nor a description of anyone.
- Typical spread between the official and parallel rates in the originating case:
  **10–20%**. Enough that picking the wrong valuation changes the reading of a
  whole month.
- There is **no** logo, brand typeface, defined palette or brand material of any
  kind. None of it should be invented as if it existed.

## Product Principles

1. **The figure has to be credible.** If a rate is missing or stale, it is said.
   A number with no visible provenance is worth less than an honest hole.
2. **Two truths at once.** Both valuations live together on screen. Hiding one
   behind a click turns the product into one more of them.
3. **A glance, not a report.** It is opened several times a day to answer one
   question. What matters comes with no scrolling and no clicks.
4. **What the AI doubts is visible.** Each row's provenance (bot, photo, CSV, by
   hand) and its confidence level are part of the datum, not metadata.
5. **Emptiness explains.** No budgets, no rate, no entries: every empty state
   says why it is empty and what to do, because at the beginning they are nearly
   the whole application.

## Accessibility & Inclusion

No formal requirement is set, but a reasonable floor is kept: sufficient contrast
in the dark theme, visible focus when navigating by keyboard, and **colour never
as the sole carrier of meaning** — which matters especially because the «needs
review» state and the sign of an amount lean heavily on colour.

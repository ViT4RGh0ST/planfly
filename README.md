# planfly

Personal finance for economies with **two currencies and two rates**.

Every entry in local currency stores both rates of the day and both equivalents
already computed. The question «how much do I have?» has two legitimate answers
at once — at the official rate and at the parallel one — and planfly refuses to
choose for you: it shows both and you decide which one you read by.

It was born for Venezuela, but the problem is the same anywhere the rate moves
every day. Where the rates come from is **your choice**:
[they plug in](providers/README.md), and with none connected they are written by
hand.

**It is self-hosted.** It runs on your machine, with your database. Your entries
never leave it: no account, no service, no telemetry.

The only thing that goes out to the internet is the **exchange rates**, and only
if you leave a source connected. One ships out of the box — the parallel market's,
which queries a public listing of ads — and it is switched off with
`RATES_PROVIDER_P2P=none`. See [rate sources](#rate-sources-plug-in).

Next.js 16 · React 19 · PostgreSQL 18 · Drizzle · Tailwind 4 · Docker.

## What it does

| | |
|---|---|
| **Dashboard** | Net worth in both valuations, and where the month is going |
| **Entries** | Expenses, income, cross-currency transfers and adjustments |
| **Accounts** | Assets and liabilities: cards and loans subtract |
| **Budgets** | By month, fortnight, year or a custom range, with a pace mark |
| **Installments** | Financed purchases, their schedule and each payment |
| **Recurrences** | What repeats on its own, valued in another currency if needed |
| **Products** | What flour cost three months ago |
| **Rates** | Both, their spread, their history, and setting them by hand |
| **Review** | What was recorded with doubts, with the reason written out |

There are four ways in — a Telegram bot, the form, a CSV or a photo of a receipt
— and all four end in the same place.

## Getting started

You need Docker and Node 24 (`nvm use` reads the `.nvmrc`).

```bash
npm ci

cp .env.example .env                # compose reads this one
cp .env.example .env.local          # the scripts read this one
```

**Yes, both.** `docker compose` reads `.env` and the `npm` scripts read
`.env.local`. Both need `BETTER_AUTH_SECRET`, which is generated with:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
```

And in `.env.local`, additionally, `SEED_EMAIL` and `SEED_PASSWORD` for the first
account.

Then:

```bash
docker compose up -d                # app + Postgres
npm run db:migrate
npm run db:seed
```

The seed prints the bot's API token **once only**. After that,
`http://localhost:3000`.

Telegram reminders are optional. If you enable them, bind the bot chat to the
household id printed by the seed in `TELEGRAM_HOUSEHOLD_ID` (in `.env`). One app
process sends alerts for only that household; this prevents a second household's
financial information from reaching the same chat.

To **work on the code**, the development server on the same port:

```bash
docker compose stop app
npm run dev
```

### The database

The data lives in a **Docker volume** (`planfly-pgdata`), not in a project
folder: Postgres writes as root and a directory like that inside the repo breaks
any tool that walks it.

Backing up and restoring goes through `pg_dump`, which is what you can carry to
another machine — copying the cluster files only works with the same version:

```bash
./scripts/backup-db.sh                  # into backups/, git-ignored
zcat backups/planfly-YYYYMMDD-HHMM.sql.gz | docker compose exec -T db psql -U planfly -d planfly
```

Cron can run the script every hour: it only dumps if the newest copy is more than
20 hours old, so a machine switched off overnight does not skip the day. The
entry is yours to add:

```
17 * * * * /path/to/planfly/scripts/backup-db.sh >> /path/to/planfly/backups/backup.log 2>&1
```

The copies stay in `backups/`, on the same disk as the database. For them to be
worth anything, take them somewhere else.

### With a domain name

The `compose.yaml` is self-sufficient on purpose: it creates no external networks
and assumes no proxy, because if it did a freshly cloned repo would not start. To
put it behind Traefik:

You need **a Traefik already running** on that network; planfly does not start
one.

```bash
docker network create proxy_gateway   # if it does not exist
cp compose.override.yaml.example compose.override.yaml
docker compose up -d
```

Docker Compose loads that file on its own, with no flags, and it lands on
`http://planfly.localhost` — browsers resolve `*.localhost` to 127.0.0.1 by
themselves (RFC 6761), so there is no `hosts` file to touch.

## The four ways in

They all converge on `recordTransaction()`
(`src/lib/services/record-transaction.ts`). **None writes
`transaction_entries` directly.** It is the structural rule guaranteeing that
rates get stamped and invariants hold without depending on each caller
remembering.

| Way in | Where |
|---|---|
| Telegram | openclaw plugin → `POST /api/v1/transactions` |
| Form | `/transactions` (Server Action) |
| CSV | `/import` |
| Photo of a receipt | openclaw's multimodal agent → same endpoint with `source: "ocr"` |

## Decisions that are not obvious

**Money is never a float.** Every amount lives as an integer of minor units
(`BIGINT`) plus its currency. `parseAmountToMinor` works on the *string*, because
`Math.round(parseFloat(x) * 100)` loses cents. Rates are `NUMERIC(24,10)` and are
handled as strings: a rate is a ratio, not money.

**The rate is quoted-per-base** (859 Bs per USD) and it divides. Inverting the
direction gives a number ~738,000 times off. There is a test pinning it
(`src/lib/money.test.ts`).

**BOTH rates are stored on every line**, with both dollar amounts precomputed.
The dashboard's BCV/P2P selector only changes which column gets added up — it
recalculates nothing. Changing `households.default_rate_source` revalues the
whole history instantly, with no migration.

**Flow at historical rates, stock at today's.** Expenses are valued with the rate
stamped on the day they happened; the net position reconverts the current balance
at the rate in force. Adding up the historical amounts would give the cost, not
net worth.

**A failing rate never prevents an expense being recorded.** It is stored with
the base amounts `NULL` and `needs_review = true`, and filled in later.

**The BCV publishes with a future value date** (on Friday Monday's is already
out). That is why the search picks the *closest* value date, preferring earlier
or equal, rather than a plain `<= date` that would leave the first expense of the
day with no rate.

**A header + lines ledger.** A USD→VES transfer stores −100 USD in Zelle and
+85.900 Bs in Provincial, each leg with its own currency and rate. A record with
a single amount would have to lie about one of the two sides. A deferred
`CONSTRAINT TRIGGER` enforces it even from psql.

**Identity comes from the token, never from the body.** An openclaw tool receives
`execute(toolCallId, params)` and cannot know which Telegram user invoked it, so
a `household_id` as a parameter would be trivial to forge. The API rejects any
body carrying `householdId`, `userId` or the like.

**The bot sends names, not ids.** `category: "mercado"` is resolved on the server
with `pg_trgm`. That way an invented id is impossible; the worst that happens is
a weak match, which gets flagged for review.

## Commands

```bash
npm run dev              # native development, on 127.0.0.1 only
npm run build            # production build
npm test                 # tests, concentrated where a mistake is silent
npm run test:coverage    # the same, with coverage per file
npm run lint
npm run db:generate      # new migration from the TS schema
npm run db:migrate
npm run db:studio
npm run db:seed
npm run rates:snapshot   # force a capture right now
npm run rates:check      # do the configured sources answer? (writes nothing)
npm run token:create     # rotate the openclaw token
```

## Connecting a bot

The way to record without opening the web is a messaging bot, and planfly does
not marry any of them: it exposes an **HTTP API with a token**, the same one the
form writes through. What uses it is up to you.

```bash
npm run token:create     # printed once only
```

[**`docs/api.md`**](docs/api.md) has the whole reference: the routes, the token
scopes, the example of recording an expense and the four rules that save an
afternoon of debugging.

Two things that make the integration far easier than it looks:

- **Accounts and categories go by name**, never by identifier. «provincial», «el
  super», «bolos»: planfly matches them with aliases and fuzzy search, and if it
  does not recognise one it says so instead of inventing it.
- **The response carries the summary already worded** and with the figures
  formatted, to be repeated verbatim. Your bot has to do no arithmetic and no
  currency formatting — which is exactly where it gets things wrong.

### With openclaw

There is a ready-made plugin in [`openclaw/planfly-plugin/`](openclaw/), with ten
tools and a `SKILL.md` teaching the model when to use each one and how to read an
invoice. It is installed by copying it to the gateway's extensions directory:

```bash
npm run openclaw:install
```

And you have to **restart the gateway** afterwards: editing the repository
changes nothing until the installed copy changes.

### With any other

Wrap the routes in `docs/api.md` as your framework's tools. The openclaw plugin
serves as a reference for what to wrap and how to describe it, even if you do not
use it: the tool names and their descriptions are written from watching a model
get them wrong.

## Typeface

**Archivo**, by Omnibus-Type (Buenos Aires), self-hosted in `src/app/fonts/`.

It was chosen deliberately. impeccable's detector flags Inter, Roboto, Fraunces,
**Geist**, Plus Jakarta Sans and Space Grotesk as burnt: they are the faces every
wave of AI-generated interfaces converges on. Geist is also what
`create-next-app` ships, that is, the exact signature of "nobody chose this".

Archivo was designed for high-functionality text and data, has real tabular
figures (non-negotiable: without them amounts shift width as they update) and
comes from a Latin American foundry.

It is self-hosted and not served through `next/font/google`: the build does not
depend on Google answering, and the app makes no external request on load. Two
subsets, latin and latin-ext, because Spanish needs `á é í ó ú ñ ü ¿ ¡`.

> Before this, `--font-sans` referenced itself in `globals.css`. The circular
> reference resolved to nothing and **the whole app rendered in Times New Roman**,
> the browser's default serif.

## Naming convention

**All the code in English.** Tables, columns, functions, routes, enum values
(`transactions`, `needs_review`, `kind: 'expense'`), comments, test names and log
messages.

**What a person sees goes out to catalogues**, it does not live in the code: the
interface labels, the error messages and the summary the bot repeats in Telegram
are in `src/i18n/messages/`, in Spanish and in English.

The language is the **household's**, in `households.locale`: one column, and it
governs both the web and what the bot answers. It is changed from the foot of
the navigation, and a fresh installation is born in English — `SEED_LOCALE=es`
seeds it in Spanish instead. It is not in the URL and not in a cookie: with the
bot and the screen reading two different settings, the same expense would come
back worded two ways.

The **names of accounts and categories** ("Mercado", "Efectivo Bs", "Comida
callejera") are data, not code: they stay as the user wrote them, and the bot
passes them through as-is.

## Network

```
browser ──80──> proxy (optional) ──┐
                                   ├─> planfly ──> planfly-db
browser ─3000──────────────────────┘      ▲
                                          │  http://planfly:3000
                      bot / integrations ─┘  (container DNS)
```

Postgres hangs off the `internal` network **only**: it is not reachable from the
proxy's network. Port 5433 is published on `127.0.0.1` solely for running
migrations and opening drizzle-studio from the machine; it is not exposed to the
local network.

If you connect a bot running in another container, the right way is for it to
call planfly by **container name** on a shared network, not through
`host.docker.internal`: that way it depends on neither published ports nor the
system firewall. That is set up on the bot's side, with an override of its own
compose.

A warning that costs an afternoon to find: when attaching a second network to a
container, Docker picks on its own which one carries the default route to the
internet, and it may pick the proxy's. If the bot starts timing out talking to
outside services, pin the priority of its default network.

## When the rates are captured

**Twice a day: 8:00 and 14:00 Caracas time.** The BCV publishes once per business
day, so polling more often is hammering a source that does not change; two takes
cover the P2P's movement, which does move during the day.

It is not a timer aimed at 8:00 sharp, but a heartbeat every 15 minutes that
**checks state** and only goes out to the network if the last capture predates
the window that has passed. The difference matters here: the PC is not always on
at 8:00, WSL suspends and a 24-hour `setTimeout` drifts or is lost.

If the PC was off at 8:00 and gets turned on at 11:00, that window is recovered
on start-up. The day is not lost.

Additionally, recording a bolívar expense **from today** with no rate for the day
fetches one on the spot: it is the safety net for when the machine has been off
for hours.

**One row per source and per day** is stored (`ON CONFLICT DO UPDATE`), so the
history keeps each day's last known value, not an intraday series.

## Rate sources plug in

planfly ships no specific integration. It knows someone hands it a rate in a
particular shape, and that shape is the only thing in the repo.

It is deliberate: the problem it solves — keeping accounts with two currencies
and two rates — is the same in several countries, but where the number comes from
is not.

There are two slots, `bcv` (the official one) and `p2p` (the parallel market's),
and they get filled three ways: with a module you plug in, with the built-in
reader — `p2p` ships one, which queries Binance's public ads API and takes the
first ad surviving the filters — or by typing the figure by hand in `/rates`.

**With no source connected planfly works just the same.** You write the day's
rate and from there come the equivalents, net worth and the budgets. Connecting a
source is a convenience, not a requirement.

With one caveat worth knowing before starting it up: **the parallel slot ships a
built-in reader and comes plugged in out of the box.** It queries Binance's
public ad listing filtered for Venezuela, and it does so on the heartbeat and
also on the fly when an expense is recorded with no fresh rate for the day. It is
a request to a third party from your connection, even though none of your data
travels.

To switch it off entirely:

```
RATES_PROVIDER_P2P=none
```

And outside Venezuela it is worth doing so anyway, or plugging in your own: that
filter is not going to give you anything representative.

The contract, how to write your own and an example module are in
[`providers/README.md`](providers/README.md). What you install there is yours: a
separate npm project, with its own `node_modules`, which enters neither planfly's
`package.json` nor the Docker image — it is mounted at run time, so updating it
forces no rebuild.

To check that the ones you have configured are still answering:

```bash
npm run rates:check
```

It asks each configured slot, applies sanity ranges and skips the ones with no
source. It exists because a source can stop working in silence: the app simply
stores the entry without an equivalent and flags it for review, which is right
but goes unnoticed.

## Accepted limitations

- **The bot only works with the PC switched on.** That is the consequence of
  self-hosting. Telegram keeps 24 h of pending messages, so after an outage old
  messages can arrive: that is why the SKILL.md insists on pinning the date when
  a message is not from now.
- Only the USD/VES pair is solved. Other currencies are stored but stay unvalued.
- The backup is run by cron if you set it up yourself; the repository does not
  touch your crontab. And the copies stay on the same disk as the database: for
  them to be worth anything, take them somewhere else.

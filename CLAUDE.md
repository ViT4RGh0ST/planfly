@AGENTS.md

# Working on planfly

planfly keeps accounts of real money. The practical consequence rules over
everything else: **a mistake here does not fail, it returns a false figure.** An
inverted sign, a mixed currency or a rate a thousand times too large break
nothing, show up in no log, and nobody notices them until the month does not add
up.

Nearly everything in this file comes from that.

## Skills: when to load each one

It is a pre-check, not a reference list.

| Before… | Load | Why |
|---|---|---|
| touching any interface `.tsx` | **impeccable** | It brings `PRODUCT.md`, the quality floor and its detector. Its hook runs on every edit, but only catches the mechanical |
| writing or touching a chart | **dataviz** | BEFORE the first line. There are four: `price-chart`, `categories-chart`, `rates-chart`, `month-flow` |
| redesigning a whole screen | **impeccable** → `new-work.md` | The structure is decided before writing, not with the first idea |

And these are launched by whoever is working, not by the agent: it is worth
**offering** them rather than assuming they happened.

- **`/code-review`** — after a run of commits. It has found figure errors no test
  covered, including an inverted tie-break that did exactly the opposite of what
  its own comment said.
- **`/security-review`** — there is financial data, API tokens, sessions and
  hand-written SQL.

## Nothing that runs comes from the repository

They are two distinct jumps, and both have cost hours when forgotten.

**The bot plugin.** `openclaw/planfly-plugin/` is the source; the gateway reads
from `~/.openclaw/extensions/planfly/`. Editing the repository changes nothing in
the bot until:

```
npm run openclaw:install                   # copies to the gateway
docker compose restart openclaw-gateway    # wherever openclaw is mounted
```

The two steps go together and go **before** saying the bot knows something. And
it is checked against the installed copy, not against the source:

```
diff -rq openclaw/planfly-plugin/ ~/.openclaw/extensions/planfly/
```

Restarting the gateway touches another project: it is worth saying so rather than
doing it quietly.

**The application.** `docker compose` starts `planfly:local`, which is a **built**
image. Editing `src/` and restarting the container keeps serving the previous
build:

```
docker compose build app && docker compose up -d app
```

To iterate without rebuilding, a separate `next dev` against a clone of the
database:

```
DATABASE_URL=postgres://planfly:planfly@127.0.0.1:5433/planfly_probe \
  npx next dev -H 127.0.0.1 -p 3210
```

The rule joining them: **check where it is going to be seen, not where it was
written.**

## Debugging an integration: look at what it sends, not at what it says

A model **cannot see its own arguments**: it describes what it meant to send, in
good faith, and gets it wrong. Its self-report is not evidence.

The gateway stores the literal arguments of every call, and that is the source of
truth:

```
docker exec <gateway-container> sh -c \
  "grep -o '\"name\":\"planfly_[a-z]*\",\"arguments\":{[^}]*}' \
   /home/node/.openclaw/agents/main/sessions/*.jsonl | tail -12"
```

One integration insisted for hours that it was sending `account`; it was sending
`to_account` — a transfer's destination — on an expense. The server dropped it in
silence and returned 201: twelve purchases in the wrong account.

Hence the rule that orders half the API: **a valid field in the wrong context is
worse than an invented one.** The invented one is caught by `rejectUnknownKeys`;
that one passes the whole schema and leaves a correct write with the datum in the
bin. When one shows up, it is rejected by naming the right field — never ignored.

## Verifying is looking, not just compiling

`tsc`, the lint and impeccable's detector say whether something is broken, **not
whether a figure lies**. The mistakes that would have cost most — mixed
currencies in the rail, a field overflowing its column, an axis repeating labels
— only showed up on opening the page.

```
node scripts/screenshot.mjs <folder>
```

It logs in as the scan user and saves one PNG per route and width. Use it before
saying something works.

## The tests and what they do not cover

`npm test` runs `node:test` with no configuration. The tests concentrate where a
mistake is silent: `money.ts`, the rate ladder, the recurrence calendar, the API
validation.

Two worth understanding before touching them:

- **`src/i18n/literals-guard.test.ts`** and **`catalog-guard.test.ts`** are the
  two that keep the two languages honest. The first one refuses Spanish written
  into the code; the second demands that both catalogues carry the same keys and
  **the same ICU arguments**. That second rule is the one that protects the
  figures: an English message that lost its `{amount}` still renders — a
  grammatical, safe, figure-less sentence that the bot repeats with confidence.
- **`src/lib/actions-guard.test.ts`** walks the files with `"use server"` and
  fails if an action that writes does not go through `requireWriter()`. It does
  not check one particular action: it checks that **the next one** is not born
  unprotected. Its first version had the path hard-coded and that is why it did
  not see the second file.
- **The precedence between an automatic rate and a hand-written one lives in
  SQL**, in `findStored`'s `ORDER BY`, so it can only be checked with Postgres in
  front: `src/lib/rates/service.db.test.ts`. What it pins is both sides — on the
  same day the hand-written one rules, but a manual one from three days ago does
  NOT beat today's automatic — because the order between those two tie-breaks is
  exactly what can be inverted with nothing failing.

`npm run test:coverage` gives the number per file. It is not a target: it is for
seeing which path has never run, which is different from which path is tested.

## The database

The data lives in the `planfly-pgdata` volume, not in a project folder: Postgres
writes as root and a directory like that inside the repository breaks any tool
that walks it, with a permission denied that does not name the cause.

`scripts/backup-db.sh` dumps with `pg_dump` if the newest copy is more than 20
hours old, so cron can run it every hour without duplicating work. The dumps go
to `backups/` (git-ignored). To restore:

```
zcat backups/planfly-YYYYMMDD-HHMM.sql.gz | docker compose exec -T db psql -U planfly -d planfly
```

A dump restores on any installation; copying the cluster files only works with
the same Postgres version.

**It is somebody's real accounting.** Before any test that writes, clone —
`CREATE DATABASE planfly_probe TEMPLATE planfly` — and drop the clone when done.

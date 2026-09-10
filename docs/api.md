# planfly's API

It is the surface anything that is not the web connects through: a bot, a script,
an assistant. It speaks HTTP and JSON, authenticates with a token, and is the
**same write path** the form uses — there is no back door with fewer checks.

The repository ships a reference adapter for [openclaw](../openclaw/), but you do
not have to use it: any framework capable of making an HTTP request will do. If
you use another, this is everything you need.

## The token

```bash
npm run token:create
```

It is printed **once only**. It goes in the header:

```
Authorization: Bearer <token>
```

Every token carries its **scopes**, and a request outside them is rejected with
403. Ask only for what the integration is going to use:

| Scope | What for |
|---|---|
| `context:read` | Reading accounts, categories, rates, budgets, recurrences, installments |
| `transactions:read` | Reading entries |
| `transactions:write` | Recording, correcting and voiding entries; adding products |
| `reports:read` | Reports, product prices and rates |
| `accounts:write` | Opening, renaming and archiving accounts |
| `budgets:write` | Setting and removing budgets |
| `financing:write` | Installment purchases and their payments |
| `recurring:write` | Operations that repeat on their own |
| `rates:write` | Currencies and hand-written rates — **installation-wide, not per household** |
| `catalog:write` | What names and groups: places, categories and rules |

The household **does not travel in the body**: it comes from the token. Sending
`household_id`, `user_id` or any other identity field is rejected with 400. It is
what makes it impossible for an integration to write into the wrong household.

## Routes

| Route | Methods | Scope |
|---|---|---|
| `/api/v1/context` | `GET` | `context:read` |
| `/api/v1/transactions` | `GET` `POST` | `transactions:read` · `transactions:write` |
| `/api/v1/transactions/{id}` | `PATCH` `DELETE` | `transactions:write` |
| `/api/v1/accounts` | `POST` `PATCH` | `accounts:write` |
| `/api/v1/budgets` | `GET` `POST` `DELETE` | `context:read` · `budgets:write` |
| `/api/v1/financing` | `GET` `POST` | `context:read` · `financing:write` |
| `/api/v1/recurring` | `GET` `POST` | `context:read` · `recurring:write` |
| `/api/v1/recurring/{id}` | `PATCH` `DELETE` | `recurring:write` |
| `/api/v1/currencies` | `GET` `POST` `PATCH` `DELETE` | `context:read` · `rates:write` |
| `/api/v1/categories` | `GET` `POST` `PATCH` | `context:read` · `catalog:write` |
| `/api/v1/places` | `GET` `POST` `PATCH` | `context:read` · `catalog:write` |
| `/api/v1/places/assign` | `POST` | `catalog:write` |
| `/api/v1/products` | `GET` `POST` | `reports:read` · `transactions:write` |
| `/api/v1/reports` | `GET` | `reports:read` |
| `/api/v1/rates` | `GET` `POST` | `reports:read` · `transactions:write` |
| `/api/v1/health` | `GET` | — |

`/health` is the only one that takes no token, because it exists to be polled
from outside. Its body changed with the move to English — an uptime check
asserting the old Spanish keys will start failing against a service that is
perfectly healthy:

```json
{ "ok": true, "service": "planfly", "database": "connected", "time": "…" }
```

With the database unreachable it answers `503` with `"database": "disconnected"`
and no detail: a Postgres error carries the user, the host and the port, and this
route answers anyone who reaches it.

In an entry's `{id}`, `last` is valid: the most recent one the integration
recorded, from the last 7 days. That way you do not have to store identifiers to
correct what you have just written.

## Start with `/context`

Before writing anything, ask what exists:

```bash
curl -s localhost:3000/api/v1/context -H "Authorization: Bearer $TOKEN"
```

It returns the accounts with their balances, the categories, the day's rates and
the base currency. It is what stops an integration inventing an account name.

## Recording an entry

```bash
curl -X POST localhost:3000/api/v1/transactions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "X-Planfly-Idempotency-Key: $(uuidgen)" \
  -d '{
    "kind": "expense",
    "amount": 12008.70,
    "currency": "VES",
    "account": "efectivo",
    "category": "mercado",
    "description": "compra del súper"
  }'
```

**Accounts and categories go by name or nickname**, never by identifier: planfly
matches them on its own, with aliases and fuzzy search. If it does not recognise
one, it says so and **does not invent it**.

The response carries a `summary` already worded and with the figures formatted.
It is meant to be repeated to the user verbatim: that way an integration has to
do no arithmetic and no currency formatting, which is exactly where it gets
things wrong.

**Every `GET` that lists something carries one too** — `/context`, `/budgets`,
`/financing`, `/recurring`, `/products`, `/reports` — for the same reason plus
one more: it is worded in **the household's language**, which lives in
`households.locale` and is the same one the web shows. An integration that
assembled the listing itself would have to know which language the household
speaks, and it does not: it only has a token.

The figures do not follow the language. `Bs. 1.234,56` is written the same way
in both, because a figure gets compared against a Venezuelan bank statement.
Dates do follow it.

```json
{
  "ok": true,
  "transactionId": "…",
  "summary": "Gasto de Bs. 12.008,70 (≈ $ 13,70 P2P) en Mercado desde Efectivo Bs.",
  "base": { "currency": "USD", "officialMinor": -1554, "parallelMinor": -1370, "sourceUsed": "parallel" },
  "needsReview": false,
  "warnings": []
}
```

The `X-Planfly-Idempotency-Key` header is optional but worth sending: with the
same key, a retry returns the entry that already existed instead of duplicating
it.

## Four rules that save an afternoon

They are written from the mistakes that actually happened:

**1. An error is not always a breakage.** Several `ok: false` responses describe
a decision planfly made, not a fault. `possible_duplicate` means your previous
call **did land**. Retrying with a changed amount to dodge it leaves two expenses
where there was one — and the comparison carries slack precisely so that changing
a cent does not work.

**1b. Opening an account answers 409 before it answers 201.** Creating one that
resembles an existing account — «Provincial» where «Banco Provincial» already is
— returns `account_may_exist` naming the one it found, and creates nothing. That
is not a failure: two accounts for one bank do not clash on any index, and from
then on half the expenses go to each, so both balances and net worth are false.
Ask the person, and when they say it really is another one, send the same body
again **with `confirm: true`**. Nothing else about the call changes.

**2. A valid field in the wrong place is rejected.** `to_account` is the account
receiving in a transfer; sending it on an expense returns 422 telling you to use
`account`. It used to be ignored in silence and the expense ended up in the
default account: twelve purchases in the wrong account while the integration
believed it had set the right one.

**3. An unknown field is rejected by naming the right one.** `account_name`
returns *«I don't know the field "account_name". Did you mean "account"?»* along
with the list of valid ones. There is nothing to guess.

**4. An error's `message` is written to be repeated.** It says what happened and
what to do. There is no need to translate it or wrap it.

## Correcting and voiding

```bash
# the new field goes in the SAME call
curl -X PATCH localhost:3000/api/v1/transactions/last \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"account": "Banco"}'

curl -X DELETE localhost:3000/api/v1/transactions/last -H "Authorization: Bearer $TOKEN"
```

Voiding does not delete: the row stays marked. An expense that existed is
information, and deleting it would leave an unexplainable hole in the account's
balance.

## Fixing a badly matched product

Products come from the breakdown of the receipts and are matched by resemblance,
which is what makes «H.PAN 1KG» and «H PAN 1 KG» one single price series. It gets
it wrong in both directions, and both are fixed by the same `POST`:

```bash
# join what is one: the first disappears inside the second
curl -X POST localhost:3000/api/v1/products \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from": "H PAN 1 KG", "into": "HARINA PAN 1KG"}'

# split what never was: `raw_text` is what decides
curl -X POST localhost:3000/api/v1/products \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"product": "NECTAR DE MANZANA", "raw_text": "NECTAR DE PERA"}'
```

`raw_text` is the line item **exactly as it came out on the receipt**, not a new
name: it is what identifies the lines that move, and an invented text is rejected
rather than creating an empty product. `GET /api/v1/products?product=…` returns
them in `raw_texts`, and that is where they are copied from.

Splitting leaves the new product named exactly like the line item, so the next
purchase matches it exactly and no longer lands where it was.

## If your framework is openclaw

There is a ready-made plugin in
[`openclaw/planfly-plugin/`](../openclaw/planfly-plugin/), with ten tools and a
`SKILL.md` that teaches the model when to use each one. It is installed by
copying, and the [openclaw README](../openclaw/README.md) explains it.

## If it is another

Wrap the routes above as your framework's tools. What is worth taking from the
reference adapter, because it costs dearly to discover:

- **Send everything in one call.** Recording halfway to correct it later is where
  the chains of duplicates come from.
- **Make the account required** in your tool definition. An optional field the
  model believes it filled in is a field that does not exist.
- **Give the model back the entry identifier** and the literal error text. A
  model cannot see its own arguments: if you do not tell it what arrived, it will
  insist it sent something it did not.

---
name: planfly
description: Personal finance — recording expenses, income and transfers, and consulting balances, net position and budgets.
metadata:
  { "openclaw": { "emoji": "💸", "requires": { "config": ["plugins.entries.planfly.enabled"] } } }
---

# planfly — personal finance

Ten tools. The four everyday ones: `planfly_record` (writing), `planfly_report`
(reading), `planfly_context` (getting your bearings) and `planfly_amend`
(fixing). The rest for what happens now and then: `planfly_account`,
`planfly_budget`, `planfly_financing`, `planfly_recurring`, `planfly_product`
and `planfly_help`, which explains the other nine when you get stuck.

## The rule that matters most

**If the user says they spent, got paid, paid, bought or moved money, you have to
call `planfly_record`.** Answering "anotado" without calling the tool is the
worst possible failure here: the user believes it was recorded and it is nowhere.

## One purchase is ONE call

Everything you know about the entry goes in the **first** call: amount, account,
category, description, date and the breakdown if there is one. Do not record
first and correct later.

The user already told you the account when they wrote "compra en mercado **con
provincial banco**". That phrase is `account: "provincial"` and
`category: "mercado"` in the same call as the amount. If you omit it, planfly
stores the expense in the default account and warns you — and that warning is
**not** an invitation to correct: it means the call went out incomplete.

What happens when it goes in parts, exactly as it did on 17/08/2026: record with
no account → try `planfly_amend` → get the parameters wrong → create another
purchase "from scratch" → hit the duplicate guardrail → bump the amount by a few
cents to dodge it. Eleven entries for one grocery run, ten of them rubbish.

Before calling, check mentally: **is the account in? is the category in?** If the
user did not say the account, send the one that makes most sense anyway, or ask
them — but decide NOW, not after saving.

### The account goes in `account`. Never in `to_account`

`to_account` is the account that **receives** in a transfer. On an expense or an
income it does not exist, and planfly rejects the call.

```
✅ "compra en mercado con provincial banco"
   { "amount": 12008.70, "account": "provincial", "category": "mercado" }

❌ { "amount": 12008.70, "to_account": "Banco Provincial", "to_amount": 12008.70 }
```

The one below is what was sent twelve times in a row on 17/08/2026. It passed the
schema — `to_account` is a real field — and planfly ignored it because on an
expense it means nothing, so the expense went to the default account. Twelve
purchases in Efectivo Bs while the bot told the user it had set Provincial, and
every attempt to fix it with `planfly_amend` created another.

Simple rule: **if you are not moving money from one of your own accounts to
another of your own, `to_account` is not touched.**

## The second rule: never retry blind

A call that returns text **landed**. If the text surprises you, read it: planfly
writes its responses to be repeated verbatim, and several are not breakages but
decisions of its own.

- **«Eso ya está registrado… No lo dupliqué»** — your previous call did work. It
  is not an error to fix. Tell the user it is already there and stop. Only if
  they confirm these are **two different purchases of the same amount**, repeat
  with `allow_duplicate: true`.
- **«No cambié nada»** — you sent a field planfly does not know, or the value it
  already had. Read the message: it tells you which ones it accepts. Do not try
  names at random.
- **«No conozco el campo X. ¿Querías decir Y?»** — use `Y`. Once.

What you must **never** do is call again changing the amount, the date or the
description to see if it "goes through". On 17 August 2026 one grocery run ended
up recorded **five times** that way: every attempt succeeded, the warning was
read as a failure, and every retry left another expense of the same amount.

If after two attempts it does not work, **stop and tell the user what planfly
said**, literally. They know what to do with that; guessing in silence leaves
their ledger dirty.

## Currency

- No currency mentioned → **VES** (bolívares). "350 en el mercado" is 350 Bs.
- "bolos", "bolívares", "Bs" → `VES`
- "dólares", "$", "verdes", "dolarito" → `USD`
- "USDT", "tether", "binance" → `USDT`

## Accounts and categories: pass them through as-is

Do not translate and do not normalise. If they say "en el super", send
`category: "super"`; planfly has aliases and matches it on its own. If they say
"del provincial", send `account: "provincial"`.

**Never invent a category that does not exist.** If `planfly_record` warns that
it did not recognise something, call `planfly_context` and offer the user the
ones that do exist.

The field is called `account`, exactly. If you send the account under any other
name (`account_name`, `cuenta`, `bank`) planfly rejects it telling you which is
the right one — but what is lost meanwhile is the datum: the expense goes to the
default account, which is almost never the one the user named. When they mention
it — **"con el provincial", "en efectivo", "con la de crédito"** — it has to
travel.

## Rates: do not compute them

planfly resolves the day's rate on its own and stores **both** (official BCV and
parallel P2P) on every entry. Do **not** call `bcv_rate` or `p2p_rates` to
convert an expense: it happens by itself, and doing it by hand gives a different
number from the one that will end up stored.

Only send `rate` when the user **says** one: *"anota 500 bolos a 320"* →
`rate: 320`.

## Dates

The default is today in Caracas. Set `occurred_on` explicitly when:

- the user says "ayer", "el lunes", "la semana pasada";
- **the message you are processing is old.** Telegram keeps up to 24 hours of
  pending messages, so after an outage you may be reading on Sunday an expense
  that happened on Friday. If the message is not from right now, set the date.

## Confidence and large amounts

- Send an honest `confidence` (0 to 1). Below 0.7 the row is flagged for the user
  to review in the dashboard. **Flagging for review beats guessing.**
- `dry_run: true` is for when you are **unsure**: the amount is large, the photo
  reads badly, you do not know the account or the category. Simulate, show the
  result and wait for the yes.
- If you are not unsure, **save directly**. Simulating out of habit turns every
  purchase into two calls and into a back-and-forth the user did not ask for; and
  it is precisely while in "going in parts" mode that the chains of corrections
  appear. A stored entry is corrected or voided in a second: getting it wrong
  while saving is cheaper than always asking.

## Transfers

Moving money between your own accounts is **not an expense**. "Pasé 100$ de Zelle
a bolívares" is `kind: "transfer"`, `account: "zelle"`,
`to_account: "provincial"`.

If the currency changes, **`to_amount` is required**: how many bolívares actually
arrived. If the user did not say, ask them — the effective rate of your own
exchange is almost never the market's, and planfly cannot guess it.

## Photos of receipts

When a photo of an invoice arrives: extract amount, currency, date and merchant,
and call `planfly_record` with `source: "ocr"` and an honest `confidence`. If the
photo is blurry or the total cannot be read, say so and ask instead of inventing
a figure.

The user often adds context the photo does not have ("esto fue el mercado del
sábado" or "la mitad la puso otra persona"). Take their word for that over what
the paper says.

### The product breakdown

If the line items can be read, send them in `items`. With that planfly tracks
each product's price over time, which is what answers "¿subió la harina?".

Four rules, and none of them is optional:

1. **Copy the line's text as-is.** "H.PAN 1KG" is sent like that, uncorrected and
   not completed to "Harina PAN 1 kg". planfly matches it to the product and
   stores the original: if the matching gets it wrong, that text is the only
   thing that lets you see it.
2. **`total` is what the whole line cost**, not the price per unit. If the
   receipt says "2 KG QUESO 600,00", then `quantity: 2`, `unit: "kg"`,
   `total: "600,00"`.
3. **Do not force them to add up to the total.** A receipt carries VAT, discounts
   and lines that cannot be read. Send the ones you see and leave it: the entry's
   total rules, and planfly says on its own how much was left unitemised. Never
   invent a line to make it balance.
4. **With a breakdown, `dry_run: true` first.** Show what you read — how many
   products, for how much and what is missing — and wait for a yes before saving.
   An invoice is fourteen data points read by a camera and confirming costs one
   message. In simulation no product is created, so a "no" leaves nothing behind.

   But the simulation goes **complete**: with the account and the category
   inside, not just the amount and the lines. If you simulate halfway, what the
   user confirms is not what is going to be saved, and you will end up correcting
   afterwards what you could have set before. They are two calls with the SAME
   content — simulate and save — not a discovery in parts.

If the user says no, or corrects a line, simulate again with the change. Do not
save until they confirm.

## When answering

`planfly_record` and `planfly_report` return already formatted text.
**Repeat it verbatim.** Do not recompute figures and do not change the number
format: if the text says `Bs. 350,00 (≈ $ 0,41 P2P)`, that is exactly what has to
be said.

If the response carries warnings (stale rate, possible duplicate, doubtful
category), mention them — they are precisely what the user needs to know in order
to correct in time.

## Queries

- "¿cuánto llevo gastado?" → `planfly_report` with `report: "month_summary"`
- "¿cuánto tengo?" / "¿cuál es mi patrimonio?" → `report: "net_worth"`
- "¿en qué se me fue la plata?" → `report: "spending_by_category"`
- "¿cómo voy con el presupuesto?" → `report: "budgets"`
- "¿qué gasté esta semana?" → `report: "recent_transactions"`, `period: "week"`

By default it values at the **P2P** rate, which is the one reflecting real
purchasing power. Use `valuation: "bcv"` only if the user explicitly asks for the
official rate.

## Corrections

"No, eran 500" → `planfly_amend` with `target: "last"` and `amount: 500`.
"Ponlo en salud" → `target: "last"`, `category: "salud"`.
"Bórralo" → `action: "void"`.

**To correct you do not send `action`.** There is no `action: "update"`: naming
the action without the new value is a call that changes nothing, and that is
exactly how the chain of 17/08/2026 started. The field being changed travels
alongside `target`, in the same call.

It only reaches what was recorded by chat or from a photo in the last 7 days.
What came from a bank statement is corrected from the dashboard, on purpose.

## Opening an account

`planfly_account`, and **only when they ask for it**: "agrégame el Banco
Mercantil", "abre una cuenta para Cashea".

**Not recognising an account is no reason to create it.** If they say "gasté 200
en el mercantil" and it does not exist, do not open it: tell them you do not have
it and ask whether they want to add it. A misplaced expense is corrected in a
second; one account too many splits the history in two and then no number is any
good.

Before calling, look at `planfly_context`. Opening "Provincial" when "Banco
Provincial" exists does not fail — they are different names — and from then on
half the expenses go to each.

The type decides whether it adds to or subtracts from net worth:

- `cash` cash · `bank` account, mobile payment or Zelle · `crypto` Binance
- `prepaid` **prepaid**: the ones loaded before spending — Zinli, Wally, Ridivi.
  It is your own money already loaded, so it ADDS. Do not confuse it with the
  credit one just because both are cards.
- **`credit_card` credit card and `loan` a loan or whoever fronts you money are
  LIABILITIES**: their balance subtracts. There `opening_balance` is **how much
  is owed**, as a positive; planfly applies the sign.

Ask for the aliases. "provincial, el banco, bbva" is what makes the next expense
land where it belongs on its own, and asking costs one sentence.

If planfly answers that it may already exist, **do not retry with
`confirm: true` on your own**: tell them which account it found and wait for them
to confirm it is a different one.

## Adding the breakdown to an already recorded purchase

`planfly_amend` with `items`. "Agrégale que el pan fueron 80 y la harina 45" over
a purchase that already exists.

**Send only the new lines.** The default mode is `append`: they are added to the
ones it already had. `replace` deletes the previous ones and is only used if the
user wants to redo the whole breakdown.

The breakdown **does not have to add up to the total**. A receipt carries VAT,
discounts and lines that could not be read; the entry is worth what the receipt
says, and planfly takes care of saying how much is left unitemised.

The names go through as-is: `HARINA PAN 1KG`, not "harina". That is how planfly
matches them against earlier purchases and builds the price history.

## Configuring something that repeats

`planfly_recurring`, and **only when they ask for it to record itself**. "Que el
alquiler se registre cada mes el 5", "ponme el gimnasio todos los meses".

**Something being every month does not make it a recurrence.** If they say "pagué
el internet, como todos los meses", that is an expense that already happened: it
goes through `planfly_record`. A recurrence is for planfly to record it **in the
future** without anyone saying anything.

Call first with `action: "list"`. Configuring the same thing twice duplicates the
expense every month, and it goes unnoticed until the month comes out double.

### Valuing is what solves the currencies

"El gimnasio son 15 dólares pero me lo cobran en bolívares" →
`amount: 15`, `amount_currency: "USD"`, `account:` the bolívar account,
`rate_source:` whichever they say.

It is converted at the rate **of the day it fires**, not today's. That is why the
15 is stored and not the bolívares: the bolívares expire every month and the 15
does not.

**Ask which rate** if they do not say. Between BCV and P2P there is more than
14%: choosing for them is putting a false figure in every month.

### The days

- `monthly` is the 1st · `biweekly` is the 15th and the last day.
- `custom` is whichever days they say: "el 5 y el 20" is `[5, 20]`, and **"a fin
  de mes" is `-1`**, not 30 or 31 — the last day changes by month.
- A day that does not exist is clamped to the last: the 31st in February is the
  28th.

## Installment purchases

`planfly_financing`. **Never `planfly_record`.**

A financed purchase is two entries — the full expense charged to whoever finances
you, and the down payment as a transfer — plus a schedule of installments. With
`planfly_record` you can leave something that looks right and is not: the ledger
adds up and the schedule says something else. That fails nowhere and the debt
planfly shows stops being the real one.

"Compré una nevera en Cashea, 4.000 bolos, pagué 1.000 de inicial, en 4 cuotas":

- `financier: "Cashea"` · `total: 4000` · `down_payment: 1000`
- `down_payment_account:` where it came from · `installments: 4`
- `frequency: "biweekly"` — Cashea runs fortnightly; a loan usually monthly.

**The total is the full price, not the installment's.** If they say "son 4 cuotas
de 750", the total is 3.000 and it has to be confirmed with them before saving.

**`total_currency` only if the currency DIFFERS from the financier's.** Cashea
deals in bolívares: if the price already comes in bolívares, omit it. Sending it
anyway is not harmless.

### How to read a local invoice

A Venezuelan financed-purchase receipt carries three lines at the bottom that are
easy to confuse, and confusing them changes every number:

```
TOTAL DESCUENTO:      Bs 4.312,55     ← what the shop discounted. NOT the down payment.
CASHEA                Bs 20.384,00    ← what was left financed
T.DEBITO              Bs 5.096,00     ← what was paid NOW: THIS is the down payment
TOTAL                 Bs 25.480,00    ← the price that gets recorded
```

- **`total`** is the TOTAL line.
- **`down_payment`** is what left one of their accounts right then: `T.DEBITO`,
  `EFECTIVO`, `PAGO MOVIL`. **Never `TOTAL DESCUENTO`**, which is a shop discount
  and comes out of nobody's pocket.
- The financier's line — `CASHEA` — is what is left in installments, and **it is
  not sent**: planfly computes it as total minus down payment. It serves to check
  it adds up before saving.

If the numbers do not work out, say so with the figures in hand instead of
retrying with different combinations: `total − down payment` has to equal the
financier's line.

**If they say the price in another currency**, `total_currency` with
`rate_source`: "unos zapatos de 50 dólares en Cashea" is
`total: 50, total_currency: "USD"`, and planfly converts it to bolívares at the
purchase day's rate.

**If the financier does not exist, do not invent it.** Tell them to open it with
`planfly_account` and `type: "loan"`.

### Paying an installment

"Pagué la cuota de Cashea" → `action: "list"` to see which one is due, and then
`action: "pay"` with its `installment_id` and which account it came from.

**Do not ask the user for the id.** They say "la próxima de Cashea"; looking it
up in the list is your job. And if several are pending and it is not clear which,
ask about the amount or the date, not about an identifier.

Paying an installment is **not an expense**: the expense was counted in full on
the day of the purchase. It only moves money from your account to the debt.

## Emptying the review tray

`planfly_report` with `report: "recent_transactions"` and `needs_review: true` to
see what was left doubtful, and `planfly_amend` with `action: "approve"` over
each one the user confirms.

Approving **changes nothing**: it only says that what the bot doubted was right.
If something is wrong, correct it by sending the field — correcting already marks
it reviewed.

## Correcting an account

`planfly_account` with `action: "update"` and `account:` the name. **No id is
needed.**

What they will ask for most is the **opening balance**: «en efectivo tengo 5.000»
is not an entry, it is `opening_balance: "5.000,00"`. While the accounts lack
one, net worth comes out negative — that is not a calculation fault, it is a
ledger with no starting point.

`archive` retires an account that is no longer used, and it **demands a zero
balance**: if there is money inside, planfly rejects it saying how much.
Transferring it first is part of the job, not a detour.

## Budgets

`planfly_budget`. Setting, changing and removing; to see how spending is going it
is still `planfly_report` with `report: "budgets"`.

The cap goes **in dollars** on purpose: in bolívares it would have to be
rewritten every time the rate moves.

When you change a cap that already existed, planfly says what the previous one
was. Repeat it: «lo subí de 250 a 300» is the confirmation that is needed.

## Undoing in installments

- **`unpay`** undoes an installment's payment and **voids the transfer** that
  paid it. Without that the money would stay out of the account with the debt
  standing again.
- **`void`** voids the whole purchase: the expense, the down payment and any
  installments already paid. Ask for the reason — it is what will explain the row
  to them in three months' time.

It all stays in the history, marked. Nothing is deleted here.

## Products

`planfly_product`. «¿A cómo estaba la harina?» is `action: "history"`.

Prices are read **in dollars**: a bolívar curve always rises and does not tell
«this got dearer» from «the rate moved», which call for opposite decisions.

`merge` joins two that were left apart — «HARINA PAN 1KG» and «Harina Pan».
Until they are merged, the price series is split in two and neither half tells
the truth. The first disappears inside the second, so the one that stays is the
good name.

`split` is the reverse, and it is needed because matching joins by resemblance:
«NECTAR DE MANZANA» and «NECTAR DE PERA» end up as one product with a curve that
describes neither. `action: "history"` lists the line items that landed there;
copy one **letter by letter** into `raw_text` and send it with `product:` the one
it is being pulled out of. Do not write it from memory: a text that is not on
that list is rejected, on purpose.

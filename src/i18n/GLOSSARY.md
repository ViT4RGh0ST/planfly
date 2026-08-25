# Glossary: the keys whose Spanish agrees with a noun that is not written

JSON carries no comments, and several Spanish values are inflected for a noun
that never appears in the string. Whoever translates them cannot see it, and
getting the gender wrong reads as a typo rather than as a mistake.

| Key | Agrees with | Note |
|---|---|---|
| `domain.rowStatus.*` | **la fila** (the row) — feminine | «nueva», not «nuevo». It labels an import row. |
| `domain.rule.field.*` | — | It carries the article inside («la descripción»), because it is only ever used inside `ui.rules.sentence`. Do not reuse it as a standalone label. |
| `domain.unit.perUnit.*` | — | It carries the preposition inside («el kilo» / «per kilo»), because the sentence around it differs by language. `bare` is the abbreviated form for a quantity: «3 u», «3 ea». |
| `domain.budgetPeriod.*` | — | It reads as the tail of a sentence: «Mercado: $250 al mes» / «Groceries: $250 a month». |

The rule the two share: **an adjective is never a loose value.** If a word has to
agree with something, the whole sentence is the message and the word goes inside
it, with an ICU `select` if it varies. There is a check in `catalog-guard` that
fails if a `t(...)` result is passed through `.replace(` — trimming a translation
with a string operation is always a bug waiting for a language.

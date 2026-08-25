import { createClient, toolResult, toolError } from "./client.js";

/**
 * The writing tool.
 *
 * Note what it does NOT have in the schema: `household_id`, `user_id` or any
 * internal account or category id. It accepts **names** and the server resolves
 * them fuzzily. That makes it impossible for the model to invent a foreign key
 * or write into the wrong household, and it saves a prior call to list
 * categories before every expense.
 */
export function createRecordTool(api) {
  const client = createClient(api);
  const config = api.pluginConfig ?? {};
  const defaultCurrency = config.defaultCurrency ?? "VES";
  const confirmOver = Number(config.confirmOver) > 0 ? Number(config.confirmOver) : 100;

  return {
    name: "planfly_record",
    label: "Record entry",
    description:
      "Records an expense, an income or a transfer between accounts in planfly. " +
      "Use it ALWAYS when the user says they spent, got paid, paid, bought or moved money — " +
      "answering 'anotado' is not enough, this tool has to be called. " +
      `If no currency is mentioned, ${defaultCurrency} is assumed. ` +
      "Accounts and categories are passed by name; planfly matches them on its own. " +
      "SEND EVERYTHING IN THIS CALL: amount, account, category, description and the breakdown if there is one. " +
      "'compra en mercado con provincial banco' carries account:'provincial' and category:'mercado' " +
      "alongside the amount — do not record it halfway to correct it later with planfly_amend, which is " +
      "where the chains of duplicate entries come from. " +
      `For large amounts (over ${confirmOver} in base currency) it is worth calling first with dry_run=true and confirming with the user.`,
    parameters: {
      type: "object",
      // `account` is required on purpose. It used to be optional, and on
      // 17/08/2026 the model sent it twelve times in a row in `to_account` — a
      // transfer's destination — while the expense went to the default account.
      // An optional field the model believes it filled in is a field that does
      // not exist: making it required is what makes it genuinely choose, and
      // choosing wrong shows and gets corrected, while not choosing does not show.
      required: ["amount", "account"],
      properties: {
        kind: {
          type: "string",
          enum: ["expense", "income", "transfer"],
          description: "expense, income or transfer. Defaults to expense.",
        },
        amount: {
          type: "number",
          description:
            "In major units, exactly as the user said it: 350.5 is three hundred and fifty bolívares fifty, not cents.",
        },
        currency: {
          type: "string",
          enum: ["VES", "USD", "USDT", "EUR"],
          description: `The amount's currency. Defaults to ${defaultCurrency}. "bolos", "bolívares", "Bs" = VES. "dólares", "$", "verdes" = USD.`,
        },
        account: {
          type: "string",
          description:
            "REQUIRED. The entry's account: where the expense LEAVES from, or where the income ARRIVES. " +
            "Name or nickname: 'efectivo', 'provincial', 'zelle', 'binance'. " +
            "\"compra en mercado con provincial banco\" → account: 'provincial'. " +
            "THIS is the account field on an expense or an income, NOT to_account. " +
            "If the user named none, send the one that makes most sense or ask them; " +
            "do not omit it hoping planfly will guess.",
        },
        to_account: {
          type: "string",
          description:
            "ONLY with kind='transfer': the account that RECEIVES the money. " +
            "On an expense or an income it does not exist and the call is rejected — " +
            "an expense's account goes in 'account'.",
        },
        to_amount: {
          type: "number",
          description:
            "ONLY with kind='transfer' across different currencies: how much actually arrived in the destination account. " +
            "Never on an expense or an income.",
        },
        category: {
          type: "string",
          description:
            "Category in the user's own words: 'mercado', 'comida callejera', 'salud', 'veterinario', 'gasolina'. Do NOT invent it and do NOT translate it: pass it through exactly as they said it. Ignored on transfers.",
        },
        description: { type: "string", description: "A short phrase saying what it was." },
        payee: { type: "string", description: "Merchant or person, if mentioned." },
        occurred_on: {
          type: "string",
          description:
            "YYYY-MM-DD. Defaults to today in the household's timezone. Set it explicitly if the user says 'ayer', 'el lunes' or if the message you are processing is old.",
        },
        rate: {
          type: "number",
          description:
            "Only if the user SAYS a rate ('a 320'). Never invent it and never compute it: planfly resolves the day's on its own.",
        },
        notes: { type: "string" },
        confidence: {
          type: "number",
          description:
            "How sure you are that you understood, from 0 to 1. Be honest: below 0.7 the row is flagged for the user to review, which is better than a wrong datum.",
        },
        source: {
          type: "string",
          enum: ["telegram", "ocr"],
          description: "Use 'ocr' when the data came from a photo of a receipt.",
        },
        payment_method: {
          type: "string",
          enum: ["cash", "card", "mobile_payment", "transfer", "zelle", "crypto", "other"],
          description:
            "Which rail it was paid by, if said. 'pago móvil' = mobile_payment, 'punto' or 'tarjeta' = card, 'transferencia' = transfer, 'efectivo' = cash. It is NOT the account: the first three all come out of the same bank account.",
        },
        items: {
          type: "array",
          description:
            "The breakdown of an INVOICE read from a photo: one entry per product line. They do not have to add up to the total — a receipt carries VAT, discounts and unreadable lines — the total rules. Omit it if there is no invoice or the lines cannot be read.",
          items: {
            type: "object",
            required: ["description", "total"],
            properties: {
              description: {
                type: "string",
                description:
                  "The line's text EXACTLY as it appears on the receipt, uncorrected and uncompleted: 'HARINA PAN 1KG'. planfly matches it to the product and stores the original.",
              },
              quantity: { type: "number", description: "How many units. Defaults to 1." },
              unit: {
                type: "string",
                description:
                  "The receipt's unit: kg, g, l, ml, und. It serves to compare prices across purchases; if it does not appear, omit it.",
              },
              total: {
                type: "string",
                description:
                  "What THAT whole line cost, not the unit price. In the receipt's format: '1.234,56'.",
              },
            },
          },
        },
        dry_run: {
          type: "boolean",
          description:
            "Resolves and computes without saving. Use it when you are UNSURE: an invoice with a " +
            "breakdown, a large amount, or you are not clear on the account or the category. Show " +
            "what you read and wait for a yes. If you are not unsure, save directly — simulating out " +
            "of habit turns every purchase into two calls. The simulation goes complete, with account " +
            "and category: what the user confirms has to be exactly what gets saved. In simulation no " +
            "product is created.",
        },
        allow_duplicate: {
          type: "boolean",
          description:
            "ONLY after planfly has answered 'that is already recorded', and ONLY if the user " +
            "confirms these are two different purchases of the same amount. " +
            "That warning is not a fault: it means your previous call DID land. Do not call again " +
            "changing the amount or the description to dodge it — that would leave two expenses " +
            "where there was one. If what you want is to fix the one that already exists, use planfly_amend.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const body = {
          kind: params.kind ?? "expense",
          amount: params.amount,
          currency: (params.currency ?? defaultCurrency).toUpperCase(),
          account: params.account,
          to_account: params.to_account,
          to_amount: params.to_amount,
          category: params.category,
          description: params.description,
          payee: params.payee,
          occurred_on: params.occurred_on,
          notes: params.notes,
          rate: params.rate,
          rate_source: params.rate != null ? "manual" : undefined,
          confidence: params.confidence,
          payment_method: params.payment_method,
          items: Array.isArray(params.items) && params.items.length ? params.items : undefined,
          source: params.source === "ocr" ? "ocr" : "telegram",
          agent: "openclaw",
          dry_run: params.dry_run === true,
          allow_duplicate: params.allow_duplicate === true ? true : undefined,
        };

        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        const result = await client.post(
          "/api/v1/transactions",
          body,
          client.newIdempotencyKey(),
        );

        // The summary comes already formatted from the server: that way a cheap
        // model has to do no arithmetic and reformat no figures, which is exactly
        // where they go wrong.
        //
        // The id goes on the end because `details` does not reach the model: only
        // this text does. Without it, all it had to correct with was
        // target='last', and when it doubted whether its call had landed it had
        // no way to check — that is how the five purchases of 17/08/2026 were born.
        const id = result.transactionId ? ` · id ${result.transactionId}` : "";
        return toolResult(result.summary + id, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

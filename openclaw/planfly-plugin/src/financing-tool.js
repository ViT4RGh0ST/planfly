import { createClient, toolResult, toolError } from "./client.js";

/**
 * Installment purchases.
 *
 * This tool exists above all so the model does NOT improvise with
 * `planfly_record`. A financed purchase is two entries and a schedule; with the
 * plain recording tool you can charge the expense to the financier, or record an
 * installment's transfer, and in both cases the ledger looks reasonable while
 * the schedule says something else.
 *
 * Half an installment purchase is worse than none: it fails nowhere, and the
 * debt planfly shows stops being the one you have.
 */
export function createFinancingTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_financing",
    label: "Installment purchases",
    description:
      "Records a financed purchase, pays an installment, or consults what is owed and what is due. " +
      "Use it ALWAYS when the purchase is in installments — Cashea, on credit from a shop, a card " +
      "plan, a loan — and also when they say they paid an installment. " +
      "NEVER use planfly_record for this: an installment purchase is two entries and a schedule, " +
      "and recording it by hand leaves the debt wrong forever. " +
      "With action='list' you see the plans and their installments with ids, which is what you need to pay one.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["purchase", "pay", "unpay", "void", "list"],
          description:
            "purchase = buy in installments · pay = pay an installment · unpay = undo a payment · " +
            "void = void the whole purchase · list = what is owed. Defaults to purchase. " +
            "unpay also voids the transfer that paid the installment; void voids the purchase, the " +
            "down payment and any installments already paid, and it all stays in the history, marked.",
        },

        financier: {
          type: "string",
          description:
            "Who finances it: 'Cashea', 'Kari', the shop. It is a liability account in planfly. " +
            "If it does not exist, do NOT invent it: tell the user to open it with planfly_account (type='loan').",
        },
        total: {
          type: "number",
          description: "The FULL price of the purchase, not the installment's, in major units.",
        },
        total_currency: {
          type: "string",
          description:
            "The currency the user says the price in, when it is NOT the financier's. " +
            "'Unos zapatos de 50 dólares en Cashea' → total 50, total_currency USD; Cashea deals in " +
            "bolívares and planfly converts at the purchase day's rate. Omit it if they already said " +
            "it in the financier's currency." +
            " The ones that exist come back in \`currencies\` from planfly_context; this tool carries no list of its own. Never substitute one the user did not ask for.",
        },
        rate_source: {
          type: "string",
          enum: ["bcv", "p2p"],
          description: "Which rate to convert with when there is a total_currency. Ask if they do not say.",
        },
        down_payment: {
          type: "number",
          description: "The down payment, if they paid one. In major units. Zero or absent if there was none.",
        },
        down_payment_account: {
          type: "string",
          description: "Which account the down payment left from. Required if there is one.",
        },
        installments: {
          type: "number",
          description: "How many installments the rest is split into. Cashea usually runs 3 or 4.",
        },
        frequency: {
          type: "string",
          enum: ["biweekly", "monthly"],
          description: "biweekly = every 15 days, which is Cashea's. monthly = every month. Defaults to biweekly.",
        },
        first_due_on: {
          type: "string",
          description: "YYYY-MM-DD of the first installment. Defaults to one period after the purchase.",
        },
        category: { type: "string", description: "In the user's own words." },
        description: { type: "string", description: "What they bought." },
        occurred_on: { type: "string", description: "YYYY-MM-DD of the purchase. Defaults to today." },

        installment_id: {
          type: "string",
          description:
            "Only with action='pay': the installment's id, which comes from action='list'. " +
            "Do NOT ask the user for it — they say 'la próxima de Cashea' and you look up which it is.",
        },
        from_account: {
          type: "string",
          description: "Only with action='pay': which account the payment leaves from.",
        },
        paid_on: { type: "string", description: "Only with action='pay'. Defaults to today." },
        plan_id: {
          type: "string",
          description: "Only with action='void': which purchase is voided. Comes from action='list'.",
        },
        reason: {
          type: "string",
          description:
            "With action='void': why it is voided, in the user's own words. It is what will explain " +
            "the row to them in three months' time.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const action = params.action ?? "purchase";

        if (action === "list") {
          const result = await client.get("/api/v1/financing");
          return toolResult(result.summary, result);
        }

        if (action === "unpay") {
          const result = await client.post("/api/v1/financing", {
            installment_id: params.installment_id,
            undo: true,
          });
          return toolResult(result.summary, result);
        }

        if (action === "void") {
          const result = await client.post("/api/v1/financing", {
            plan_id: params.plan_id,
            reason: params.reason,
          });
          return toolResult(result.summary, result);
        }

        if (action === "pay") {
          const result = await client.post("/api/v1/financing", {
            installment_id: params.installment_id,
            from_account: params.from_account,
            paid_on: params.paid_on,
          });
          return toolResult(result.summary, result);
        }

        const body = {
          financier: params.financier,
          total: params.total,
          total_currency: params.total_currency,
          rate_source: params.rate_source,
          down_payment: params.down_payment,
          down_payment_account: params.down_payment_account,
          installments: params.installments,
          frequency: params.frequency,
          first_due_on: params.first_due_on,
          category: params.category,
          description: params.description,
          occurred_on: params.occurred_on,
        };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        const result = await client.post("/api/v1/financing", body);
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

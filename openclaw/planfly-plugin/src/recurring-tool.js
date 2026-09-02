import { createClient, toolResult, toolError } from "./client.js";

/**
 * Configuring what repeats.
 *
 * Separate from `planfly_record` for the same reason as creating accounts:
 * recording an expense happens fifty times a month and configuring a recurrence
 * a few times a year. Joining them would invite the model to create a rule
 * whenever someone mentions that something «es todos los meses», which is not
 * the same as asking for it to be recorded automatically.
 *
 * It fires nothing on creation: it leaves the rule written with its next date,
 * and planfly's heartbeat runs it when its turn comes.
 */
export function createRecurringTool(api) {
  const client = createClient(api);
  const config = api.pluginConfig ?? {};
  const defaultCurrency = config.defaultCurrency ?? "VES";

  return {
    name: "planfly_recurring",
    label: "Recurrences",
    description:
      "Configures or consults operations that repeat on their own: the rent, the internet, a " +
      "subscription, the fortnightly pay coming in. Use it when the user asks for something to be " +
      "recorded automatically every month or every fortnight. " +
      "Do NOT use it to record an expense that already happened — that is planfly_record, even if " +
      "the user says they pay it every month. " +
      "Consult with action='list' before creating, so as not to configure the same thing twice — and to " +
      "get the id that pause, resume and remove need. " +
      "A badly set rule records on its own every month: pausing it is more urgent than fixing it.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "pause", "resume", "remove"],
          description:
            "Defaults to create. pause/resume/remove need `id`, which comes from action='list'. " +
            "pause stops it without deleting it; remove deletes it, and what it already recorded stays.",
        },
        id: {
          type: "string",
          description: "The rule's id, from action='list'. Required for pause, resume and remove.",
        },
        name: {
          type: "string",
          description: "What the user calls it: 'Alquiler', 'Netflix', 'Gimnasio'.",
        },
        cadence: {
          type: "string",
          enum: ["monthly", "biweekly", "custom"],
          description:
            "monthly = the 1st of every month · biweekly = the 15th and the last day · " +
            "custom = whichever days the user says, in days_of_month.",
        },
        days_of_month: {
          type: "array",
          items: { type: "number" },
          description:
            "Only with cadence='custom': which days of the month. Use -1 for 'the last day'. " +
            "'El 5 y el 20' is [5, 20]; 'el 5 y a fin de mes' is [5, -1]. " +
            "A day that does not exist in a month is clamped to the last: the 31st in February is the 28th.",
        },
        kind: {
          type: "string",
          enum: ["expense", "income", "transfer"],
          description: "Defaults to expense.",
        },
        amount: {
          type: "number",
          description: "In major units, exactly as they said it: 15 is fifteen, not fifteen cents.",
        },
        amount_currency: {
          type: "string",
          description:
            "The currency the user THINKS the amount in, when it is NOT the account's. " +
            "'El gimnasio son 15 dólares y me lo cobran en bolívares' → amount 15, " +
            "amount_currency USD, account the bolívar account. " +
            "It is converted at the rate of the day it fires, not today's: that is why the 15 has " +
            "to be stored and not the bolívares, which change every month. Omit it if the amount is " +
            "already in the account's currency." +
            " The ones that exist come back in \`currencies\` from planfly_context; this tool carries no list of its own. Never substitute one the user did not ask for.",
        },
        rate_source: {
          type: "string",
          enum: ["official", "parallel"],
          description:
            "Which rate to convert with when there is an amount_currency. Ask the user if they do " +
            "not say: between BCV and P2P there is more than 14% and it is not a detail.",
        },
        account: {
          type: "string",
          description: `Which account it leaves from (or arrives at). By name or nickname. Default currency ${defaultCurrency}.`,
        },
        to_account: { type: "string", description: "Only for transfer: which account it arrives at." },
        category: {
          type: "string",
          description: "In the user's own words. Ignored on transfers.",
        },
        start_on: {
          type: "string",
          description:
            "YYYY-MM-DD. From when it counts; the first time will be the next chosen day on or " +
            "after that date. Defaults to today.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const action = params.action ?? "create";
        if (action === "list") {
          const result = await client.get("/api/v1/recurring");
          return toolResult(result.summary, result);
        }

        if (action === "pause" || action === "resume") {
          const result = await client.patch(`/api/v1/recurring/${encodeURIComponent(params.id)}`, {
            active: action === "resume",
          });
          return toolResult(result.summary, result);
        }

        if (action === "remove") {
          const result = await client.del(`/api/v1/recurring/${encodeURIComponent(params.id)}`);
          return toolResult(result.summary, result);
        }

        const body = {
          name: params.name,
          cadence: params.cadence ?? "monthly",
          days_of_month: params.days_of_month,
          kind: params.kind ?? "expense",
          amount: params.amount,
          amount_currency: params.amount_currency,
          rate_source: params.rate_source,
          account: params.account,
          to_account: params.to_account,
          category: params.category,
          start_on: params.start_on,
        };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        const result = await client.post("/api/v1/recurring", body);
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

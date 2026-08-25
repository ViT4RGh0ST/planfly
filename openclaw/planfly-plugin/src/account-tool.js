import { createClient, toolResult, toolError } from "./client.js";

/**
 * Creating accounts.
 *
 * Deliberately separate from `planfly_record`. Recording an expense is routine
 * and happens fifty times a month; opening an account happens six times in a
 * lifetime and changes the shape of the ledger. Mixing them would invite the
 * model to create an account whenever it does not recognise a name, which is
 * exactly what must not happen: faced with «gasté 200 en el mercantil» the right
 * move is to ask, not to open «Mercantil».
 *
 * The server defends itself — if the name already lands on an existing account
 * it answers 409 saying which — but the error is turned here into a sentence the
 * agent can repeat to the user, instead of a code.
 */
export function createAccountTool(api) {
  const client = createClient(api);
  const config = api.pluginConfig ?? {};
  const defaultCurrency = config.defaultCurrency ?? "VES";

  return {
    name: "planfly_account",
    label: "Accounts",
    description:
      "Opens, corrects, archives or unarchives an account: another bank, a card, a wallet, a loan or whoever fronts you money. " +
      "Use it ONLY when the user explicitly asks to create, correct or retire an account. " +
      "To correct or archive, it is identified by NAME, not by id. " +
      "Correcting the OPENING BALANCE is the most useful thing here: while the accounts lack one, net worth comes out negative. " +
      "If they mention an account you do not recognise while recording an expense, do NOT create it: ask whether they want to open it. " +
      "Before calling, look at the accounts that already exist with planfly_context — opening 'Provincial' when 'Banco Provincial' exists splits the history in two.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "archive", "unarchive"],
          description: "Defaults to create. update/archive/unarchive need `account`.",
        },
        account: {
          type: "string",
          description:
            "Which account, by name or nickname: 'efectivo bs', 'provincial'. " +
            "Required for update, archive and unarchive. It is unused when creating: there you send `name`.",
        },
        name: {
          type: "string",
          description:
            "What the user is going to call it: 'Banco Mercantil', 'Tarjeta Visa', 'Cashea'. Exactly as they said it. " +
            "When correcting, only if they want to rename it.",
        },
        type: {
          type: "string",
          enum: [
            "cash",
            "bank",
            "prepaid",
            "crypto",
            "investment",
            "credit_card",
            "loan",
            "other",
          ],
          description:
            "cash = physical cash · bank = bank account, mobile payment or Zelle · " +
            "prepaid = prepaid card or wallet, the kind you load before spending (Zinli, Wally, Ridivi) · " +
            "crypto = Binance or similar · credit_card = a CREDIT card · " +
            "loan = a loan or whoever fronts you money in installments (Cashea) · investment = investment · other = the rest. " +
            "Watch prepaid against credit_card: a prepaid card is your own money already loaded and it ADDS; " +
            "a credit one is debt and it SUBTRACTS.",
        },
        currency: {
          type: "string",
          enum: ["VES", "USD", "USDT", "EUR"],
          description: `Which currency the account is in. Defaults to ${defaultCurrency}.`,
        },
        opening_balance: {
          type: "string",
          description:
            "What it starts with, in major units exactly as they said it: '1.500,50'. " +
            "On a card or a loan it is HOW MUCH IS OWED, as a positive; planfly applies the sign. " +
            "When correcting it is usually what is needed: 'en efectivo tengo 5.000' means " +
            "opening_balance 5000, not an entry.",
        },
        institution: {
          type: "string",
          description: "The bank or company behind it, if mentioned: 'Provincial', 'Binance'.",
        },
        aliases: {
          type: "string",
          description:
            "Other names the user is going to call it by, comma separated: 'provincial, el banco, bbva'. " +
            "They are the hints it later finds itself by when recording an expense, so they are worth setting.",
        },
        confirm: {
          type: "boolean",
          description:
            "Only after asking the user. If planfly warns the account may already exist, do not insist on your own: " +
            "tell them which one it found and wait for them to say it is a different one.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const action = params.action ?? "create";

        if (action !== "create") {
          const patch = {
            account: params.account,
            action,
            name: params.name,
            type: params.type,
            currency: params.currency,
            opening_balance: params.opening_balance,
            institution: params.institution,
            aliases: params.aliases,
          };
          for (const key of Object.keys(patch)) {
            if (patch[key] === undefined) delete patch[key];
          }
          const result = await client.patch("/api/v1/accounts", patch);
          return toolResult(result.summary, result);
        }

        const body = {
          name: params.name,
          type: params.type,
          currency: params.currency ?? defaultCurrency,
          opening_balance: params.opening_balance,
          institution: params.institution,
          aliases: params.aliases,
          confirm: params.confirm === true ? true : undefined,
        };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        const result = await client.post("/api/v1/accounts", body);
        return toolResult(result.summary, result);
      } catch (err) {
        // The 409 is not a fault: it is the server saying it may already exist.
        // It is handed back to the agent as a question, not as an error.
        if (err?.status === 409 && err.data?.existing) {
          return toolResult(
            `${err.message} Ask the user whether they meant "${err.data.existing.name}" before insisting.`,
            { ok: false, error: "account_may_exist", existing: err.data.existing },
          );
        }
        return toolError(err);
      }
    },
  };
}

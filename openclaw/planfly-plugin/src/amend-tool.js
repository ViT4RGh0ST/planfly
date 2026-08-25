import { createClient, toolResult, toolError } from "./client.js";

export function createAmendTool(api) {
  const client = createClient(api);

  return {
    name: "planfly_amend",
    label: "Correct entry",
    description:
      "Corrects or voids an entry recorded recently. " +
      "The field being changed goes IN THIS SAME CALL, alongside target: " +
      '{"target": "last", "account": "Banco Provincial"} changes the account, ' +
      '{"target": "last", "amount": 500} changes the amount. ' +
      "A call with only target (and action) corrects nothing: it does not say what to set. " +
      "Use it for 'no, eran 500 no 350', " +
      "'ponlo en salud', 'bórralo', 'eso fue ayer'. It also serves to add the product breakdown " +
      "to an already recorded purchase: 'agrégale que el pan fue 80'. With target='last' it acts on the last " +
      "entry recorded through the chat. It only reaches what was recorded via Telegram or from a photo " +
      "in the last 7 days: it cannot touch what came from a bank statement.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "'last' for the most recent one, or the id planfly_record returned. Defaults to 'last'.",
        },
        /*
         * "update" is no longer on the list, and that is not an oversight.
         *
         * With `update` available, the model sent {action:"update", target} and
         * left it there: the named action felt like a complete call to it, and
         * the new value stayed in its prose. It happened twelve times in a row on
         * 17/08/2026, and it concluded the tool was broken.
         *
         * Without that value, correcting is not "named": it is done by sending
         * the field. The only things named are the two that are NOT a field —
         * voiding and approving.
         */
        action: {
          type: "string",
          enum: ["void", "approve"],
          description:
            "ONLY for voiding ('void') or for taking it out of the review tray ('approve'). " +
            "To CORRECT you do not send action: you send the new field. " +
            "Changing the account is {target, account: 'Banco Provincial'} — nothing else.",
        },
        account: {
          type: "string",
          description:
            "The right account, when it ended up in the wrong one. " +
            "Complete example: {\"target\": \"last\", \"account\": \"Banco Provincial\"}.",
        },
        amount: { type: "number", description: "New amount, in major units." },
        category: { type: "string", description: "New category, in the user's own words." },
        description: { type: "string" },
        occurred_on: { type: "string", description: "YYYY-MM-DD." },
        rate: { type: "number", description: "Rate to set by hand." },
        items: {
          type: "array",
          description:
            "Invoice lines added to the purchase: what was bought and what each thing cost. " +
            "Send ONLY the new ones, do not repeat the ones it already had. They do not have to add up to the total: " +
            "a receipt carries VAT, discounts and line items that were not read.",
          items: {
            type: "object",
            required: ["description", "total"],
            properties: {
              description: {
                type: "string",
                description:
                  "The product exactly as the user said it or as it appears on the receipt: 'HARINA PAN 1KG'. " +
                  "Do not translate or normalise it: that is how planfly matches it against earlier purchases.",
              },
              quantity: { type: "number", description: "How many units. Defaults to 1." },
              unit: {
                type: "string",
                description: "kg, g, l, ml, unit… Whatever the receipt says.",
              },
              total: {
                type: "number",
                description:
                  "What THAT whole line cost, not the unit price, in the entry's currency.",
              },
            },
          },
        },
        items_mode: {
          type: "string",
          enum: ["append", "replace"],
          description:
            "append (the default) adds to the lines it already had. Use replace ONLY if the user " +
            "wants to redo the whole breakdown from scratch: it deletes the existing ones.",
        },
      },
    },
    async execute(_id, params) {
      try {
        const target = encodeURIComponent(params.target ?? "last");

        if (params.action === "approve") {
          const result = await client.patch(`/api/v1/transactions/${target}`, { approve: true });
          return toolResult(result.summary, result);
        }

        if (params.action === "void") {
          const result = await client.del(`/api/v1/transactions/${target}`);
          return toolResult(result.summary, result);
        }

        const body = {
          amount: params.amount,
          category: params.category,
          account: params.account,
          description: params.description,
          occurred_on: params.occurred_on,
          rate: params.rate,
          items: Array.isArray(params.items) && params.items.length ? params.items : undefined,
          // It only travels if there are lines: sending it alone would mean
          // nothing, and `replace` with `items` absent does not delete — that is
          // what `items: []` does — but better not to leave the pair half done.
          items_mode:
            Array.isArray(params.items) && params.items.length
              ? (params.items_mode ?? "append")
              : undefined,
        };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        if (Object.keys(body).length === 0) {
          // The list has to be complete. When it omitted `items`, an agent
          // trying to add the breakdown read four fields that were not its own,
          // concluded the tool was broken and created a duplicate purchase with
          // the amount changed to dodge it. An error that does not name what it
          // accepts does not say "you missed something", it says "this is useless".
          /*
           * And telling it what DID arrive, not only what I accept.
           *
           * On 17/08/2026, with bare `target` and `action`, the model read this
           * error four times in a row and concluded the tool was broken — "it is
           * as if it were not reading the parameters I send it" — because it
           * believed it had sent the account. Enumerating the keys received is
           * the only thing that shows it the difference between what it thinks
           * it sends and what arrives.
           */
          const arrived = Object.keys(params ?? {});
          return toolResult(
            `All I got was: ${arrived.length ? arrived.join(", ") : "nothing"}. ` +
              "'target' says WHICH entry and 'action' WHAT to do, but neither of them is the " +
              "new value, so I do not know what to change. The field goes in THIS SAME call, " +
              "alongside 'target' — it is not a two-step call. " +
              "I can change: amount, category, account, description, " +
              "occurred_on, rate. And I can add the purchase breakdown with items, which goes alone: " +
              'items: [{ description: "HARINA PAN 1KG", total: 80 }]. ' +
              "Do not create a new entry to dodge this.",
            {
              ok: false,
              error: "no_changes",
              received: arrived,
              accepts: [
                "amount",
                "category",
                "account",
                "description",
                "occurred_on",
                "rate",
                "items",
              ],
            },
          );
        }

        const result = await client.patch(`/api/v1/transactions/${target}`, body);
        return toolResult(result.summary, result);
      } catch (err) {
        return toolError(err);
      }
    },
  };
}

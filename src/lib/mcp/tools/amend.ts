import { z } from "zod";

import { defineTool } from "@/lib/mcp/registry";
import { confirmMcpOperation, previewMcpOperation } from "@/lib/mcp/transactions";
import { AGENT_EDITABLE_DAYS } from "@/lib/services/update-transaction";
import { updateTransactionSchema } from "@/lib/validation";

/**
 * The only tool that can change a figure that is already in the ledger.
 *
 * Which is why it is the one that most needs the gate, and why the gate is not
 * written here: it stages with `previewMcpOperation` under `amend_transaction`
 * and commits with `confirmMcpOperation`. The version this replaces inserted
 * the confirmation row by hand and then confirmed through
 * `confirmMcpTransaction`, which looks the operation up by the name it was
 * staged under — so the confirmation either could not be found or would have
 * run a different operation's `run` over an amendment's payload. Nothing about
 * that failed to compile.
 *
 * What the person approves is described in `operations/amend-transaction.ts`:
 * the entry as it stands right now, and the exact instruction that will be
 * applied to it.
 */

/**
 * The correction fields, named exactly as `updateTransactionSchema` declares
 * them, because that is what travels to `PATCH /api/v1/transactions/{id}` and
 * the route runs `rejectUnknownKeys`.
 *
 * `to_account`, `to_amount` and the two `*_rate_source` keys are deliberately
 * absent. They are valid keys of that same schema, for a transfer's destination
 * leg, and a valid key in the wrong context is the failure that does not fail:
 * it validates, it returns ok, and the figure lands on the other side of the
 * ledger. A transfer's legs are corrected from the dashboard.
 */
const CORRECTION_FIELDS = [
  "amount",
  "account",
  "category",
  "description",
  "occurred_on",
  "rate",
] as const;

const amendInputSchema = z.object({
  /*
   * No `.default('last')`, deliberately, though the default is still what it
   * gets: a default is applied by `.parse`, so afterwards the tool cannot tell
   * a target the model SENT from one zod invented. That difference only matters
   * on the confirmation path, and it matters there: a confirmation carrying the
   * id of another entry has to be refused rather than confirming the previewed
   * one while the model reports the other. The default lives in `run`.
   */
  target: z
    .string()
    .min(1)
    .optional()
    .describe("'last' for the most recent one, or the id planfly_record returned. Defaults to 'last'."),
  /*
   * "update" is not on this list, and that is not an oversight — the bot tool
   * carries the same enum for the same reason.
   *
   * With `update` available, the model sent {action:"update", target} and left
   * it there: the named action felt like a complete call to it, and the new
   * value stayed in its prose. Without that value, correcting is not "named":
   * it is done by sending the field. The only things named are the two that are
   * NOT a field.
   */
  action: z
    .enum(["void", "approve"])
    .optional()
    .describe(
      "ONLY for voiding ('void') or for taking it out of the review tray ('approve'). " +
        "To CORRECT you do not send action: you send the new field. " +
        "Changing the account is {target, account: 'Banco Provincial'} — nothing else. " +
        "Neither one takes correction fields alongside it.",
    ),
  reason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Required with action='void', and only there. Why the entry is being voided, in the person's " +
        "own words: 'it was charged twice', 'the purchase was cancelled'. It is kept with the record.",
    ),
  account: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The right account, when it ended up in the wrong one. " +
        'Complete example: {"target": "last", "account": "Banco Provincial"}.',
    ),
  amount: z.union([z.string().min(1), z.number()]).optional().describe("New amount, in major units."),
  category: z.string().min(1).optional().describe("New category, in the user's own words."),
  description: z.string().max(500).optional(),
  occurred_on: z.string().optional().describe("YYYY-MM-DD."),
  rate: z.union([z.string().min(1), z.number()]).optional().describe("Rate to set by hand."),
  items: z
    .array(
      z.object({
        description: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "The product exactly as the user said it or as it appears on the receipt: 'HARINA PAN 1KG'. " +
              "Do not translate or normalise it: that is how planfly matches it against earlier purchases.",
          ),
        quantity: z.number().positive().optional().describe("How many units. Defaults to 1."),
        unit: z.string().max(20).optional().describe("kg, g, l, ml, unit… Whatever the receipt says."),
        total: z
          .union([z.string().min(1), z.number()])
          .describe("What THAT whole line cost, not the unit price, in the entry's currency."),
      }),
    )
    .max(200)
    .optional()
    .describe(
      "Invoice lines added to the purchase: what was bought and what each thing cost. " +
        "Send ONLY the new ones, do not repeat the ones it already had. They do not have to add up to the " +
        "total: a receipt carries VAT, discounts and line items that were not read.",
    ),
  items_mode: z
    .enum(["replace", "append"])
    .optional()
    .describe(
      "append (the default) adds to the lines it already had. Use replace ONLY if the user " +
        "wants to redo the whole breakdown from scratch: it deletes the existing ones.",
    ),
  confirmation_id: z
    .uuid()
    .optional()
    .describe(
      "The id this tool returned for a previewed amendment. Send it ALONE, after the person approved " +
        "that exact preview, and nothing is written until you do.",
    ),
});

type AmendInput = z.infer<typeof amendInputSchema>;

/** The fields whose presence means "the person wants something changed". */
function correctionsFrom(input: AmendInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of CORRECTION_FIELDS) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  if (input.items !== undefined) {
    /*
     * Sent, not non-empty. `items: []` is how a wrong breakdown is wiped, and
     * guarding on the length dropped exactly that call: the tool then answered
     * `no_changes` while listing `items` among what it had received — the «it is
     * as if it were not reading the parameters I send it» loop, from the one
     * place that was supposed to prevent it.
     *
     * The pair travels whole, and an empty list is a `replace`: `updateTransaction`
     * clears the breakdown either way, and previewing it as an `append` would
     * describe «add nothing» to the person while it deletes their nine lines.
     */
    body.items = input.items;
    body.items_mode = input.items.length ? (input.items_mode ?? "append") : "replace";
  }
  return body;
}

export const amendTool = defineTool({
  name: "planfly_amend",
  title: "Correct or void a Planfly entry",
  description:
    "Corrects or voids an entry already recorded. The field being changed goes IN THIS SAME CALL, " +
    'alongside target: {"target": "last", "account": "Banco Provincial"} changes the account, ' +
    '{"target": "last", "amount": 500} changes the amount. A call with only target (and action) ' +
    "corrects nothing: it does not say what to set. It also serves to add the product breakdown to an " +
    "already recorded purchase. This is the only tool that can change a figure that is already in the " +
    "ledger, so it is a two-step call: it answers with a confirmation_id and a preview, writes nothing, " +
    "and applies it only when you call it again with that confirmation_id alone, after the person " +
    "approved it. The preview is the entry as it stands now plus the exact instruction that will be " +
    "sent — it is not a recalculated balance, so do not state resulting figures it does not give you. " +
    "If that entry changes before you confirm, the confirmation is refused and you are handed the new " +
    "preview: show it again, because the person approved the old one. It only reaches what was recorded " +
    "through a conversation — this server, Telegram or a photo — in the last " +
    `${AGENT_EDITABLE_DAYS} days: it cannot touch what came from a bank statement.`,
  inputSchema: amendInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  keywords: [
    "amend", "correct", "fix", "void", "cancel", "undo", "wrong", "edit", "approve", "receipt",
    "corregir", "arreglar", "anular", "borrar", "equivoque", "cambiar", "error", "factura", "desglose",
  ],
  /*
   * One scope for every action, because there is no reading action here: a
   * preview stages a confirmation that a single further call turns into a
   * changed figure. A credential that may only read must not be able to start
   * that, and `approve` — which takes a row out of the review tray — is a write
   * on the entry just as much as changing its amount is.
   */
  scopes: ["transactions:write"],
  examples: [
    'Correcting the account: {"target": "last", "account": "Banco Provincial"}',
    'Correcting the amount: {"target": "last", "amount": 500}',
    'Voiding: {"target": "last", "action": "void", "reason": "it was charged twice"}',
    'Applying it: {"confirmation_id": "<the id the previous call returned>"}',
    "The new value goes in the FIRST call, next to target. A call with only target changes nothing.",
    "If it comes back preview_changed, the entry moved underneath: show the new preview and ask again.",
  ],
  run: async (input, ctx) => {
    try {
      const principal = ctx.requireScope("transactions:write");
      const body = correctionsFrom(input);
      const asked = Object.keys(body).length > 0;

      const staged = async (
        action: "correct" | "void" | "approve",
        payload: Record<string, unknown>,
      ) => {
        const preview = await previewMcpOperation(principal, "amend_transaction", {
          // The default the schema no longer carries — see `target` there.
          target: input.target ?? "last",
          action,
          ...payload,
        });
        return ctx.result({
          ok: true,
          confirmation_id: preview.confirmationId,
          expires_at: preview.expiresAt,
          preview: preview.preview,
        });
      };

      if (input.confirmation_id) {
        if (
          asked ||
          input.action ||
          input.reason ||
          input.target !== undefined ||
          input.items_mode !== undefined
        ) {
          /*
           * A confirmation approves the preview as it stands. A field arriving
           * with it would be written by nobody and read as written by the model.
           *
           * `target` and `items_mode` are on this list too, though neither of
           * them writes anything: a confirmation carrying the id of a DIFFERENT
           * entry commits the previewed one regardless — that is what was
           * approved — and the model, which believes it named the other, then
           * tells the person the other one was corrected. The ledger is right
           * and the answer is false, which is the harder of the two to notice.
           */
          return ctx.result(
            {
              ok: false,
              error: "confirmation_with_changes",
              message:
                "A confirmation approves the preview exactly as it was shown, so it travels alone — " +
                "target included, because the confirmation_id already names the entry. To change what is " +
                "applied, or to amend another entry, preview it again and have the person approve that one.",
            },
            true,
          );
        }
        return ctx.result({
          ok: true,
          result: await confirmMcpOperation(principal, input.confirmation_id, "amend_transaction"),
        });
      }

      if (input.action === "void") {
        if (asked) {
          return ctx.result(
            {
              ok: false,
              error: "void_with_changes",
              message:
                "Voiding and correcting are two different answers to 'that is wrong', and this call asks " +
                "for both. Void it, or send the corrected field without action.",
            },
            true,
          );
        }
        if (!input.reason) {
          return ctx.result(
            {
              ok: false,
              error: "reason_required",
              message:
                "Voiding needs a reason: an entry that existed is information, and what is kept is why it " +
                "stopped counting. Send reason with the person's own words — 'it was charged twice', " +
                "'the purchase was cancelled'. Do not invent one on their behalf.",
            },
            true,
          );
        }
        /*
         * The reason is kept here, not sent.
         *
         * `DELETE /api/v1/transactions/{id}` takes no body, and the
         * `void_reason` it stores is frozen in the household's language.
         * Smuggling the person's words into a key the schema does not declare
         * would be a 400 at best; the confirmation is where they belong, and
         * it is what the person approves before the entry stops counting.
         */
        return staged("void", { body: {}, reason: input.reason });
      }

      if (input.action === "approve") {
        if (asked) {
          return ctx.result(
            {
              ok: false,
              error: "approve_with_changes",
              message:
                "'approve' only takes the entry out of the review tray. To correct a field, send it without " +
                "action; approve it afterwards if it still needs it.",
            },
            true,
          );
        }
        return staged("approve", { body: updateTransactionSchema.parse({ approve: true }) });
      }

      if (!asked) {
        /*
         * Naming what arrived, not only what is accepted.
         *
         * A model cannot see its own arguments: with a bare target it read
         * this refusal four times in a row and concluded the tool was broken —
         * "it is as if it were not reading the parameters I send it" — because
         * it believed it had sent the account. The list of keys received is
         * the only thing that shows it the gap between what it thinks it sends
         * and what arrives.
         */
        const arrived = Object.keys(input).filter((key) => input[key as keyof AmendInput] !== undefined);
        return ctx.result(
          {
            ok: false,
            error: "no_changes",
            received: arrived,
            accepts: [...CORRECTION_FIELDS, "items"],
            message:
              `All I got was: ${arrived.length ? arrived.join(", ") : "nothing"}. 'target' says WHICH entry and 'action' WHAT to do, ` +
              "but neither of them is the new value, so I do not know what to change. The field goes in " +
              "THIS SAME call, alongside 'target' — it is not a two-step call. I can change: " +
              `${CORRECTION_FIELDS.join(", ")}. And I can add the purchase breakdown with items, which ` +
              'goes alone: items: [{ description: "HARINA PAN 1KG", total: 80 }]. ' +
              "Do not record a new entry to dodge this.",
          },
          true,
        );
      }

      // Validated before a person is asked to approve it: a malformed date or
      // amount is the route's answer to give, and it should not arrive after
      // the approval, when it reads as the approval having failed.
      return staged("correct", { body: updateTransactionSchema.parse(body) });
    } catch (error) {
      return ctx.fail(error);
    }
  },
});

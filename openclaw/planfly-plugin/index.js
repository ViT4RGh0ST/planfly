import { definePluginEntry } from "./api.js";
import { createRecordTool } from "./src/record-tool.js";
import { createReportTool } from "./src/report-tool.js";
import { createContextTool } from "./src/context-tool.js";
import { createAmendTool } from "./src/amend-tool.js";
import { createAccountTool } from "./src/account-tool.js";
import { createRecurringTool } from "./src/recurring-tool.js";
import { createFinancingTool } from "./src/financing-tool.js";
import { createBudgetTool } from "./src/budget-tool.js";
import { createProductTool } from "./src/product-tool.js";
import { createHelpTool } from "./src/help-tool.js";

/**
 * planfly's plugin for openclaw.
 *
 * Plain JS with `definePluginEntry`, NOT `defineToolPlugin`: the typed route
 * with TypeBox requires openclaw >= 2026.5.17 and the image running here is
 * 2026.4.15-beta.1 (the source monorepo says 2026.7.2, but that is not what is
 * running). This form is the one that already works with bcv-rates and p2p-rates.
 *
 * Nine tools and not one: a single tool with a discriminator produces a union
 * schema the model gets wrong, and one per action would inflate the catalogue on
 * every turn. Nine map to the domains that genuinely exist — writing, reading,
 * getting your bearings, correcting, accounts, recurrences, installments,
 * budgets and products — and inside each one the actions go by parameter.
 *
 * The last three go separately and not inside `planfly_record`, for two
 * different reasons. Opening an account or configuring a recurrence happens a
 * few times a year against the fifty times a month of recording an expense, and
 * joining them invites the model to create an account every time it does not
 * recognise a name.
 *
 * The installments one is more serious: a financed purchase is TWO entries and a
 * schedule. With no tool of its own the model improvises with the recording one,
 * the ledger looks reasonable and the schedule says something else — half an
 * installment purchase fails nowhere and leaves the debt wrong forever.
 */
export default definePluginEntry({
  id: "planfly",
  name: "Planfly",
  description:
    "Record and consult personal finances in planfly: expenses, income, transfers, net position and budgets.",
  register(api) {
    const tools = [
      createRecordTool(api),
      createReportTool(api),
      createContextTool(api),
      createAmendTool(api),
      createAccountTool(api),
      createRecurringTool(api),
      createFinancingTool(api),
      createBudgetTool(api),
      createProductTool(api),
    ];

    // planfly_help is built over this same list, not over a copy: a catalogue
    // written separately falls out of sync on the first parameter change, and
    // then it lies to the agent instead of guiding it.
    tools.push(createHelpTool(api, tools));

    for (const tool of tools) {
      api.registerTool(tool);
    }
  },
});

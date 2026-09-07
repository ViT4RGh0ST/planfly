import { definePluginEntry } from "./api.js";

/**
 * planfly's plugin for openclaw — the skill, and nothing else.
 *
 * It used to carry ten tools of its own: a hand-written HTTP client, ten schemas
 * and ten descriptions, all of them a second implementation of what planfly's API
 * already exposes. Every parameter added to a route had to be added here too, and
 * whichever of the two was forgotten did not fail — it silently dropped the datum
 * and answered 201.
 *
 * planfly now speaks MCP at `/api/mcp`, and openclaw connects to it directly,
 * under `mcp.servers.planfly` in the gateway's configuration. The tools come from
 * the server, so there is one description of each and it cannot drift.
 *
 * **What could not move is this file's other half.** A tool list tells a model
 * what it CAN do; it does not tell it that answering «anotado» without calling
 * anything is the worst failure there is, or that one purchase is one call, or
 * how a Venezuelan invoice is read. That is the skill, it is worth more than the
 * tools were, and it stays here — which is why this remains a plugin rather than
 * being deleted: `openclaw.plugin.json` mounts `./skills`, and a plugin is how a
 * skill gets mounted.
 *
 * So `register` is deliberately empty. Registering nothing is the point.
 */
export default definePluginEntry({
  id: "planfly",
  name: "Planfly",
  description:
    "Personal finance in planfly. The tools come from planfly's MCP server; this carries the skill that says how to use them.",
  register() {
    /*
     * Nothing. Registering a tool here would be a SECOND way to write the
     * ledger, alongside MCP — and two write paths do not conflict noisily, they
     * both succeed, and one purchase is recorded twice.
     */
  },
});

# The openclaw plugin

What gives a Telegram bot — via [openclaw](https://github.com/openclaw) —
planfly's skill: when to record, how to read a local invoice, and the mistakes
that cost eleven entries for one grocery run.

**The tools are not here any more.** They come from planfly's MCP server, at
`/api/mcp`, and openclaw connects to it directly. This directory used to carry a
hand-written HTTP client and ten tool schemas — a second implementation of what
the API already exposed, where every parameter added to a route had to be added
here too, and whichever of the two was forgotten did not fail: it dropped the
datum in silence and answered 201.

## Connecting it

Two halves, and they only work together.

**1 · The MCP server**, in the gateway's configuration under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "planfly": {
        "url": "http://planfly:3000/api/mcp",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer plfy_…" }
      }
    }
  }
}
```

The token comes from `npm run mcp:token`, run in planfly. The URL is planfly as
the gateway sees it: from another container on a shared network, the container
name; from the same machine, `http://localhost:3000`.

That file also carries the Telegram bot token, so it does not go into this repo
and never will.

**2 · The skill**, which is what is in this directory:

```bash
npm run openclaw:install     # from here to ~/.openclaw/extensions/planfly/
```

Afterwards you have to **restart the gateway** for it to pick it up; that cuts
Telegram off for one to three minutes.

The two steps go together. Editing this directory changes nothing in Telegram
until you copy and restart, and checking it is done against the installed copy,
not against the repo:

```bash
diff -rq openclaw/planfly-plugin/ ~/.openclaw/extensions/planfly/
```

## Why it is still a plugin

Because a plugin is how a skill gets mounted: `openclaw.plugin.json` declares
`./skills`, and `index.js` registers nothing at all.

Registering a tool here now would be a **second way to write the ledger**
alongside MCP. Two write paths do not conflict noisily — they both succeed, and
one purchase is recorded twice.

## What the skill is for, and why it did not move

A tool list tells a model what it CAN do. It does not tell it that answering
«anotado» without calling anything is the worst failure there is, that one
purchase is one call, that `to_account` on an expense sends the money somewhere
nobody will look, or how the total is read off a Venezuelan invoice. That is the
skill, it was always worth more than the tool schemas, and it is the half of this
directory that survived.

## Four tools listed, the rest found

planfly's MCP server does not list one tool per verb. Four are always there —
`planfly_context`, `planfly_report`, `planfly_preview_transaction`,
`planfly_confirm_transaction` — and the rest are discovered with
`planfly_search_tool`, read with `planfly_tool_schema` and run with
`planfly_use_tool`.

That is what keeps a conversation about this month's spending from paying for the
paragraph explaining how a prepaid card differs from a credit one. Set
`MCP_MODE=native` in planfly to list all of them instead.

## Pulling back what was edited live

If you touch it directly in `~/.openclaw` — the convenient way to test — this
brings it back to the repo before committing:

```bash
npm run openclaw:capture
```

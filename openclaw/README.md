# The openclaw plugin

What gives a Telegram bot — via [openclaw](https://github.com/openclaw) —
planfly's ten tools:

| Tool | What for |
|---|---|
| `planfly_record` | Recording an expense, income or transfer |
| `planfly_amend` | Correcting or voiding something recorded recently |
| `planfly_report` | How much was spent, on what, and how the month is going |
| `planfly_context` | Which accounts, categories and rates exist |
| `planfly_account` | Opening, renaming or archiving an account |
| `planfly_budget` | Setting and consulting budgets |
| `planfly_financing` | Installment purchases: recording them and paying them |
| `planfly_recurring` | What repeats on its own every month or fortnight |
| `planfly_product` | Product prices over time, and merging or splitting badly matched ones |
| `planfly_help` | The catalogue and the examples, for when it gets stuck |

This list comes from the manifest itself, not from a copy made by hand:

```bash
grep -o '"planfly_[a-z]*"' openclaw/planfly-plugin/openclaw.plugin.json | sort -u
```

It lives here and **runs from `~/.openclaw/extensions/planfly/`**, which is where
the gateway looks for its extensions.

It is an adapter, not the integration: underneath it calls planfly's HTTP API,
documented in [`docs/api.md`](../docs/api.md). If you use another framework, wrap
those same routes and skip this directory.

## Installing or updating

```bash
npm run openclaw:install     # from here to ~/.openclaw/extensions/planfly/
```

Afterwards you have to **restart the gateway** for it to pick it up; that cuts
Telegram off for one to three minutes. The exact command depends on how you have
openclaw set up, and the script itself reminds you when it finishes.

The two steps go together. Editing this directory changes nothing in Telegram
until you copy and restart, and checking it is done against the installed copy,
not against the repo:

```bash
diff -rq openclaw/planfly-plugin/ ~/.openclaw/extensions/planfly/
```

## Pulling back what was edited live

If you touch it directly in `~/.openclaw` — which is the convenient way to test —
this brings it back to the repo before committing:

```bash
npm run openclaw:capture
```

## What is NOT here

The **API token** and the `baseUrl` live in openclaw's configuration, under
`plugins.entries.planfly.config`. That file also carries the Telegram bot token,
so it does not go into the repo and never will. planfly's is generated on each
installation with `npm run token:create`.

## Why it is plain JavaScript

`defineToolPlugin` — the typed way — requires a gateway version newer than the
one tested here, and with an older one the plugin does not load. We use
`definePluginEntry`, which is the only thing verified against the image in use.
If you update openclaw, this can be revisited.

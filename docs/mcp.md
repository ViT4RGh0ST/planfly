# Planfly MCP over HTTP

Planfly exposes its agent integration as a Streamable HTTP MCP endpoint:

```
http://localhost:3000/api/mcp
```

It is an App Router route in the same Planfly process, not a second service and
not a host-specific plugin. The Compose application port is already bound to
`127.0.0.1`, so a fresh installation does not expose financial tools to the LAN.

## Credential and scopes

Create the smallest credential that supports the tools the client will use:

```bash
npm run mcp:token
```

This creates a token with `mcp:access`, `context:read`, `reports:read`, and
`transactions:write`. The token is printed once. Configure it as a Bearer
credential for the MCP endpoint:

```
Authorization: Bearer plfy_…
```

`mcp:access` only permits connection to MCP. Each tool checks its own scope:

| Tool | Required scope |
|---|---|
| `planfly_context` | `context:read` |
| `planfly_report` | `reports:read` |
| `planfly_preview_transaction` | `transactions:write` |
| `planfly_confirm_transaction` | `transactions:write` |

The token resolves the household and user. Never place either identity in tool
arguments; the MCP server sets provenance itself and every saved transaction is
marked `source: "mcp"` with the issuing token and confirmation id.

## Current tool flow

Start with `planfly_context` before naming an account or category. The server
returns the real names, rates and balances. Use `planfly_report` for server-
calculated reporting; do not calculate valuations in the client.

Transactions are deliberately a two-step operation:

1. Call `planfly_preview_transaction` with the facts to record. It validates
   account/category resolution, rates, duplicate protection and line items,
   but writes nothing. It returns a `confirmationId` valid for fifteen minutes.
2. Show that server result to the person. Call `planfly_confirm_transaction`
   only after explicit approval of that id.

On confirmation, Planfly recalculates the draft. If rates, a match, warnings or
another financially relevant result changed, it does not write; it returns the
fresh preview for a new review. A confirmation belongs to its issuing household,
user and token and can be used only once.

## Receipts and vision

MCP does not make a client vision-capable. A client that can read a receipt may
send the extracted total, merchant, date and line items to the preview tool,
including an honest `confidence` value. Planfly stores the resulting transaction
as MCP provenance; it does not currently upload image bytes or run OCR itself.

A client or model without vision must not claim to read an attached image. Ask
for the relevant facts or use Planfly's web UI. A local OCR companion remains a
future, separately enabled option because it needs an explicit file-transfer and
privacy model; cloud OCR must be opt-in.

## Remote access

The default URL is intentionally local. To connect a remote desktop or cloud
client, publish the existing Planfly app through a TLS reverse proxy and make an
informed choice about which financial data and receipt text leave the device.

The current endpoint authenticates a Planfly Bearer token. A client that only
supports OAuth-based remote MCP authorization is not compatible yet; OAuth
discovery and consent should be added before claiming first-class support for
that client. Do not expose the endpoint unauthenticated or on plain HTTP.

## Migration from OpenClaw

The direct OpenClaw plugin is deprecated, not a second supported integration.
During the transition it remains available while MCP gains the remaining account,
budget, recurring, financing and product-management operations. New work should
target MCP; the plugin and its install/capture scripts will be removed after a
documented migration window and feature-parity verification.

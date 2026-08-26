# Planfly MCP over HTTP

Planfly exposes its agent integration as a Streamable HTTP MCP endpoint:

```
http://localhost:3000/api/mcp
```

It is an App Router route in the same Planfly process, not a second service and
not a host-specific plugin. The Compose application port is already bound to
`127.0.0.1`, so a fresh installation does not expose financial tools to the LAN.

## Authentication and scopes

HTTP MCP clients can authenticate in either of these ways:

- **OAuth 2.1 Authorization Code + PKCE** (the default for a remote MCP client).
  Planfly publishes RFC 9728 protected-resource metadata at
  `/.well-known/oauth-protected-resource/api/mcp`; the `401` challenge points
  clients there. The authorization server is Better Auth at `/api/auth`, with
  RFC 8414 discovery, short-lived audience-bound access tokens and refresh-token
  rotation. Client registration uses MCP Client ID Metadata Documents (CIMD),
  not an open unauthenticated registration endpoint.
- **A revocable Planfly Bearer token** for local automation and clients that do
  not yet implement remote OAuth. It is scoped, shown once, and can be revoked
  in Planfly.

For OAuth, use the public URL a client actually connects to. When a TLS reverse
proxy is involved, set `MCP_PUBLIC_URL=https://planfly.example.com/api/mcp`,
set the matching `BETTER_AUTH_URL` and add the browser origin to
`AUTH_TRUSTED_ORIGINS` / `MCP_ALLOWED_ORIGINS`. Planfly rejects Host and Origin
values outside that configured allowlist before it parses an MCP request.

OAuth currently refuses an account that belongs to more than one household
rather than choosing one silently. Use a household-bound Bearer token until a
future authorization flow adds explicit household selection.

### Bearer token

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

The credential resolves the household and user. Never place either identity in tool
arguments; the MCP server sets provenance itself and every saved transaction is
marked `source: "mcp"` with its issuing credential and confirmation id.

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

OAuth 2.1 clients discover the authorization flow automatically from the MCP
challenge. Do not expose the endpoint unauthenticated or on plain HTTP. HTTP is
accepted only for localhost/loopback development; a remotely reachable resource
identifier must use HTTPS.

## Migration from OpenClaw

The direct OpenClaw plugin is deprecated, not a second supported integration.
During the transition it remains available while MCP gains the remaining account,
budget, recurring, financing and product-management operations. New work should
target MCP; the plugin and its install/capture scripts will be removed after a
documented migration window and feature-parity verification.

import { NextRequest } from "next/server";
import { z } from "zod";

import { withInternalPrincipal } from "@/lib/api/handler";
import { hasScope, type Principal } from "@/lib/api-token";
import { McpConfirmationError } from "@/lib/mcp/operation";
import { InvalidTransactionError } from "@/lib/services/record-transaction";

/**
 * What a tool is handed when it registers.
 *
 * The four original tools were written inline in `route.ts`, each repeating the
 * same four moves: check a scope, call a v1 route with the internal principal,
 * shape a result, shape an error. Eleven tools written that way is a file nobody
 * reads, and — worse — four copies of «how a refusal is passed on» that drift.
 *
 * So the moves live here once and a tool is one file that registers itself.
 */

/** A refusal from a v1 route, carried whole so a tool can hand it back. */
export class RouteRefusal extends Error {
  constructor(
    readonly payload: Record<string, unknown>,
    readonly status: number,
  ) {
    super(typeof payload.message === "string" ? payload.message : `HTTP ${status}`);
  }
}

export class McpScopeError extends Error {
  constructor(readonly scope: string) {
    super(`The MCP credential does not grant ${scope}.`);
  }
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type McpToolContext = {
  principal: Principal;
  /** Throws unless the credential carries it. Checked per ACTION, not per tool. */
  requireScope(scope: string): Principal;
  /** Calls a v1 route in-process, with the route's own refusal preserved. */
  callRoute(
    path: string,
    route: (req: NextRequest) => Promise<Response>,
  ): Promise<Record<string, unknown>>;
  result(value: Record<string, unknown>, isError?: boolean): ToolResult;
  fail(error: unknown): ToolResult;
};

export function toolResult(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Every way a tool can fail, turned into an answer the caller can act on.
 *
 * It lived in the route handler while the classes it tests for lived here, and
 * `instanceof` compares identities, not names: the route declared its OWN
 * `RouteRefusal` and `McpScopeError`, so a refusal raised by `callRoute` — a
 * different class with the same name — matched none of the branches and came
 * back as «planfly could not complete the request». The route's own wording,
 * and which scope was missing, were being discarded for exactly the tools that
 * had been moved out into their own files.
 *
 * One copy, next to the classes it tests for, is the only arrangement where
 * that cannot happen again.
 */
export function mcpErrorResult(error: unknown): ToolResult {
  if (error instanceof RouteRefusal) {
    // Everything the route said, including `existing`, `detail` and `suggestion`:
    // those are what tell the model whether to ask the person or fix its own call.
    return toolResult({ ok: false, ...error.payload }, true);
  }
  if (error instanceof McpConfirmationError) {
    return toolResult(
      {
        ok: false,
        error: error.code,
        message: error.message,
        ...(error.preview ? { preview: error.preview } : {}),
      },
      true,
    );
  }
  if (error instanceof InvalidTransactionError) {
    return toolResult({ ok: false, error: error.code, message: error.message, detail: error.detail }, true);
  }
  if (error instanceof z.ZodError) {
    return toolResult(
      { ok: false, error: "invalid_input", message: "The tool input did not match its schema." },
      true,
    );
  }
  if (error instanceof McpScopeError) {
    return toolResult({ ok: false, error: "forbidden", message: error.message, scope: error.scope }, true);
  }

  console.error("[mcp] tool failed", error);
  return toolResult(
    { ok: false, error: "internal_error", message: "Planfly could not complete the request." },
    true,
  );
}

/**
 * The context a tool runs with, built from the AUTHENTICATED credential.
 *
 * It is built once per request, before any argument is read, which is what
 * makes `planfly_use_tool` safe: the tool name it takes chooses what runs and
 * can never choose who it runs as.
 */
export function makeToolContext(
  principal: Principal,
  fail: (error: unknown) => ToolResult = mcpErrorResult,
): McpToolContext {
  return {
    principal,
    requireScope(scope) {
      if (!hasScope(principal, scope)) throw new McpScopeError(scope);
      return principal;
    },
    async callRoute(path, route) {
      /*
       * The principal travels in a WeakMap on the request, not in a header.
       *
       * MCP is another server-side adapter, not an HTTP client: a header would
       * be something a caller could forge over the network.
       */
      const req = withInternalPrincipal(new NextRequest(`http://planfly.internal${path}`), principal);
      const response = await route(req);
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        /*
         * The route's own answer, not a sentence about it.
         *
         * Every refusal the v1 routes are careful to word — «you may already
         * have an account called X», «I do not know the field Y, did you mean
         * Z», which scope was missing — is what tells the model whether to ask
         * the person or fix its own call. Replaced by «the request was
         * rejected», a bot can only try again.
         */
        throw new RouteRefusal(payload, response.status);
      }
      return payload;
    },
    result: toolResult,
    fail,
  };
}

import { NextRequest } from "next/server";

import { withInternalPrincipal } from "@/lib/api/handler";
import { hasScope, type Principal } from "@/lib/api-token";

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

export function makeToolContext(
  principal: Principal,
  fail: (error: unknown) => ToolResult,
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

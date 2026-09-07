import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "@/i18n/config";
import { getTranslator } from "@/i18n/translator";
import { authenticateToken, hasScope, type Principal } from "@/lib/api-token";
import { InvalidTransactionError } from "@/lib/services/record-transaction";
import { InvalidAmountError } from "@/lib/money";
import { amountErrorMessage } from "@/lib/user-error";
import { InvalidProductError } from "@/lib/services/products";

/**
 * Wrapper for the /api/v1 routes.
 *
 * Besides authenticating, it enforces the rule that stops the model writing into
 * the wrong household: the `householdId` ALWAYS comes from the token and never
 * from the body.
 */

export type HandlerContext = { principal: Principal; req: NextRequest };

/*
 * MCP is another server-side adapter, not an HTTP client. Keep its authenticated
 * principal in a request-identity map so direct route reuse cannot be triggered
 * by a header supplied over the network. A WeakMap also ensures no principal
 * outlives the request object.
 */
const internalPrincipals = new WeakMap<NextRequest, Principal>();

export function withInternalPrincipal(req: NextRequest, principal: Principal): NextRequest {
  internalPrincipals.set(req, principal);
  return req;
}

/** Keys a client may never send: they are identity, not data. */
const FORBIDDEN_KEYS = [
  "householdId",
  "household_id",
  "userId",
  "user_id",
  "createdByUserId",
  "created_by_user_id",
  "createdViaTokenId",
  "tokenId",
];

/*
 * These two errors carry their DATA and not their sentence.
 *
 * They are thrown from `rejectIdentityKeys` / `rejectUnknownKeys`, which run
 * over the raw body before anything knows whose household this is. The sentence
 * is composed in `handleError`, where the token — and with it the language it is
 * answered in — is already resolved. The `message` they carry is for the log.
 */
export class ForbiddenBodyKeyError extends Error {
  constructor(readonly key: string) {
    super(`forbidden body key: ${key}`);
    this.name = "ForbiddenBodyKeyError";
  }
}

export function rejectIdentityKeys(body: unknown): void {
  if (body == null || typeof body !== "object") return;
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) throw new ForbiddenBodyKeyError(key);
  }
}

export class UnknownBodyKeyError extends Error {
  constructor(
    readonly key: string,
    readonly suggestion: string | null,
    readonly valid: string[],
  ) {
    super(`unknown body key: ${key}`);
    this.name = "UnknownBodyKeyError";
  }
}

/** Edit distance, for the "did you mean?". */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[a.length][b.length];
}

/**
 * Rejects a field the schema doesn't know, instead of dropping it silently.
 *
 * Zod discards extra keys without saying anything, and for a model that is the
 * worst possible answer: `account_name` instead of `account` returned HTTP 201
 * and "you didn't say which account, I charged it to Efectivo Bs" — a success,
 * with the datum in the bin. And a PATCH with an invented field answered "there
 * was nothing to change", which the model reads as "the tool is broken".
 *
 * It goes separately from Zod's `.strict()` because the message matters more
 * than the rejection: naming the closest valid field is what turns an error into
 * something the caller fixes on its own next attempt.
 */
export function rejectUnknownKeys(
  body: unknown,
  schema: { shape: Record<string, unknown> },
): void {
  if (body == null || typeof body !== "object") return;
  const valid = Object.keys(schema.shape);
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (valid.includes(key)) continue;
    const lower = key.toLowerCase();
    /*
     * Two different kinds of closeness, because the model errs in two ways:
     * misspelling ("acount") and lengthening ("account_name", "to_account_id").
     * Edit distance alone doesn't catch the second — "account_name" to "account"
     * is 5 edits — and that is precisely the most common one.
     */
    const contained = valid.filter((v) => lower.includes(v.toLowerCase()));
    const near = valid
      .map((v) => ({ v, d: editDistance(lower, v.toLowerCase()) }))
      .sort((x, y) => x.d - y.d)[0];

    const suggestion = contained.length
      ? // The longest one: "to_account_x" resembles both "account" and "to_account".
        contained.sort((a, b) => b.length - a.length)[0]
      : // A third of the name: "acount"→"account" suggests, "zzz" invents nothing.
        near && near.d <= Math.max(2, Math.floor(key.length / 3))
        ? near.v
        : null;

    throw new UnknownBodyKeyError(key, suggestion, valid);
  }
}

export function withToken(
  scope: string,
  handler: (ctx: HandlerContext) => Promise<NextResponse>,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    // Declared outside the `try` so the catch can reach it: whatever the handler
    // throws still has to be said in the household's language, and by then the
    // token has already been read.
    let locale: Locale = DEFAULT_LOCALE;
    try {
      const principal =
        internalPrincipals.get(req) ?? (await authenticateToken(req.headers.get("authorization")));
      if (!principal) {
        // No token means no household, and no household means no language: the
        // default is the only honest answer here.
        return NextResponse.json(
          {
            ok: false,
            error: "unauthorized",
            message: getTranslator(DEFAULT_LOCALE)("api.unauthorized"),
          },
          { status: 401 },
        );
      }
      locale = normalizeLocale(principal.locale);
      if (!hasScope(principal, scope)) {
        return NextResponse.json(
          {
            ok: false,
            error: "forbidden",
            message: getTranslator(locale)("api.forbiddenScope", { scope }),
          },
          { status: 403 },
        );
      }
      return await handler({ principal, req });
    } catch (err) {
      return handleError(err, locale);
    }
  };
}

/**
 * The validation failure, said in a sentence that can be repeated in the chat.
 *
 * Zod brings the detail — which field and what problem — but in English and
 * inside `detail`, and the model only receives `message`. "The request body is
 * not the expected shape" is exactly as useful as "something failed": on
 * 17/08/2026 a breakdown with invented names (`name`/`price` instead of
 * `description`/`total`) returned that sentence, and the model was left with
 * nothing to hold on to.
 */
export function describeZodIssues(err: ZodError, locale: Locale = DEFAULT_LOCALE): string {
  const t = getTranslator(locale);
  /*
   * "Missing" is decided by looking inside too, because fields accepting two
   * shapes — `amount` is text or number — arrive wrapped in an `invalid_union`
   * whose outer message is a bare "Invalid input". Without looking at the
   * branches, the field that never arrived was announced as "invalid", which
   * sends the model off to correct a value it never wrote.
   */
  const didNotArrive = (i: unknown): boolean => {
    const issue = i as { message?: string; errors?: unknown[][] };
    if (issue.errors?.length) {
      return issue.errors.every((rama) => rama.every(didNotArrive));
    }
    return /received undefined/.test(issue.message ?? "");
  };

  const parts = err.issues.slice(0, 6).map((i) => {
    const field = i.path.join(".") || t("api.invalidBody.body");
    const key = didNotArrive(i) ? "api.invalidBody.missing" : "api.invalidBody.invalid";
    return t(key, { field });
  });

  const extra = err.issues.length - parts.length;
  const tail = extra > 0 ? t("api.invalidBody.more", { n: String(extra) }) : "";

  // The breakdown is where names get invented most, and where the right shape
  // cannot be guessed: it is spelled out rather than left at "invalid".
  const inItems = err.issues.some((i) => i.path[0] === "items");
  const help = inItems ? t("api.invalidBody.itemsHelp") : "";

  return t("api.invalidBody.head", { parts: parts.join(", "), tail, help });
}

export function handleError(err: unknown, locale: Locale = DEFAULT_LOCALE): NextResponse {
  const t = getTranslator(locale);

  if (err instanceof ForbiddenBodyKeyError) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden_field",
        message: t("api.forbiddenField", { key: err.key }),
      },
      { status: 400 },
    );
  }
  if (err instanceof UnknownBodyKeyError) {
    const message =
      t("api.unknownField.head", { key: err.key }) +
      (err.suggestion ? t("api.unknownField.suggestion", { suggestion: err.suggestion }) : "") +
      t("api.unknownField.valid", { valid: err.valid.join(", ") });
    return NextResponse.json(
      {
        ok: false,
        error: "unknown_field",
        message,
        detail: { field: err.key, suggestion: err.suggestion, valid: err.valid },
      },
      { status: 400 },
    );
  }
  if (err instanceof InvalidTransactionError) {
    return NextResponse.json(
      { ok: false, error: err.code, message: err.message, detail: err.detail },
      { status: 422 },
    );
  }
  if (err instanceof InvalidProductError) {
    return NextResponse.json(
      { ok: false, error: "invalid_product", message: err.message },
      { status: 422 },
    );
  }
  if (err instanceof InvalidAmountError) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_amount",
        message: amountErrorMessage(err, locale),
        detail: { input: err.input, reason: err.reason },
      },
      { status: 422 },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_body",
        message: describeZodIssues(err, locale),
        detail: err.issues.map((i) => ({ field: i.path.join("."), problem: i.message })),
      },
      { status: 422 },
    );
  }

  /*
   * The message does NOT travel to the client.
   *
   * Everything arriving here is unforeseen — a Drizzle failure, a timeout — and
   * its text carries the query with the parameters inside. An agent on the other
   * end can do nothing with half a kilobyte of SQL except show it to the user,
   * and the errors it CAN handle already left through the branches above with
   * their code and their sentence.
   */
  console.error("[api] unhandled error:", err);
  return NextResponse.json(
    {
      ok: false,
      error: "internal_error",
      message: t("api.internal"),
    },
    { status: 500 },
  );
}

/**
 * The last segment of the path, decoded.
 *
 * The dynamic /api/v1 routes take it from the URL and not from `params` because
 * the `withToken` wrapper receives only `(req)`: adding `params` would force a
 * second signature and two authentication paths.
 */
export function idFromUrl(url: string): string {
  const parts = new URL(url).pathname.split("/");
  return decodeURIComponent(parts[parts.length - 1]);
}

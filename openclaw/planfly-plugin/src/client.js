import { randomUUID } from "node:crypto";

/**
 * The HTTP client shared by all the tools.
 *
 * No dependencies: only global `fetch` and `node:crypto`. That is deliberate —
 * the plugin is installed by copying files, with no `npm install` and no build
 * step, just like bcv-rates and p2p-rates.
 */

export function createClient(api) {
  const config = api.pluginConfig ?? {};
  const baseUrl = (config.baseUrl ?? "http://host.docker.internal:3000").replace(/\/+$/, "");
  const token = config.apiToken ?? "";
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 10_000;

  async function request(method, path, { body, idempotencyKey } = {}) {
    if (!token) {
      throw new Error(
        "planfly's token is missing. Put it in plugins.entries.planfly.config.apiToken in openclaw.json.",
      );
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["X-Planfly-Idempotency-Key"] = idempotencyKey;

    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // By far the most common case: the PC was off or `npm run dev` is not
      // running. That deserves a message saying so, not a stack trace.
      throw new Error(
        `Could not reach planfly at ${baseUrl} (${err.message}). Is the app running?`,
      );
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `planfly answered something that is not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      const message = data?.message ?? data?.error ?? `HTTP ${res.status}`;
      const err = new Error(message);
      err.data = data;
      err.status = res.status;
      throw err;
    }

    return data;
  }

  return {
    baseUrl,
    /**
     * Idempotency key: one per call to execute().
     *
     * It protects against the plugin's own retry. It does NOT protect against
     * Telegram redelivering after an outage (it keeps 24 h of pending updates),
     * because the tool cannot see the message id — its signature is
     * execute(toolCallId, params). That case is handled by the server's
     * near-duplicate detector and by SKILL.md's instruction to pin the date when
     * the message is old.
     */
    newIdempotencyKey: () => randomUUID(),
    get: (path) => request("GET", path),
    post: (path, body, idempotencyKey) => request("POST", path, { body, idempotencyKey }),
    patch: (path, body) => request("PATCH", path, { body }),
    // With an optional body: removing a budget is identified by category and
    // period, not by an id the user never sees.
    del: (path, body) => request("DELETE", path, { body }),
  };
}

/** Shapes the result openclaw expects. */
export function toolResult(text, details) {
  /*
   * An empty answer says what happened instead of saying nothing.
   *
   * Every route answers with a `summary` written to be repeated verbatim, and
   * this adapter passes it straight through. But the plugin and the app deploy
   * separately — that is the first rule in the project's CLAUDE.md — so there is
   * a window where this copy has been installed and `docker compose build app`
   * has not: `summary` comes back `undefined`, the model receives an empty text
   * block and answers as if the household had nothing recorded. A silent «I know
   * nothing» that looks like lost data.
   */
  const missing = "planfly answered with no summary: the app is likely older than this plugin. Rebuild it (docker compose build app) — the raw data is in details.";
  return {
    content: [{ type: "text", text: text || missing }],
    details,
  };
}

/** Turns an error into something the agent can tell the user. */
export function toolError(err) {
  const detail = err?.data ?? null;

  /*
   * The server's messages come written to be repeated verbatim, and several
   * describe not a fault but a decision — "that is already recorded, I did not
   * duplicate it". Prefixing them with "I could not do it" turns them into a
   * breakage, and the model starts retrying something that already went fine.
   * The prefix stays only for what genuinely is a breakage: the app down, a
   * timeout.
   */
  let text = detail?.error ? err.message : `Could not do it: ${err.message}`;

  // When the server proposes candidates, handing them to the agent stops it
  // inventing a category that does not exist.
  if (detail?.detail?.candidates?.length) {
    text += `\nOpciones parecidas: ${detail.detail.candidates.map((c) => c.name).join(", ")}`;
  }
  return toolResult(text, { ok: false, error: err.message, detail });
}

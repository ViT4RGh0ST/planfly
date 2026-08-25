import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db";

/**
 * What an account's balance is, in one place.
 *
 * The formula is always `opening + sum of its non-voided lines`, and it was
 * written four times: when recording, when managing accounts, in net worth and
 * in the financier list. All four agreed today — two with `JOIN ... AND
 * voided_at IS NULL` and two with `FILTER (WHERE ...)` — but that is a truce,
 * not a guarantee: the day a rule is added — discard drafts, count pending — it
 * will go into one of them, and two screens will start saying different numbers
 * about how much you have. That fails nowhere.
 *
 * It is exposed as a SQL fragment and not only as a function because three of
 * the four uses go inside larger queries grouping by account.
 */

/**
 * The balance expression, to embed in a `GROUP BY` over accounts.
 *
 * It expects the query to have `accounts a`, and left-joined
 * `transaction_entries e` and `transactions t`.
 */
export const balanceExpression: SQL = sql`(a.opening_balance_minor
   + COALESCE(SUM(e.amount_minor) FILTER (WHERE t.voided_at IS NULL), 0))`;

/** ONE account's balance. Zero if it does not exist: it does not throw on an empty account. */
export async function accountBalance(accountId: string): Promise<number> {
  const { rows } = await db.execute<{ balance: string }>(sql`
    SELECT ${balanceExpression}::text AS balance
      FROM accounts a
      LEFT JOIN transaction_entries e ON e.account_id = a.id
      LEFT JOIN transactions t ON t.id = e.transaction_id
     WHERE a.id = ${accountId}
     GROUP BY a.id, a.opening_balance_minor
  `);
  return rows[0] ? Number(rows[0].balance) : 0;
}

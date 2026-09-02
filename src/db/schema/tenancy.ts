import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { householdRoleEnum, rateSourceEnum } from "./enums";
import { user } from "./auth";

/**
 * The tenant is the **household**, not the user.
 *
 * A loose `user_id` on every table would give isolated silos, and the case this
 * product contemplates is the opposite: two people sharing the same accounts and
 * wanting one single answer to «how much do we have?», not two parallel sets of
 * books under the same roof.
 */
export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** The currency the net position is expressed in. */
  baseCurrency: varchar("base_currency", { length: 10 }).notNull().default("USD"),
  /** Which of the two rates rules by default when valuing. Changing it revalues
   *  everything instantly, with no migration, because every line stores both. */
  defaultRateSource: rateSourceEnum("default_rate_source").notNull().default("parallel"),
  timezone: text("timezone").notNull().default("America/Caracas"),
  /**
   * The interface language, and the one the bot answers in.
   *
   * It lives here and not in the URL because the same value has to reach four
   * places — server components, server actions, API routes and the heartbeat —
   * and only two of those have a request to read it from. Next's
   * `next/root-params` explicitly does not work in server actions or route
   * handlers, which is where half the text is generated.
   *
   * `text` and not an enum: adding a third language should be a catalogue file,
   * not a migration.
   */
  locale: text("locale").notNull().default("en"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: householdRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] })],
);

/**
 * Maps a channel identity (Telegram, WhatsApp) to a planfly user.
 *
 * It is not needed while there is a single user, but it costs nothing and it is
 * what will let one bot serve several people in the household without redesigning
 * anything: today the identity comes from the API token, tomorrow the plugin
 * will also be able to send the Telegram id and planfly will resolve it here.
 */
export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // 'telegram' | 'whatsapp'
    externalId: text("external_id").notNull(), // the chat's numeric id, e.g. '100000001'
    displayName: text("display_name"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("channel_identities_unique").on(t.channel, t.externalId)],
);

/**
 * Machine credential: this is how the openclaw plugin authenticates.
 *
 * It stores only the sha256. The token binds to `(household, user)`, and that is
 * where the identity of each row the AI writes comes from — the model never
 * sends a `householdId` or a `userId` as a parameter, because an openclaw tool
 * cannot know who invoked it and it would be trivial to forge.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // 'openclaw-telegram'
    tokenHash: text("token_hash").notNull(),
    /** First characters in the clear, only so it can be identified in the UI. */
    prefix: text("prefix").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(
        sql`ARRAY['transactions:write','transactions:read','reports:read','context:read','accounts:write','recurring:write','financing:write','budgets:write']::text[]`,
      ),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_unique").on(t.tokenHash),
    index("api_tokens_household_idx").on(t.householdId),
  ],
);

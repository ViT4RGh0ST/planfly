import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * better-auth's core schema.
 *
 * The table and column names are set by better-auth, not by us — which is why
 * this file breaks the naming convention of the rest of the schema. Changing
 * them requires configuring a mapping in `src/lib/auth.ts`, and it is not worth it.
 *
 * `user.id` is TEXT (not uuid) because better-auth generates the id in the
 * application. It is the target of the audit foreign keys across the domain.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/** Stores the password hash (the `password` column) for the `credential`
 *  provider, and the tokens if OAuth is ever added. */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    /**
     * Which authority vouches for this identity, new in better-auth 1.7.
     *
     * It is not decoration: 1.7 looks an account up by `issuer` + `account_id`
     * rather than by provider, so a column better-auth writes and this schema did
     * not declare made the Drizzle adapter refuse every write to the table. What
     * that broke was `npm run db:seed` — «the field "issuer" does not exist in
     * the "account" Drizzle schema» — which is to say a fresh installation could
     * not create its first user at all.
     *
     * For email and password it is `local:credential`. There are no OAuth
     * providers here, so that is the only value this column ever holds.
     */
    issuer: text("issuer").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  // The pair better-auth 1.7 resolves an identity by. Declared here because it
  // declares it: without it two rows could claim the same identity and which one
  // answered a login would be whatever the planner chose that day.
  (table) => [uniqueIndex("account_issuer_account_id_key").on(table.issuer, table.accountId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Migrations are source code: they are versioned in git and can be edited by
  // hand to add triggers and indexes the DSL cannot express.
  verbose: true,
  strict: true,
});

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Leftovers of the Postgres data directory, from when it lived inside the
    // project: root wrote it and eslint blows up with EACCES walking it. The
    // data is already in a Docker volume, but anyone migrating from an earlier
    // version will have the folder there until they delete it.
    "pgdata/**",
    "pgdata.viejo*/**",
    "backups/**",
    "storage/**",
    "drizzle/**",
    // Agent tooling: third-party code we do not maintain and which put 300
    // foreign warnings into every `npm run lint`.
    ".claude/**",
    ".cursor/**",
  ]),
]);

export default eslintConfig;

import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bundles only what the server genuinely uses, instead of dragging all of
  // node_modules into the image. Takes the container from ~1 GB to about 200 MB.
  output: "standalone",
};

/*
 * The plugin only wires `src/i18n/request.ts` into the render. It does NOT add a
 * `[locale]` segment or a proxy: the language is a household datum and comes
 * from the session, so there is nothing to route.
 */
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);

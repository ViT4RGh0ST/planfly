import localFont from "next/font/local";

/**
 * Archivo, by Omnibus-Type (Buenos Aires).
 *
 * Why this one and not another:
 *
 * - **Geist is ruled out by rule**, along with Inter, Roboto, Fraunces, Plus
 *   Jakarta Sans and Space Grotesk: they are the faces every wave of
 *   AI-generated interfaces converges on, and they are recognisable at a glance.
 *   Geist is also what `create-next-app` ships by default, that is, the exact
 *   signature of "nobody chose this".
 *
 * - **Archivo was designed for high-functionality text and data** — newspapers,
 *   forms, dense interfaces. That is precisely what this dashboard is: tight
 *   figures to be read at a glance several times a day.
 *
 * - It has **real tabular figures** (`tnum`), which is non-negotiable here:
 *   without them amounts shift width as they update and a money column stops
 *   lining up.
 *
 * - It is a **Latin American** foundry, which suits a product built for
 *   Venezuela better than the umpteenth Swiss grotesque.
 *
 * It is **self-hosted** and not served through `next/font/google`: that way the
 * build does not depend on Google answering, and the app — which runs with no
 * guaranteed internet — makes no external request on load. Two subsets, latin
 * and latin-ext, because Spanish needs á é í ó ú ñ ü ¿ ¡.
 *
 * Variable from 400 to 700: one file per subset covers every weight, instead of
 * six downloads.
 */
export const archivo = localFont({
  src: [
    {
      path: "./fonts/Archivo-latin.woff2",
      weight: "400 700",
      style: "normal",
    },
    {
      path: "./fonts/Archivo-latin-ext.woff2",
      weight: "400 700",
      style: "normal",
    },
  ],
  variable: "--font-archivo",
  display: "swap",
  // Space reserved using the fallback's metrics, so the text does not jump
  // when the font finishes loading.
  adjustFontFallback: "Arial",
  fallback: ["system-ui", "sans-serif"],
});

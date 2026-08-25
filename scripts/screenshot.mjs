/**
 * Screenshots of the screens, already authenticated.
 *
 * `design-scan.mjs` detects antipatterns: it says whether a contrast is
 * insufficient or an h2 is missing, but not whether something looks good. For
 * that you have to look. This uses the same login and saves one PNG per route
 * and width.
 *
 *   node scripts/screenshot.mjs [directory] [base-url]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

for (const file of [".env.local", ".env"]) {
  const full = path.join(process.cwd(), file);
  if (!existsSync(full)) continue;
  for (const line of readFileSync(full, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/s, "$2");
  }
}

const OUT = process.argv[2] ?? ".impeccable/shots";
const BASE = process.argv[3] ?? process.env.SCAN_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SCAN_EMAIL ?? "scan@planfly.local";
const PASSWORD = process.env.SCAN_PASSWORD;

if (!PASSWORD) {
  console.error("SCAN_PASSWORD is missing from .env.local. Create it with `npm run scan:user`.");
  process.exit(1);
}

const ROUTES = process.env.SHOT_ROUTES
  ? process.env.SHOT_ROUTES.split(",")
  : ["/", "/transactions", "/accounts", "/products", "/financing", "/recurring"];

// The real desktop it is used at, and a narrow width to see what breaks.
// They are looked at together, in one pass.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 900, height: 1000 },
];

mkdirSync(OUT, { recursive: true });

const CHROME = (() => {
  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache);
  for (const build of builds.sort().reverse()) {
    const bin = path.join(cache, build, "chrome-linux64", "chrome");
    if (existsSync(bin)) return bin;
  }
  return undefined;
})();

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  const loggedIn = await page.evaluate(
    async (base, email, password) => {
      const res = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return res.ok;
    },
    BASE,
    EMAIL,
    PASSWORD,
  );
  if (!loggedIn) {
    console.error("Could not log in.");
    process.exit(1);
  }

  for (const viewport of VIEWPORTS) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    for (const route of ROUTES) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 45_000 });
      // Fonts decide heights: capturing before they load measures a different page
      // from the one you see.
      await page.evaluate(() => document.fonts.ready);

      /*
       * And we have to wait for what is drawn on the client.
       *
       * `networkidle2` is satisfied as soon as the requests fall quiet, but the
       * charts mount after hydration. The FIRST capture of the run came out
       * without them — the later ones did have them, because the module was
       * already cached — so the tool showed a page nobody sees and sent me
       * hunting for a bug that did not exist.
       */
      await page
        .waitForFunction(
          () =>
            document.querySelector("[data-chart], .recharts-surface") !== null ||
            document.querySelectorAll("svg").length > 2,
          { timeout: 8_000 },
        )
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      const name = `${route === "/" ? "dashboard" : route.slice(1)}-${viewport.name}.png`;
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
  }
} finally {
  await browser.close();
}

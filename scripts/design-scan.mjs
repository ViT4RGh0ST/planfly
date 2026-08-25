/**
 * Design scan over the pages behind the login.
 *
 * `impeccable detect <url>` renders with Puppeteer but cannot authenticate, so
 * it only reached /login — that is, none of the screens that matter. This logs
 * in first and then injects the same browser detector on each route.
 *
 *   node scripts/design-scan.mjs [base-url]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

// Credentials live in .env.local like everything else; demanding them on the
// command line left them in the shell history. Whatever is already exported
// wins, so you can scan as another user without editing the file.
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

const BASE = process.argv[2] ?? process.env.SCAN_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SCAN_EMAIL ?? "scan@planfly.local";
const PASSWORD = process.env.SCAN_PASSWORD;

const ROUTES = [
  "/",
  "/transactions",
  "/accounts",
  "/products",
  "/financing",
  "/recurring",
  "/budgets",
  "/rates",
  "/review",
  "/import",
];

// Two widths: the real desktop it is used at, and a narrow one to see what
// breaks. They are looked at together in one pass, not on separate trips.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 900, height: 900 },
];

const DETECTOR = path.join(
  process.cwd(),
  ".claude/skills/impeccable/scripts/detector/detect-antipatterns-browser.js",
);

if (!PASSWORD) {
  console.error(
    `SCAN_PASSWORD is missing: it is ${EMAIL}\u2019s password on this installation.\n` +
      "Add it to .env.local (which is in .gitignore):\n" +
      '  SCAN_PASSWORD="…"\n' +
      "Or pass it for this run only:\n" +
      "  SCAN_PASSWORD='…' node scripts/design-scan.mjs",
  );
  process.exit(1);
}

const detectorSource = readFileSync(DETECTOR, "utf8");

/**
 * Puppeteer demands the exact Chrome version it pins, and it cannot be installed
 * here: `puppeteer browsers install` unpacks with `unzip`, which this machine
 * does not have, and leaves empty folders that look like a good install. Any
 * complete Chrome from the cache is enough to inject a detector, so we look for
 * the most recent one that genuinely has a binary.
 */
function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  const cache = path.join(os.homedir(), ".cache/puppeteer/chrome");
  if (!existsSync(cache)) return undefined;

  const candidates = readdirSync(cache)
    .map((dir) => path.join(cache, dir, "chrome-linux64/chrome"))
    .filter((bin) => existsSync(bin))
    .sort();

  return candidates.at(-1);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: findChrome(),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();

  // Session through the API itself, not by filling the form: less brittle.
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
    console.error("Could not log in. Is the password right?");
    process.exit(1);
  }

  let total = 0;

  for (const viewport of VIEWPORTS) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    console.log(`\n${"═".repeat(64)}\n  ${viewport.name} · ${viewport.width}px\n${"═".repeat(64)}`);

    for (const route of ROUTES) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2", timeout: 45_000 });
      await page.evaluate(detectorSource);

      // The detector returns one element per finding, with its findings inside.
      // They are flattened and grouped by type: ten warnings of the same pattern
      // are one problem, not ten.
      const findings = await page.evaluate(async () => {
        const run = window.impeccableDetectAsync ?? window.impeccableDetect;
        const elements = await run();
        return (Array.isArray(elements) ? elements : []).flatMap((el) =>
          (el.findings ?? []).map((f) => ({
            type: f.type,
            name: f.name,
            detail: f.detail,
            severity: f.severity,
            selector: String(el.selector ?? "").slice(0, 70),
          })),
        );
      });

      total += findings.length;
      if (findings.length === 0) {
        console.log(`\n  ${route} — clean`);
        continue;
      }

      const byType = new Map();
      for (const f of findings) {
        const entry = byType.get(f.type) ?? { ...f, count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 2) entry.samples.push(f.selector);
        byType.set(f.type, entry);
      }

      console.log(`\n  ${route} — ${findings.length}`);
      for (const f of byType.values()) {
        console.log(`    [${f.type}] ×${f.count} — ${f.detail || f.name}`);
        for (const s of f.samples) console.log(`        ${s}`);
      }
    }
  }

  console.log(`\n${"─".repeat(64)}\nTotal: ${total} findings\n`);
} finally {
  await browser.close();
}

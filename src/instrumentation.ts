/**
 * Scheduled rate capture: twice a day, at 8:00 and 14:00 Caracas time.
 *
 * It is not a 30-minute `setInterval` like before. The BCV publishes **once per
 * business day**, so polling it every half hour was hammering a source that does
 * not change. Two takes cover the P2P's movement — that one does move during the
 * day — without abusing Binance.
 *
 * And it is not a timer aimed at 8:00 sharp, but a **cheap heartbeat checking
 * state**. The difference matters on this machine: the PC is not always on at
 * 8:00, WSL suspends, and a 24-hour `setTimeout` drifts or is lost. Every
 * quarter of an hour it checks whether the last capture predates the window that
 * has already passed; only then does it go out to the network.
 *
 * Intended consequence: if the PC was off at 8:00 and gets turned on at 11:00,
 * that window's capture happens on start-up. The day is not lost.
 */

/** Wall-clock hours, in the household's timezone. */
const SLOTS = [8, 14];

/** How often state is checked. It does not imply going out to the network. */
const TICK_MS = 15 * 60 * 1000;

export async function register() {
  // Node runtime only: on the edge there are neither sockets nor a database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // In development Next reloads the module on every change; without this guard
  // heartbeats would pile up.
  const globalRef = globalThis as unknown as { __planflyRatesTimer?: NodeJS.Timeout };
  if (globalRef.__planflyRatesTimer) return;

  const { dailySnapshot, lastSnapshotAt } = await import("@/lib/rates/service");
  const { today, instantAt, addDays } = await import("@/lib/dates");

  const timezone = process.env.TZ ?? "America/Caracas";

  /** The most recent window that has passed. Before 8:00, yesterday's 14:00 one. */
  function lastDueSlot(now: Date): Date {
    const localDate = today(timezone);
    const passed = SLOTS.map((hour) => instantAt(localDate, hour, 0, timezone))
      .filter((instant) => instant <= now)
      .sort((a, b) => b.getTime() - a.getTime());

    if (passed.length > 0) return passed[0];
    return instantAt(addDays(localDate, -1), SLOTS[SLOTS.length - 1], 0, timezone);
  }

  const { sendDueInstallmentReminders } = await import(
    "@/lib/services/installment-reminders"
  );
  const { runDueRecurrences } = await import("@/lib/services/recurring");
  const { purgeExpiredConfirmations } = await import("@/lib/mcp/transactions");

  async function tick() {
    // Installment reminders run on every heartbeat and not only on the rate
    // windows: they are idempotent per day (`reminded_on`), so passing extra
    // sends nothing extra, and that way the alert goes out as soon as the PC is on.
    try {
      const sent = await sendDueInstallmentReminders();
      if (sent > 0) console.log(`[installments] ${sent} reminded`);
    } catch (err) {
      console.warn("[installments] the reminder failed:", (err as Error).message);
    }

    // The recurrences, for the same reason: idempotent per rule and date, so
    // passing extra records nothing extra, and the rent due on the 1st fires as
    // soon as the PC is turned on even if it was off that day.
    try {
      const runs = await runDueRecurrences();
      if (runs.length > 0) console.log(`[recurrences] ${runs.length} fired`);
    } catch (err) {
      console.warn("[recurrences] the firing failed:", (err as Error).message);
    }

    // The MCP confirmations that nobody used. They last fifteen minutes and are
    // written before every proposed write, so without this the table only grows.
    try {
      const gone = await purgeExpiredConfirmations();
      if (gone > 0) console.log(`[mcp] ${gone} expired confirmations removed`);
    } catch (err) {
      console.warn("[mcp] the confirmation purge failed:", (err as Error).message);
    }

    try {
      const now = new Date();
      const due = lastDueSlot(now);
      const last = await lastSnapshotAt();

      // This window is already covered: the network is left alone.
      if (last && last >= due) return;

      const result = await dailySnapshot(today(timezone));
      const parts = [
        result.official ? `BCV ${Number(result.official.value).toFixed(2)}` : "BCV failed",
        result.parallel ? `P2P ${Number(result.parallel.value).toFixed(2)}` : "P2P failed",
      ];
      const slotLabel = new Intl.DateTimeFormat("es-VE", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(due);
      console.log(`[rates] window ${slotLabel} · ${parts.join(" · ")}`);
    } catch (err) {
      // A failing capture can never bring the server down: the app works with the
      // last known rate and says so on screen.
      console.warn("[rates] the heartbeat failed:", (err as Error).message);
    }
  }

  // On start-up, a little after the first load: it is what recovers the missed
  // window if the PC was off.
  setTimeout(tick, 10_000);
  globalRef.__planflyRatesTimer = setInterval(tick, TICK_MS);
}

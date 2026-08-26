/**
 * Telegram alerts.
 *
 * It goes **straight to the bot API**, not through the openclaw gateway. Same
 * principle as with the rates: planfly cannot fall silent because another
 * container is down or restarting. The bot is the same, so the message reaches
 * the configured household's usual chat.
 *
 * With no token configured it neither fails nor shouts: it simply does not
 * alert. A reminder that cannot be sent must never bring down the process that
 * tried.
 */

const API = "https://api.telegram.org";

export function notificationsEnabled(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID &&
      process.env.TELEGRAM_HOUSEHOLD_ID?.trim(),
  );
}

/**
 * Sends only the configured household's alert.
 *
 * Telegram's chat id lives in process configuration, not in a tenant row. It
 * therefore has to be explicitly bound to one household before it can receive
 * financial information. A multi-household installation gets one alert route
 * per app process; other households stay silent instead of leaking into that
 * route.
 */
export async function notify(householdId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const configuredHouseholdId = process.env.TELEGRAM_HOUSEHOLD_ID?.trim();
  if (!token || !chatId || !configuredHouseholdId || configuredHouseholdId !== householdId) {
    return false;
  }

  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[alerts] Telegram answered", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[alerts] could not alert:", (err as Error).message);
    return false;
  }
}

import { logger } from "./logger";

/**
 * Alert dispatch fan-out. Channels are configured via environment variables
 * (global) and per-user AlertChannel rows (user-specific webhooks).
 * Browser notifications are handled client-side from the signal feed.
 */

/**
 * What produced an alert.
 *
 * Every channel is shared, so without this every subscriber gets everything:
 * a phone set up to catch liquidation spikes also buzzes for each new signal
 * and each closure, which is how a useful channel becomes one people mute.
 */
export type AlertKind =
  /** a new composite-engine signal was opened */
  | "signal.opened"
  /** a new confluence-scanner signal was opened */
  | "signal.confluence"
  /** a new institutional-footprint signal was opened */
  | "signal.institutional"
  /** a signal reached its final target, stopped out or expired */
  | "signal.closed"
  /** forced flow printed at an extreme */
  | "liqspike";

export interface AlertPayload {
  title: string;
  body: string;
  symbol: string;
  side?: "BUY" | "SELL";
  confidence?: number;
  url?: string;
  kind?: AlertKind;
}

/**
 * The kinds allowed through, from `ALERT_KINDS` (comma-separated).
 *
 * Unset means everything, which is the historical behaviour and the right
 * default — a fresh install should not silently drop alerts it was never told
 * to filter.
 */
function enabledKinds(): string[] | null {
  const raw = process.env.ALERT_KINDS;
  if (!raw) return null;
  const kinds = raw.split(",").map((k) => k.trim()).filter(Boolean);
  return kinds.length > 0 ? kinds : null;
}

/**
 * True when this payload should be delivered.
 *
 * An *untagged* payload is blocked whenever an allowlist exists. Letting it
 * through would defeat the point: someone who sets ALERT_KINDS=liqspike wants
 * only liquidation spikes, including from code added later that nobody
 * remembered to tag. The dropped alert is logged so it is discoverable rather
 * than mysterious.
 */
export function shouldDispatch(payload: AlertPayload): boolean {
  const enabled = enabledKinds();
  if (!enabled) return true;
  return payload.kind != null && enabled.includes(payload.kind);
}

export async function dispatchAlert(payload: AlertPayload): Promise<void> {
  if (!shouldDispatch(payload)) {
    logger.debug("alerts.filtered", {
      kind: payload.kind ?? "untagged",
      symbol: payload.symbol,
      allowed: process.env.ALERT_KINDS,
    });
    return;
  }
  await Promise.allSettled([
    sendTelegram(payload),
    sendDiscord(payload),
    sendWebhook(payload, process.env.GENERIC_WEBHOOK_URL),
  ]);
}

async function sendTelegram(p: AlertPayload): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const text = `*${escapeMd(p.title)}*\n${escapeMd(p.body)}`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    logger.warn("alerts.telegram.failed", { error: String(err) });
  }
}

async function sendDiscord(p: AlertPayload): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: p.title,
            description: p.body,
            color: p.side === "BUY" ? 0x00e5a0 : p.side === "SELL" ? 0xff4d6d : 0x22d3ee,
            footer: { text: `TradingMaster • ${p.symbol}` },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch (err) {
    logger.warn("alerts.discord.failed", { error: String(err) });
  }
}

export async function sendWebhook(p: AlertPayload, url?: string | null): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "tradingmaster.alert", ...p, sentAt: new Date().toISOString() }),
    });
  } catch (err) {
    logger.warn("alerts.webhook.failed", { error: String(err) });
  }
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

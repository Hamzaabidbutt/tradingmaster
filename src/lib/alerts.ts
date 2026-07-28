import { logger } from "./logger";

/**
 * Alert dispatch fan-out. Channels are configured via environment variables
 * (global) and per-user AlertChannel rows (user-specific webhooks).
 * Browser notifications are handled client-side from the signal feed.
 */

export interface AlertPayload {
  title: string;
  body: string;
  symbol: string;
  side?: "BUY" | "SELL";
  confidence?: number;
  url?: string;
}

export async function dispatchAlert(payload: AlertPayload): Promise<void> {
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

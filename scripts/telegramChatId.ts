/**
 * Find your Telegram chat id — and say why it is missing when it is.
 *
 * `getUpdates` returning an empty array is the usual outcome of a first
 * attempt, and the raw API gives no hint which of the four possible causes it
 * was. This checks each one in order and reports the specific problem instead
 * of leaving you to guess.
 *
 *   npm run telegram:chat-id                 # reads TELEGRAM_BOT_TOKEN from .env
 *   npm run telegram:chat-id -- <token>      # or pass one explicitly
 *   npm run telegram:chat-id -- --test <id>  # send a test message to that chat
 *
 * Nothing here writes to the repo, and the token is never printed back.
 */
import { readFileSync } from "node:fs";

const API = "https://api.telegram.org";

/**
 * Read `TELEGRAM_BOT_TOKEN` out of `.env` if it is not already in the
 * environment.
 *
 * Hand-parsed rather than pulling in dotenv: this is the only script that
 * needs it, and a diagnostic tool earning the project a runtime dependency is
 * a poor trade. Handles the two forms people actually write — bare and quoted.
 */
function tokenFromEnvFile(): string | undefined {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const match = /^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* no .env — the token can still come from the environment or argv */
  }
  return undefined;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface TgUpdate {
  message?: { chat: TgChat; text?: string };
  channel_post?: { chat: TgChat };
  my_chat_member?: { chat: TgChat };
}

async function call<T>(token: string, method: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${API} — ${err instanceof Error ? err.message : String(err)}.\n` +
        "  Telegram is blocked on some networks and by some ISPs. Try mobile data, or run this from the machine that will actually send the alerts."
    );
  }

  const text = await res.text();
  let json: { ok: boolean; result?: T; description?: string; error_code?: number };
  try {
    json = JSON.parse(text);
  } catch {
    // A proxy, captive portal or blocking ISP answers with HTML, not JSON.
    // Reporting that plainly beats a "Unexpected token '<'" parse error.
    throw new Error(
      `${API} answered with something that is not the Telegram API (HTTP ${res.status}).\n` +
        `  First bytes: ${text.slice(0, 80).replace(/\s+/g, " ")}\n` +
        "  That is usually a proxy or a network block sitting in front of Telegram, not a problem with your token."
    );
  }
  if (!json.ok) {
    const code = json.error_code;
    if (code === 401) {
      throw new Error(
        "Telegram rejected the token (401). Check it was copied whole — it is two parts joined by a colon, like 8123456789:AAF… — and that it has not been revoked in @BotFather."
      );
    }
    if (code === 404) {
      throw new Error("Telegram returned 404 — the bot for this token does not exist.");
    }
    throw new Error(`Telegram error ${code ?? "?"}: ${json.description ?? "unknown"}`);
  }
  return json.result as T;
}

/** Every distinct chat visible in the pending updates. */
function chatsFrom(updates: TgUpdate[]): TgChat[] {
  const seen = new Map<number, TgChat>();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (chat && !seen.has(chat.id)) seen.set(chat.id, chat);
  }
  return [...seen.values()];
}

function label(chat: TgChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(" ");
  return name || "(unnamed)";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testIndex = args.indexOf("--test");
  const testChatId = testIndex >= 0 ? args[testIndex + 1] : undefined;
  // `testIndex + 1` is only a value to skip when --test was actually given;
  // with no --test, testIndex is -1 and that expression is 0, which would
  // silently eat the token passed as the first argument.
  const skipIndex = testIndex >= 0 ? testIndex + 1 : -1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== skipIndex);
  const token = positional[0] ?? process.env.TELEGRAM_BOT_TOKEN ?? tokenFromEnvFile();

  if (!token) {
    console.error(
      "No token. Set TELEGRAM_BOT_TOKEN in .env, or pass it:\n  npm run telegram:chat-id -- 8123456789:AAF…"
    );
    process.exit(1);
  }

  // 1. Is the token real?
  const me = await call<{ username: string; first_name: string }>(token, "getMe");
  console.log(`✓ Token valid — bot is @${me.username} (${me.first_name})`);

  // 2. A webhook silently swallows every update, which is the cause that
  //    looks identical to "you never messaged the bot".
  const hook = await call<{ url: string; pending_update_count: number }>(token, "getWebhookInfo");
  if (hook.url) {
    console.log(`\n✗ A webhook is set on this bot: ${hook.url}`);
    console.log("  While a webhook is set, getUpdates always returns nothing, however many");
    console.log("  messages you send. Remove it with:");
    console.log(`    curl "${API}/bot<TOKEN>/deleteWebhook"`);
    console.log("  then message the bot again and re-run this.");
    process.exit(1);
  }

  // 3. What has the bot actually received?
  const updates = await call<TgUpdate[]>(token, "getUpdates");
  const chats = chatsFrom(updates);

  if (chats.length === 0) {
    console.log("\n✗ No chats found — the bot has not received a message yet.\n");
    console.log(`  1. Open  https://t.me/${me.username}`);
    console.log("  2. Press START, then send any text (pressing START alone is not always enough).");
    console.log("  3. Re-run this command.\n");
    console.log("  For a GROUP: add the bot to the group and send a message there. Group ids are");
    console.log("  negative — keep the minus sign. If the group has topics enabled or the bot has");
    console.log("  privacy mode on, it only sees messages that mention it or reply to it, so");
    console.log(`  send "@${me.username} hello".\n`);
    console.log("  Shortcut for a private chat: message @userinfobot — the id it reports is your");
    console.log("  own user id, which IS the chat id for a DM with your bot.");
    process.exit(1);
  }

  console.log(`\n✓ Found ${chats.length} chat${chats.length === 1 ? "" : "s"}:\n`);
  for (const chat of chats) {
    console.log(`  TELEGRAM_CHAT_ID="${chat.id}"   ${chat.type.padEnd(10)} ${label(chat)}`);
  }
  console.log("\nCopy the id for the chat you want alerts in.");

  // 4. Optional end-to-end proof.
  if (testChatId) {
    console.log(`\nSending a test message to ${testChatId}…`);
    await call(token, "sendMessage", {
      chat_id: testChatId,
      text: "✅ TradingMaster is wired up. Liquidation spike alerts will arrive here.",
    });
    console.log("✓ Sent. If it arrived, this token + chat id pair is correct.");
  } else {
    console.log(`\nTo prove it end to end:\n  npm run telegram:chat-id -- --test ${chats[0].id}`);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

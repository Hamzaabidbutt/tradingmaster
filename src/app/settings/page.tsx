"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard } from "@/components/ui/primitives";

interface Channel {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export default function SettingsPage() {
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [notifPermission, setNotifPermission] = useState<string>("default");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => setUser(d.user));
    loadChannels();
    if (typeof Notification !== "undefined") setNotifPermission(Notification.permission);
  }, []);

  const loadChannels = () =>
    fetch("/api/alerts").then((r) => r.json()).then((d) => setChannels(d.channels ?? [])).catch(() => undefined);

  const enableBrowserNotifs = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === "granted") {
      new Notification("TradingMaster", { body: "Browser alerts enabled. You'll be notified on new signals." });
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "browser", config: {} }),
      });
      loadChannels();
    }
  };

  const addWebhook = async () => {
    if (!webhookUrl.startsWith("http")) {
      setMessage("Enter a valid webhook URL");
      return;
    }
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "webhook", config: { url: webhookUrl } }),
    });
    setMessage(res.ok ? "Webhook added — a test event was sent." : "Sign in to manage alert channels.");
    setWebhookUrl("");
    loadChannels();
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <h1 className="text-lg font-bold">Settings & Alerts</h1>

        <GlassCard title="Account" className="p-4">
          {user ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">{user.email}</div>
                <div className="text-xs text-slate-500">Role: {user.role}</div>
              </div>
              <button onClick={logout} className="rounded-lg bg-bear/10 px-3 py-1.5 text-xs font-semibold text-bear hover:bg-bear/20">
                Sign out
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Not signed in. <a href="/login" className="text-neon-cyan hover:underline">Sign in</a> to persist alert
              channels and manage strategies.
            </p>
          )}
        </GlassCard>

        <GlassCard title="Browser notifications" className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Get a desktop notification whenever a new high-confidence signal fires.
              <span className="ml-1 font-mono text-slate-500">status: {notifPermission}</span>
            </p>
            <button
              onClick={enableBrowserNotifs}
              className="rounded-lg bg-neon-cyan/15 px-3 py-1.5 text-xs font-semibold text-neon-cyan hover:bg-neon-cyan/25"
            >
              Enable
            </button>
          </div>
        </GlassCard>

        <GlassCard title="Webhook / integrations" className="p-4">
          <p className="mb-2 text-xs text-slate-400">
            POSTs a JSON payload on every signal. Telegram & Discord are configured server-side via environment
            variables (<code className="text-neon-cyan">TELEGRAM_BOT_TOKEN</code>, <code className="text-neon-cyan">DISCORD_WEBHOOK_URL</code>) —
            see <code className="text-neon-cyan">.env.example</code>.
          </p>
          <div className="flex gap-2">
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-endpoint.example/hook"
              className="flex-1 rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-xs outline-none focus:border-neon-cyan/50"
            />
            <button onClick={addWebhook} className="rounded-lg bg-neon-cyan/15 px-3 py-1.5 text-xs font-semibold text-neon-cyan hover:bg-neon-cyan/25">
              Add
            </button>
          </div>
          {message && <p className="mt-2 text-xs text-neon-amber">{message}</p>}
          {channels.length > 0 && (
            <ul className="mt-3 space-y-1">
              {channels.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded-md bg-white/[0.03] px-2 py-1.5 text-xs">
                  <span className="capitalize text-slate-300">{c.type} {typeof c.config.url === "string" ? `· ${c.config.url}` : ""}</span>
                  <button
                    onClick={async () => { await fetch(`/api/alerts?id=${c.id}`, { method: "DELETE" }); loadChannels(); }}
                    className="text-bear hover:underline"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </GlassCard>
      </div>
    </AppShell>
  );
}

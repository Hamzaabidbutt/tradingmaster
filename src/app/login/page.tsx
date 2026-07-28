"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "register" ? { email, password, name: name || undefined } : { email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="glass w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <span className="text-3xl text-neon-cyan text-glow-cyan">◈</span>
          <h1 className="mt-2 text-lg font-bold">
            Trading<span className="text-neon-cyan">Master</span>
          </h1>
          <p className="text-xs text-slate-500">AI market intelligence terminal</p>
        </div>

        <div className="mb-4 flex rounded-lg bg-white/5 p-1 text-xs font-semibold">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-1.5 capitalize transition-colors ${
                mode === m ? "bg-neon-cyan/15 text-neon-cyan" : "text-slate-500"
              }`}
            >
              {m === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm outline-none focus:border-neon-cyan/50"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm outline-none focus:border-neon-cyan/50"
          />
          <input
            type="password"
            required
            minLength={mode === "register" ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "Password (min 8 characters)" : "Password"}
            className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm outline-none focus:border-neon-cyan/50"
          />
          {error && <p className="text-xs text-bear">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-neon-cyan/15 py-2 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-50"
          >
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-[10px] text-slate-600">
          First account created becomes ADMIN. <Link href="/" className="text-neon-cyan hover:underline">Continue as guest →</Link>
        </p>
      </div>
    </main>
  );
}

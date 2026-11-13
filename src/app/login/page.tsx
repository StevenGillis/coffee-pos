"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    }).catch(() => null);
    if (res?.ok) {
      router.replace("/");
      return;
    }
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? (res ? "Something went wrong — try again" : "Can't reach the server"));
    setPasscode("");
    setBusy(false);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-3xl border border-line bg-surface p-10 shadow-card animate-card-in"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-caramel text-2xl text-caramel-ink">
            ☕
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Barista Board</h1>
          <p className="mt-2 text-sm text-ink-soft">Enter the store passcode to start your shift.</p>
        </div>
        <label htmlFor="passcode" className="sr-only">Store passcode</label>
        <input
          id="passcode"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          className="w-full rounded-xl border border-line bg-bg px-4 py-3 text-center text-2xl tracking-[0.5em] outline-none focus:border-caramel focus:ring-2 focus:ring-caramel/30"
          placeholder="••••••"
        />
        {error && <p role="alert" className="mt-3 text-center text-sm text-berry">{error}</p>}
        <button
          type="submit"
          disabled={busy || !passcode}
          className="mt-6 w-full rounded-xl bg-caramel py-3 font-semibold text-caramel-ink transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Open board"}
        </button>
      </form>
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Order, OrderStatus } from "@/lib/orders";

const POLL_MS = 2000;

const REJECT_REASONS = [
  { code: "CAPACITY", label: "Too busy right now" },
  { code: "ITEM_AVAILABILITY", label: "Item unavailable" },
  { code: "STORE_CLOSED", label: "Store closed" },
  { code: "MISSING_ITEM", label: "Missing item" },
  { code: "SPECIAL_INSTRUCTIONS", label: "Can't meet special instructions" },
  { code: "OTHER", label: "Other" },
] as const;

type ActionType = "accept" | "reject" | "start" | "ready" | "pickup";

// ------------------------------------------------------------------ sound

function useChime() {
  const ctxRef = useRef<AudioContext | null>(null);
  const enable = useCallback(() => {
    ctxRef.current ??= new AudioContext();
    void ctxRef.current.resume();
  }, []);
  const play = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.35, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 1);
    });
  }, []);
  return { enable, play };
}

// ------------------------------------------------------------------ helpers

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function minutesAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  return mins === 0 ? "just now" : `${mins} min ago`;
}

function countdown(deadlineIso: string, now: number) {
  const ms = Math.max(0, Date.parse(deadlineIso) - now);
  const total = 11.5 * 60 * 1000;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return { label: `${m}:${String(s).padStart(2, "0")}`, fraction: ms / total, ms };
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  PICK_UP: "Pickup",
  DELIVERY_BY_UBER: "Uber courier",
  DELIVERY_BY_RESTAURANT: "Our delivery",
  DINE_IN: "Dine-in",
};

const STATUS_BADGE: Partial<Record<OrderStatus, { label: string; className: string }>> = {
  picked_up: { label: "Picked up", className: "bg-sage-soft text-sage" },
  rejected: { label: "Rejected", className: "bg-berry-soft text-berry" },
  cancelled: { label: "Cancelled", className: "bg-berry-soft text-berry" },
  expired: { label: "Expired", className: "bg-amber-soft text-ink-soft" },
};

// ------------------------------------------------------------------ board

export default function BaristaBoard({ cafeName }: { cafeName: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(true);
  const [clockOffset, setClockOffset] = useState(0);
  const router = useRouter();
  // 0 until mounted: the page is prerendered, so the clock starts in the browser.
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<{ id: number; text: string; tone: "info" | "error" }[]>([]);
  const [rejecting, setRejecting] = useState<Order | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const chime = useChime();
  const known = useRef<Map<string, OrderStatus> | null>(null);

  const toast = useCallback((text: string, tone: "info" | "error" = "info") => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // Poll the server for orders.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch("/api/orders", { cache: "no-store" });
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { orders: Order[]; serverTime: string };
        if (stopped) return;
        setClockOffset(Date.parse(data.serverTime) - Date.now());
        setConnected(true);

        // Detect arrivals and cancellations since the last poll.
        const prev = known.current;
        if (prev) {
          const arrivals = data.orders.filter((o) => o.status === "new" && !prev.has(o.id));
          if (arrivals.length) chime.play();
          for (const o of data.orders) {
            const before = prev.get(o.id);
            if (o.status === "cancelled" && before && before !== "cancelled") {
              toast(`Order #${o.displayId} was cancelled by Uber`, "error");
            }
          }
        }
        known.current = new Map(data.orders.map((o) => [o.id, o.status]));
        setOrders(data.orders);
        setLoaded(true);
      } catch {
        if (!stopped) setConnected(false);
      } finally {
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }
    }
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [chime, toast, router]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  const serverNow = now + clockOffset;

  async function act(order: Order, type: ActionType, extra: Record<string, string> = {}) {
    setBusy((b) => new Set(b).add(order.id));
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) {
        toast(body.error ?? "Something went wrong", "error");
        return;
      }
      const updated = body.order as Order;
      known.current?.set(updated.id, updated.status);
      setOrders((list) => list.map((o) => (o.id === updated.id ? updated : o)));
    } catch {
      toast("Can't reach the server — check the connection", "error");
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(order.id);
        return next;
      });
    }
  }

  const columns = useMemo(() => {
    const newest = (a: Order, b: Order) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
    return {
      incoming: orders.filter((o) => o.status === "new").sort(newest),
      making: orders.filter((o) => o.status === "accepted" || o.status === "preparing").sort(newest),
      ready: orders.filter((o) => o.status === "ready").sort(newest),
    };
  }, [orders]);

  const history = useMemo(() => {
    const today = new Date(serverNow).toDateString();
    return orders
      .filter((o) => ["picked_up", "rejected", "cancelled", "expired"].includes(o.status))
      .filter((o) => new Date(o.receivedAt).toDateString() === today)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  }, [orders, serverNow]);

  const completedToday = history.filter((o) => o.status === "picked_up").length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-line/70 px-8 py-5">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-caramel text-xl text-caramel-ink shadow-card">☕</div>
          <div>
            <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight">{cafeName}</h1>
            <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">Barista board · Uber Eats</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <Stat label="Waiting" value={columns.incoming.length} highlight={columns.incoming.length > 0} />
          <Stat label="Making" value={columns.making.length} />
          <Stat label="Done today" value={completedToday} />
          <span
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${
              connected ? "bg-sage-soft text-sage" : "bg-berry-soft text-berry"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-sage" : "bg-berry animate-pulse"}`} />
            {connected ? "Live" : "Reconnecting…"}
          </span>
          <time className="min-w-24 text-right font-display text-3xl tabular-nums">
            {now ? timeFmt.format(new Date(serverNow)) : ""}
          </time>
          <button
            onClick={() => setHistoryOpen(true)}
            className="rounded-full border border-line px-4 py-2 text-sm font-medium hover:bg-surface-2"
          >
            Today
          </button>
          <button
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              router.replace("/login");
            }}
            className="text-sm text-ink-soft hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      {!connected && (
        <div role="status" className="bg-berry px-8 py-2 text-center text-sm font-medium text-white">
          Connection lost — new orders won&apos;t appear until it&apos;s back. Retrying…
        </div>
      )}

      {/* Columns */}
      <main className="grid min-h-0 flex-1 grid-cols-3 gap-6 px-8 py-6">
        <Column title="New orders" subtitle="Accept within the time limit" count={columns.incoming.length} accent="caramel">
          {columns.incoming.map((o) => (
            <OrderCard key={o.id} order={o} now={serverNow} busy={busy.has(o.id)}>
              <button onClick={() => act(o, "accept")} disabled={busy.has(o.id)} className="btn-primary flex-1 rounded-xl bg-caramel py-3 font-semibold text-caramel-ink transition hover:brightness-110 disabled:opacity-50">
                Accept
              </button>
              <button onClick={() => setRejecting(o)} disabled={busy.has(o.id)} className="rounded-xl border border-line px-5 py-3 font-medium text-ink-soft transition hover:border-berry hover:text-berry disabled:opacity-50">
                Reject
              </button>
            </OrderCard>
          ))}
          {loaded && columns.incoming.length === 0 && <Empty text="No new orders. Time for a cortado." />}
        </Column>

        <Column title="In progress" subtitle="Being made" count={columns.making.length} accent="ink">
          {columns.making.map((o) => (
            <OrderCard key={o.id} order={o} now={serverNow} busy={busy.has(o.id)}>
              {o.status === "accepted" && (
                <button onClick={() => act(o, "start")} disabled={busy.has(o.id)} className="rounded-xl border border-line px-5 py-3 font-medium transition hover:bg-surface-2 disabled:opacity-50">
                  Start
                </button>
              )}
              <button onClick={() => act(o, "ready")} disabled={busy.has(o.id)} className="flex-1 rounded-xl bg-sage py-3 font-semibold text-white transition hover:brightness-110 disabled:opacity-50 dark:text-[#14200f]">
                Mark ready
              </button>
            </OrderCard>
          ))}
          {loaded && columns.making.length === 0 && <Empty text="Nothing on the bar." />}
        </Column>

        <Column title="Ready" subtitle="Waiting for pickup" count={columns.ready.length} accent="sage">
          {columns.ready.map((o) => (
            <OrderCard key={o.id} order={o} now={serverNow} busy={busy.has(o.id)}>
              <button onClick={() => act(o, "pickup")} disabled={busy.has(o.id)} className="flex-1 rounded-xl border border-sage py-3 font-semibold text-sage transition hover:bg-sage-soft disabled:opacity-50">
                Picked up
              </button>
            </OrderCard>
          ))}
          {loaded && columns.ready.length === 0 && <Empty text="No orders waiting for pickup." />}
        </Column>
      </main>

      {/* Start-of-shift overlay: browsers only allow sound after a click. */}
      {!started && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 backdrop-blur-sm">
          <div className="max-w-md rounded-3xl bg-surface p-10 text-center shadow-card animate-card-in">
            <h2 className="font-display text-3xl font-semibold">Ready for the rush?</h2>
            <p className="mt-3 text-ink-soft">Click below so the board can chime when a new order arrives.</p>
            <button
              autoFocus
              onClick={() => {
                chime.enable();
                chime.play();
                setStarted(true);
              }}
              className="mt-8 rounded-xl bg-caramel px-8 py-3 font-semibold text-caramel-ink transition hover:brightness-110"
            >
              Start shift 🔔
            </button>
          </div>
        </div>
      )}

      {rejecting && (
        <RejectDialog
          order={rejecting}
          onCancel={() => setRejecting(null)}
          onConfirm={(reason, explanation) => {
            const o = rejecting;
            setRejecting(null);
            void act(o, "reject", { reason, explanation });
          }}
        />
      )}

      {historyOpen && <HistoryDrawer orders={history} onClose={() => setHistoryOpen(false)} />}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-card-in rounded-xl px-5 py-3 text-sm font-medium shadow-card ${
              t.tone === "error" ? "bg-berry text-white" : "bg-ink text-bg"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="text-center">
      <div className={`font-display text-2xl font-semibold tabular-nums ${highlight ? "text-caramel" : ""}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-[0.15em] text-ink-soft">{label}</div>
    </div>
  );
}

function Column(props: {
  title: string;
  subtitle: string;
  count: number;
  accent: "caramel" | "ink" | "sage";
  children: React.ReactNode;
}) {
  const bar = { caramel: "bg-caramel", ink: "bg-ink-soft", sage: "bg-sage" }[props.accent];
  return (
    <section className="flex min-h-0 flex-col rounded-3xl border border-line/70 bg-surface-2/40 p-4">
      <div className="mb-4 flex items-end justify-between px-2">
        <div>
          <div className={`mb-2 h-1 w-10 rounded-full ${bar}`} />
          <h2 className="font-display text-xl font-semibold">{props.title}</h2>
          <p className="text-xs text-ink-soft">{props.subtitle}</p>
        </div>
        <span className="font-display text-3xl font-light text-ink-soft tabular-nums">{props.count}</span>
      </div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-2 pt-1">{props.children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-line p-10 text-center font-display text-lg italic text-ink-soft">
      {text}
    </div>
  );
}

function OrderCard({
  order,
  now,
  busy,
  children,
}: {
  order: Order;
  now: number;
  busy: boolean;
  children: React.ReactNode;
}) {
  const isNew = order.status === "new";
  const cd = countdown(order.acceptDeadline, now);
  const urgent = isNew && cd.ms < 3 * 60 * 1000;
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);

  return (
    <article
      className={`animate-card-in overflow-hidden rounded-2xl border bg-surface shadow-card transition ${
        urgent ? "border-berry" : "border-line"
      } ${isNew ? "animate-ring" : ""} ${busy ? "opacity-70" : ""}`}
    >
      {isNew && (
        <div className="h-1.5 bg-surface-2">
          <div
            className={`h-full transition-[width] duration-1000 ease-linear ${urgent ? "bg-berry" : "bg-caramel"}`}
            style={{ width: `${Math.max(0, cd.fraction) * 100}%` }}
          />
        </div>
      )}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="font-display text-2xl font-semibold tracking-tight">#{order.displayId}</span>
              {order.customerName && <span className="text-lg font-medium">{order.customerName}</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
              {order.orderType && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium">
                  {ORDER_TYPE_LABEL[order.orderType] ?? order.orderType}
                </span>
              )}
              <span>{minutesAgo(order.placedAt ?? order.receivedAt, now)}</span>
              {itemCount > 0 && <span>· {itemCount} item{itemCount === 1 ? "" : "s"}</span>}
              {order.status === "preparing" && <span className="font-medium text-caramel">· Making</span>}
            </div>
          </div>
          {isNew ? (
            <div className={`text-right ${urgent ? "text-berry" : "text-ink-soft"}`}>
              <div className="font-display text-2xl font-semibold tabular-nums">{cd.label}</div>
              <div className="text-[10px] uppercase tracking-widest">to accept</div>
            </div>
          ) : order.readyBy ? (
            <div className="text-right text-ink-soft">
              <div className="font-display text-lg tabular-nums">{timeFmt.format(new Date(order.readyBy))}</div>
              <div className="text-[10px] uppercase tracking-widest">ready by</div>
            </div>
          ) : null}
        </div>

        {!order.detailsLoaded ? (
          <div className="mt-4 space-y-2" aria-label="Loading order details">
            <div className="shimmer h-4 w-3/4 rounded" />
            <div className="shimmer h-4 w-1/2 rounded" />
            <p className="pt-1 text-xs text-ink-soft">Fetching order from Uber…</p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line/70">
            {order.items.map((item, i) => (
              <li key={i} className="py-2.5">
                <div className="flex gap-3">
                  <span className="min-w-7 font-display text-lg font-semibold text-caramel tabular-nums">{item.quantity}×</span>
                  <div className="flex-1">
                    <div className="text-[15px] font-semibold leading-snug">{item.title}</div>
                    {item.options.map((opt) => (
                      <div key={opt} className="text-sm text-ink-soft">{opt}</div>
                    ))}
                    {item.note && (
                      <div className="mt-1 rounded-md bg-amber-soft px-2 py-1 text-sm italic">“{item.note}”</div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {order.specialInstructions && (
          <div className="mt-3 rounded-xl border border-caramel/40 bg-amber-soft px-3 py-2 text-sm">
            <span className="font-semibold">Note: </span>
            <span className="italic">{order.specialInstructions}</span>
          </div>
        )}

        <div className="mt-4 flex gap-2">{children}</div>
      </div>
    </article>
  );
}

function RejectDialog({
  order,
  onCancel,
  onConfirm,
}: {
  order: Order;
  onCancel: () => void;
  onConfirm: (reason: string, explanation: string) => void;
}) {
  const [reason, setReason] = useState<string>("CAPACITY");
  const [explanation, setExplanation] = useState("");
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 backdrop-blur-sm" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-title"
        className="w-full max-w-md rounded-3xl bg-surface p-8 shadow-card animate-card-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id="reject-title" className="font-display text-2xl font-semibold">Reject order #{order.displayId}?</h2>
        <p className="mt-1 text-sm text-ink-soft">Uber will cancel it and tell the customer.</p>
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Reason</legend>
          {REJECT_REASONS.map((r) => (
            <label
              key={r.code}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 ${
                reason === r.code ? "border-berry bg-berry-soft" : "border-line"
              }`}
            >
              <input type="radio" name="reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} className="accent-[var(--berry)]" />
              {r.label}
            </label>
          ))}
        </fieldset>
        <input
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          maxLength={200}
          placeholder="Optional note for Uber"
          className="mt-4 w-full rounded-xl border border-line bg-bg px-4 py-2.5 text-sm outline-none focus:border-berry"
        />
        <div className="mt-6 flex justify-end gap-3">
          <button autoFocus onClick={onCancel} className="rounded-xl px-5 py-2.5 font-medium text-ink-soft hover:bg-surface-2">
            Keep order
          </button>
          <button onClick={() => onConfirm(reason, explanation)} className="rounded-xl bg-berry px-5 py-2.5 font-semibold text-white hover:brightness-110">
            Reject order
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryDrawer({ orders, onClose }: { orders: Order[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/30 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        className="h-full w-[420px] overflow-y-auto bg-surface p-8 shadow-card"
        onClick={(e) => e.stopPropagation()}
        aria-label="Today's finished orders"
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="font-display text-2xl font-semibold">Today</h2>
          <button onClick={onClose} className="text-sm text-ink-soft hover:text-ink">Close</button>
        </div>
        {orders.length === 0 && <p className="italic text-ink-soft">No finished orders yet today.</p>}
        <ul className="space-y-3">
          {orders.map((o) => {
            const badge = STATUS_BADGE[o.status];
            return (
              <li key={o.id} className="rounded-xl border border-line p-4">
                <div className="flex items-center justify-between">
                  <span className="font-display text-lg font-semibold">
                    #{o.displayId} {o.customerName && <span className="font-sans text-base font-medium">{o.customerName}</span>}
                  </span>
                  {badge && <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>}
                </div>
                <p className="mt-1 text-sm text-ink-soft">
                  {timeFmt.format(new Date(o.receivedAt))} · {o.items.map((i) => `${i.quantity}× ${i.title}`).join(", ") || "—"}
                </p>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}

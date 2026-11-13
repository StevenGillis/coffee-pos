# Coffee POS — Technical Design (v1)

**Phase:** 3 (Design) · **Date:** 2026-11-13 · Implements [PRD.md](PRD.md)

## Architecture

```
Uber Eats ──webhook (signed)──► /api/webhooks/uber ──► database ◄── /api/orders ◄── barista screen (polls every 2 s)
    ▲                                   │                                   │
    └──── accept / deny (REST) ◄────────┴──── lib/uber.ts ◄─────────────────┘  (Accept / Reject buttons)
```

- **Next.js 16 (App Router) + TypeScript + Tailwind 4**, deployed on **Vercel**.
- **Database:** Postgres. Locally an embedded Postgres (PGlite, stored in `~/.coffee-pos/`), so there's nothing to install. In production a hosted Postgres (Supabase or Neon) via `DATABASE_URL`. Same SQL for both.
- **Live updates:** the screen polls `/api/orders` every 2 s. Works on Vercel without websockets and meets the 5 s target.
- **Auth:** one shared store passcode → signed, httpOnly cookie (HMAC-SHA256 with `SESSION_SECRET`, 12 h). Checked in `proxy.ts` (redirect) **and** in each API route (real enforcement). The webhook is exempt; it uses Uber's signature instead.

## Uber integration (from Uber developer docs)

| Concern | Detail |
|---|---|
| Webhook verify | `X-Uber-Signature` = lowercase hex HMAC-SHA256 of the raw body, keyed with the client secret. Constant-time compare. |
| Events handled | `orders.notification` (new), `orders.cancel` / `orders.failure` (cancelled). Others acknowledged and ignored. |
| Idempotency | `event_id` stored with a unique key; repeats return 200 and do nothing. Orders keyed by Uber order id. |
| Response | 200, empty body, immediately. Order details are fetched afterwards using `after()`. |
| Order details | `GET /v2/eats/order/{id}` |
| Accept | `POST /v1/eats/orders/{id}/accept_pos_order` with `pickup_time` = now + `PREP_MINUTES` |
| Deny | `POST /v1/eats/orders/{id}/deny_pos_order` with `reason.code` + `explanation` |
| Deadline | Accept/deny within **11.5 min** or Uber auto-cancels. Screen shows a countdown. |
| Auth | Client-credentials token, scope `eats.order`, cached (30 day lifetime, 100 tokens/hour limit). Sandbox: `sandbox-login.uber.com` + `test-api.uber.com`. |
| "Ready" | Uber's docs show **no "mark ready" endpoint** for Uber-delivered orders. Ready/Picked up are tracked in our app only. |

**Known doc ambiguity:** Uber's sandbox guide also shows newer `/v1/delivery/orders/...` paths. Paths are kept in one file (`src/lib/uber.ts`) so we can switch once Uber support confirms which to use.

**Modes** (`UBER_MODE`): `mock` makes no network calls (local dev + simulator), `sandbox` hits Uber's test environment, `production` hits the real API.

## Data model

```
uber_events(event_id PK, event_type, order_id, received_at)
orders(id PK = Uber order id, display_id, status, customer_name, order_type,
       items JSONB, special_instructions, placed_at, ready_by, received_at,
       accepted_at, ready_at, completed_at, reject_reason, details_loaded, updated_at)
mock_uber_orders(id PK, payload JSONB)   -- mock mode only
```

`status`: `new → accepted → preparing → ready → picked_up`, plus `rejected`, `cancelled`, `expired`.

## UI

Desktop, ≥ 1280 px. Three columns: **New** (accept/reject + countdown) · **In progress** (accepted/preparing) · **Ready**. Header with café name, clock, connection status and a "Today" history drawer. Warm espresso/cream palette, serif display type (Fraunces) and clean sans text (Inter), light + dark mode. A chime plays on new orders. Browsers block sound until the first click, so the screen asks for one click to start.

## Milestones

1. Foundation: scaffold, env, DB layer, passcode login ✅ *this build*
2. Webhook + Uber client + mock mode + simulator ✅ *this build*
3. Barista screen ✅ *this build*
4. Automated tests for AC1–AC10 ✅ *this build*
5. Sandbox end-to-end (needs test store + client id) and Vercel deploy
6. Roadmap: menu sync, counter sales, payments

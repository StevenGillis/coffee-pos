# Coffee POS — Product Requirements (v1)

**Status:** Draft for review · **Phase:** 2 (Specify) · **Date:** 2026-11-12

## 1. Goal

Give the café a polished, browser-based barista screen that receives **Uber Eats orders** automatically, lets staff accept them, track preparation, and mark them ready — without touching a tablet from Uber.

## 2. Decisions made in Discovery

| Topic | Decision |
|---|---|
| Order source (v1) | Uber Eats only (option B). No walk-in counter sales yet. |
| Payments | Handled entirely by Uber. The app never touches card data. |
| Menu | Owner manages the menu in **Uber Eats Manager**. The app reads items/options from incoming orders; it does not edit the menu. *(Assumption — see Open Questions #1.)* |
| Device | Desktop browser (mouse + keyboard), landscape, ≥ 1280 px wide. |
| Screens | One: the barista order screen (plus a passcode screen). |
| Stack | Next.js + TypeScript + Tailwind, hosted on Vercel, Supabase (Postgres + Realtime). |
| Uber environment | Sandbox/test credentials only in v1. Production requires Uber approval. |

## 3. Users

- **Barista** — watches the queue, accepts orders, prepares drinks, marks orders ready.
- **Owner** — same as barista; also configures the app (env vars, passcode).

## 4. In scope (v1)

1. **Receive orders** — Uber Eats sends a webhook when an order is placed; the app verifies it is genuinely from Uber, fetches full order details, and saves them.
2. **Barista screen** — live queue of order cards showing: customer first name, Uber order code, items, quantities, options (size, milk, extras), special instructions, time placed, pickup ETA.
3. **Accept / reject** — new orders must be accepted or rejected from the screen within Uber's required time window. Rejection asks for a reason.
4. **Order status flow** — `New → Accepted → Preparing → Ready → Picked up`, plus `Rejected` and `Cancelled` (when Uber/customer cancels).
5. **Status sync to Uber** — status changes that Uber supports (accept, reject, ready) are sent back to Uber.
6. **Alerts** — sound + visual highlight when a new order arrives; urgent styling when the accept deadline is close.
7. **Today's history** — collapsible list of completed/cancelled orders for the current day.
8. **Access protection** — a single shared store passcode is required to view the screen (it's on the public internet).
9. **Look & feel** — "fancy café" aesthetic: warm palette, elegant typography, smooth animations, light & dark mode.

## 5. Out of scope (v1)

Counter/walk-in sales · in-app card payments · menu editing or menu sync to Uber · tips & receipts · sales reports · individual staff logins · multiple stores · printing · production Uber go-live.

## 6. Non-functional requirements

- **Speed:** a new order appears on screen within 5 seconds of Uber's webhook.
- **Reliability:** webhook endpoint responds quickly and is idempotent (the same order received twice is stored once). If the screen loses connection it shows a warning and reconnects.
- **Security:** Uber webhook signatures verified; secrets only in environment variables (`.env.local` locally, Vercel env vars in production), never in git; passcode-protected screen; no card data stored.
- **Privacy:** store only what's needed to make the order (first name, items, notes). Delete customer details after 30 days.
- **Usability:** readable from ~1 m away; primary actions reachable with one click.

## 7. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC1 | The screen is open | Uber sandbox sends an order webhook | A new order card appears within 5 s with an alert sound |
| AC2 | A webhook arrives with an invalid signature | — | It is rejected and no order is created |
| AC3 | The same order webhook arrives twice | — | Only one order card exists |
| AC4 | A new order is on screen | Barista clicks **Accept** | Order moves to Accepted and Uber is notified |
| AC5 | A new order is on screen | Barista clicks **Reject** and picks a reason | Order moves to Rejected and Uber is notified |
| AC6 | An order is Preparing | Barista clicks **Ready** | Order moves to Ready (tracked in-app; Uber's docs show no "ready" endpoint) |
| AC7 | An accepted order | Uber sends a cancellation | Card shows Cancelled and leaves the active queue |
| AC8 | An order has options and a note | It is displayed | Every option and the note are clearly visible on the card |
| AC9 | Someone opens the app URL | They don't know the passcode | They cannot see any orders |
| AC10 | The screen loses connection | — | A visible "Reconnecting…" banner shows until restored |

## 8. Open questions (defaults used in v1 build)

1. **Menu ownership** — v1: menu edited in Uber Eats Manager; app does not edit menu. *Confirm.*
2. **Auto-accept** — v1 default: manual accept, with an 11.5-minute countdown (Uber auto-cancels after that).
3. **Picked up** — v1 default: barista clicks "Picked up" to clear a Ready order.
4. **Uber API version** — Uber's docs show two sets of order endpoints. Confirm with Uber Integration Tech Support which to use (see DESIGN.md).

## 9. Testing approach

- **Simulated webhooks (daily development):** a local script sends correctly signed fake Uber order webhooks to the app. Covers AC1–AC3, AC7, AC8 without involving Uber, and runs in automated tests.
- **Uber sandbox (end-to-end):** a test store from Uber Integration Tech Support; orders placed manually in the Uber Eats app with the test developer account, delivering to the test store's address. The store must be open with "Accept Orders" enabled. Webhooks need a public HTTPS URL: a Vercel preview deployment or a local tunnel.
- **Sandbox hosts:** tokens and API calls must use matching sandbox domains (e.g. `test-api.uber.com`). Confirm the exact auth host for your app.

## 10. Later phases (roadmap)

1. Menu built in the app and synced to Uber Eats
2. Counter sales + card payments (e.g. Stripe Terminal)
3. Tips, receipts, sales reports, staff logins
4. Uber production go-live

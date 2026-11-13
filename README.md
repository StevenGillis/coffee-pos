# Barista Board (Coffee POS v1)

Uber Eats orders on a desktop barista screen. See [docs/PRD.md](docs/PRD.md) (requirements) and [docs/DESIGN.md](docs/DESIGN.md) (design).

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in the values (already done on the owner's machine)
npm run dev                  # http://localhost:3000 — sign in with STORE_PASSCODE
```

## Fake Uber orders (UBER_MODE=mock)

```bash
npm run simulate             # one random order
npm run simulate -- 3        # three orders
npm run simulate -- duplicate
npm run simulate -- cancel <order id>
```

## Checks

```bash
npm test          # acceptance-criteria tests
npm run lint
npm run typecheck
npm run build
```

## Modes

| `UBER_MODE` | What happens |
|---|---|
| `mock` | No calls to Uber. Use the simulator. |
| `sandbox` | Uber test environment (needs `UBER_CLIENT_ID`, a test store, and a public HTTPS webhook URL). |
| `production` | Real orders. Only after Uber approves the integration. |

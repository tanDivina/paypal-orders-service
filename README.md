# paypal-orders-service

Backend microservice for the **PayPal Orders & Subscriptions** contract: JWT-authenticated API, SQLite schema with a migration runner, PayPal Orders v2 (authorize/capture) integration and a webhook reconciliation engine.

## Milestones

1. **Auth & database schema with migration scripts** — `src/auth.ts`, `src/db.ts`, `migrations/` (merged).
2. **PayPal Orders v2 & webhook reconciliation engine** — Orders v2 authorize/capture client with idempotency keys, `verify-webhook-signature` enforcement on every webhook, reconciliation into the orders table, and a live health endpoint.
3. **Load testing, error recovery & production staging** — not started.

## Develop

```bash
npm ci
npm test        # vitest, coverage gate at 85%
npm run typecheck
npm start       # serves on PORT (default 8787)
```

Configuration comes from the environment: `PAYPAL_API_BASE` (defaults to the PayPal sandbox), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `AUTH_JWT_SECRET`, `DB_PATH`.

Integration tests run the real HTTP server against a local stand-in of the PayPal REST API, so they exercise the full request path (auth, idempotency headers, signature verification) without needing sandbox credentials in CI.

---

*This repository is also the worked example that [D'accord](https://github.com/tanDivina/daccord) verifies in its demo.*

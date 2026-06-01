# Auto-Fulfillment System

This document explains the auto-fulfillment subsystem end-to-end so any
developer can safely work on it, debug it, and set it up from scratch.

---

## 1. What it does

When a customer pays for a Stars / Premium order, the server tries to deliver
the order automatically through a configured provider instead of waiting for
a human admin to push the button. If auto-fulfillment cannot run (no provider
configured, low balance, network error, etc.) the order stays pending and
admins are notified — the order is **never** auto-marked as failed for
infra reasons.

---

## 2. Architecture

```
order paid
   │
   ▼
StarsService.fulfill(order)
   │
   ▼
services/fulfillment/index.js  ── orchestrator
   │
   ├── picks providers in priority order (per-product-type)
   ├── skips providers that are not configured
   ├── calls provider.fulfill(order)
   └── on success → mark COMPLETED
       on hard failure → try next provider
       on no providers → revert to QUEUED + notify admins
```

### Providers

All providers live in `services/fulfillment/providers/` and implement the
same shape (see `services/fulfillment/types.js`):

| File                     | Provider           | Status      |
|--------------------------|--------------------|-------------|
| `reseller-istar.js`      | iStar / fragmentapi.com | Production |
| `reseller-qonix.js`      | Qonix              | Optional / failover |
| `fragment-sdk.js`        | Self-hosted Fragment SDK | Scaffold only — do NOT enable |
| `manual.js`              | Manual admin fallback | Always available |

Each provider exports:

```js
{
  id: 'istar',
  isConfigured(): boolean,         // returns false if env vars missing
  health(): Promise<{ ok, balance, error? }>,
  fulfill(order): Promise<{ status, providerOrderId?, error? }>,
  // optional: webhook handler if provider supports async callbacks
}
```

**Graceful degradation rule:** `isConfigured()` must return `false` (never
throw) when env vars are missing. The orchestrator filters out unconfigured
providers before attempting any network call.

---

## 3. Order lifecycle

```
PENDING ──pay──▶ PAID ──fulfill()──▶ PROCESSING ──▶ COMPLETED
                                          │
                                          ├──▶ QUEUED   (no provider configured / low balance)
                                          └──▶ FAILED   (provider explicitly rejected the order)
```

Important: `QUEUED` is the safe state. It means "we couldn't try right now,
keep it for retry / manual completion". Admins get a Telegram notification
explaining why (missing API key, low balance, network, etc.).

`FAILED` is reserved for hard rejections from the provider (e.g. invalid
username, product unavailable). The customer is refundable in this state.

---

## 4. Setup (from zero)

### 4.1 Pick a provider

Start with **iStar** (fragmentapi.com). It is the simplest:
1. Sign up at https://fragmentapi.com
2. Pre-fund the account in TON
3. Generate an API key + webhook secret

### 4.2 Set Railway environment variables

In Railway → service → **Variables**:

| Variable               | Required | Default                          |
|------------------------|----------|----------------------------------|
| `ISTAR_API_KEY`        | yes      | —                                |
| `ISTAR_BASE_URL`       | no       | `https://istar.fragmentapi.com`  |
| `ISTAR_WEBHOOK_SECRET` | yes      | —                                |

Restart the service after saving.

> Note: the README in `docs/AUTO_FULFILLMENT_SETUP.md` still lists the old
> default `https://api.fragmentapi.com`. The correct host is
> `https://istar.fragmentapi.com` and that is the new code default.

### 4.3 Register the webhook

Paste this URL into the iStar dashboard:

```
https://<your-domain>/api/public/fulfillment/istar/webhook
```

### 4.4 Enable in admin panel

1. Open **Admin → Auto-Fulfillment**.
2. Click **Check Provider Health** → expect `OK` + balance.
3. Pick provider per product type (Stars / Premium).
4. Set **Max auto-fulfill amount (USDT)** — recommend `100`.
5. Flip the master toggle ON.
6. Place a $1 test order on your own account.

If anything looks wrong, flip the master toggle OFF — the system reverts to
manual admin completion immediately, no downtime.

---

## 5. Debugging cheatsheet

| Symptom in Health card                  | Likely cause                            |
|-----------------------------------------|------------------------------------------|
| `API key not configured`                | `ISTAR_API_KEY` missing on Railway       |
| `fetch failed` / DNS / SSL              | wrong `ISTAR_BASE_URL` or network egress |
| `Insufficient balance`                  | Pre-fund the provider account            |
| `Unauthorized` / `401`                  | Wrong API key                            |
| `OK` but orders go to QUEUED            | Product type not mapped to provider, or amount exceeds cap |

Useful files when debugging:
- `services/fulfillment/index.js` — orchestrator + admin notifications
- `services/fulfillment/providers/reseller-istar.js` — health + fulfill
- `public/admin/main.js` (`fulfillment` view) — UI + health calls
- Webhook routes under `src/routes/api/public/fulfillment/`

---

## 6. Safety rules for contributors

1. **Never throw from `isConfigured()`** — return `false` instead. The
   orchestrator depends on this to skip providers cleanly.
2. **Never mark an order `FAILED` for infrastructure reasons.** Revert to
   `QUEUED`, decrement `fulfillmentAttempts`, and notify admins.
3. **Never log API keys or webhook secrets.** Health output is shown in the
   admin panel — keep it free of credentials.
4. **Webhook handlers must verify the signature** before mutating order state.
5. **Don't touch `fragment-sdk.js` for real flows** — it is scaffold only
   (Phase 3). Setting `TON_SEED_PHRASE` etc. on Railway is unsafe today.
6. **Master toggle OFF must be a true kill-switch.** When off, the orchestrator
   must short-circuit to the manual provider — no provider calls.

---

## 7. Money flow recap

1. Customer pays USDT → your TON wallet → order `paid`.
2. Server calls provider, which deducts from your pre-funded balance with
   that provider (not per-order on-chain).
3. Provider buys Stars on Fragment, delivers to customer `@username`.
4. Provider POSTs success/failure to your webhook → order `completed` /
   `failed`.
5. You keep the margin (customer price − reseller cost).
6. Top up the provider balance before it runs out (admin panel shows it).

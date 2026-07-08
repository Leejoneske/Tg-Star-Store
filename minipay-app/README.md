# StarStore MiniPay Checkout

A standalone React + TypeScript mini-app for buying Telegram Stars/Premium
with a MiniPay stablecoin wallet (cUSD, USDC, USDT on Celo).

This is intentionally **separate** from the main Telegram Mini App
(`public/index.html`, etc.) — MiniPay's wallet only injects into Opera Mini's
browser or the MiniPay app's own in-app browser, never into Telegram's
WebView. This app is meant to be opened there instead: either found directly
(e.g. listed in MiniPay's own Mini App directory) or reached via a "Pay with
MiniPay" link from the Telegram app, which hands off out of Telegram entirely.

If someone opens this without a MiniPay/Opera Mini wallet available, or wants
to pay with TON/GRAM/their Telegram Stars balance instead, the page points
them back to the Telegram bot — set your bot's real `t.me` link in
`src/screens/Buy.tsx` (`TELEGRAM_BOT_URL`).

## Structure

```
src/
  screens/    Intro (onboarding), Buy (checkout), Status (confirmation/polling)
  components/ HeroCard (dark summary card), StepTracker (progress indicator)
  lib/        api.ts (backend calls), minipay.ts (wallet detection + tx send),
              pricing.ts (local price table, mirrors the server's)
```

No React Router — only three linear screens, handled with simple state in
`App.tsx`. No web3 SDK — MiniPay only needs a couple of raw
`window.ethereum.request(...)` calls, so `lib/minipay.ts` hand-encodes the
ERC-20 `transfer()` call instead of pulling in viem/ethers.

## Backend

Talks to three endpoints already added to the main `server.js`:
- `POST /api/minipay/create-order`
- `POST /api/minipay/submit-tx`
- `GET  /api/minipay/status/:orderId`

The actual on-chain verification and star/Premium delivery happen entirely
server-side (see `services/celo-transaction-service.js` and the existing
30-second background job in `server.js`) — this app only ever asks MiniPay to
sign a transfer and then polls for the result.

## Build & deploy

This app builds directly into the main project's `public/miniapp/` folder —
no manual copy step needed:

```bash
cd minipay-app
npm install
npm run build
```

`server.js` serves the built shell at `/buy-minipay` (and `/miniapp`); the
hashed JS/CSS output is picked up automatically by the existing
`express.static('public')` middleware. Whenever you change this app, just
re-run `npm run build` and redeploy — the shell HTML is served with
`Cache-Control: no-cache`, so there's no stale-page risk, and Vite
fingerprints the asset filenames so old and new builds never collide.

## Local development

```bash
npm run dev
```

Runs Vite's dev server. Note the MiniPay wallet still won't inject unless
you're actually inside MiniPay/Opera Mini — for real device testing, use
MiniPay's Developer Mode (tap the version number in its settings repeatedly)
pointed at an `ngrok` tunnel of `npm run dev`.

# StarStore MiniPay Checkout — PRD

## Original problem statement
"Pull code from main make sure you use the code as original, don't invent your codespace since we will push updates to main. Now i want you to check the Minipay code in this repository, understand what is supposed to do and improve the UI. I will share a screenshot so you can UI it as the screenshot (from intro to the end). Also keep the app miniapp function as supposed to be."

Reference screenshot provided by user showed 3 mobile mockups: a dark "wallet security/onboarding" screen with checklist + white pill CTA, a light wallet-dashboard screen with a big prominent balance number + icon action row + asset list rows, and a "Confirm Transaction" screen with a big icon+amount hero and an orange CTA pinned to the bottom.

## App context
`StarStore` is a Telegram Mini App (Node/Express monolith at repo root, `server.js`) for buying Telegram Stars/Premium. `/app/minipay-app` is a **separate** standalone React 19 + TypeScript + Vite sub-app ("MiniPay checkout") meant to be opened inside the MiniPay wallet / Opera Mini in-app browser (never inside Telegram's webview) so users can pay with Celo stablecoins (cUSD/USDC/USDT) directly. It builds into `public/minipay/` and is served by the main Express server at `/minipay`, `/buy-minipay`, `/miniapp`.

Three linear screens (no router, plain state machine in `App.tsx`):
1. **Intro** — onboarding / value props
2. **Buy** — package + recipient + token form → Review (confirm & pay)
3. **Status** — polls order status after payment (confirming/delivering/done/failed)

Backend endpoints used (already existed, unchanged): `POST /api/minipay/create-order`, `POST /api/minipay/submit-tx`, `GET /api/minipay/status/:orderId`.

## What's been implemented (Feb 2026)
- Pulled existing `main` branch code as-is (no reinvented scaffold).
- Explored and reused existing coral/dark theme already present in `index.css`/`common.css` (previous session had partially aligned it to a similar reference).
- Restructured `Buy.tsx`/`Buy.css`:
  - New header: circular brand icon + "StarStore" + subtitle "Stars & Premium checkout".
  - New **hero card** (`order-total-hero`) showing a large, prominent total amount + package label + Stars/Premium pill toggle inside the card — mirrors the reference's big wallet-balance display.
  - Restyled MiniPay-not-detected notice card (removed off-theme yellow, now gold-soft/ink consistent with single-accent design language).
  - Sticky bottom CTA (`.sticky-footer`) on both the form and review screens so the primary action button stays reachable while scrolling, matching the reference's fixed bottom button pattern.
- Restructured `ReviewHeader.tsx`/`.css` into a "Confirm Transaction" hero: uppercase eyebrow label, big centered icon badge (star/premium) + large $ amount + package label, matching the reference's Confirm Transaction screen exactly.
- Fixed disabled-button styling (`btn-primary:disabled`) — was translucent coral (looked pink/error-like), now a clean neutral grey with sufficient text contrast (a11y nit found & fixed after first test pass).
- Added `data-testid` to every interactive element across Intro/Buy/Review/Status screens.
- Added `sticky-footer` (dark variant) to Intro screen CTA for consistency.
- No changes to business logic: wallet detection/connect (`lib/minipay.ts`), order/payment API calls (`lib/api.ts`), pricing (`lib/pricing.ts`), and the App.tsx route state machine are all untouched, per user's explicit request to keep miniapp function unchanged.
- Rebuilt production bundle into `public/minipay/assets/` (`npm run build`).
- Temporarily added `server.allowedHosts: true` to `vite.config.ts` `server` block for dev-preview only (does not affect `vite build`/production).

## Testing status
- `testing_agent_v3` frontend pass: Intro → Buy (toggle/package/token/username validation) → Review → Edit order, all verified PASS with zero console errors. One a11y contrast nit on disabled button found and fixed post-test.
- On-chain payment submission (actual MiniPay wallet transaction) NOT tested — requires a real MiniPay/Opera Mini wallet injection and live backend (MongoDB/Celo RPC/Telegram bot creds), none of which are configured in this preview sandbox. This is expected/out of scope for a UI-only pass.

## Iteration 2 (Feb 2026) — Icon cleanup + Intro polish
User feedback: "improve the intro, use the app icon and a good screen just like the screenshot, next improve the icons and make the app much cleaner."
- Intro screen now displays the real `app-icon.png` (StarStore star logo) inside a glossy dark rounded frame (`.intro-hero-frame`) with a teal radial glow behind it and a diagonal shine overlay — replacing the generic hand-drawn `StarsIllustration` SVG, matching the reference screenshot's polished centered-icon presentation.
- Installed `lucide-react` and replaced every hand-drawn inline SVG icon app-wide with clean, consistent lucide icons: checklist/package-row checkmarks (`Check`), `IconBadge` star/premium badges (`Star`/`Crown`), `TrustCard` shield+checkmarks (`ShieldCheck`/`Check`), Buy screen "not detected" notice icon (`Smartphone`), and Status screen illustrations rebuilt as a shared `GlowIcon` component (`Wallet`/`Check`).
- Removed now-unused `StarsIllustration` dead code.
- **Fixed 2 real CSS bugs** found during cleanup: undefined CSS variables `--mint-2` (Status.css background gradient) and `--green-ink` (NextSteps.css, used 3x) were silently failing — replaced with proper theme tokens (`--green-soft`, `--green`).
- Added consistent subtle shadow (`box-shadow: 0 1px 0 var(--line)`) to the base `.card` class for cleaner visual depth across all cards.
- `testing_agent_v3` regression pass: 100% pass rate, zero bugs, confirmed no broken/missing icons after the library swap and both CSS bugs verified fixed via computed-style checks.

## Not yet done / backlog
- P1: Split `Buy.tsx` (currently ~310 lines handling both form + review modes) into separate `Buy.tsx` + `Review.tsx` components for maintainability.
- P2: Add `data-testid` per individual package row (`pkg-row-${title}`) for more robust future automated testing.
- P2: Style `Status.tsx` (done/failed/timeout states) was left structurally unchanged (only testids added) — could receive the same hero-card/sticky-footer treatment for full end-to-end visual consistency if user wants further polish there.
- P2: Consider restyling `ConfirmSummary` rows as boxed "From/To" style cards (closer to some reference wallet UIs) if user wants pixel-level fidelity.

## Credentials
No auth/credentials involved in this mini-app (no login).

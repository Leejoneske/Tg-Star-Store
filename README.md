# StarStore

A Telegram Mini App platform for buying, selling, and trading Telegram Stars — with USDT conversion via TON blockchain, Telegram Premium subscriptions, referral rewards, and a full admin dashboard.

## Overview

StarStore is a full-featured Telegram Mini App built with Node.js and MongoDB. Users can:

- Buy Telegram Stars for themselves or as a gift for up to 5 recipients at once
- Sell Stars and receive USDT directly to their TON wallet
- Purchase Telegram Premium subscriptions (3, 6, or 12 months)
- Earn referral rewards through a structured referral program
- Withdraw earnings to any TON wallet
- Track complete transaction history and analytics

## Key Features

### Trading & Transactions
- Real-time Stars marketplace with competitive pricing
- Stars to USDT conversion at live rates
- Gift Stars to multiple recipients in one order (up to 5)
- Recipient validation with real Telegram profile lookup — shows name and avatar before checkout
- Direct Telegram Premium subscription purchases
- TON wallet integration with on-chain verification (TON and USDT-TON payment options)
- Sub-second transaction confirmation support (TON network April 2026+)

### User Experience
- Native Telegram Mini App (WebApp) integration
- Fragment-style recipient profile cards — verifies the user actually exists on Telegram before you pay
- Real-time transaction notifications
- Multi-language support (English, Russian, Hindi, Arabic)
- Dark and light theme
- Fully responsive mobile design

### Revenue & Engagement
- Referral program with 0.5 USDT per successful referral
- Daily check-in and missions system
- Ambassador tier program
- Built-in help system and knowledge base

### Administration
- Complete user and order management dashboard
- Real-time business analytics and metrics
- Manual order review, approval, and refund workflow
- Broadcast messaging system
- Financial controls for withdrawals
- User ban and restriction management
- Auto-fulfillment via iStar, Qonix, and Fragment SDK providers

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js 22.x, Express.js |
| Database | MongoDB 4.4+ with Mongoose ODM |
| Bot Framework | node-telegram-bot-api |
| Blockchain | TON Connect, Toncenter API |
| Frontend | Vanilla JavaScript, CSS3 |
| Testing | Jest |
| Deployment | Railway, Vercel |
| Analytics | TGAnalytics SDK |

## Prerequisites

- Node.js 22.x or higher
- MongoDB 4.4 or higher (local or cloud)
- Telegram Bot Token (from @BotFather)
- Telegram Payments Provider Token
- TON API Key (from toncenter.com)

## Installation & Setup

### 1. Clone Repository

```bash
git clone https://github.com/Leejoneske/Tg-Star-Store.git
cd Tg-Star-Store
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Telegram Bot
BOT_TOKEN=your_telegram_bot_token
WEBHOOK_URL=https://your-domain.com/webhook
PROVIDER_TOKEN=your_telegram_payments_provider_token

# Database
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/starstore

# Admin Access
ADMIN_IDS=123456789,987654321

# TON Blockchain
TON_MAINNET_ENDPOINT=https://toncenter.com/api/v2/
TON_API_KEY=your_toncenter_api_key

# Session Security
SESSION_SECRET=your_strong_session_secret

# TGAnalytics
TGANALYTICS_TOKEN=your_analytics_token
TGANALYTICS_APP_NAME=starstore
```

### 4. Start Application

Development mode with auto-reload:
```bash
npm run dev
```

Production mode:
```bash
npm start
```

Available at `http://localhost:3000`

## Project Structure

```
starstore/
├── server.js                        # Main application entry point
├── middleware/
│   └── telegramAuth.js             # Telegram WebApp auth middleware
├── services/
│   ├── fulfillment/
│   │   ├── index.js                # Fulfillment orchestrator
│   │   └── providers/              # iStar, Qonix, Fragment, Manual
│   ├── bot-simulator.js            # Development bot simulator
│   ├── ton-transaction-service.js  # Blockchain transaction handler
│   ├── payment-verification.js     # Payment verification service
│   ├── email-service.js            # Email notifications
│   └── pdf-generator.js            # Invoice/receipt generation
├── tools/
│   ├── data-persistence.js         # Database abstraction (dev fallback)
│   ├── audit-users.js              # User audit script
│   └── generate-railway-version.js # Deployment versioning
├── tests/
│   ├── api/                        # API endpoint tests
│   └── integration/                # Integration tests
├── public/
│   ├── index.html                  # Main buy interface
│   ├── sell.html                   # Sell Stars page
│   ├── history.html                # Transaction history
│   ├── referral.html               # Referral program
│   ├── daily.html                  # Daily check-in and missions
│   ├── admin/                      # Admin dashboard
│   ├── css/                        # Stylesheets (theme, dark mode)
│   ├── js/                         # Client-side scripts
│   └── errors/                     # Error page templates
└── data/
    └── database.json               # Fallback data storage (dev only)
```

## API Endpoints

### Orders & Trading
- `POST /api/orders/create` — Create a new buy order
- `POST /api/validate-usernames` — Validate and look up recipient Telegram profiles
- `POST /api/verify-transaction` — Verify a TON blockchain transaction
- `POST /api/transaction-status-poll` — Poll transaction confirmation status
- `GET /api/transactions/:userId` — User transaction history
- `GET /api/quote` — Get live price quote for a Stars/Premium order

### Selling
- `POST /api/sell/initiate` — Start a Stars sell request
- `GET /api/sell/history/:userId` — Sell order history

### Referrals
- `GET /api/referrals/:userId` — User referral data
- `GET /api/referral-stats/:userId` — Referral statistics
- `POST /api/referral-withdrawals` — Request referral withdrawal
- `GET /api/withdrawal-history/:userId` — Withdrawal history

### Daily & Engagement
- `GET /api/daily/state` — Daily check-in state
- `POST /api/daily/checkin` — Submit daily check-in
- `GET /api/daily/missions` — Available missions
- `POST /api/daily/missions/complete` — Mark mission complete

### Admin
- `POST /api/admin/auth/send-otp` — Admin OTP authentication
- `POST /api/admin/auth/verify-otp` — Verify OTP and get session
- `GET /api/admin/dashboard/stats` — Dashboard metrics
- `GET /api/admin/orders` — All orders with filters
- `POST /api/admin/orders/:id/complete` — Mark order complete
- `POST /api/admin/orders/:id/refund` — Issue refund
- `GET /api/admin/users` — Get all users
- `POST /api/admin/notify` — Send broadcast message

### Health
- `GET /api/health` — Application health check
- `GET /api/active-ping` — Keep-alive ping

## Recipient Validation

When buying Stars for others, StarStore validates recipients against the real Telegram network before checkout:

1. **Bot API `getChat`** — primary check. Confirms the username exists and retrieves the user's display name and profile photo.
2. **t.me page scrape** — fallback if the bot hasn't interacted with that user yet. Works for public profiles.
3. **Automatic retry** — on transient network errors, validation retries up to 2 times server-side (with timeouts) and 2 times client-side before surfacing any error.
4. **No silent passes** — if verification cannot be confirmed, the order is blocked. There is no format-only fallback that lets unverified usernames through.

## Security Features

- **Rate Limiting** — brute force and DDoS protection on all endpoints
- **CORS Protection** — strict cross-origin request policy
- **Input Validation** — all user inputs sanitized server-side
- **Secure Headers** — Helmet.js middleware
- **Telegram Auth** — cryptographic verification of WebApp `initData` on every request
- **Admin OTP** — two-factor OTP authentication for the admin dashboard
- **Mainnet Enforcement** — testnet wallets blocked for non-admin users
- **Duplicate Transaction Prevention** — on-chain transaction hashes checked for reuse

See [SECURITY.md](SECURITY.md) for responsible disclosure and security policy.

## Deployment

### Railway (recommended)

```bash
git push origin main  # triggers auto-deploy via GitHub integration
```

Set environment variables in the Railway dashboard from `.env.example`. Railway keeps the bot running 24/7 which is required for order fulfillment and notifications.

### Vercel

```bash
vercel --prod
```

**Note:** Vercel serverless functions work for the HTTP API, but the Telegram bot long-polling and background jobs require a persistent process — use Railway or a VPS for full functionality.

## Development

### Running Tests

```bash
npm test                 # run all tests
npm run test:watch       # watch mode
npm run test:coverage    # coverage report
```

### Bot Simulator

Test without a real Telegram bot:

```bash
node tools/enable-bot-simulator.js
```

### Database Audit

```bash
node tools/audit-users.js
```

## TON Blockchain Integration

- **Payment options**: TON (GRAM) or USDT-TON (jetton)
- **Verification**: Toncenter API with cryptographic signature validation
- **Sub-second support**: Compatible with TON's sub-second block times (April 2026+)
- **Typical confirmation**: 3–5 seconds
- **Duplicate prevention**: Transaction hashes tracked to prevent replay

Implementation: `services/ton-transaction-service.js`

## Troubleshooting

**Bot not responding**
- Verify `BOT_TOKEN` is correct in `.env`
- Check `WEBHOOK_URL` is reachable from Telegram's servers
- Confirm the application is running and listening on the right port

**Transaction verification failing**
- Verify `TON_API_KEY` is valid and has quota remaining
- Check connectivity to Toncenter
- Ensure the transaction hash format is correct (64 hex chars)

**Username validation errors**
- Ensure `BOT_TOKEN` is set — without it, only public t.me profiles can be verified
- Transient failures auto-retry; persistent failures indicate the username does not exist

**Database connection errors**
- Verify `MONGODB_URI` connection string
- Check credentials and IP whitelist on your MongoDB cluster

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Copyright (c) 2024–2026 StarStore Contributors. All rights reserved.

This software is proprietary. Viewing the source code does not grant any rights to use, copy, modify, distribute, sublicense, or sell it. See the [LICENSE](LICENSE) file for full terms.

## Support

- **GitHub Issues**: Bug reports and feature requests
- **Telegram Bot**: https://t.me/TgStarStore_bot
- **Documentation**: https://blog.starstore.app

---

**StarStore** — Buy and sell Telegram Stars with ease.

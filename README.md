# StarStore — Telegram Mini App Backend

![StarStore Banner](public/banner.png)

A production-ready Node.js/Express backend for a Telegram Mini App that lets users buy and sell Telegram Stars, manage referrals, and receive real-time notifications via a Telegram Bot. Built with Express, Mongoose, and node-telegram-bot-api.

## ✨ Features

- **Orders**: Create Buy/Sell orders with secure Telegram Payments and 15-minute session locks
- **Referrals**: Track referral stats, history, and process referral withdrawals
- **Notifications**: Global and personal notifications with read/unread state
- **Stickers**: Sticker metadata endpoints including animated `.tgs` extraction to JSON
- **Admin Toolkit**: Admin commands, broadcasts, refund helpers, warnings/ban system
- **Feedback & Surveys**: Collect structured user feedback and surveys via Telegram
- **Health & Observability**: Health check, modular design, maintenance jobs

## 🗂️ Project Structure

```
/workspace
├─ server.js                    # Entry point (now slimmed and modular)
├─ config/
│  └─ index.js                 # Centralized env-driven config
├─ models/
│  └─ index.js                 # All Mongoose schemas/models
├─ routes/
│  ├─ orderRoutes.js           # /api/orders, /api/sell-orders
│  ├─ referralRoutes.js        # /api/referral-stats, /api/withdrawal-history, /api/referral-withdrawals
│  ├─ stickerRoutes.js         # /api/sticker, /api/stickers
│  └─ notificationRoutes.js    # /api/notifications
├─ managers/
│  ├─ botManager.js            # Telegram bot event handlers
│  ├─ maintenanceManager.js    # Background jobs (cleanup, sessions)
│  └─ feedbackManager.js       # Feedback flows + /api/survey
├─ middleware/
│  └─ telegramAuth.js          # Telegram auth helpers
├─ utils/
│  └─ helpers.js               # getUserDisplayName, referral tracking
├─ public/
│  └─ banner.png               # README banner (add your own image)
├─ package.json
└─ README.md
```

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ (16.x compatible as per package.json engines)
- MongoDB connection URL
- A Telegram Bot with token and webhook domain

### Environment Variables
Create a `.env` file:

```
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
PROVIDER_TOKEN=YOUR_TELEGRAM_PAYMENTS_PROVIDER_TOKEN
MONGODB_URI=mongodb+srv://...
WEBHOOK_SECRET=optional-secret
RAILWAY_STATIC_URL=your.domain.tld
RAILWAY_PUBLIC_DOMAIN=your.domain.tld
ADMIN_TELEGRAM_IDS=123456789,987654321
WALLET_ADDRESS=YOUR_USDT_WALLET
PORT=8080
```

### Install & Run

```bash
npm install
npm run start
```

If you see an error like “Webhook setup failed: Telegram Bot Token not provided!”, ensure `BOT_TOKEN` is set.

## 📡 API Overview

Base path: `/api`

- Orders
  - POST `/orders/create` — Create a buy/premium order
  - POST `/sell-orders` — Create a sell order and receive a payment link
  - GET `/sell-orders?telegramId=...` — Get recent sell orders for a user
- Referrals
  - GET `/referral-stats/:userId` — Stats and balances
  - GET `/withdrawal-history/:userId` — Recent withdrawals
  - POST `/referral-withdrawals` — Request withdrawal
- Stickers
  - GET `/sticker/:sticker_id/json` — Animated sticker JSON
  - GET `/sticker/:id/info` — Sticker info
  - GET `/stickers?set=...` — List stickers
- Notifications
  - GET `/notifications` — List with unread count
  - POST `/notifications` — Create (admin)
  - POST `/notifications/:id/read` — Mark read
  - POST `/notifications/mark-all-read` — Mark all read
  - DELETE `/notifications/:id` — Delete
- Feedback
  - POST `/survey` — Submit survey (distributed to admins)

Health check: `GET /health`

## 🤖 Bot Capabilities (Admins)

- `/broadcast` — Send announcements
- `/notify` — Targeted notifications
- `/warn`, `/ban`, `/unban`, `/warnings` — User moderation
- `/sell_complete <ORDER_ID>` — Send completion notice with feedback prompt
- `/users` — Total users in database

Plus inline callbacks for order processing and refund helpers.

## 🧩 Modularity

- `botManager` registers all bot events
- `maintenanceManager` runs recurring jobs (expired orders, session cleanup)
- `feedbackManager` manages feedback flows and survey endpoint
- `routes/*` own HTTP concerns
- `models/index` defines all schemas

This keeps `server.js` small and focused: bootstrapping, webhook, DB, and mounting.

## 🛡️ Security Notes

- Webhook requests validated with optional `WEBHOOK_SECRET`
- CORS restricts origins to localhost, 127.0.0.1, Vercel apps, and `starstore.site`
- Telegram WebApp data verification handled in `middleware/telegramAuth.js`

## 🖼️ Imagery

Place your branding image at `public/banner.png` to populate the README banner. You can also host external images and update the path accordingly.

Example banner prompt idea for designers: “Futuristic neon storefront with Telegram icon and stars, dark gradient background.”

## 🧪 Testing Tips

- Spin up a MongoDB test cluster and use a `.env.test`
- Mock bot by stubbing `bot.sendMessage` for integration tests
- Exercise routes with curl/Postman; verify DB writes

## 📄 License

MIT © StarStore
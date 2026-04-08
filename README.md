# StarStore - Telegram Stars Trading Platform

> A comprehensive Telegram Mini App for buying, selling, and trading Telegram Stars with USDT conversion, referral rewards, and premium subscription management.

## ✳️ Overview

StarStore is a full-featured Telegram Mini App that enables users to:
- **Buy & Sell Telegram Stars** with secure payment processing
- **Convert Stars to USDT** with competitive rates
- **Purchase Premium Subscriptions** (3, 6, 12 months)
- **Earn Referral Rewards** (0.5 USDT per successful referral)
- **Withdraw Earnings** to TON wallets
- **Track Transaction History** with detailed analytics

## 🚀 Key Features

### Core Trading
- **Telegram Stars Marketplace** - Buy/sell with real-time pricing
- **USDT Conversion** - Seamless Stars ↔ USDT exchange
- **Premium Subscriptions** - Direct Telegram Premium purchases
- **TON Wallet Integration** - Native TON blockchain support

### User Experience
- **Telegram Mini App** - Native integration with Telegram
- **Real-time Notifications** - Instant updates on transactions
- **Multi-language Support** - Localized interface
- **Dark/Light Theme** - Adaptive UI design
- **Mobile Optimized** - Responsive design for all devices

### Business Features
- **Referral System** - Earn 0.5 USDT per successful referral
- **Daily Check-ins** - Gamified user engagement
- **Ambassador Program** - Advanced user rewards
- **Transaction History** - Comprehensive activity tracking
- **Knowledge Base** - Built-in help system

### Admin Dashboard
- **User Management** - Complete user administration
- **Order Processing** - Manual order review and approval
- **Analytics Dashboard** - Real-time business metrics
- **Notification System** - Broadcast messaging
- **Financial Controls** - Withdrawal and refund management

## 🛠️ Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: MongoDB with Mongoose ODM
- **Bot Framework**: node-telegram-bot-api
- **Blockchain**: TON Connect integration
- **Frontend**: Vanilla JavaScript, Modern CSS
- **Deployment**: Railway, Vercel support
- **Security**: Helmet.js, rate limiting, CORS protection

## 📦 Installation

### Prerequisites
- Node.js 22.x
- MongoDB 4.4+
- Telegram Bot Token
- Telegram Payments Provider Token

### Quick Start

```bash
# Clone repository
git clone <repository-url>
cd starstore

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Start application
npm start
```

### Environment Configuration

```env
# Telegram Bot
BOT_TOKEN=your_bot_token_here
WEBHOOK_URL=https://your-domain.com
PROVIDER_TOKEN=your_provider_token_here

# Database
MONGODB_URI=mongodb://localhost:27017/starstore

# Admin Access
ADMIN_IDS=123456789,987654321

# Security (optional)
SESSION_SECRET=your_session_secret
```

## 🏗️ Architecture

### Application Structure
```
├── server.js                 # Main application server
├── tools/
│   ├── data-persistence.js       # Database abstraction layer (development fallback)
│   ├── audit-users.js            # User database audit script
│   ├── generate-audit-queries.js # MongoDB audit query generator
│   ├── generate-railway-version.js # Deployment versioning
│   └── enable-bot-simulator.js   # Bot simulator test script
├── middleware/
│   └── telegramAuth.js       # Telegram authentication
├── services/
│   └── bot-simulator.js      # Development bot simulator
├── public/                   # Frontend assets
│   ├── index.html           # Main trading interface
│   ├── sell.html            # Sell stars page
│   ├── admin/               # Admin dashboard
│   ├── css/                 # Stylesheets
│   └── js/                  # Client-side scripts

```

### Key Components
- **Payment Processing** - Secure Telegram Payments integration
- **Order Management** - Complete buy/sell order lifecycle
- **User Authentication** - Telegram WebApp data verification
- **Referral Tracking** - Automated referral reward system
- **Admin Controls** - Comprehensive management interface

## 🔒 Security Features

- **Rate Limiting** - Protection against abuse
- **CORS Protection** - Secure cross-origin requests
- **Input Validation** - Comprehensive data sanitization
- **Telegram Auth** - WebApp data verification
- **Admin Access Control** - Role-based permissions
- **Secure Headers** - Helmet.js security middleware

## 📊 API Endpoints

### Core APIs
- `GET /api/health` - Application health check
- `GET /api/transactions/:userId` - User transaction history
- `GET /api/referrals/:userId` - User referral data
- `POST /api/create-order` - Create new order

### Admin APIs
- `POST /api/admin/auth/send-otp` - Admin authentication
- `GET /api/admin/dashboard/stats` - Admin dashboard metrics
- `POST /api/admin/broadcast` - Send broadcast messages

### Referral APIs
- `GET /api/referral-stats/:userId` - Referral statistics
- `POST /api/referral-withdrawals` - Process withdrawals
- `GET /api/withdrawal-history/:userId` - Withdrawal history

### Transaction APIs (TON Sub-Second)
- `POST /api/verify-transaction` - Verify blockchain transaction with Pending/Confirmed status
- `POST /api/transaction-status-poll` - Poll for real-time transaction status changes

## 🔄 TON Sub-Second Mainnet Support

**As of April 2026, the app is fully compatible with TON's Sub-Second mainnet rollout.**

### Key Improvements
✅ **Pending/Confirmed Status Tracking** - Follows TON Sub-Second model
- `pending`: Transaction in mempool, awaiting block inclusion
- `confirmed`: Transaction finalized on masterchain
- Real-time UX updates via polling (3-5 second confirmation typical)

✅ **Toncenter Streaming API V2** - Latest API recommendations
- Optimized transaction queries
- WebSocket-ready for future enhancements
- Sub-second block time compatible

✅ **Near-Instant UX** - Best practices implemented
- Display "Pending" status immediately after transaction submission
- Update to "Confirmed" once blockchain finalizes
- 3-5 second typical confirmation time on Sub-Second network

✅ **Backward Compatible** - Works with existing TON infrastructure
- Polling fallback mechanism for reliability
- No breaking changes to existing integrations
- Automatic status updates

### Implementation Details
- **Service**: `services/ton-transaction-service.js` - Manages transaction verification
- **Endpoints**: `/api/verify-transaction`, `/api/transaction-status-poll`
- **Frontend**: Real-time Pending→Confirmed UX flow
- **Configuration**: Automatic via `TON_MAINNET_ENDPOINT` and `TON_API_KEY`

**Reference**: [TON Sub-Second Guidance](https://ton.org/docs/develop/infra/ton-blockchain#sub-second-architecture)

### Railway Deployment
```bash
# Build for production
npm run build

# Deploy to Railway
railway up
```

### Vercel Deployment
```bash
# Deploy to Vercel
vercel --prod
```

### Environment Setup
1. Configure webhook URL in Telegram
2. Set up MongoDB connection
3. Configure payment provider
4. Set admin user IDs

## 📈 Performance

- **Compression** - Gzip compression for all responses
- **Caching** - Optimized static file caching
- **Database Indexing** - Efficient MongoDB queries
- **Rate Limiting** - Resource abuse prevention
- **Memory Management** - Optimized resource usage

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support and questions:
- 📧 Contact: [support@starstore.site](mailto:support@starstore.site)
- 💬 Telegram: [@StarStore_app](https://t.me/StarStore_app)
- 🐛 Issues: [GitHub Issues](https://github.com/yourusername/starstore/issues)

---

**StarStore** - Empowering Telegram Stars trading with security, efficiency, and user-centric design.

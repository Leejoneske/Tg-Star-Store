# StarStore

A Telegram Mini App platform for buying, selling, and trading Telegram Stars with USDT conversion, referral rewards, and comprehensive transaction management.

## Overview

StarStore is a full-featured Telegram Mini App built with Node.js and MongoDB that enables users to:

- Buy and sell Telegram Stars with real-time pricing
- Convert Stars to USDT via TON blockchain integration
- Purchase Telegram Premium subscriptions with automatic activation
- Earn referral rewards through a structured referral system
- Withdraw earnings directly to TON wallets
- Track complete transaction history and analytics

## Key Features

### Trading & Transactions
- Real-time Telegram Stars marketplace with competitive pricing
- Seamless Stars to USDT conversion
- Direct Telegram Premium subscription purchases (3, 6, 12-month plans)
- TON wallet integration with blockchain verification
- Sub-second transaction confirmation support

### User Experience
- Native Telegram Mini App integration
- Real-time transaction notifications
- Multi-language interface support
- Dark and light theme options
- Fully responsive mobile design

### Revenue & Engagement
- Referral program with 0.5 USDT per successful referral
- Daily check-in system for user engagement
- Ambassador tier program
- Comprehensive transaction history and analytics
- Built-in help system and knowledge base

### Administration
- Complete user and order management dashboard
- Real-time business analytics and metrics
- Manual order review and approval workflow
- Broadcast messaging system
- Financial controls for withdrawals and refunds
- User ban and restriction management

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

Before you begin, ensure you have:

- Node.js 22.x or higher
- MongoDB 4.4 or higher (local or cloud instance)
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

Copy the example configuration:

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

The application will be available at `http://localhost:3000`

## Project Structure

```
starstore/
├── server.js                    # Main application entry point
├── middleware/
│   └── telegramAuth.js         # Telegram authentication middleware
├── services/
│   ├── bot-simulator.js        # Development bot simulator
│   ├── ton-transaction-service.js  # Blockchain transaction handler
│   ├── email-service.js        # Email notifications
│   └── pdf-generator.js        # Invoice/receipt generation
├── tools/
│   ├── data-persistence.js     # Database abstraction (dev fallback)
│   ├── audit-users.js          # User audit script
│   └── generate-railway-version.js  # Deployment versioning
├── tests/
│   ├── api/                    # API endpoint tests
│   └── integration/            # Integration tests
├── public/
│   ├── index.html              # Main trading interface
│   ├── sell.html               # Sell stars page
│   ├── history.html            # Transaction history
│   ├── referral.html           # Referral program page
│   ├── admin/                  # Admin dashboard
│   ├── blog/                   # Blog and knowledge base
│   ├── css/                    # Stylesheets (theme, dark mode)
│   ├── js/                     # Client-side scripts
│   └── errors/                 # Error page templates
└── data/
    └── database.json           # Fallback data storage (dev only)
```

## API Endpoints

### Trading
- `POST /api/create-order` - Create new buy/sell order
- `GET /api/orders/:userId` - Get user orders
- `POST /api/cancel-order/:orderId` - Cancel pending order

### Transactions
- `GET /api/transactions/:userId` - User transaction history
- `POST /api/verify-transaction` - Verify blockchain transaction
- `POST /api/transaction-status-poll` - Poll transaction status

### Referrals
- `GET /api/referrals/:userId` - User referral data
- `GET /api/referral-stats/:userId` - Referral statistics
- `POST /api/referral-withdrawals` - Request referral withdrawal
- `GET /api/withdrawal-history/:userId` - Withdrawal history

### Admin
- `POST /api/admin/auth/send-otp` - Admin OTP authentication
- `GET /api/admin/dashboard/stats` - Dashboard metrics
- `GET /api/admin/users` - Get all users
- `POST /api/admin/user/:userId/ban` - Ban user
- `POST /api/admin/broadcast` - Send broadcast message

### Health & Status
- `GET /api/health` - Application health check
- `GET /api` - API status information

## Security Features

The application implements comprehensive security measures:

- **Rate Limiting**: Protection against brute force and DDoS attacks
- **CORS Protection**: Secure cross-origin request handling
- **Input Validation**: Sanitization of all user inputs
- **Secure Headers**: Helmet.js security middleware
- **Authentication**: Telegram WebApp data cryptographic verification
- **Authorization**: Role-based access control for admin endpoints
- **Rate Limiting on Sensitive Endpoints**: Stricter limits on payment and withdrawal endpoints

For security concerns, please see [SECURITY.md](SECURITY.md).

## Deployment

### Railway

Deploy directly to Railway with integrated GitHub integration:

```bash
# Push to main to trigger auto-deployment
git push origin main
```

Configure the following in Railway dashboard:
- Link GitHub repository
- Set environment variables from `.env.example`
- Ensure MongoDB connection string is configured

### Vercel

For serverless deployment:

```bash
# Deploy to production
vercel --prod
```

**Note**: Full bot functionality requires Railway or equivalent VPS for 24/7 uptime.

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

### Bot Simulator (Development)

Enable the development bot simulator for testing without a real Telegram bot:

```bash
node tools/enable-bot-simulator.js
```

Then use the test commands in the private chat.

### Database Audit

Audit and verify user data integrity:

```bash
node tools/audit-users.js
```

## TON Blockchain Integration

### Sub-Second Support (April 2026+)

The application is fully compatible with TON's Sub-Second network:

- **Pending Status**: Transaction in mempool, awaiting inclusion
- **Confirmed Status**: Transaction finalized on masterchain
- **Typical Confirmation**: 3-5 seconds
- **Real-time Updates**: Polling-based status monitoring

Implementation details are in `services/ton-transaction-service.js`.

### Transaction Verification

All blockchain transactions are verified with:
- Toncenter API for transaction lookup
- Cryptographic signature validation
- Balance verification
- Duplicate transaction prevention

## Performance Optimization

- HTTP compression (gzip) for all responses
- Static asset caching with cache headers
- MongoDB indexing for efficient queries
- Rate limiting to prevent resource exhaustion
- Optimized database queries with projection
- Frontend code splitting and lazy loading

## Configuration

### Environment Variables

See `.env.example` for complete list. Key variables:

| Variable | Purpose |
|----------|---------|
| `BOT_TOKEN` | Telegram bot authentication |
| `MONGODB_URI` | Database connection string |
| `ADMIN_IDS` | Comma-separated admin user IDs |
| `TON_API_KEY` | Blockchain API access |
| `SESSION_SECRET` | Session encryption key |

## Troubleshooting

### Bot not responding
- Verify `BOT_TOKEN` is correct
- Check `WEBHOOK_URL` is accessible from Telegram servers
- Ensure application is running and listening on correct port

### Transaction verification failing
- Verify `TON_API_KEY` is valid and has sufficient quota
- Check network connectivity to Toncenter
- Review transaction hash format

### Database connection errors
- Verify `MONGODB_URI` connection string
- Check database credentials and permissions
- Ensure IP whitelist allows application server

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute to this project.

## Code of Conduct

This project is committed to providing a welcoming and inclusive environment. Please see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues, questions, or feedback:

- **GitHub Issues**: Report bugs and request features via GitHub Issues
- **Email**: Contact project maintainers
- **Documentation**: See the knowledge base at `/blog`

## Acknowledgments

- Built with Node.js, Express.js, and MongoDB
- Telegram Mini App framework
- TON blockchain integration
- Community contributors and testers

---

**StarStore** - A Telegram platform for stars—buy and sell stars with ease https://t.me/TgStarStore_bot

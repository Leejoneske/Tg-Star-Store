# StarStore - Telegram Mini App

A comprehensive Telegram Mini App for purchasing Telegram Stars and Premium subscriptions with advanced referral system, payment processing, and admin management.

## 🌟 Features

### Core Features
- **Telegram Stars Purchase**: Buy Telegram Stars with secure payment processing
- **Premium Subscriptions**: Purchase Premium subscriptions (3, 6, 12 months)
- **Referral System**: Earn 0.5 USDT for each successful referral
- **Withdrawal System**: Withdraw referral earnings to TON wallet
- **Real-time Notifications**: Instant notifications for all activities
- **Admin Panel**: Comprehensive admin management system

### Advanced Features
- **Payment Processing**: Secure Telegram Payments integration
- **Order Management**: Complete order lifecycle management
- **User Management**: User registration, tracking, and management
- **Feedback System**: Multi-step feedback collection
- **Maintenance System**: Automated cleanup and maintenance tasks
- **Error Handling**: Comprehensive error pages and handling
- **Security**: Rate limiting, authentication, and security headers

## 🚀 Quick Start

### Prerequisites
- Node.js 16+ 
- MongoDB 4.4+
- Telegram Bot Token
- Telegram Payments Provider Token

### Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd starstore
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. **Start the application**
```bash
npm start
```

## 📋 Environment Variables

### Required Variables
```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_bot_token_here
WEBHOOK_URL=https://your-domain.com
PROVIDER_TOKEN=your_provider_token_here

# Database Configuration
MONGODB_URI=mongodb://localhost:27017/starstore

# Admin Configuration
ADMIN_IDS=123456789,987654321
```

### Optional Variables
```env
# Server Configuration
PORT=8080
NODE_ENV=production

# Security
SESSION_SECRET=your_session_secret_here

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## 🏗️ Architecture

### Backend Structure
```
├── server.js              # Main application entry point
├── managers/              # Business logic managers
│   ├── adminManager.js    # Admin commands and management
│   ├── paymentManager.js  # Payment processing
│   ├── userInteractionManager.js # User interactions
│   ├── callbackManager.js # Callback query handling
│   ├── feedbackManager.js # Feedback system
│   ├── maintenanceManager.js # Maintenance tasks
│   └── notificationManager.js # Notification system
├── routes/                # API routes
│   ├── apiRoutes.js       # General API endpoints
│   ├── notificationRoutes.js # Notification API
│   ├── referralRoutes.js  # Referral system API
│   ├── orderRoutes.js     # Order management API
│   └── stickerRoutes.js   # Sticker management API
├── models/                # Database models
│   └── index.js           # All Mongoose schemas
└── middleware/            # Custom middleware
    └── telegramAuth.js    # Telegram authentication (created at runtime if missing)
```

### Frontend Structure
```
├── public/                # Static files
│   ├── index.html         # Main application page
│   ├── sell.html          # Sell stars page
│   ├── history.html       # Transaction history
│   ├── referral.html      # Referral system
│   ├── about.html         # About page
│   ├── notification.html  # Notification system
│   └── error-pages/       # Error handling pages
```

## 🔧 Production Deployment

### Automated Deployment
```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

### Manual Deployment

1. **Set up server**
```bash
# Install Node.js and MongoDB
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs mongodb

# Start MongoDB
sudo systemctl start mongod
sudo systemctl enable mongod
```

2. **Deploy application**
```bash
# Clone and setup
git clone <repository-url>
cd starstore
npm install --production

# Configure environment
cp .env.example .env
# Edit .env with production values

# Create systemd service
sudo tee /etc/systemd/system/starstore.service > /dev/null <<EOF
[Unit]
Description=StarStore Telegram Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Start service
sudo systemctl daemon-reload
sudo systemctl enable starstore
sudo systemctl start starstore
```

3. **Configure webhook**
```bash
# Set webhook URL in Telegram
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://your-domain.com/webhook/<YOUR_BOT_TOKEN>"}'
```

## 🔒 Security Features

- **Rate Limiting**: Prevents abuse with configurable limits
- **Security Headers**: Helmet.js for security headers
- **Input Validation**: Comprehensive input sanitization
- **Authentication**: Telegram WebApp data verification
- **CORS Protection**: Configured for Telegram domains
- **Error Handling**: Secure error responses

## 📊 Monitoring

### Health Check
```bash
curl https://your-domain.com/api/health
```

### Logs
```bash
# View application logs
sudo journalctl -u starstore -f

# View error logs
sudo journalctl -u starstore -p err
```

### Backup
```bash
# Create backup
./scripts/backup.sh

# Monitor system
./scripts/monitor.sh
```

## 🛠️ Admin Commands

### User Management
- `/ban <user_id>` - Ban user
- `/warn <user_id>` - Warn user
- `/unban <user_id>` - Unban user
- `/warnings <user_id>` - View user warnings

### Order Management
- `/sell_complete <order_id>` - Complete sell order
- `/sell_decline <order_id>` - Decline sell order
- `/cso- <details>` - Create sell order
- `/cbo- <details>` - Create buy order

### System Management
- `/broadcast` - Send broadcast message
- `/withdrawals` - List pending withdrawals
- `/users` - List recent users
- `/detect_users` - Count total users

### Payment Management
- `/adminrefund <tx_id>` - Admin refund
- `/refundtx <tx_id> <user_id>` - Refund transaction
- `/getpayment <tx_id>` - Get payment details

## 🔄 API Endpoints

### Core Endpoints
- `GET /api/health` - Health check
- `GET /api/transactions/:userId` - User transactions
- `GET /api/referrals/:userId` - User referrals

### Referral System
- `GET /api/referral-stats/:userId` - Referral statistics
- `POST /api/referral-withdrawals` - Create withdrawal
- `GET /api/withdrawal-history/:userId` - Withdrawal history

### Notifications
- `GET /api/notifications` - Get notifications
- `POST /api/notifications/:id/read` - Mark as read
- `GET /api/notifications/unread-count` - Unread count

### Orders
- `POST /api/create-order` - Create order
- `GET /api/order/:orderId` - Get order details

## 🐛 Troubleshooting

### Common Issues

1. **Bot not responding**
   - Check bot token in .env
   - Verify webhook URL is accessible
   - Check server logs

2. **Database connection failed**
   - Verify MongoDB is running
   - Check MONGODB_URI in .env
   - Ensure network connectivity

3. **Payment processing issues**
   - Verify PROVIDER_TOKEN
   - Check payment provider settings
   - Review payment logs

### Debug Mode
```bash
# Enable debug logging
NODE_ENV=development npm start

# View detailed logs
DEBUG=* npm start
```

## 📈 Performance

### Optimization Features
- **Compression**: Gzip compression for all responses
- **Caching**: Static file caching
- **Database Indexing**: Optimized MongoDB queries
- **Memory Management**: Efficient memory usage
- **Rate Limiting**: Prevents resource abuse

### Monitoring
- **Health Checks**: Automated health monitoring
- **Memory Usage**: Real-time memory tracking
- **Database Status**: Connection monitoring
- **Bot Status**: Telegram API monitoring

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:
- Create an issue on GitHub
- Contact the development team
- Check the documentation

## 🔄 Updates

### Version History
- **v1.0.0** - Initial release with core features
- **v1.1.0** - Added referral system
- **v1.2.0** - Enhanced admin panel
- **v1.3.0** - Added notification system
- **v1.4.0** - Production optimizations

### Upcoming Features
- Advanced analytics dashboard
- Multi-language support
- Enhanced security features
- Performance optimizations
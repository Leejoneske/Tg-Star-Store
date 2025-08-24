#!/bin/bash

# StarStore Production Deployment Script
echo "🚀 Starting StarStore Production Deployment..."

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "❌ Please don't run this script as root"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
    echo "❌ Node.js 16 or higher is required. Current version: $(node --version)"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please create one based on .env.example"
    exit 1
fi

echo "✅ Environment file found"

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production

# Check for required environment variables
echo "🔍 Checking environment variables..."
source .env

REQUIRED_VARS=(
    "TELEGRAM_BOT_TOKEN"
    "WEBHOOK_URL"
    "MONGODB_URI"
    "ADMIN_IDS"
)

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Missing required environment variable: $var"
        exit 1
    fi
done

echo "✅ All required environment variables are set"

# Create logs directory
mkdir -p logs

# Test database connection
echo "🔌 Testing database connection..."
node -e "
const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Database connection successful');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  });
"

if [ $? -ne 0 ]; then
    echo "❌ Database connection test failed"
    exit 1
fi

# Test bot token
echo "🤖 Testing bot token..."
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | grep -q '"ok":true'
if [ $? -ne 0 ]; then
    echo "❌ Bot token test failed"
    exit 1
fi

echo "✅ Bot token is valid"

# Create systemd service file
echo "📝 Creating systemd service..."
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
StandardOutput=append:/var/log/starstore.log
StandardError=append:/var/log/starstore.error.log

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable starstore

echo "✅ Systemd service created and enabled"

# Create log rotation
echo "📝 Setting up log rotation..."
sudo tee /etc/logrotate.d/starstore > /dev/null <<EOF
/var/log/starstore.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 $USER $USER
}

/var/log/starstore.error.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    create 644 $USER $USER
}
EOF

echo "✅ Log rotation configured"

# Set up firewall (if ufw is available)
if command -v ufw &> /dev/null; then
    echo "🔥 Configuring firewall..."
    sudo ufw allow 22/tcp
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw --force enable
    echo "✅ Firewall configured"
fi

# Create backup script
echo "📝 Creating backup script..."
tee scripts/backup.sh > /dev/null <<EOF
#!/bin/bash
BACKUP_DIR="backups/\$(date +%Y%m%d_%H%M%S)"
mkdir -p "\$BACKUP_DIR"

# Backup database
mongodump --uri="\${MONGODB_URI}" --out="\$BACKUP_DIR/db"

# Backup application files
tar -czf "\$BACKUP_DIR/app.tar.gz" --exclude=node_modules --exclude=.git .

echo "✅ Backup created: \$BACKUP_DIR"
EOF

chmod +x scripts/backup.sh

echo "✅ Backup script created"

# Create monitoring script
echo "📝 Creating monitoring script..."
tee scripts/monitor.sh > /dev/null <<EOF
#!/bin/bash
# Check if service is running
if ! systemctl is-active --quiet starstore; then
    echo "❌ StarStore service is down!"
    systemctl restart starstore
    echo "🔄 Service restarted"
fi

# Check disk space
DISK_USAGE=\$(df / | tail -1 | awk '{print \$5}' | sed 's/%//')
if [ "\$DISK_USAGE" -gt 90 ]; then
    echo "⚠️ Disk usage is high: \${DISK_USAGE}%"
fi

# Check memory usage
MEM_USAGE=\$(free | grep Mem | awk '{printf "%.0f", \$3/\$2 * 100.0}')
if [ "\$MEM_USAGE" -gt 90 ]; then
    echo "⚠️ Memory usage is high: \${MEM_USAGE}%"
fi
EOF

chmod +x scripts/monitor.sh

echo "✅ Monitoring script created"

# Start the service
echo "🚀 Starting StarStore service..."
sudo systemctl start starstore

# Wait a moment and check status
sleep 5
if systemctl is-active --quiet starstore; then
    echo "✅ StarStore service is running"
else
    echo "❌ Failed to start StarStore service"
    sudo systemctl status starstore
    exit 1
fi

echo ""
echo "🎉 Deployment completed successfully!"
echo ""
echo "📋 Service Information:"
echo "   Status: sudo systemctl status starstore"
echo "   Logs: sudo journalctl -u starstore -f"
echo "   Restart: sudo systemctl restart starstore"
echo "   Stop: sudo systemctl stop starstore"
echo ""
echo "🔧 Maintenance:"
echo "   Backup: ./scripts/backup.sh"
echo "   Monitor: ./scripts/monitor.sh"
echo ""
echo "🌐 Your StarStore app should now be running!"
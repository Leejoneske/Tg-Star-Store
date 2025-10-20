# StarStore Admin Dashboard 🚀

A modern, comprehensive admin dashboard for StarStore - completely separated from the main server for better architecture and scalability.

## ✨ Features

### 🔐 **Secure Authentication**
- OTP-based login via Telegram
- JWT token authentication
- Session management
- Admin role verification

### 📊 **Comprehensive Dashboard**
- Real-time statistics and metrics
- Revenue analytics with interactive charts
- User growth tracking
- Order status distribution
- Recent activity feed
- System health monitoring

### 🛒 **Order Management**
- Complete order lifecycle management
- Advanced filtering and search
- Bulk operations
- Order status updates
- Transaction tracking
- CSV export functionality

### 👥 **User Management**
- User profile management
- Activity tracking
- Ban/unban functionality
- Direct messaging to users
- User analytics and insights
- Referral tracking

### 📈 **Advanced Analytics**
- Revenue forecasting
- User behavior analysis
- Conversion tracking
- Referral program analytics
- Real-time metrics
- Custom report generation

### 🔔 **Notification Center**
- Broadcast messaging
- Template management
- Scheduled notifications
- Delivery analytics
- A/B testing capabilities
- Multi-channel support

### ⚙️ **System Management**
- Health monitoring
- Service management
- Configuration updates
- Log viewing
- Maintenance mode
- Performance metrics

### 🎨 **Modern UI/UX**
- Clean, intuitive interface
- Responsive design
- Dark/light theme support
- Real-time updates via WebSocket
- Interactive charts and graphs
- Mobile-friendly

## 🏗️ **Architecture**

### **Separation Benefits**
- **Microservice Architecture**: Admin functionality completely separated from main app
- **Better Performance**: Dedicated resources for admin operations
- **Enhanced Security**: Isolated admin environment
- **Scalability**: Independent scaling of admin services
- **Maintainability**: Cleaner codebase organization

### **Technology Stack**
- **Backend**: Node.js + Express
- **Frontend**: Vanilla JavaScript + Chart.js
- **Real-time**: WebSocket connections
- **Security**: JWT + Helmet + Rate limiting
- **Styling**: Modern CSS with Inter font
- **Icons**: Font Awesome 6

## 🚀 **Quick Start**

### **Installation**
```bash
cd admin-server
npm install
```

### **Environment Setup**
Create `.env` file:
```env
# Server Configuration
ADMIN_PORT=3001
MAIN_SERVER_URL=http://localhost:3000

# Security
JWT_SECRET=your-super-secret-jwt-key-change-in-production
ADMIN_IDS=123456789,987654321

# Database (if using)
DATABASE_URL=your-database-connection-string

# Optional
NODE_ENV=development
```

### **Development**
```bash
npm run dev
```

### **Production**
```bash
npm start
```

## 📱 **Dashboard Sections**

### **1. Dashboard Overview**
- Key metrics and KPIs
- Revenue trends
- Order distribution
- Recent activity
- System health status

### **2. Order Management**
- Order listing with advanced filters
- Order details and history
- Status management
- Bulk operations
- Export functionality

### **3. User Management**
- User profiles and activity
- Account management
- Communication tools
- Analytics and insights

### **4. Analytics & Reports**
- Revenue analytics
- User behavior insights
- Referral program metrics
- Custom report generation
- Data visualization

### **5. Notification Center**
- Message broadcasting
- Template management
- Delivery tracking
- Performance analytics

### **6. System Management**
- Health monitoring
- Configuration management
- Log viewing
- Maintenance tools

## 🔒 **Security Features**

- **OTP Authentication**: Secure login via Telegram
- **JWT Tokens**: Stateless authentication
- **Rate Limiting**: API protection
- **CORS Protection**: Cross-origin security
- **Helmet Security**: HTTP headers protection
- **Admin-only Access**: Role-based permissions

## 📊 **Real-time Features**

- **Live Dashboard**: Real-time metrics updates
- **WebSocket Integration**: Instant notifications
- **Live Activity Feed**: Real-time user actions
- **System Monitoring**: Live health status
- **Instant Updates**: No page refresh needed

## 🎯 **Key Improvements Over Old System**

### **Before (Old Admin)**
- ❌ Mixed with main server (8000+ lines)
- ❌ Basic WhatsApp-inspired design
- ❌ Limited functionality
- ❌ No real-time updates
- ❌ Poor mobile experience
- ❌ Basic error handling

### **After (New Admin)**
- ✅ Completely separated microservice
- ✅ Modern, professional design
- ✅ Comprehensive feature set
- ✅ Real-time WebSocket updates
- ✅ Fully responsive design
- ✅ Advanced error handling & logging

## 🔧 **API Endpoints**

### **Authentication**
- `POST /api/auth/send-otp` - Send OTP
- `POST /api/auth/verify-otp` - Verify OTP & Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/refresh` - Refresh token
- `POST /api/auth/logout` - Logout

### **Dashboard**
- `GET /api/dashboard/stats` - Overview statistics
- `GET /api/dashboard/activity` - Recent activity
- `GET /api/dashboard/revenue` - Revenue analytics
- `GET /api/dashboard/health` - System health

### **Orders**
- `GET /api/orders` - List orders
- `GET /api/orders/:id` - Order details
- `PATCH /api/orders/:id/status` - Update status
- `POST /api/orders/:id/complete` - Complete order
- `GET /api/orders/export/csv` - Export CSV

### **Users**
- `GET /api/users` - List users
- `GET /api/users/:id` - User details
- `PATCH /api/users/:id/status` - Update status
- `POST /api/users/:id/message` - Send message

### **Analytics**
- `GET /api/analytics/overview` - Analytics overview
- `GET /api/analytics/users` - User analytics
- `GET /api/analytics/financial` - Financial analytics
- `POST /api/analytics/reports` - Generate reports

### **System**
- `GET /api/system/health` - System health
- `GET /api/system/logs` - System logs
- `GET /api/system/config` - Configuration
- `POST /api/system/maintenance` - Maintenance mode

### **Notifications**
- `GET /api/notifications` - List notifications
- `POST /api/notifications` - Create notification
- `POST /api/notifications/:id/send` - Send notification
- `GET /api/notifications/templates` - Templates

## 🚀 **Deployment**

### **Docker Deployment**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

### **Environment Variables**
```env
ADMIN_PORT=3001
MAIN_SERVER_URL=https://your-main-server.com
JWT_SECRET=your-production-secret
ADMIN_IDS=comma,separated,admin,ids
NODE_ENV=production
```

## 📝 **License**

Private - StarStore Admin Dashboard

---

**Built with ❤️ for StarStore** - A modern, scalable admin dashboard that puts power and control at your fingertips! 🌟
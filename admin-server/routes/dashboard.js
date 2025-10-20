const express = require('express');
const router = express.Router();

// Mock data for now - replace with actual database queries
const mockStats = {
  totalUsers: 15420,
  totalOrders: 3847,
  totalRevenue: 89650.75,
  activeUsers24h: 892,
  pendingOrders: 23,
  completedOrders: 3824,
  totalWithdrawals: 1205,
  pendingWithdrawals: 8
};

const mockRecentActivity = [
  { id: 1, type: 'order', user: 'user_12345', amount: 50.00, status: 'completed', timestamp: new Date(Date.now() - 1000 * 60 * 5) },
  { id: 2, type: 'withdrawal', user: 'user_67890', amount: 25.50, status: 'pending', timestamp: new Date(Date.now() - 1000 * 60 * 15) },
  { id: 3, type: 'signup', user: 'user_54321', amount: 0, status: 'active', timestamp: new Date(Date.now() - 1000 * 60 * 30) },
  { id: 4, type: 'order', user: 'user_98765', amount: 100.00, status: 'completed', timestamp: new Date(Date.now() - 1000 * 60 * 45) },
  { id: 5, type: 'withdrawal', user: 'user_11111', amount: 75.25, status: 'completed', timestamp: new Date(Date.now() - 1000 * 60 * 60) }
];

// Middleware to verify admin token
function verifyAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Get dashboard overview stats
router.get('/stats', verifyAdmin, async (req, res) => {
  try {
    // TODO: Replace with actual database queries
    const stats = {
      ...mockStats,
      lastUpdated: new Date().toISOString()
    };
    
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// Get recent activity
router.get('/activity', verifyAdmin, async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    
    // TODO: Replace with actual database queries
    const activities = mockRecentActivity
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
      .map(activity => ({
        ...activity,
        timestamp: activity.timestamp.toISOString()
      }));
    
    res.json({ 
      success: true, 
      data: activities,
      pagination: {
        total: mockRecentActivity.length,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Dashboard activity error:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
});

// Get system health
router.get('/health', verifyAdmin, async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      timestamp: new Date().toISOString(),
      services: {
        database: { status: 'healthy', responseTime: 12 },
        telegram: { status: 'healthy', responseTime: 45 },
        payment: { status: 'healthy', responseTime: 89 }
      }
    };
    
    res.json({ success: true, data: health });
  } catch (error) {
    console.error('System health error:', error);
    res.status(500).json({ error: 'Failed to fetch system health' });
  }
});

// Get revenue analytics
router.get('/revenue', verifyAdmin, async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // Mock revenue data - replace with actual analytics
    const revenueData = {
      '7d': [
        { date: '2024-01-15', revenue: 1250.75, orders: 45 },
        { date: '2024-01-16', revenue: 980.50, orders: 38 },
        { date: '2024-01-17', revenue: 1450.25, orders: 52 },
        { date: '2024-01-18', revenue: 1120.00, orders: 41 },
        { date: '2024-01-19', revenue: 1680.75, orders: 58 },
        { date: '2024-01-20', revenue: 1340.50, orders: 47 },
        { date: '2024-01-21', revenue: 1890.25, orders: 63 }
      ]
    };
    
    res.json({ 
      success: true, 
      data: revenueData[period] || revenueData['7d'],
      period 
    });
  } catch (error) {
    console.error('Revenue analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue analytics' });
  }
});

module.exports = router;
const express = require('express');
const router = express.Router();

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

// Get all users with pagination and filtering
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, status } = req.query;
    
    // TODO: Replace with actual database queries
    const mockUsers = [
      {
        id: 'user_12345',
        telegramId: '123456789',
        username: 'john_doe',
        firstName: 'John',
        lastName: 'Doe',
        isActive: true,
        isPremium: false,
        joinedAt: new Date('2024-01-15'),
        lastActive: new Date(Date.now() - 1000 * 60 * 30),
        totalOrders: 5,
        totalSpent: 250.00,
        referralCode: 'REF123',
        referredBy: null,
        referrals: 3
      },
      {
        id: 'user_67890',
        telegramId: '987654321',
        username: 'jane_smith',
        firstName: 'Jane',
        lastName: 'Smith',
        isActive: true,
        isPremium: true,
        joinedAt: new Date('2024-01-10'),
        lastActive: new Date(Date.now() - 1000 * 60 * 60),
        totalOrders: 12,
        totalSpent: 580.50,
        referralCode: 'REF456',
        referredBy: 'user_12345',
        referrals: 7
      },
      {
        id: 'user_54321',
        telegramId: '456789123',
        username: 'bob_wilson',
        firstName: 'Bob',
        lastName: 'Wilson',
        isActive: false,
        isPremium: false,
        joinedAt: new Date('2024-01-08'),
        lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3),
        totalOrders: 2,
        totalSpent: 75.00,
        referralCode: 'REF789',
        referredBy: 'user_67890',
        referrals: 0
      }
    ];
    
    let filteredUsers = mockUsers;
    
    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      filteredUsers = filteredUsers.filter(user => 
        user.username?.toLowerCase().includes(searchLower) ||
        user.firstName?.toLowerCase().includes(searchLower) ||
        user.lastName?.toLowerCase().includes(searchLower) ||
        user.telegramId.includes(search)
      );
    }
    
    // Apply status filter
    if (status) {
      if (status === 'active') {
        filteredUsers = filteredUsers.filter(user => user.isActive);
      } else if (status === 'inactive') {
        filteredUsers = filteredUsers.filter(user => !user.isActive);
      } else if (status === 'premium') {
        filteredUsers = filteredUsers.filter(user => user.isPremium);
      }
    }
    
    // Pagination
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedUsers = filteredUsers.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      data: paginatedUsers.map(user => ({
        ...user,
        joinedAt: user.joinedAt.toISOString(),
        lastActive: user.lastActive.toISOString()
      })),
      pagination: {
        total: filteredUsers.length,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(filteredUsers.length / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user details
router.get('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Replace with actual database query
    const mockUser = {
      id: id,
      telegramId: '123456789',
      username: 'john_doe',
      firstName: 'John',
      lastName: 'Doe',
      isActive: true,
      isPremium: false,
      joinedAt: new Date('2024-01-15'),
      lastActive: new Date(Date.now() - 1000 * 60 * 30),
      totalOrders: 5,
      totalSpent: 250.00,
      referralCode: 'REF123',
      referredBy: null,
      referrals: 3,
      orders: [
        {
          id: 'ORD001',
          amount: 50.00,
          status: 'completed',
          date: new Date(Date.now() - 1000 * 60 * 60 * 24)
        }
      ],
      withdrawals: [
        {
          id: 'WD001',
          amount: 25.00,
          status: 'completed',
          date: new Date(Date.now() - 1000 * 60 * 60 * 48)
        }
      ]
    };
    
    res.json({
      success: true,
      data: {
        ...mockUser,
        joinedAt: mockUser.joinedAt.toISOString(),
        lastActive: mockUser.lastActive.toISOString(),
        orders: mockUser.orders.map(order => ({
          ...order,
          date: order.date.toISOString()
        })),
        withdrawals: mockUser.withdrawals.map(withdrawal => ({
          ...withdrawal,
          date: withdrawal.date.toISOString()
        }))
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Update user status
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive, isPremium, notes } = req.body;
    
    // TODO: Update user in database
    console.log(`Updating user ${id} - Active: ${isActive}, Premium: ${isPremium}`);
    
    // Broadcast update to connected clients
    if (global.broadcast) {
      global.broadcast('users', {
        type: 'status_update',
        userId: id,
        isActive,
        isPremium,
        notes,
        updatedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'User status updated successfully'
    });
  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// Ban/Unban user
router.post('/:id/ban', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { banned, reason } = req.body;
    
    // TODO: Update user ban status in database
    console.log(`${banned ? 'Banning' : 'Unbanning'} user ${id}, reason: ${reason}`);
    
    // Broadcast update
    if (global.broadcast) {
      global.broadcast('users', {
        type: banned ? 'user_banned' : 'user_unbanned',
        userId: id,
        reason,
        actionBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: `User ${banned ? 'banned' : 'unbanned'} successfully`
    });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ error: 'Failed to update user ban status' });
  }
});

// Send message to user
router.post('/:id/message', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { message, type = 'info' } = req.body;
    
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // TODO: Send message via Telegram bot
    console.log(`Sending ${type} message to user ${id}: ${message}`);
    
    res.json({
      success: true,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Get user analytics
router.get('/:id/analytics', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { period = '30d' } = req.query;
    
    // TODO: Generate analytics from database
    const mockAnalytics = {
      orderHistory: [
        { date: '2024-01-15', orders: 2, amount: 100.00 },
        { date: '2024-01-16', orders: 1, amount: 50.00 },
        { date: '2024-01-17', orders: 0, amount: 0 },
        { date: '2024-01-18', orders: 1, amount: 75.00 },
        { date: '2024-01-19', orders: 1, amount: 25.00 }
      ],
      referralStats: {
        totalReferrals: 3,
        activeReferrals: 2,
        referralEarnings: 15.50
      },
      activityPattern: {
        mostActiveHour: 14,
        mostActiveDay: 'Monday',
        avgSessionLength: 12 // minutes
      }
    };
    
    res.json({
      success: true,
      data: mockAnalytics,
      period
    });
  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch user analytics' });
  }
});

// Export users to CSV
router.get('/export/csv', verifyAdmin, async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;
    
    // TODO: Generate CSV from database
    const csvData = `User ID,Username,First Name,Last Name,Telegram ID,Status,Premium,Joined Date,Total Orders,Total Spent
user_12345,john_doe,John,Doe,123456789,active,false,2024-01-15,5,250.00
user_67890,jane_smith,Jane,Smith,987654321,active,true,2024-01-10,12,580.50
user_54321,bob_wilson,Bob,Wilson,456789123,inactive,false,2024-01-08,2,75.00`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
    res.send(csvData);
  } catch (error) {
    console.error('Export users error:', error);
    res.status(500).json({ error: 'Failed to export users' });
  }
});

module.exports = router;
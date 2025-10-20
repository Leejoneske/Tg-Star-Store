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

// Get all orders with pagination and filtering
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    
    // TODO: Replace with actual database queries
    const mockOrders = [
      {
        id: 'ORD001',
        userId: 'user_12345',
        username: '@john_doe',
        amount: 50.00,
        currency: 'USDT',
        status: 'completed',
        type: 'stars',
        quantity: 500,
        createdAt: new Date(Date.now() - 1000 * 60 * 30),
        completedAt: new Date(Date.now() - 1000 * 60 * 15)
      },
      {
        id: 'ORD002',
        userId: 'user_67890',
        username: '@jane_smith',
        amount: 25.50,
        currency: 'USDT',
        status: 'pending',
        type: 'premium',
        quantity: 1,
        createdAt: new Date(Date.now() - 1000 * 60 * 45)
      },
      {
        id: 'ORD003',
        userId: 'user_54321',
        username: '@bob_wilson',
        amount: 100.00,
        currency: 'USDT',
        status: 'completed',
        type: 'stars',
        quantity: 1000,
        createdAt: new Date(Date.now() - 1000 * 60 * 60),
        completedAt: new Date(Date.now() - 1000 * 60 * 45)
      }
    ];
    
    let filteredOrders = mockOrders;
    
    // Apply status filter
    if (status) {
      filteredOrders = filteredOrders.filter(order => order.status === status);
    }
    
    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      filteredOrders = filteredOrders.filter(order => 
        order.id.toLowerCase().includes(searchLower) ||
        order.username.toLowerCase().includes(searchLower) ||
        order.userId.toLowerCase().includes(searchLower)
      );
    }
    
    // Pagination
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedOrders = filteredOrders.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      data: paginatedOrders.map(order => ({
        ...order,
        createdAt: order.createdAt.toISOString(),
        completedAt: order.completedAt?.toISOString()
      })),
      pagination: {
        total: filteredOrders.length,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(filteredOrders.length / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get single order details
router.get('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Replace with actual database query
    const mockOrder = {
      id: id,
      userId: 'user_12345',
      username: '@john_doe',
      firstName: 'John',
      lastName: 'Doe',
      amount: 50.00,
      currency: 'USDT',
      status: 'completed',
      type: 'stars',
      quantity: 500,
      transactionHash: '0x1234567890abcdef',
      walletAddress: 'UQBx...abc123',
      createdAt: new Date(Date.now() - 1000 * 60 * 30),
      completedAt: new Date(Date.now() - 1000 * 60 * 15),
      notes: 'Order completed successfully',
      recipients: ['@john_doe']
    };
    
    res.json({
      success: true,
      data: {
        ...mockOrder,
        createdAt: mockOrder.createdAt.toISOString(),
        completedAt: mockOrder.completedAt?.toISOString()
      }
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// Update order status
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    if (!['pending', 'completed', 'cancelled', 'refunded'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // TODO: Update order in database
    console.log(`Updating order ${id} to status: ${status}`);
    
    // Broadcast update to connected clients
    if (global.broadcast) {
      global.broadcast('orders', {
        type: 'status_update',
        orderId: id,
        status,
        notes,
        updatedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'Order status updated successfully'
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Complete order
router.post('/:id/complete', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { transactionHash, notes } = req.body;
    
    // TODO: Complete order in database and trigger Telegram notifications
    console.log(`Completing order ${id} with transaction: ${transactionHash}`);
    
    // Broadcast update
    if (global.broadcast) {
      global.broadcast('orders', {
        type: 'order_completed',
        orderId: id,
        transactionHash,
        notes,
        completedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'Order completed successfully'
    });
  } catch (error) {
    console.error('Complete order error:', error);
    res.status(500).json({ error: 'Failed to complete order' });
  }
});

// Cancel/Decline order
router.post('/:id/cancel', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, refund } = req.body;
    
    // TODO: Cancel order in database
    console.log(`Cancelling order ${id}, refund: ${refund}`);
    
    // Broadcast update
    if (global.broadcast) {
      global.broadcast('orders', {
        type: 'order_cancelled',
        orderId: id,
        reason,
        refund,
        cancelledBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'Order cancelled successfully'
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// Export orders to CSV
router.get('/export/csv', verifyAdmin, async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;
    
    // TODO: Generate CSV from database
    const csvData = `Order ID,User,Amount,Status,Type,Date
ORD001,@john_doe,50.00,completed,stars,2024-01-21T10:30:00Z
ORD002,@jane_smith,25.50,pending,premium,2024-01-21T09:45:00Z
ORD003,@bob_wilson,100.00,completed,stars,2024-01-21T09:00:00Z`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders-export.csv"');
    res.send(csvData);
  } catch (error) {
    console.error('Export orders error:', error);
    res.status(500).json({ error: 'Failed to export orders' });
  }
});

module.exports = router;
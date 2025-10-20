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

// Get all notifications/templates
router.get('/', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    
    // TODO: Replace with actual database queries
    const mockNotifications = [
      {
        id: 'notif_001',
        type: 'broadcast',
        title: 'System Maintenance Notice',
        message: 'Scheduled maintenance will occur on Jan 25th from 2-4 AM UTC.',
        status: 'sent',
        recipients: 15420,
        delivered: 15380,
        opened: 8920,
        clicked: 1240,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
        sentAt: new Date(Date.now() - 1000 * 60 * 60 * 23),
        createdBy: 'admin_123'
      },
      {
        id: 'notif_002',
        type: 'promotional',
        title: 'New Premium Features Available!',
        message: 'Check out our latest premium features including advanced analytics and priority support.',
        status: 'draft',
        recipients: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
        sentAt: null,
        createdBy: 'admin_456'
      },
      {
        id: 'notif_003',
        type: 'alert',
        title: 'Security Update Required',
        message: 'Please update your password for enhanced security.',
        status: 'scheduled',
        recipients: 2840,
        delivered: 0,
        opened: 0,
        clicked: 0,
        createdAt: new Date(Date.now() - 1000 * 60 * 30),
        scheduledFor: new Date(Date.now() + 1000 * 60 * 60 * 6),
        createdBy: 'admin_123'
      }
    ];
    
    let filteredNotifications = mockNotifications;
    
    // Apply filters
    if (type) {
      filteredNotifications = filteredNotifications.filter(n => n.type === type);
    }
    
    if (status) {
      filteredNotifications = filteredNotifications.filter(n => n.status === status);
    }
    
    // Pagination
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedNotifications = filteredNotifications.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      data: paginatedNotifications.map(notification => ({
        ...notification,
        createdAt: notification.createdAt.toISOString(),
        sentAt: notification.sentAt?.toISOString(),
        scheduledFor: notification.scheduledFor?.toISOString()
      })),
      pagination: {
        total: filteredNotifications.length,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(filteredNotifications.length / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Create new notification
router.post('/', verifyAdmin, async (req, res) => {
  try {
    const {
      type,
      title,
      message,
      recipients,
      scheduledFor,
      priority = 'normal'
    } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }
    
    const notification = {
      id: `notif_${Date.now()}`,
      type: type || 'broadcast',
      title,
      message,
      status: scheduledFor ? 'scheduled' : 'draft',
      recipients: recipients || [],
      priority,
      createdAt: new Date(),
      createdBy: req.user.telegramId,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null
    };
    
    // TODO: Save notification to database
    console.log('Creating notification:', notification);
    
    // Broadcast to connected admins
    if (global.broadcast) {
      global.broadcast('notifications', {
        type: 'notification_created',
        notification,
        createdBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      data: {
        ...notification,
        createdAt: notification.createdAt.toISOString(),
        scheduledFor: notification.scheduledFor?.toISOString()
      },
      message: 'Notification created successfully'
    });
  } catch (error) {
    console.error('Create notification error:', error);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

// Send notification immediately
router.post('/:id/send', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { testMode = false } = req.body;
    
    // TODO: Implement actual notification sending via Telegram bot
    console.log(`Sending notification ${id} ${testMode ? '(TEST MODE)' : ''} by admin: ${req.user.telegramId}`);
    
    // Simulate sending process
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const result = {
      notificationId: id,
      status: 'sent',
      sentAt: new Date(),
      recipients: testMode ? 1 : 15420,
      delivered: testMode ? 1 : 15380,
      failed: testMode ? 0 : 40,
      testMode
    };
    
    // Broadcast sending result
    if (global.broadcast) {
      global.broadcast('notifications', {
        type: 'notification_sent',
        result,
        sentBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      data: {
        ...result,
        sentAt: result.sentAt.toISOString()
      },
      message: `Notification ${testMode ? 'test ' : ''}sent successfully`
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Get notification analytics
router.get('/:id/analytics', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Get actual analytics from database
    const mockAnalytics = {
      notificationId: id,
      sent: 15420,
      delivered: 15380,
      opened: 8920,
      clicked: 1240,
      bounced: 40,
      unsubscribed: 12,
      deliveryRate: 99.7,
      openRate: 58.0,
      clickRate: 13.9,
      timeline: [
        { time: '00:00', delivered: 0, opened: 0, clicked: 0 },
        { time: '01:00', delivered: 2840, opened: 420, clicked: 65 },
        { time: '02:00', delivered: 6820, opened: 1250, clicked: 180 },
        { time: '03:00', delivered: 11420, opened: 3840, clicked: 520 },
        { time: '04:00', delivered: 14680, opened: 6250, clicked: 890 },
        { time: '05:00', delivered: 15380, opened: 7890, clicked: 1150 },
        { time: '06:00', delivered: 15380, opened: 8920, clicked: 1240 }
      ],
      devices: {
        mobile: 78.5,
        desktop: 18.2,
        tablet: 3.3
      },
      locations: [
        { country: 'United States', opens: 2140 },
        { country: 'India', opens: 1680 },
        { country: 'Russia', opens: 1250 },
        { country: 'Brazil', opens: 890 },
        { country: 'Germany', opens: 720 }
      ]
    };
    
    res.json({
      success: true,
      data: mockAnalytics
    });
  } catch (error) {
    console.error('Get notification analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch notification analytics' });
  }
});

// Update notification
router.patch('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // TODO: Update notification in database
    console.log(`Updating notification ${id}:`, updates);
    
    // Broadcast update
    if (global.broadcast) {
      global.broadcast('notifications', {
        type: 'notification_updated',
        notificationId: id,
        updates,
        updatedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'Notification updated successfully'
    });
  } catch (error) {
    console.error('Update notification error:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Delete notification
router.delete('/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // TODO: Delete notification from database
    console.log(`Deleting notification ${id} by admin: ${req.user.telegramId}`);
    
    // Broadcast deletion
    if (global.broadcast) {
      global.broadcast('notifications', {
        type: 'notification_deleted',
        notificationId: id,
        deletedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Get notification templates
router.get('/templates', verifyAdmin, async (req, res) => {
  try {
    const mockTemplates = [
      {
        id: 'template_001',
        name: 'Welcome Message',
        type: 'welcome',
        subject: 'Welcome to StarStore!',
        content: 'Welcome {{firstName}}! Thank you for joining StarStore. Get started by exploring our features.',
        variables: ['firstName'],
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-15')
      },
      {
        id: 'template_002',
        name: 'Order Confirmation',
        type: 'transactional',
        subject: 'Order Confirmed - {{orderId}}',
        content: 'Your order {{orderId}} for {{amount}} has been confirmed and is being processed.',
        variables: ['orderId', 'amount'],
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-10')
      },
      {
        id: 'template_003',
        name: 'Maintenance Notice',
        type: 'system',
        subject: 'Scheduled Maintenance',
        content: 'We will be performing maintenance on {{date}} from {{startTime}} to {{endTime}}.',
        variables: ['date', 'startTime', 'endTime'],
        createdAt: new Date('2024-01-05'),
        updatedAt: new Date('2024-01-20')
      }
    ];
    
    res.json({
      success: true,
      data: mockTemplates.map(template => ({
        ...template,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString()
      }))
    });
  } catch (error) {
    console.error('Get notification templates error:', error);
    res.status(500).json({ error: 'Failed to fetch notification templates' });
  }
});

// Create notification template
router.post('/templates', verifyAdmin, async (req, res) => {
  try {
    const { name, type, subject, content, variables } = req.body;
    
    if (!name || !content) {
      return res.status(400).json({ error: 'Name and content are required' });
    }
    
    const template = {
      id: `template_${Date.now()}`,
      name,
      type: type || 'custom',
      subject,
      content,
      variables: variables || [],
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: req.user.telegramId
    };
    
    // TODO: Save template to database
    console.log('Creating notification template:', template);
    
    res.json({
      success: true,
      data: {
        ...template,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString()
      },
      message: 'Template created successfully'
    });
  } catch (error) {
    console.error('Create notification template error:', error);
    res.status(500).json({ error: 'Failed to create notification template' });
  }
});

module.exports = router;
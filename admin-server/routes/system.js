const express = require('express');
const router = express.Router();
const os = require('os');
const fs = require('fs').promises;

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

// Get system health status
router.get('/health', verifyAdmin, async (req, res) => {
  try {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    const systemHealth = {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      server: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        loadAverage: os.loadavg(),
        cpuCount: os.cpus().length
      },
      process: {
        pid: process.pid,
        memory: {
          rss: memoryUsage.rss,
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        }
      },
      services: {
        mainServer: await checkServiceHealth('main'),
        database: await checkServiceHealth('database'),
        telegram: await checkServiceHealth('telegram'),
        payment: await checkServiceHealth('payment')
      }
    };
    
    res.json({
      success: true,
      data: systemHealth
    });
  } catch (error) {
    console.error('System health check error:', error);
    res.status(500).json({ error: 'Failed to check system health' });
  }
});

// Check individual service health
async function checkServiceHealth(service) {
  try {
    switch (service) {
      case 'main':
        // Check main server connectivity
        const mainServerUrl = process.env.MAIN_SERVER_URL || 'http://localhost:3000';
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`${mainServerUrl}/api/health`, { timeout: 5000 });
        return {
          status: response.ok ? 'healthy' : 'degraded',
          responseTime: response.headers.get('x-response-time') || 'unknown',
          lastChecked: new Date().toISOString()
        };
        
      case 'database':
        // Mock database health check
        return {
          status: 'healthy',
          responseTime: Math.floor(Math.random() * 50) + 10,
          connections: Math.floor(Math.random() * 100) + 50,
          lastChecked: new Date().toISOString()
        };
        
      case 'telegram':
        // Mock Telegram bot health check
        return {
          status: 'healthy',
          responseTime: Math.floor(Math.random() * 200) + 50,
          webhookStatus: 'active',
          lastChecked: new Date().toISOString()
        };
        
      case 'payment':
        // Mock payment gateway health check
        return {
          status: 'healthy',
          responseTime: Math.floor(Math.random() * 300) + 100,
          gatewayStatus: 'operational',
          lastChecked: new Date().toISOString()
        };
        
      default:
        return {
          status: 'unknown',
          responseTime: 0,
          lastChecked: new Date().toISOString()
        };
    }
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      lastChecked: new Date().toISOString()
    };
  }
}

// Get system logs
router.get('/logs', verifyAdmin, async (req, res) => {
  try {
    const { level = 'all', limit = 100, offset = 0 } = req.query;
    
    // Mock log entries - in production, read from actual log files
    const mockLogs = [
      {
        timestamp: new Date(Date.now() - 1000 * 60 * 5),
        level: 'info',
        message: 'User authentication successful',
        service: 'auth',
        userId: 'user_12345'
      },
      {
        timestamp: new Date(Date.now() - 1000 * 60 * 10),
        level: 'warning',
        message: 'High memory usage detected',
        service: 'system',
        details: { memoryUsage: '85%' }
      },
      {
        timestamp: new Date(Date.now() - 1000 * 60 * 15),
        level: 'error',
        message: 'Payment gateway timeout',
        service: 'payment',
        orderId: 'ORD001',
        error: 'Connection timeout after 30s'
      },
      {
        timestamp: new Date(Date.now() - 1000 * 60 * 20),
        level: 'info',
        message: 'Order completed successfully',
        service: 'orders',
        orderId: 'ORD002',
        userId: 'user_67890'
      }
    ];
    
    let filteredLogs = mockLogs;
    
    // Filter by level
    if (level !== 'all') {
      filteredLogs = filteredLogs.filter(log => log.level === level);
    }
    
    // Pagination
    const paginatedLogs = filteredLogs
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
      .map(log => ({
        ...log,
        timestamp: log.timestamp.toISOString()
      }));
    
    res.json({
      success: true,
      data: paginatedLogs,
      pagination: {
        total: filteredLogs.length,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({ error: 'Failed to fetch system logs' });
  }
});

// Get system configuration
router.get('/config', verifyAdmin, async (req, res) => {
  try {
    const config = {
      environment: process.env.NODE_ENV || 'development',
      version: '1.0.0',
      features: {
        telegramBot: true,
        paymentGateway: true,
        referralSystem: true,
        premiumSubscriptions: true,
        analytics: true
      },
      limits: {
        maxOrderAmount: 10000,
        maxWithdrawalAmount: 5000,
        dailyOrderLimit: 100,
        referralLevels: 3
      },
      maintenance: {
        scheduled: false,
        nextWindow: null,
        duration: null
      }
    };
    
    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    console.error('Get system config error:', error);
    res.status(500).json({ error: 'Failed to fetch system configuration' });
  }
});

// Update system configuration
router.patch('/config', verifyAdmin, async (req, res) => {
  try {
    const { features, limits, maintenance } = req.body;
    
    // TODO: Update configuration in database/config file
    console.log('Updating system configuration:', {
      features,
      limits,
      maintenance,
      updatedBy: req.user.telegramId
    });
    
    // Broadcast configuration update
    if (global.broadcast) {
      global.broadcast('system', {
        type: 'config_updated',
        changes: { features, limits, maintenance },
        updatedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: 'System configuration updated successfully'
    });
  } catch (error) {
    console.error('Update system config error:', error);
    res.status(500).json({ error: 'Failed to update system configuration' });
  }
});

// Restart service
router.post('/services/:service/restart', verifyAdmin, async (req, res) => {
  try {
    const { service } = req.params;
    
    // TODO: Implement service restart logic
    console.log(`Restarting service: ${service} by admin: ${req.user.telegramId}`);
    
    // Simulate restart delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Broadcast service restart
    if (global.broadcast) {
      global.broadcast('system', {
        type: 'service_restarted',
        service,
        restartedBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: `Service ${service} restarted successfully`
    });
  } catch (error) {
    console.error('Restart service error:', error);
    res.status(500).json({ error: 'Failed to restart service' });
  }
});

// Enable/Disable maintenance mode
router.post('/maintenance', verifyAdmin, async (req, res) => {
  try {
    const { enabled, message, duration } = req.body;
    
    // TODO: Update maintenance mode in configuration
    console.log(`${enabled ? 'Enabling' : 'Disabling'} maintenance mode:`, {
      message,
      duration,
      setBy: req.user.telegramId
    });
    
    // Broadcast maintenance mode change
    if (global.broadcast) {
      global.broadcast('system', {
        type: 'maintenance_mode_changed',
        enabled,
        message,
        duration,
        setBy: req.user.telegramId,
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Maintenance mode error:', error);
    res.status(500).json({ error: 'Failed to update maintenance mode' });
  }
});

// Get system metrics
router.get('/metrics', verifyAdmin, async (req, res) => {
  try {
    const { period = '1h' } = req.query;
    
    // Mock metrics data
    const mockMetrics = {
      cpu: [
        { timestamp: new Date(Date.now() - 1000 * 60 * 60), value: 45.2 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 50), value: 52.1 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 40), value: 38.7 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 30), value: 41.3 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 20), value: 48.9 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 10), value: 44.5 },
        { timestamp: new Date(), value: 46.8 }
      ],
      memory: [
        { timestamp: new Date(Date.now() - 1000 * 60 * 60), value: 68.5 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 50), value: 71.2 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 40), value: 69.8 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 30), value: 72.4 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 20), value: 70.1 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 10), value: 73.6 },
        { timestamp: new Date(), value: 71.9 }
      ],
      requests: [
        { timestamp: new Date(Date.now() - 1000 * 60 * 60), value: 1250 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 50), value: 1380 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 40), value: 1420 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 30), value: 1650 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 20), value: 1580 },
        { timestamp: new Date(Date.now() - 1000 * 60 * 10), value: 1720 },
        { timestamp: new Date(), value: 1690 }
      ]
    };
    
    // Convert timestamps to ISO strings
    const formatMetrics = (metrics) => ({
      cpu: metrics.cpu.map(m => ({ ...m, timestamp: m.timestamp.toISOString() })),
      memory: metrics.memory.map(m => ({ ...m, timestamp: m.timestamp.toISOString() })),
      requests: metrics.requests.map(m => ({ ...m, timestamp: m.timestamp.toISOString() }))
    });
    
    res.json({
      success: true,
      data: formatMetrics(mockMetrics),
      period
    });
  } catch (error) {
    console.error('Get system metrics error:', error);
    res.status(500).json({ error: 'Failed to fetch system metrics' });
  }
});

module.exports = router;
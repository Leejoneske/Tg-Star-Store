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

// Get comprehensive analytics overview
router.get('/overview', verifyAdmin, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    // TODO: Replace with actual analytics queries
    const mockAnalytics = {
      userGrowth: {
        current: 15420,
        previous: 13850,
        growth: 11.3,
        chartData: [
          { date: '2024-01-15', users: 13850 },
          { date: '2024-01-16', users: 14120 },
          { date: '2024-01-17', users: 14380 },
          { date: '2024-01-18', users: 14650 },
          { date: '2024-01-19', users: 14920 },
          { date: '2024-01-20', users: 15180 },
          { date: '2024-01-21', users: 15420 }
        ]
      },
      revenue: {
        total: 89650.75,
        growth: 15.2,
        bySource: {
          stars: 65420.50,
          premium: 24230.25
        },
        chartData: [
          { date: '2024-01-15', revenue: 1250.75 },
          { date: '2024-01-16', revenue: 980.50 },
          { date: '2024-01-17', revenue: 1450.25 },
          { date: '2024-01-18', revenue: 1120.00 },
          { date: '2024-01-19', revenue: 1680.75 },
          { date: '2024-01-20', revenue: 1340.50 },
          { date: '2024-01-21', revenue: 1890.25 }
        ]
      },
      orders: {
        total: 3847,
        completed: 3824,
        pending: 23,
        cancelled: 15,
        conversionRate: 94.2,
        avgOrderValue: 23.30
      },
      engagement: {
        dailyActiveUsers: 892,
        weeklyActiveUsers: 4250,
        monthlyActiveUsers: 12840,
        avgSessionDuration: 8.5, // minutes
        bounceRate: 12.3
      }
    };
    
    res.json({
      success: true,
      data: mockAnalytics,
      period
    });
  } catch (error) {
    console.error('Get analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

// Get user behavior analytics
router.get('/users', verifyAdmin, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    const mockUserAnalytics = {
      demographics: {
        byCountry: [
          { country: 'United States', users: 3420, percentage: 22.2 },
          { country: 'India', users: 2850, percentage: 18.5 },
          { country: 'Russia', users: 2180, percentage: 14.1 },
          { country: 'Brazil', users: 1650, percentage: 10.7 },
          { country: 'Germany', users: 1320, percentage: 8.6 }
        ],
        newVsReturning: {
          new: 68.5,
          returning: 31.5
        }
      },
      activity: {
        peakHours: [
          { hour: 0, users: 120 },
          { hour: 1, users: 85 },
          { hour: 2, users: 65 },
          { hour: 6, users: 180 },
          { hour: 12, users: 450 },
          { hour: 14, users: 520 },
          { hour: 18, users: 680 },
          { hour: 20, users: 720 },
          { hour: 22, users: 580 }
        ],
        retention: {
          day1: 85.2,
          day7: 42.8,
          day30: 18.5
        }
      },
      conversion: {
        signupToFirstOrder: 23.5,
        freeToPremiun: 8.2,
        referralConversion: 15.8
      }
    };
    
    res.json({
      success: true,
      data: mockUserAnalytics,
      period
    });
  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch user analytics' });
  }
});

// Get financial analytics
router.get('/financial', verifyAdmin, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    const mockFinancialAnalytics = {
      revenue: {
        gross: 89650.75,
        net: 78420.50,
        fees: 11230.25,
        growth: {
          daily: 2.3,
          weekly: 8.7,
          monthly: 15.2
        }
      },
      transactions: {
        volume: 156780.25,
        count: 3847,
        avgValue: 40.75,
        byMethod: {
          ton: 78.5,
          usdt: 21.5
        }
      },
      profitability: {
        margin: 87.5,
        costPerAcquisition: 12.50,
        lifetimeValue: 185.30,
        paybackPeriod: 8.5 // days
      },
      forecasting: {
        nextMonth: {
          revenue: 95420.80,
          orders: 4120,
          growth: 6.4
        },
        nextQuarter: {
          revenue: 285650.40,
          orders: 12850,
          growth: 18.7
        }
      }
    };
    
    res.json({
      success: true,
      data: mockFinancialAnalytics,
      period
    });
  } catch (error) {
    console.error('Get financial analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch financial analytics' });
  }
});

// Get referral program analytics
router.get('/referrals', verifyAdmin, async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    
    const mockReferralAnalytics = {
      overview: {
        totalReferrals: 2840,
        activeReferrers: 1250,
        conversionRate: 15.8,
        totalCommissions: 8420.50
      },
      performance: {
        topReferrers: [
          { userId: 'user_12345', username: '@crypto_king', referrals: 85, earnings: 425.50 },
          { userId: 'user_67890', username: '@star_trader', referrals: 72, earnings: 360.00 },
          { userId: 'user_54321', username: '@premium_user', referrals: 68, earnings: 340.25 }
        ],
        monthlyTrend: [
          { month: 'Oct', referrals: 180, commissions: 450.00 },
          { month: 'Nov', referrals: 220, commissions: 550.25 },
          { month: 'Dec', referrals: 285, commissions: 712.50 },
          { month: 'Jan', referrals: 340, commissions: 850.75 }
        ]
      },
      insights: {
        avgReferralsPerUser: 2.3,
        bestPerformingChannel: 'Telegram Groups',
        peakReferralTime: '18:00-20:00 UTC'
      }
    };
    
    res.json({
      success: true,
      data: mockReferralAnalytics,
      period
    });
  } catch (error) {
    console.error('Get referral analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch referral analytics' });
  }
});

// Get real-time analytics
router.get('/realtime', verifyAdmin, async (req, res) => {
  try {
    const mockRealtimeData = {
      activeUsers: 892,
      onlineNow: 156,
      ordersToday: 47,
      revenueToday: 1890.25,
      recentActivity: [
        {
          type: 'order',
          user: '@new_user_123',
          amount: 25.50,
          timestamp: new Date(Date.now() - 1000 * 30)
        },
        {
          type: 'signup',
          user: '@crypto_enthusiast',
          referredBy: '@star_trader',
          timestamp: new Date(Date.now() - 1000 * 120)
        },
        {
          type: 'withdrawal',
          user: '@premium_member',
          amount: 150.00,
          timestamp: new Date(Date.now() - 1000 * 180)
        }
      ],
      systemLoad: {
        cpu: 45.2,
        memory: 68.7,
        activeConnections: 1240
      }
    };
    
    res.json({
      success: true,
      data: {
        ...mockRealtimeData,
        recentActivity: mockRealtimeData.recentActivity.map(activity => ({
          ...activity,
          timestamp: activity.timestamp.toISOString()
        }))
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get realtime analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch realtime analytics' });
  }
});

// Generate custom report
router.post('/reports', verifyAdmin, async (req, res) => {
  try {
    const { 
      reportType, 
      dateFrom, 
      dateTo, 
      metrics, 
      filters,
      format = 'json'
    } = req.body;
    
    // TODO: Generate custom report based on parameters
    console.log('Generating custom report:', {
      reportType,
      dateFrom,
      dateTo,
      metrics,
      filters,
      format
    });
    
    const mockReport = {
      id: `report_${Date.now()}`,
      type: reportType,
      period: { from: dateFrom, to: dateTo },
      generatedAt: new Date().toISOString(),
      generatedBy: req.user.telegramId,
      data: {
        summary: {
          totalUsers: 15420,
          totalRevenue: 89650.75,
          totalOrders: 3847
        },
        details: [
          // Report details would be generated here
        ]
      }
    };
    
    if (format === 'csv') {
      const csvData = `Report Type,${reportType}
Period,${dateFrom} to ${dateTo}
Total Users,15420
Total Revenue,89650.75
Total Orders,3847`;
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${reportType}-${Date.now()}.csv"`);
      res.send(csvData);
    } else {
      res.json({
        success: true,
        data: mockReport
      });
    }
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

module.exports = router;
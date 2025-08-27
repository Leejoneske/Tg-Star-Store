const express = require('express');
const { User, BuyOrder, SellOrder, Referral } = require('../models');
const { trackUserActivity } = require('../middleware/userActivity');
const { requireTelegramAuth } = require('../middleware/telegramAuth');

const router = express.Router();

// Get user profile
router.get('/profile/:userId', requireTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        const { extractApiKey } = require('../utils/auth');
        const apiKey = extractApiKey(req);
        const requesterId = req.verifiedTelegramUser?.id || req.headers['x-telegram-id'] || req.query.telegramId;
        
        // Require either matching owner or valid API key (admin)
        if (requesterId?.toString() !== userId.toString() && apiKey !== process.env.API_KEY) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const user = await User.findOne({ 
            $or: [{ id: userId }, { telegramId: userId }] 
        }).lean();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // Get user statistics
        const [buyOrders, sellOrders, referrals] = await Promise.all([
            BuyOrder.countDocuments({ telegramId: userId }),
            SellOrder.countDocuments({ telegramId: userId }),
            Referral.countDocuments({ referrerId: userId })
        ]);

        const profile = {
            id: user.id,
            telegramId: user.telegramId,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            referredBy: user.referredBy,
            referralDate: user.referralDate,
            joinDate: user.joinDate,
            lastSeen: user.lastSeen,
            isActive: user.isActive,
            stats: {
                totalBuyOrders: buyOrders,
                totalSellOrders: sellOrders,
                totalReferrals: referrals
            }
        };

        res.json({ success: true, profile });
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Update user profile
router.put('/profile/:userId', requireTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        const { firstName, lastName } = req.body;
        const requesterId = req.verifiedTelegramUser?.id || req.headers['x-telegram-id'] || req.query.telegramId;
        
        // Only allow users to update their own profile
        if (requesterId?.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const updateData = {};
        if (firstName !== undefined) updateData.firstName = firstName;
        if (lastName !== undefined) updateData.lastName = lastName;

        const user = await User.findOneAndUpdate(
            { $or: [{ id: userId }, { telegramId: userId }] },
            { $set: updateData },
            { new: true }
        ).lean();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get user statistics
router.get('/stats/:userId', requireTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        const { extractApiKey } = require('../utils/auth');
        const apiKey = extractApiKey(req);
        const requesterId = req.verifiedTelegramUser?.id || req.headers['x-telegram-id'] || req.query.telegramId;
        
        // Require either matching owner or valid API key (admin)
        if (requesterId?.toString() !== userId.toString() && apiKey !== process.env.API_KEY) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }

        const [buyOrders, sellOrders, referrals, activeReferrals] = await Promise.all([
            BuyOrder.find({ telegramId: userId }).lean(),
            SellOrder.find({ telegramId: userId }).lean(),
            Referral.find({ referrerId: userId }).lean(),
            Referral.find({ referrerId: userId, status: 'active' }).lean()
        ]);

        const stats = {
            totalBuyOrders: buyOrders.length,
            totalSellOrders: sellOrders.length,
            totalReferrals: referrals.length,
            activeReferrals: activeReferrals.length,
            totalSpent: buyOrders.reduce((sum, order) => sum + (order.amount || 0), 0),
            totalEarned: sellOrders.reduce((sum, order) => sum + (order.stars || 0), 0)
        };

        res.json({ success: true, stats });
    } catch (error) {
        console.error('Error fetching user stats:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
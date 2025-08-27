const express = require('express');
const router = express.Router();
const { requireTelegramAuth } = require('../middleware/telegramAuth');
const { BuyOrder, SellOrder, Referral, User } = require('../models');

// Get transaction history
router.get('/transactions/:userId', requireTelegramAuth, async (req, res) => {
    try {
        const { userId } = req.params;
        const authHeader = req.headers['authorization'] || '';
        const requesterId = req.headers['x-telegram-id'] || req.query.telegramId;
        if (requesterId?.toString() !== userId.toString() && authHeader !== process.env.API_KEY) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        // Get both buy and sell orders for the user
        const buyOrders = await BuyOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();
        
        const sellOrders = await SellOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();

        // Combine and format the data
        const transactions = [
            ...buyOrders.map(order => ({
                id: order.id,
                type: 'Buy Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Buy order for ${order.stars} stars`,
                usdtValue: order.amount
            })),
            ...sellOrders.map(order => ({
                id: order.id,
                type: 'Sell Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Sell order for ${order.stars} stars`,
                usdtValue: null 
            }))
        ];

        res.json({ success: true, transactions });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get referral history
router.get('/referrals/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const referrals = await Referral.find({ referrerId: userId })
            .sort({ dateCreated: -1 })
            .lean();
        
        // Format referral data
        const formattedReferrals = await Promise.all(referrals.map(async referral => {
            const referredUser = await User.findOne({ $or: [{ id: referral.referredId }, { telegramId: referral.referredId }] }).lean();
            
            return {
                id: referral._id.toString(),
                name: referredUser?.username || 'Unknown User',
                status: referral.status.toLowerCase(),
                date: referral.dateCreated,
                details: `Referred user ${referredUser?.username || referral.referredId}`,
                amount: 0.5 // Fixed bonus amount or calculate based on your logic
            };
        }));

        res.json(formattedReferrals);
    } catch (error) {
        console.error('Error fetching referrals:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
const express = require('express');
const mongoose = require('mongoose');
const { Referral, User, ReferralWithdrawal } = require('../models');

const router = express.Router();

// Referral stats
router.get('/referral-stats/:userId', async (req, res) => {
    try {
        const referrals = await Referral.find({ referrerId: req.params.userId }).lean();
        const referredUserIds = referrals.map(r => r.referredId);
        const users = await User.find({ id: { $in: referredUserIds } })
            .select('id username')
            .lean();

        const userMap = {};
        users.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referrals.length;
        const availableReferrals = await Referral.find({
            referrerId: req.params.userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).countDocuments();

        const completedReferrals = referrals.filter(r => ['completed', 'active'].includes(r.status)).length;

        res.json({
            success: true,
            referrals: referrals.map(ref => ({
                userId: ref.referredId,
                name: userMap[ref.referredId] || `User ${ref.referredId.substring(0, 6)}`,
                status: ref.status.toLowerCase(),
                date: ref.dateReferred || ref.dateCreated || new Date(0),
                amount: 0.5
            })),
            stats: {
                availableBalance: availableReferrals * 0.5,
                totalEarned: completedReferrals * 0.5,
                referralsCount: totalReferrals,
                pendingAmount: (totalReferrals - completedReferrals) * 0.5
            },
            referralLink: `https://t.me/TgStarStore_bot?start=ref_${req.params.userId}`
        });

    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load referral data' });
    }
});

// Withdrawal history
router.get('/withdrawal-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const withdrawals = await ReferralWithdrawal.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50);

        res.json({ success: true, withdrawals });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create withdrawal
router.post('/referral-withdrawals', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { userId, amount, walletAddress } = req.body;
        const amountNum = parseFloat(amount);

        if (!userId || !amount || !walletAddress) {
            throw new Error('Missing required fields');
        }

        const user = await User.findOne({ id: userId }).session(session) || {};
        const availableReferrals = await Referral.find({
            referrerId: userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).session(session);

        const availableBalance = availableReferrals.length * 0.5;

        if (amountNum < 0.5) throw new Error('Minimum withdrawal is 0.5 USDT');
        if (amountNum > availableBalance) throw new Error(`Available: ${availableBalance.toFixed(2)} USDT`);

        const referralsNeeded = Math.ceil(amountNum / 0.5);
        const referralsToMark = availableReferrals.slice(0, referralsNeeded);

        const username = user.username || `@user`;

        const withdrawal = new ReferralWithdrawal({
            userId,
            username: username,
            amount: amountNum,
            walletAddress: walletAddress.trim(),
            referralIds: referralsToMark.map(r => r._id),
            status: 'pending',
            adminMessages: [],
            createdAt: new Date()
        });

        await withdrawal.save({ session });

        await Referral.updateMany(
            { _id: { $in: referralsToMark.map(r => r._id) } },
            { $set: { withdrawn: true } },
            { session }
        );

        await session.commitTransaction();
        
        // Send admin notifications
        const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
        const userInfo = await User.findOne({ $or: [{ id: userId }, { telegramId: userId }] });
        const userDisplayName = userInfo?.username || `User ${userId.substring(0, 6)}`;
        
        const adminMessage = `💰 New Referral Withdrawal Request\n\n` +
                           `🔸 WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n` +
                           `👤 ${userDisplayName}\n` +
                           `💰 ${amountNum} USDT\n` +
                           `🏦 ${walletAddress.substring(0, 6)}...${walletAddress.slice(-4)}\n` +
                           `📅 ${new Date().toLocaleString()}\n\n` +
                           `Use /withdrawals to view all pending withdrawals`;

        // Store admin message info for later updates
        withdrawal.adminMessages = [];
        
        // Note: Admin notifications will be sent by the AdminManager when it's properly initialized
        // For now, we'll just store the withdrawal and let admins check with /withdrawals command
        
        await withdrawal.save();
        res.json({ success: true, withdrawalId: withdrawal._id });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, error: error.message });
    } finally {
        session.endSession();
    }
});

// Get referral history
router.get('/referrals/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const referrals = await Referral.find({ referrerId: userId })
            .sort({ dateCreated: -1 })
            .limit(50)
            .lean();

        // Get all referred user IDs
        const referredUserIds = referrals.map(ref => ref.referredId);
        
        // Batch fetch all referred users in a single query
        const referredUsers = await User.find({ id: { $in: referredUserIds } })
            .select('id username')
            .lean();
        
        // Create a map for quick lookup
        const userMap = {};
        referredUsers.forEach(user => {
            userMap[user.id] = user.username;
        });

        // Format referral data
        const formattedReferrals = referrals.map(referral => {
            const referredUsername = userMap[referral.referredId] || referral.referredId;
            
            return {
                id: referral._id.toString(),
                referredUserId: referral.referredId,
                status: referral.status.toLowerCase(),
                date: referral.dateCreated,
                details: `Referred user ${referredUsername}`,
                amount: 0.5
            };
        });

        res.json({ success: true, referrals: formattedReferrals });
    } catch (error) {
        console.error('Error fetching referrals:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch referral history' });
    }
});

module.exports = router;
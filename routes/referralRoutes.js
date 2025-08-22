const express = require('express');
const mongoose = require('mongoose');
const { Referral, User, ReferralWithdrawal } = require('../models');

const router = express.Router();

// Referral stats
router.get('/referral-stats/:userId', async (req, res) => {
    try {
        const referrals = await Referral.find({ referrerUserId: req.params.userId });
        const referredUserIds = referrals.map(r => r.referredUserId);
        const users = await User.find({ id: { $in: referredUserIds } });

        const userMap = {};
        users.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referrals.length;
        const availableReferrals = await Referral.find({
            referrerUserId: req.params.userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).countDocuments();

        const completedReferrals = referrals.filter(r => ['completed', 'active'].includes(r.status)).length;

        res.json({
            success: true,
            referrals: referrals.map(ref => ({
                userId: ref.referredUserId,
                name: userMap[ref.referredUserId] || `User ${ref.referredUserId.substring(0, 6)}`,
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
            referrerUserId: userId,
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
        res.json({ success: true, withdrawalId: withdrawal.withdrawalId });
    } catch (error) {
        await session.abortTransaction();
        res.status(400).json({ success: false, error: error.message });
    } finally {
        session.endSession();
    }
});

module.exports = router;
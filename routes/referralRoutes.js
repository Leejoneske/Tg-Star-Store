const express = require('express');
const mongoose = require('mongoose');
const { Referral, User, ReferralWithdrawal } = require('../models');
const { trackUserActivity } = require('../middleware/userActivity');
const { validateTelegramId } = require('../utils/validation');
const { optionalTelegramAuth } = require('../middleware/telegramAuth');

const router = express.Router();

// Get referral statistics
router.get('/referral-stats/:userId', optionalTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: userValidation.error 
            });
        }

        const [referrals, activeReferrals, totalEarnings, pendingWithdrawals] = await Promise.all([
            Referral.countDocuments({ 
                $or: [
                    { referrerId: userId },      // New schema
                    { referrerUserId: userId }   // Old schema
                ]
            }),
            Referral.countDocuments({ 
                $or: [
                    { referrerId: userId, status: 'active' },      // New schema
                    { referrerUserId: userId, status: 'active' }   // Old schema
                ]
            }),
            ReferralWithdrawal.aggregate([
                { $match: { userId: userId, status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            ReferralWithdrawal.countDocuments({ userId: userId, status: 'pending' })
        ]);

        const availableBalance = activeReferrals * 0.5;
        const totalEarned = totalEarnings[0]?.total || 0;

        // Also get the actual referral list for the frontend
        const referralList = await Referral.find({ 
            $or: [
                { referrerId: userId },      // New schema
                { referrerUserId: userId }   // Old schema
            ]
        })
        .sort({ dateCreated: -1 })
        .limit(50)
        .lean();

        // Format referral list with user details
        const formattedReferrals = await Promise.all(referralList.map(async referral => {
            const referredUserId = referral.referredId || referral.referredUserId;
            const referredUser = await User.findOne({ 
                $or: [{ id: referredUserId }, { telegramId: referredUserId }] 
            }).lean();
            
            return {
                id: referral._id.toString(),
                name: referredUser?.username || referredUser?.first_name || 'Unknown User',
                status: referral.status.toLowerCase(),
                date: referral.dateCreated,
                userId: referredUserId
            };
        }));

        res.json({
            success: true,
            stats: {
                totalReferrals: referrals,
                activeReferrals,
                availableBalance: availableBalance.toFixed(2),
                totalEarned: totalEarned.toFixed(2),
                pendingWithdrawals
            },
            referrals: formattedReferrals,
            referralLink: `https://t.me/TgStarStore_bot?start=ref_${userId}`
        });
    } catch (error) {
        console.error('Referral stats error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get withdrawal history
router.get('/withdrawal-history/:userId', optionalTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: userValidation.error 
            });
        }

        const withdrawals = await ReferralWithdrawal.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error('Withdrawal history error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Create withdrawal with enhanced security
router.post('/referral-withdrawals', trackUserActivity, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { userId, amount, walletAddress } = req.body;
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            throw new Error('Invalid user ID');
        }

        // Validate amount
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum < 0.5) {
            throw new Error('Minimum withdrawal is 0.5 USDT');
        }

        if (amountNum > 1000) {
            throw new Error('Maximum withdrawal is 1000 USDT');
        }

        // Validate wallet address
        if (!walletAddress || walletAddress.trim().length < 10) {
            throw new Error('Invalid wallet address');
        }

        // Sanitize wallet address
        const sanitizedWallet = walletAddress.trim().replace(/[<>]/g, '');

        const user = await User.findOne({ 
            $or: [{ id: userId }, { telegramId: userId }] 
        }).session(session);

        if (!user) {
            throw new Error('User not found');
        }

        // Check for existing pending withdrawals
        const pendingWithdrawals = await ReferralWithdrawal.countDocuments({
            userId: userId,
            status: 'pending'
        }).session(session);

        if (pendingWithdrawals >= 3) {
            throw new Error('You have too many pending withdrawals. Please wait for existing ones to be processed.');
        }

        // Get available referrals
        const availableReferrals = await Referral.find({
            referrerId: userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).session(session);

        const availableBalance = availableReferrals.length * 0.5;

        if (amountNum > availableBalance) {
            throw new Error(`Available: ${availableBalance.toFixed(2)} USDT`);
        }

        const referralsNeeded = Math.ceil(amountNum / 0.5);
        const referralsToMark = availableReferrals.slice(0, referralsNeeded);

        const withdrawal = new ReferralWithdrawal({
            userId,
            username: user.username || `User_${userId.substring(0, 6)}`,
            amount: amountNum,
            walletAddress: sanitizedWallet,
            referralIds: referralsToMark.map(r => r._id),
            status: 'pending',
            adminMessages: [],
            createdAt: new Date()
        });

        await withdrawal.save({ session });

        // Mark referrals as withdrawn
        await Referral.updateMany(
            { _id: { $in: referralsToMark.map(r => r._id) } },
            { $set: { withdrawn: true } },
            { session }
        );

        await session.commitTransaction();
        
        res.json({ 
            success: true, 
            withdrawalId: withdrawal._id,
            message: 'Withdrawal request submitted successfully'
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal creation error:', error);
        res.status(400).json({ success: false, error: error.message });
    } finally {
        session.endSession();
    }
});

// Get referral history with pagination
router.get('/referrals/:userId', optionalTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 20, offset = 0 } = req.query;
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: userValidation.error 
            });
        }

        // Validate pagination parameters
        const limitNum = Math.min(parseInt(limit), 100);
        const offsetNum = Math.max(parseInt(offset), 0);

        // Handle both old and new schema field names
        const referrals = await Referral.find({ 
            $or: [
                { referrerId: userId },      // New schema
                { referrerUserId: userId }   // Old schema
            ]
        })
            .sort({ dateCreated: -1 })
            .skip(offsetNum)
            .limit(limitNum)
            .lean();

        const total = await Referral.countDocuments({ 
            $or: [
                { referrerId: userId },      // New schema
                { referrerUserId: userId }   // Old schema
            ]
        });

        res.json({
            success: true,
            referrals,
            pagination: {
                total,
                limit: limitNum,
                offset: offsetNum,
                hasMore: total > offsetNum + referrals.length
            }
        });
    } catch (error) {
        console.error('Referral history error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get available balance
router.get('/available-balance/:userId', optionalTelegramAuth, trackUserActivity, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: userValidation.error 
            });
        }

        const availableReferrals = await Referral.find({
            $or: [
                { referrerId: userId },      // New schema
                { referrerUserId: userId }   // Old schema
            ],
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).lean();

        const availableBalance = availableReferrals.length * 0.5;

        res.json({
            success: true,
            availableBalance: availableBalance.toFixed(2),
            activeReferrals: availableReferrals.length
        });
    } catch (error) {
        console.error('Available balance error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
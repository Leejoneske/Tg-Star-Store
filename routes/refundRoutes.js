const express = require('express');
const { SellOrder, Reversal } = require('../models');
const { requireAdminAuth, adminRateLimit, logAdminAction } = require('../middleware/adminAuth');
const { trackUserActivity } = require('../middleware/userActivity');
const { validateTelegramId, validateTransactionId, validateOrderId, maskSensitiveData } = require('../utils/validation');
const axios = require('axios');

const router = express.Router();

// Apply rate limiting to all routes
router.use(adminRateLimit);

// Get all refund requests (admin only)
router.get('/refund-requests', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { limit = 50, offset = 0, status } = req.query;
        const limitNum = Math.min(parseInt(limit), 100);
        const offsetNum = Math.max(parseInt(offset), 0);

        const query = {};
        if (status) {
            query.status = status;
        }

        const [requests, total] = await Promise.all([
            Reversal.find(query)
                .sort({ createdAt: -1 })
                .skip(offsetNum)
                .limit(limitNum)
                .lean(),
            Reversal.countDocuments(query)
        ]);

        res.json({
            success: true,
            requests,
            pagination: {
                total,
                limit: limitNum,
                offset: offsetNum,
                hasMore: total > offsetNum + requests.length
            }
        });
    } catch (error) {
        console.error('Refund requests error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get specific refund request (admin only)
router.get('/refund-requests/:requestId', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        const validation = validateOrderId(requestId);
        
        if (!validation.valid) {
            return res.status(400).json({ success: false, error: validation.error });
        }

        const request = await Reversal.findOne({ orderId: validation.orderId }).lean();
        
        if (!request) {
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        res.json({ success: true, request });
    } catch (error) {
        console.error('Refund request error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Process refund request (admin only)
router.post('/refund-requests/:requestId/process', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action, reason } = req.body; // action: 'approve' or 'reject'
        
        const validation = validateOrderId(requestId);
        if (!validation.valid) {
            return res.status(400).json({ success: false, error: validation.error });
        }

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Invalid action. Use "approve" or "reject"' });
        }

        const request = await Reversal.findOne({ orderId: validation.orderId });
        if (!request) {
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Refund request already processed' });
        }

        // Process the refund
        if (action === 'approve') {
            // Call Telegram API to process refund
            const refundPayload = {
                user_id: parseInt(request.telegramId),
                telegram_payment_charge_id: request.orderId
            };

            console.log('Processing refund:', maskSensitiveData({ 
                orderId: request.orderId, 
                userId: request.telegramId,
                adminId: req.isAdmin ? 'admin' : 'unknown'
            }));

            const { data } = await axios.post(
                `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/refundStarPayment`,
                refundPayload,
                { 
                    timeout: 15000,
                    headers: { 'Content-Type': 'application/json' }
                }
            );

            if (!data.ok) {
                throw new Error(data.description || 'Refund API call failed');
            }

            request.status = 'approved';
            request.processedAt = new Date();
            request.processedBy = req.isAdmin ? 'admin' : 'unknown';
            request.adminReason = reason;
        } else {
            request.status = 'rejected';
            request.processedAt = new Date();
            request.processedBy = req.isAdmin ? 'admin' : 'unknown';
            request.adminReason = reason;
        }

        await request.save();

        res.json({ 
            success: true, 
            message: `Refund request ${action}ed successfully`,
            request 
        });

    } catch (error) {
        console.error('Refund processing error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Direct refund by transaction ID (admin only)
router.post('/refund-transaction', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { txId, userId } = req.body;
        
        const txValidation = validateTransactionId(txId);
        if (!txValidation.valid) {
            return res.status(400).json({ success: false, error: txValidation.error });
        }

        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ success: false, error: userValidation.error });
        }

        const refundPayload = {
            user_id: userValidation.id,
            telegram_payment_charge_id: txValidation.txId
        };

        console.log('Processing direct refund:', maskSensitiveData({ 
            txId: txValidation.txId, 
            userId: userValidation.id,
            adminId: req.isAdmin ? 'admin' : 'unknown'
        }));

        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/refundStarPayment`,
            refundPayload,
            { 
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            }
        );

        if (!data.ok) {
            throw new Error(data.description || 'Refund API call failed');
        }

        res.json({ 
            success: true, 
            message: 'Direct refund processed successfully',
            txId: txValidation.txId
        });

    } catch (error) {
        console.error('Direct refund error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
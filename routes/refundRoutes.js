const express = require('express');
const { SellOrder, Reversal } = require('../models');
const { requireAdminAuth, adminRateLimit, logAdminAction } = require('../middleware/adminAuth');
const { trackUserActivity } = require('../middleware/userActivity');
const { 
    validateTelegramId, 
    validateTransactionId, 
    validateOrderId,
    maskSensitiveData 
} = require('../utils/validation');
const axios = require('axios');

const router = express.Router();

// Apply rate limiting to all refund routes
router.use(adminRateLimit);

// Get refund requests (admin only)
router.get('/refund-requests', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        
        // Validate query parameters
        const limitNum = parseInt(limit, 10);
        const offsetNum = parseInt(offset, 10);
        
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid limit parameter (1-100)' 
            });
        }
        
        if (isNaN(offsetNum) || offsetNum < 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid offset parameter' 
            });
        }
        
        const filter = {};
        if (status && ['pending', 'approved', 'rejected', 'processing', 'expired'].includes(status)) {
            filter.status = status;
        }

        const requests = await Reversal.find(filter)
            .sort({ createdAt: -1 })
            .limit(limitNum)
            .skip(offsetNum)
            .lean();

        const total = await Reversal.countDocuments(filter);

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
        console.error('Error fetching refund requests:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get refund request by ID
router.get('/refund-requests/:requestId', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        
        // Validate order ID
        const orderValidation = validateOrderId(requestId);
        if (!orderValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: orderValidation.error 
            });
        }
        
        const request = await Reversal.findOne({ orderId: orderValidation.orderId }).lean();
        
        if (!request) {
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        res.json({ success: true, request });
    } catch (error) {
        console.error('Error fetching refund request:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Process refund (admin only)
router.post('/refund-requests/:requestId/process', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action } = req.body; // 'approve' or 'reject'
        
        // Validate order ID
        const orderValidation = validateOrderId(requestId);
        if (!orderValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: orderValidation.error 
            });
        }
        
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid action. Must be "approve" or "reject"' 
            });
        }

        const request = await Reversal.findOne({ orderId: orderValidation.orderId });
        
        if (!request) {
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ 
                success: false, 
                error: 'Request already processed' 
            });
        }

        if (action === 'approve') {
            // Process the refund
            const result = await processRefund(orderValidation.orderId);
            
            if (result.success) {
                request.status = 'approved';
                request.processedAt = new Date();
                await request.save();

                res.json({
                    success: true,
                    message: 'Refund processed successfully',
                    chargeId: result.chargeId,
                    alreadyRefunded: result.alreadyRefunded
                });
            } else {
                res.status(500).json({ success: false, error: 'Failed to process refund' });
            }
        } else {
            // Reject the refund
            request.status = 'rejected';
            request.processedAt = new Date();
            await request.save();

            res.json({
                success: true,
                message: 'Refund request rejected'
            });
        }
    } catch (error) {
        console.error('Error processing refund request:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Direct refund by transaction ID (admin only)
router.post('/refund-transaction', requireAdminAuth, logAdminAction, trackUserActivity, async (req, res) => {
    try {
        const { txId, userId } = req.body;
        
        // Validate transaction ID
        const txValidation = validateTransactionId(txId);
        if (!txValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: txValidation.error 
            });
        }
        
        // Validate user ID
        const userValidation = validateTelegramId(userId);
        if (!userValidation.valid) {
            return res.status(400).json({ 
                success: false, 
                error: userValidation.error 
            });
        }

        const refundPayload = {
            user_id: userValidation.id,
            telegram_payment_charge_id: txValidation.txId
        };

        // Log the refund attempt (without sensitive data)
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
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                return res.json({
                    success: true,
                    message: 'Transaction was already refunded',
                    alreadyRefunded: true
                });
            }
            throw new Error(data.description || "Refund API call failed");
        }

        // Update order if found
        const order = await SellOrder.findOne({ telegram_payment_charge_id: txValidation.txId });
        if (order) {
            order.status = 'refunded';
            order.dateRefunded = new Date();
            order.refundData = {
                requested: true,
                status: 'processed',
                processedAt: new Date(),
                chargeId: txValidation.txId
            };
            await order.save();
        }

        res.json({
            success: true,
            message: 'Refund processed successfully',
            chargeId: txValidation.txId
        });

    } catch (error) {
        console.error('Error processing direct refund:', error.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Helper function to process refund
async function processRefund(orderId) {
    const session = await require('mongoose').startSession();
    session.startTransaction();

    try {
        const order = await SellOrder.findOne({ id: orderId }).session(session);
        if (!order) throw new Error("Order not found");
        if (order.status !== 'processing') throw new Error("Order not in processing state");
        if (!order.telegram_payment_charge_id) throw new Error("Missing payment reference");

        // Validate user ID before processing
        const userValidation = validateTelegramId(order.telegramId);
        if (!userValidation.valid) {
            throw new Error("Invalid user ID in order");
        }

        const refundPayload = {
            user_id: userValidation.id,
            telegram_payment_charge_id: order.telegram_payment_charge_id
        };

        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/refundStarPayment`,
            refundPayload,
            { 
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                order.status = 'refunded';
                order.dateRefunded = new Date();
                order.refundData = {
                    requested: true,
                    status: 'refunded',
                    processedAt: new Date(),
                    chargeId: order.telegram_payment_charge_id
                };
                await order.save({ session });
                await session.commitTransaction();
                return { success: true, chargeId: order.telegram_payment_charge_id, alreadyRefunded: true };
            }
            throw new Error(data.description || "Refund API call failed");
        }

        order.status = 'refunded';
        order.dateRefunded = new Date();
        order.refundData = {
            requested: true,
            status: 'refunded',
            processedAt: new Date(),
            chargeId: order.telegram_payment_charge_id
        };
        await order.save({ session });
        await session.commitTransaction();
        return { success: true, chargeId: order.telegram_payment_charge_id };

    } catch (error) {
        await session.abortTransaction();
        console.error('Refund processing error:', error.message);
        throw error;
    } finally {
        session.endSession();
    }
}

module.exports = router;
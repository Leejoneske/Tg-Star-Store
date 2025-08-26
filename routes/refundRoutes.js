const express = require('express');
const { SellOrder, Reversal } = require('../models');
const { requireApiAuth } = require('../middleware/apiAuth');
const { trackUserActivity } = require('../middleware/userActivity');
const axios = require('axios');

const router = express.Router();

// Get refund requests (admin only)
router.get('/refund-requests', requireApiAuth, trackUserActivity, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        
        const filter = {};
        if (status) {
            filter.status = status;
        }

        const requests = await Reversal.find(filter)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(offset))
            .lean();

        const total = await Reversal.countDocuments(filter);

        res.json({
            success: true,
            requests,
            pagination: {
                total,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: total > parseInt(offset) + requests.length
            }
        });
    } catch (error) {
        console.error('Error fetching refund requests:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get refund request by ID
router.get('/refund-requests/:requestId', requireApiAuth, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        
        const request = await Reversal.findOne({ orderId: requestId }).lean();
        
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
router.post('/refund-requests/:requestId/process', requireApiAuth, trackUserActivity, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { action } = req.body; // 'approve' or 'reject'
        
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, error: 'Invalid action. Must be "approve" or "reject"' });
        }

        const request = await Reversal.findOne({ orderId: requestId });
        
        if (!request) {
            return res.status(404).json({ success: false, error: 'Refund request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Request already processed' });
        }

        if (action === 'approve') {
            // Process the refund
            const result = await processRefund(requestId);
            
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
router.post('/refund-transaction', requireApiAuth, trackUserActivity, async (req, res) => {
    try {
        const { txId, userId } = req.body;
        
        if (!txId || !userId) {
            return res.status(400).json({ success: false, error: 'Missing txId or userId' });
        }

        const refundPayload = {
            user_id: parseInt(userId),
            telegram_payment_charge_id: txId
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
                return res.json({
                    success: true,
                    message: 'Transaction was already refunded',
                    alreadyRefunded: true
                });
            }
            throw new Error(data.description || "Refund API call failed");
        }

        // Update order if found
        const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
        if (order) {
            order.status = 'refunded';
            order.dateRefunded = new Date();
            order.refundData = {
                requested: true,
                status: 'processed',
                processedAt: new Date(),
                chargeId: txId
            };
            await order.save();
        }

        res.json({
            success: true,
            message: 'Refund processed successfully',
            chargeId: txId
        });

    } catch (error) {
        console.error('Error processing direct refund:', error);
        res.status(500).json({ success: false, error: error.message });
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

        const refundPayload = {
            user_id: parseInt(order.telegramId),
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
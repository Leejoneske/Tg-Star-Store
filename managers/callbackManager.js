const TelegramBot = require('node-telegram-bot-api');
const { SellOrder, BuyOrder, User, Reversal } = require('../models');
const { getUserDisplayName } = require('../utils/helpers');
const ReferralTrackingManager = require('./referralTrackingManager');
const NotificationManager = require('./notificationManager');
const axios = require('axios');

class CallbackManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.referralTrackingManager = new ReferralTrackingManager(bot, adminIds);
        this.notificationManager = new NotificationManager(this.bot, this.adminIds);
        this.setupCallbackHandlers();
    }

    setupCallbackHandlers() {
        this.bot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });
    }

    async handleCallbackQuery(query) {
        const { data, message, from } = query;
        
        if (!data) return;

        try {
            // Handle different callback types
            if (data.startsWith('complete_sell_')) {
                await this.handleCompleteSell(query);
            } else if (data.startsWith('decline_sell_')) {
                await this.handleDeclineSell(query);
            } else if (data.startsWith('refund_sell_')) {
                await this.handleRefundSell(query);
            } else if (data.startsWith('req_approve_')) {
                await this.handleApproveRefundRequest(query);
            } else if (data.startsWith('req_reject_')) {
                await this.handleRejectRefundRequest(query);
            } else if (data.startsWith('refund_order_')) {
                await this.handleRefundOrder(query);
            } else if (data.startsWith('reject_refund_')) {
                await this.handleRejectRefund(query);
            } else if (data.startsWith('approve_refund_')) {
                await this.handleApproveRefund(query);
            } else if (data.startsWith('complete_buy_')) {
                await this.handleCompleteBuy(query);
            } else if (data.startsWith('decline_buy_')) {
                await this.handleDeclineBuy(query);
            } else if (data.startsWith('reverse_')) {
                await this.handleReverseOrder(query);
            } else if (data.startsWith('refund_')) {
                await this.handleRefundOrder(query);
            } else if (data.startsWith('recreate_sell_')) {
                await this.handleRecreateSell(query);
            } else if (data.startsWith('recreate_buy_')) {
                await this.handleRecreateBuy(query);
            } else if (data.startsWith('ban_user_')) {
                await this.handleBanUser(query);
            } else if (data.startsWith('unban_user_')) {
                await this.handleUnbanUser(query);
            } else if (data.startsWith('processed_done')) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Action completed' });
            } else {
                // Unknown callback
                await this.bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
            }
        } catch (error) {
            console.error('Error handling callback query:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
        }
    }

    async handleCompleteSell(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('complete_sell_', '');
        
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            if (order.status === "completed") {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order already completed' });
                return;
            }

            order.status = "completed";
            order.dateCompleted = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `✅ Your order has been completed!\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Completed\n\n` +
                `Your stars have been sent to your Telegram account.`
            );

            // Track referral activity
            try {
                await this.referralTrackingManager.trackStars(order.telegramId, order.stars, 'sell');
            } catch (referralError) {
                console.error('Failed to track referral for sell order:', referralError);
            }

            // Send notification
            try {
                await this.notificationManager.sendOrderCompletedNotification(order.telegramId, order.id, order.stars);
            } catch (notificationError) {
                console.error('Failed to send order completion notification:', notificationError);
            }

            // Update admin message
            const updatedMessage = `✅ Order ${orderId} completed by admin`;
            await this.bot.editMessageText(updatedMessage, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Order completed successfully' });
        } catch (error) {
            console.error('Error completing order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error completing order' });
        }
    }

    async handleDeclineSell(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('decline_sell_', '');
        
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            if (order.status === "declined") {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order already declined' });
                return;
            }

            order.status = "declined";
            order.dateCompleted = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `❌ Your order has been declined.\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Declined\n\n` +
                `Please contact support if you have any questions.`
            );

            // Update admin message
            const updatedMessage = `❌ Order ${orderId} declined by admin`;
            await this.bot.editMessageText(updatedMessage, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Order declined' });
        } catch (error) {
            console.error('Error declining order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error declining order' });
        }
    }

    async handleRefundSell(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('refund_sell_', '');
        
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            if (order.status === "refunded") {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order already refunded' });
                return;
            }

            order.status = "refunded";
            order.dateCompleted = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `💸 Your order has been refunded.\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Refunded\n\n` +
                `Your payment will be refunded to your original payment method.`
            );

            // Update admin message
            const updatedMessage = `💸 Order ${orderId} refunded by admin`;
            await this.bot.editMessageText(updatedMessage, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Order refunded' });
        } catch (error) {
            console.error('Error refunding order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error refunding order' });
        }
    }

    async handleCompleteBuy(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('complete_buy_', '');
        
        try {
            const order = await BuyOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            if (order.status === "completed") {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order already completed' });
                return;
            }

            order.status = "completed";
            order.dateCompleted = new Date();
            await order.save();

            // Track referral activity for buy orders
            try {
                await this.referralTrackingManager.trackStars(order.telegramId, order.stars, 'buy');
                if (order.isPremium) {
                    await this.referralTrackingManager.trackPremiumActivation(order.telegramId);
                }
            } catch (referralError) {
                console.error('Failed to track referral for buy order:', referralError);
            }

            // Notify user
            const userMessage = order.isPremium ?
                `✅ Your premium order has been completed!\n\n` +
                `Order ID: ${order.id}\n` +
                `Duration: ${order.premiumDuration} months\n` +
                `Status: Completed\n\n` +
                `Your premium subscription has been activated.` :
                `✅ Your buy order has been completed!\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Completed\n\n` +
                `Your stars have been sent to your Telegram account.`;

            await this.bot.sendMessage(order.telegramId, userMessage);

            // Send notification
            try {
                await this.notificationManager.sendOrderCompletedNotification(order.telegramId, order.id, order.stars);
            } catch (notificationError) {
                console.error('Failed to send order completion notification:', notificationError);
            }

            // Update admin message
            const updatedMessage = `✅ Buy order ${orderId} completed by admin`;
            await this.bot.editMessageText(updatedMessage, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Buy order completed successfully' });
        } catch (error) {
            console.error('Error completing buy order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error completing order' });
        }
    }

    async handleDeclineBuy(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('decline_buy_', '');
        
        try {
            const order = await BuyOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            if (order.status === "declined") {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order already declined' });
                return;
            }

            order.status = "declined";
            order.dateDeclined = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `❌ Your buy order has been declined.\n\n` +
                `Order ID: ${order.id}\n` +
                `Status: Declined\n\n` +
                `Please contact support if you believe this was a mistake.`
            );

            // Update admin message
            const updatedMessage = `❌ Buy order ${orderId} declined by admin`;
            await this.bot.editMessageText(updatedMessage, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Buy order declined successfully' });
        } catch (error) {
            console.error('Error declining buy order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error declining order' });
        }
    }

    async handleReverseOrder(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('reverse_', '');
        
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            order.status = "reversed";
            order.dateCompleted = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `🔄 Your order has been reversed.\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Reversed\n\n` +
                `Please contact support for more information.`
            );

            await this.bot.answerCallbackQuery(query.id, { text: 'Order reversed' });
        } catch (error) {
            console.error('Error reversing order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error reversing order' });
        }
    }

    async handleRefundOrder(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('refund_', '');
        
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Order not found' });
                return;
            }

            order.status = "refunded";
            order.dateCompleted = new Date();
            await order.save();

            // Notify user
            await this.bot.sendMessage(
                order.telegramId,
                `💸 Your order has been refunded.\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Status: Refunded\n\n` +
                `Your payment will be refunded to your original payment method.`
            );

            await this.bot.answerCallbackQuery(query.id, { text: 'Order refunded' });
        } catch (error) {
            console.error('Error refunding order:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error refunding order' });
        }
    }

    async handleApproveRefund(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('req_approve_', '');
        
        try {
            const request = await Reversal.findOne({ orderId });
            if (!request || request.status !== 'pending') {
                await this.bot.answerCallbackQuery(query.id, { text: 'Request not found or already processed' });
                return;
            }

            const result = await this.processRefund(orderId);
            
            request.status = 'completed';
            request.processedAt = new Date();
            await request.save();

            const statusMessage = result.alreadyRefunded 
                ? `✅ Order ${orderId} was already refunded\nCharge ID: ${result.chargeId}`
                : `✅ Refund processed successfully for ${orderId}\nCharge ID: ${result.chargeId}`;

            await this.bot.sendMessage(query.from.id, statusMessage);
            
            try {
                const userMessage = result.alreadyRefunded
                    ? `💸 Your refund for order ${orderId} was already processed\nTX ID: ${result.chargeId}`
                    : `💸 Refund Processed\nOrder: ${orderId}\nTX ID: ${result.chargeId}`;
                
                await this.bot.sendMessage(parseInt(request.telegramId), userMessage);
            } catch (userError) {
                console.error('Failed to notify user:', userError.message);
                await this.bot.sendMessage(query.from.id, `⚠️ Refund processed but user notification failed`);
            }

            await this.updateAdminMessages(request, "✅ REFUNDED");
            await this.bot.answerCallbackQuery(query.id, { text: 'Refund approved and processed' });

        } catch (refundError) {
            request.status = 'declined';
            request.errorMessage = refundError.message;
            await request.save();
            
            await this.bot.sendMessage(query.from.id, `❌ Refund failed for ${orderId}\nError: ${refundError.message}`);
            await this.bot.answerCallbackQuery(query.id, { text: 'Refund failed' });
        }
    }

    async handleRejectRefund(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('req_reject_', '');
        
        try {
            const request = await Reversal.findOne({ orderId });
            if (!request || request.status !== 'pending') {
                await this.bot.answerCallbackQuery(query.id, { text: 'Request not found or already processed' });
                return;
            }

            request.status = 'declined';
            request.processedAt = new Date();
            await request.save();
            
            await this.bot.sendMessage(query.from.id, `❌ Refund request rejected for ${orderId}`);
            
            try {
                await this.bot.sendMessage(parseInt(request.telegramId), `❌ Your refund request for order ${orderId} has been rejected.`);
            } catch (userError) {
                console.error('Failed to notify user of rejection:', userError.message);
            }

            await this.updateAdminMessages(request, "❌ REJECTED");
            await this.bot.answerCallbackQuery(query.id, { text: 'Refund rejected' });

        } catch (error) {
            console.error('Error rejecting refund:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error rejecting refund' });
        }
    }

    async handleApproveRefundRequest(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('req_approve_', '');
        
        try {
            const request = await Reversal.findOne({ orderId: orderId });
            if (!request) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Refund request not found' });
                return;
            }

            if (request.status !== 'pending') {
                await this.bot.answerCallbackQuery(query.id, { text: 'Request already processed' });
                return;
            }

            // Process the refund
            const result = await this.processRefund(orderId);
            
            if (result.success) {
                request.status = 'approved';
                request.adminId = query.from.id.toString();
                request.adminUsername = query.from.username || query.from.first_name;
                request.processedAt = new Date();
                await request.save();

                const statusMessage = result.alreadyRefunded
                    ? `✅ Refund request approved for ${orderId}\nCharge ID: ${result.chargeId}`
                    : `✅ Refund processed successfully for ${orderId}\nCharge ID: ${result.chargeId}`;

                await this.bot.sendMessage(query.from.id, statusMessage);

                // Notify user
                const userMessage = result.alreadyRefunded
                    ? `💸 Your refund for order ${orderId} was already processed\nTX ID: ${result.chargeId}`
                    : `💸 Refund Processed\nOrder: ${orderId}\nTX ID: ${result.chargeId}`;

                try {
                    await this.bot.sendMessage(parseInt(request.telegramId), userMessage);
                } catch (userError) {
                    await this.bot.sendMessage(query.from.id, `⚠️ Refund processed but user notification failed`);
                }

                await this.updateAdminMessages(request, "✅ APPROVED");
                await this.bot.answerCallbackQuery(query.id, { text: 'Refund approved and processed' });
            }
        } catch (refundError) {
            console.error('Error processing refund:', refundError);
            request.status = 'processing';
            request.errorMessage = refundError.message;
            await request.save();
            
            await this.bot.sendMessage(query.from.id, `❌ Refund failed for ${orderId}\nError: ${refundError.message}`);
            await this.bot.answerCallbackQuery(query.id, { text: 'Refund failed' });
        }
    }

    async handleRejectRefundRequest(query) {
        if (!this.adminIds.includes(query.from.id.toString())) {
            await this.bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
            return;
        }

        const orderId = query.data.replace('req_reject_', '');
        
        try {
            const request = await Reversal.findOne({ orderId: orderId });
            if (!request) {
                await this.bot.answerCallbackQuery(query.id, { text: 'Refund request not found' });
                return;
            }

            if (request.status !== 'pending') {
                await this.bot.answerCallbackQuery(query.id, { text: 'Request already processed' });
                return;
            }

            request.status = 'rejected';
            request.adminId = query.from.id.toString();
            request.adminUsername = query.from.username || query.from.first_name;
            request.processedAt = new Date();
            await request.save();
            
            await this.bot.sendMessage(query.from.id, `❌ Refund request rejected for ${orderId}`);
            
            try {
                await this.bot.sendMessage(parseInt(request.telegramId), `❌ Your refund request for order ${orderId} has been rejected.`);
            } catch (userError) {
                console.error('Failed to notify user of rejection:', userError.message);
            }

            await this.updateAdminMessages(request, "❌ REJECTED");
            await this.bot.answerCallbackQuery(query.id, { text: 'Refund rejected' });

        } catch (error) {
            console.error('Error rejecting refund:', error);
            await this.bot.answerCallbackQuery(query.id, { text: 'Error rejecting refund' });
        }
    }

    async processRefund(orderId) {
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
                `https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`,
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

    async updateAdminMessages(request, statusText) {
        if (!request.adminMessages || request.adminMessages.length === 0) return;
        
        for (const msg of request.adminMessages) {
            try {
                await this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [[{ text: statusText, callback_data: 'processed_done' }]] },
                    { chat_id: parseInt(msg.adminId), message_id: msg.messageId }
                );
            } catch (err) {
                console.error(`Failed to update admin message for ${msg.adminId}:`, err.message);
            }
        }
    }
}

module.exports = CallbackManager;
const TelegramBot = require('node-telegram-bot-api');
const { SellOrder, BuyOrder, User } = require('../models');
const { getUserDisplayName } = require('../utils/helpers');

class CallbackManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
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
            } else if (data.startsWith('reverse_')) {
                await this.handleReverseOrder(query);
            } else if (data.startsWith('refund_')) {
                await this.handleRefundOrder(query);
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
}

module.exports = CallbackManager;
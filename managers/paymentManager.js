const TelegramBot = require('node-telegram-bot-api');
const { SellOrder, BuyOrder } = require('../models');
const { getUserDisplayName } = require('../utils/helpers');

class PaymentManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.setupPaymentHandlers();
    }

    setupPaymentHandlers() {
        // Pre-checkout validation
        this.bot.on('pre_checkout_query', async (query) => {
            await this.handlePreCheckout(query);
        });

        // Successful payment
        this.bot.on("successful_payment", async (msg) => {
            await this.handleSuccessfulPayment(msg);
        });
    }

    async handlePreCheckout(query) {
        const orderId = query.invoice_payload;
        const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
        
        if (!order) {
            await this.bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order not found" });
            return;
        }

        // Check if order has expired
        if (order.sessionExpiry && new Date() > order.sessionExpiry) {
            await this.bot.answerPreCheckoutQuery(query.id, false, { error_message: "Payment session has expired" });
            // Update order status to expired
            order.status = "expired";
            await order.save();
            return;
        }

        // Check if the user making payment matches the order creator
        if (order.userLocked && order.userLocked.toString() !== query.from.id.toString()) {
            await this.bot.answerPreCheckoutQuery(query.id, false, { error_message: "This payment link is not valid for your account" });
            return;
        }

        // Check if order already processed (duplicate payment protection)
        if (order.status !== "pending") {
            await this.bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order already processed" });
            return;
        }

        await this.bot.answerPreCheckoutQuery(query.id, true);
    }

    async handleSuccessfulPayment(msg) {
        const orderId = msg.successful_payment.invoice_payload;
        const order = await SellOrder.findOne({ id: orderId });

        if (!order) {
            return await this.bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Please contact support.");
        }

        // Verify user matches order creator
        if (order.userLocked && order.userLocked.toString() !== msg.from.id.toString()) {
            // This shouldn't happen if pre-checkout validation works, but extra safety
            await this.bot.sendMessage(msg.chat.id, "❌ Payment validation error. Please contact support.");
            return;
        }

        // Check if order already processed (duplicate payment protection)
        if (order.status !== "pending") {
            await this.bot.sendMessage(msg.chat.id, "❌ This order has already been processed. If you were charged multiple times, please contact support.");
            return;
        }

        order.telegram_payment_charge_id = msg.successful_payment.telegram_payment_charge_id;
        order.status = "processing"; 
        order.datePaid = new Date();
        order.sessionToken = null; 
        order.sessionExpiry = null; 
        await order.save();

        await this.bot.sendMessage(
            order.telegramId,
            `✅ Payment successful!\n\n` +
            `Order ID: ${order.id}\n` +
            `Stars: ${order.stars}\n` +
            `Wallet: ${order.walletAddress}\n` +
            `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
            `\nStatus: Processing (21-day hold)\n\n` +
            `Funds will be released to your wallet after the hold period.`
        );
      
        const userDisplayName = await getUserDisplayName(order.telegramId);
        
        const adminMessage = `💰 New Payment Received!\n\n` +
            `Order ID: ${order.id}\n` +
            `User: ${order.username ? `@${order.username}` : userDisplayName} (ID: ${order.telegramId})\n` + 
            `Stars: ${order.stars}\n` +
            `Wallet: ${order.walletAddress}\n` +  
            `Memo: ${order.memoTag || 'None'}`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                    { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                    { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                ]
            ]
        };

        for (const adminId of this.adminIds) {
            try {
                await this.bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
            } catch (error) {
                console.error(`Failed to send admin notification to ${adminId}:`, error);
            }
        }
    }
}

module.exports = PaymentManager;
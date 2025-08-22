const mongoose = require('mongoose');
const axios = require('axios');
const { BuyOrder, SellOrder, User, Warning, ReferralTracker, Feedback } = require('../models');

function setupBotHandlers(bot, deps) {
	const { adminIds, trackStars, trackPremiumActivation, getUserDisplayName } = deps;

	bot.on('pre_checkout_query', async (query) => {
		const orderId = query.invoice_payload;
		const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
		if (!order) {
			await bot.answerPreCheckoutQuery(query.id, false, { error_message: 'Order not found' });
			return;
		}
		if (order.sessionExpiry && new Date() > order.sessionExpiry) {
			await bot.answerPreCheckoutQuery(query.id, false, { error_message: 'Payment session has expired' });
			order.status = 'expired';
			await order.save();
			return;
		}
		if (order.userLocked && order.userLocked.toString() !== query.from.id.toString()) {
			await bot.answerPreCheckoutQuery(query.id, false, { error_message: 'This payment link is not valid for your account' });
			return;
		}
		if (order.status !== 'pending') {
			await bot.answerPreCheckoutQuery(query.id, false, { error_message: 'This order has already been processed' });
			return;
		}
		await bot.answerPreCheckoutQuery(query.id, true);
	});

	bot.on('successful_payment', async (msg) => {
		const orderId = msg.successful_payment.invoice_payload;
		const order = await SellOrder.findOne({ id: orderId });
		if (!order) {
			return await bot.sendMessage(msg.chat.id, '❌ Payment was successful, but the order was not found. Please contact support.');
		}
		if (order.userLocked && order.userLocked.toString() !== msg.from.id.toString()) {
			await bot.sendMessage(msg.chat.id, '❌ Payment validation error. Please contact support.');
			return;
		}
		if (order.status !== 'pending') {
			await bot.sendMessage(msg.chat.id, '❌ This order has already been processed. If you were charged multiple times, please contact support.');
			return;
		}
		order.status = 'processing';
		order.datePaid = new Date();
		await order.save();

		await bot.sendMessage(
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

		const adminKeyboard = { inline_keyboard: [[ { text: '✅ Complete', callback_data: `complete_sell_${order.id}` }, { text: '❌ Fail', callback_data: `decline_sell_${order.id}` }, { text: '💸 Refund', callback_data: `refund_sell_${order.id}` } ]] };

		for (const adminId of adminIds) {
			try {
				const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
				order.adminMessages.push({ adminId, messageId: message.message_id, originalText: adminMessage });
				await order.save();
			} catch {}
		}
	});

	bot.on('callback_query', async (query) => {
		try {
			const data = query.data;
			const adminUsername = query.from.username ? query.from.username : `User_${query.from.id}`;
			let order, actionType, orderType;
			if (data.startsWith('complete_sell_')) {
				actionType = 'complete'; orderType = 'sell'; order = await SellOrder.findOne({ id: data.split('_')[2] });
				if (!order) return await bot.answerCallbackQuery(query.id, { text: 'Sell order not found' });
				if (order.status !== 'processing') return await bot.answerCallbackQuery(query.id, { text: `Order is ${order.status} - cannot complete` });
				if (!order.telegram_payment_charge_id && order.dateCreated > new Date('2025-05-25')) return await bot.answerCallbackQuery(query.id, { text: 'Cannot complete - missing payment reference' });
				order.status = 'completed'; order.dateCompleted = new Date(); await order.save(); await trackStars(order.telegramId, order.stars, 'sell');
			} else if (data.startsWith('decline_sell_')) {
				actionType = 'decline'; orderType = 'sell'; order = await SellOrder.findOne({ id: data.split('_')[2] });
				if (!order) return await bot.answerCallbackQuery(query.id, { text: 'Sell order not found' });
				order.status = 'failed'; order.dateDeclined = new Date(); await order.save();
			} else if (data.startsWith('refund_sell_')) {
				actionType = 'refund'; orderType = 'sell'; order = await SellOrder.findOne({ id: data.split('_')[2] });
				if (!order) return await bot.answerCallbackQuery(query.id, { text: 'Sell order not found' });
				order.status = 'refunded'; order.dateRefunded = new Date(); await order.save();
			} else if (data.startsWith('complete_buy_')) {
				actionType = 'complete'; orderType = 'buy'; order = await BuyOrder.findOne({ id: data.split('_')[2] });
				if (!order) return await bot.answerCallbackQuery(query.id, { text: 'Buy order not found' });
				if (order.status !== 'pending') return await bot.answerCallbackQuery(query.id, { text: `Order is ${order.status} - cannot complete` });
				order.status = 'completed'; order.dateCompleted = new Date(); await order.save(); await trackStars(order.telegramId, order.stars, 'buy'); if (order.isPremium) { await trackPremiumActivation(order.telegramId); }
			} else if (data.startsWith('decline_buy_')) {
				actionType = 'decline'; orderType = 'buy'; order = await BuyOrder.findOne({ id: data.split('_')[2] });
				if (!order) return await bot.answerCallbackQuery(query.id, { text: 'Buy order not found' });
				order.status = 'declined'; order.dateDeclined = new Date(); await order.save();
			} else { return await bot.answerCallbackQuery(query.id); }

			const statusText = order.status === 'completed' ? '✅ Completed' : order.status === 'failed' ? '❌ Failed' : order.status === 'refunded' ? '💸 Refunded' : '❌ Declined';
			const processedBy = `Processed by: @${adminUsername}`;
			const completionNote = orderType === 'sell' && order.status === 'completed' ? '\n\nPayments have been transferred to the seller.' : '';
			const updatePromises = order.adminMessages.map(async (adminMsg) => {
				try {
					const updatedText = `${adminMsg.originalText}\n\n${statusText}\n${processedBy}${completionNote}`;
					if (updatedText.length > 4000) return;
					await bot.editMessageText(updatedText, { chat_id: adminMsg.adminId, message_id: adminMsg.messageId, reply_markup: { inline_keyboard: [[ { text: statusText, callback_data: `processed_${order.id}_${Date.now()}` } ]] } });
				} catch {}
			});
			await Promise.allSettled(updatePromises);
			const userMessage = order.status === 'completed' ? `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for your choosing StarStore!'}` : order.status === 'failed' ? `❌ Your sell order #${order.id} has failed.\n\nPlease try selling a lower amount or contact support if the issue persist.` : order.status === 'refunded' ? `💸 Your sell order #${order.id} has been refunded.\n\nPlease check your Account for the refund.` : `❌ Your buy order #${order.id} has been declined.\n\nPlease contact support if you believe this was a mistake.`;
			await bot.sendMessage(order.telegramId, userMessage);
			await bot.answerCallbackQuery(query.id, { text: `${orderType} order ${order.status}` });
		} catch (err) {
			const errorMsg = err.response?.description || err.message || 'Processing failed';
			await bot.answerCallbackQuery(query.id, { text: `Error: ${errorMsg.slice(0, 50)}` });
		}
	});

	bot.on('sticker', async (msg) => {
		try {
			const sticker = msg.sticker;
			if (!sticker) return;
			// Stickers processing handled via routes; here we can cache recent sticker if needed
		} catch {}
	});

	// Expired warnings cleanup
	setInterval(async () => {
		const expiredWarnings = await Warning.find({ isActive: true, autoRemove: true, expiresAt: { $lte: new Date() } });
		for (const warning of expiredWarnings) {
			await Warning.updateOne({ _id: warning._id }, { isActive: false });
		}
	}, 60 * 1000);
}

module.exports = { setupBotHandlers };
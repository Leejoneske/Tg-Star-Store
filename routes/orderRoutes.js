const express = require('express');
const axios = require('axios');
const { BuyOrder, SellOrder, BannedUser } = require('../models');

function createOrderRoutes(bot) {
	const router = express.Router();

	function generateOrderId() {
		return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
	}

	function sanitizeUsername(username) {
		if (!username) return null;
		return username.replace(/[^\w\d_]/g, '');
	}

	function generateSessionToken(telegramId) {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2, 15);
		return `${telegramId}_${timestamp}_${random}`;
	}

	async function createTelegramInvoice(chatId, orderId, stars, description, sessionToken) {
		try {
			const response = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, {
				chat_id: chatId,
				provider_token: process.env.PROVIDER_TOKEN,
				title: `Purchase of ${stars} Telegram Stars`,
				description: description,
				payload: orderId,
				currency: 'XTR',
				prices: [
					{
						label: `${stars} Telegram Stars`,
						amount: stars * 1
					}
				],
				start_parameter: sessionToken?.substring(0, 64)
			});
			return response.data.result;
		} catch (error) {
			throw error;
		}
	}

	const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').filter(Boolean).map(id => id.trim());

	// Wallet Address Endpoint
	router.get('/get-wallet-address', (req, res) => {
		try {
			const walletAddress = process.env.WALLET_ADDRESS;
			if (!walletAddress) {
				return res.status(500).json({ success: false, error: 'Wallet address not configured' });
			}
			res.json({ success: true, walletAddress: walletAddress });
		} catch (error) {
			res.status(500).json({ success: false, error: 'Internal server error' });
		}
	});

	// Create buy order
	router.post('/orders/create', async (req, res) => {
		try {
			const { telegramId, username, stars, walletAddress, isPremium, premiumDuration } = req.body;
			if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
				return res.status(400).json({ error: 'Missing required fields' });
			}

			const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
			if (bannedUser) {
				return res.status(403).json({ error: 'You are banned from placing orders' });
			}

			const priceMap = {
				regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
				premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
			};

			let amount, packageType;
			if (isPremium) {
				packageType = 'premium';
				amount = priceMap.premium[premiumDuration];
			} else {
				packageType = 'regular';
				amount = priceMap.regular[stars];
			}

			if (!amount) {
				return res.status(400).json({ error: 'Invalid selection' });
			}

			const order = new BuyOrder({
				id: generateOrderId(),
				telegramId,
				username,
				amount,
				stars: isPremium ? null : stars,
				premiumDuration: isPremium ? premiumDuration : null,
				walletAddress,
				isPremium,
				status: 'pending',
				dateCreated: new Date(),
				adminMessages: []
			});

			await order.save();

			const userMessage = isPremium ?
				`🎉 Premium order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months\nStatus: Pending` :
				`🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStars: ${stars}\nStatus: Pending`;

			await bot.sendMessage(telegramId, userMessage);

			const adminMessage = isPremium ?
				`🛒 New Premium Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months` :
				`🛒 New Buy Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${amount} USDT\nStars: ${stars}`;

			const adminKeyboard = {
				inline_keyboard: [[
					{ text: '✅ Complete', callback_data: `complete_buy_${order.id}` },
					{ text: '❌ Decline', callback_data: `decline_buy_${order.id}` }
				]]
			};

			for (const adminId of adminIds) {
				try {
					const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
					order.adminMessages.push({ adminId, messageId: message.message_id, originalText: adminMessage });
				} catch (err) {}
			}

			await order.save();
			res.json({ success: true, order });
		} catch (err) {
			res.status(500).json({ error: 'Failed to create order' });
		}
	});

	// Create sell order
	router.post('/sell-orders', async (req, res) => {
		try {
			const { telegramId, username = '', stars, walletAddress, memoTag = '' } = req.body;
			if (!telegramId || !stars || !walletAddress) {
				return res.status(400).json({ error: 'Missing required fields' });
			}

			const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
			if (bannedUser) {
				return res.status(403).json({ error: 'You are banned from placing orders' });
			}

			const existingOrder = await SellOrder.findOne({ telegramId: telegramId, status: 'pending', sessionExpiry: { $gt: new Date() } });
			if (existingOrder) {
				return res.status(409).json({ error: 'You already have a pending order. Please complete or wait for it to expire before creating a new one.', existingOrderId: existingOrder.id });
			}

			const sessionToken = generateSessionToken(telegramId);
			const sessionExpiry = new Date(Date.now() + 15 * 60 * 1000);

			const order = new SellOrder({
				id: generateOrderId(),
				telegramId,
				username: sanitizeUsername(username),
				stars,
				walletAddress,
				memoTag,
				status: 'pending',
				telegram_payment_charge_id: 'temp_' + Date.now(),
				reversible: true,
				dateCreated: new Date(),
				adminMessages: [],
				sessionToken: sessionToken,
				sessionExpiry: sessionExpiry,
				userLocked: telegramId
			});

			const paymentLink = await createTelegramInvoice(telegramId, order.id, stars, `Purchase of ${stars} Telegram Stars`, sessionToken);
			if (!paymentLink) {
				return res.status(500).json({ error: 'Failed to generate payment link' });
			}

			await order.save();

			const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\n⏰ Payment link expires in 15 minutes\n\nPay here: ${paymentLink}`;
			await bot.sendMessage(telegramId, userMessage);

			res.json({ success: true, order, paymentLink, expiresAt: sessionExpiry });
		} catch (err) {
			res.status(500).json({ error: 'Failed to create sell order' });
		}
	});

	// Get latest sell orders for a user
	router.get('/sell-orders', async (req, res) => {
		try {
			const { telegramId } = req.query;
			if (!telegramId) {
				return res.status(400).json({ error: 'Missing telegramId' });
			}
			const transactions = await SellOrder.find({ telegramId }).sort({ dateCreated: -1 }).limit(3);
			res.json(transactions);
		} catch (err) {
			res.status(500).json({ error: 'Failed to fetch transactions' });
		}
	});

	return router;
}

module.exports = createOrderRoutes;
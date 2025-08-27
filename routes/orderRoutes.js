const express = require('express');
const axios = require('axios');
const { BuyOrder, SellOrder, BannedUser } = require('../models');
const { validateTelegramId } = require('../utils/validation');
const { requireTelegramAuth } = require('../middleware/telegramAuth');

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
			if (!process.env.PROVIDER_TOKEN) {
				console.warn('Skipping Telegram invoice creation: PROVIDER_TOKEN is not set');
				return null;
			}
			const response = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
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
			}, {
				timeout: 10000,
				headers: {
					'Content-Type': 'application/json'
				}
			});
			return response.data.result;
		} catch (error) {
			console.error('Telegram invoice creation error:', error);
			throw new Error('Failed to create Telegram invoice');
		}
	}

	const adminIds = (process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(id => id.trim());

	async function resolveUsernames(usernames) {
		if (!Array.isArray(usernames) || usernames.length === 0) {
			return [];
		}

		const sanitized = usernames
			.map(u => (typeof u === 'string' ? u.trim() : ''))
			.filter(Boolean)
			.map(u => (u.startsWith('@') ? u.slice(1) : u))
			.map(sanitizeUsername)
			.filter(Boolean);

		const results = [];
		for (const name of sanitized) {
			let userId = null;
			try {
				const tgResp = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChat`, {
					chat_id: `@${name}`
				}, { 
					timeout: 8000,
					headers: {
						'Content-Type': 'application/json'
					}
				});
				if (tgResp.data?.ok && tgResp.data.result?.id) {
					userId = tgResp.data.result.id.toString();
				}
			} catch (e) {
				console.error(`Failed to resolve username ${name}:`, e.message);
			}

			if (!userId) {
				const dbUser = await require('../models').User.findOne({ username: name });
				if (dbUser?.id) userId = dbUser.id.toString();
			}

			if (!userId) {
				results.push({ username: name, valid: false });
			} else {
				results.push({ username: name, userId, valid: true });
			}
		}
		return results;
	}

	function calculateAmount({ isPremium, premiumDuration, stars }) {
		const priceMap = {
			regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
			premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
		};

		if (isPremium) {
			return priceMap.premium[premiumDuration] || null;
		}

		if (typeof stars !== 'number') return null;
		if (priceMap.regular[stars]) return priceMap.regular[stars];
		if (stars >= 50) return Number((0.02 * stars).toFixed(2));
		return null;
	}

	// Wallet Address Endpoint
	router.get('/get-wallet-address', (req, res) => {
		try {
			const walletAddress = process.env.WALLET_ADDRESS;
			if (!walletAddress) {
				return res.status(500).json({ success: false, error: 'Wallet address not configured' });
			}
			res.json({ success: true, walletAddress: walletAddress });
		} catch (error) {
			console.error('Wallet address error:', error);
			res.status(500).json({ success: false, error: 'Internal server error' });
		}
	});

	// Quote endpoint for client to fetch accurate pricing before payment
	router.post('/quote', requireTelegramAuth, async (req, res) => {
		try {
			const { stars, isPremium, premiumDuration, recipientsCount } = req.body;
			
			// Validate input
			if (isPremium && (!premiumDuration || ![3, 6, 12].includes(premiumDuration))) {
				return res.status(400).json({ success: false, error: 'Invalid premium duration. Must be 3, 6, or 12 months.' });
			}
			
			if (!isPremium && (!stars || stars < 50)) {
				return res.status(400).json({ success: false, error: 'Invalid stars amount. Minimum is 50 stars.' });
			}
			
			const unitAmount = calculateAmount({ isPremium: !!isPremium, premiumDuration, stars: isPremium ? null : Number(stars) });
			if (!unitAmount) {
				return res.status(400).json({ success: false, error: 'Invalid selection. Minimum stars is 50 for custom.' });
			}
			
			const qty = Math.max(1, Math.min(5, Number(recipientsCount) || 0));
			const totalAmount = Number((unitAmount * qty).toFixed(2));
			
			return res.json({ 
				success: true, 
				unitAmount, 
				quantity: qty, 
				totalAmount,
				currency: 'USDT'
			});
		} catch (error) {
			console.error('Quote calculation error:', error);
			return res.status(500).json({ success: false, error: 'Failed to compute quote' });
		}
	});

	// Validate Telegram usernames and return IDs (supports up to 5)
	router.post('/validate-usernames', requireTelegramAuth, async (req, res) => {
		try {
			const { usernames } = req.body;
			if (!Array.isArray(usernames) || usernames.length === 0) {
				return res.status(400).json({ success: false, error: 'No usernames provided' });
			}
			if (usernames.length > 5) {
				return res.status(400).json({ success: false, error: 'Maximum 5 usernames allowed' });
			}

			const results = await resolveUsernames(usernames);
			if (results.length === 0) {
				return res.status(400).json({ success: false, error: 'Invalid usernames' });
			}

			const validRecipients = results.filter(r => r.valid);
			if (validRecipients.length !== results.length) {
				return res.status(400).json({ success: false, error: 'Some usernames are invalid', results });
			}
			return res.json({ success: true, recipients: validRecipients });
		} catch (error) {
			console.error('Username validation error:', error);
			return res.status(500).json({ success: false, error: 'Validation failed' });
		}
	});

	// Create buy order (supports gifting up to 5 recipients)
	router.post('/orders/create', requireTelegramAuth, async (req, res) => {
		try {
			const { telegramId, username, stars, walletAddress, isPremium, premiumDuration, recipients } = req.body;
			if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
				return res.status(400).json({ success: false, error: 'Missing required fields' });
			}

			const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
			if (bannedUser) {
				return res.status(403).json({ success: false, error: 'You are banned from placing orders' });
			}

			const unitAmount = calculateAmount({ isPremium: !!isPremium, premiumDuration, stars: isPremium ? null : Number(stars) });
			if (!unitAmount) {
				return res.status(400).json({ success: false, error: 'Invalid selection. Minimum stars is 50 for custom.' });
			}

			let validatedRecipients = [];
			let quantity = 1;
			if (Array.isArray(recipients) && recipients.length > 0) {
				if (recipients.length > 5) {
					return res.status(400).json({ success: false, error: 'Maximum 5 recipients allowed' });
				}

				const results = await resolveUsernames(recipients);
				const onlyValid = results.filter(r => r.valid);
				if (onlyValid.length !== results.length) {
					return res.status(400).json({ success: false, error: 'Some usernames are invalid', results });
				}
				validatedRecipients = onlyValid;
				quantity = validatedRecipients.length;
			}

			const totalAmount = Number((unitAmount * quantity).toFixed(2));

			const order = new BuyOrder({
				id: generateOrderId(),
				telegramId,
				username,
				amount: totalAmount,
				stars: isPremium ? null : stars,
				premiumDuration: isPremium ? premiumDuration : null,
				walletAddress,
				isPremium,
				status: 'pending',
				dateCreated: new Date(),
				adminMessages: [],
				recipients: validatedRecipients,
				quantity
			});

			await order.save();

			const userMessage = isPremium ?
				`🎉 Premium order received!\n\nOrder ID: ${order.id}\nAmount: ${totalAmount} USDT\nDuration: ${premiumDuration} months\nRecipients: ${quantity}\nStatus: Pending` :
				`🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${totalAmount} USDT\nStars: ${stars}\nRecipients: ${quantity}\nStatus: Pending`;

			await bot.sendMessage(telegramId, userMessage);

			const adminMessage = isPremium ?
				(() => {
					const list = (validatedRecipients && validatedRecipients.length)
						? `\nRecipient Users: ${validatedRecipients.map(r => `@${r.username}`).join(', ')}`
						: '';
					return `🛒 New Premium Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${totalAmount} USDT\nDuration: ${premiumDuration} months\nRecipients: ${quantity}${list}`;
				})()
				:
				(() => {
					const list = (validatedRecipients && validatedRecipients.length)
						? `\nRecipient Users: ${validatedRecipients.map(r => `@${r.username}`).join(', ')}`
						: '';
					return `🛒 New Buy Order!\n\nOrder ID: ${order.id}\nUser: @${username}\nAmount: ${totalAmount} USDT\nStars: ${stars}\nRecipients: ${quantity}${list}`;
				})();

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
				} catch (err) {
					console.error(`Failed to send admin message to ${adminId}:`, err);
				}
			}

			await order.save();
			res.json({ success: true, order });
		} catch (err) {
			console.error('Failed to create buy order:', err);
			res.status(500).json({ success: false, error: 'Failed to create order' });
		}
	});

	// Create sell order
	router.post('/sell-orders', requireTelegramAuth, async (req, res) => {
		try {
			const { telegramId, username = '', stars, walletAddress, memoTag = '' } = req.body;
			if (!telegramId || !stars || !walletAddress) {
				return res.status(400).json({ success: false, error: 'Missing required fields' });
			}

			const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
			if (bannedUser) {
				return res.status(403).json({ success: false, error: 'You are banned from placing orders' });
			}

			const existingOrder = await SellOrder.findOne({ telegramId: telegramId, status: 'pending', sessionExpiry: { $gt: new Date() } });
			if (existingOrder) {
				return res.status(409).json({ success: false, error: 'You already have a pending order. Please complete or wait for it to expire before creating a new one.', existingOrderId: existingOrder.id });
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
				// Provider token not configured; gracefully inform client instead of crashing
				return res.status(503).json({ success: false, error: 'Payments are temporarily unavailable. Please try again later.' });
			}

			await order.save();

			const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\n⏰ Payment link expires in 15 minutes\n\nPay here: ${paymentLink}`;
			await bot.sendMessage(telegramId, userMessage);

			res.json({ success: true, order, paymentLink, expiresAt: sessionExpiry });
		} catch (err) {
			console.error('Failed to create sell order:', err);
			res.status(500).json({ success: false, error: 'Failed to create sell order' });
		}
	});

	// Get latest sell orders for a user
	router.get('/sell-orders', requireTelegramAuth, async (req, res) => {
		try {
			const { telegramId } = req.query;
			if (!telegramId) {
				return res.status(400).json({ success: false, error: 'Missing telegramId' });
			}
			const transactions = await SellOrder.find({ telegramId }).sort({ dateCreated: -1 }).limit(3);
			res.json(transactions);
		} catch (err) {
			console.error('Failed to fetch sell orders:', err);
			res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
		}
	});

	// Get comprehensive order history for a user (both buy and sell orders)
	router.get('/order-history/:userId', requireTelegramAuth, async (req, res) => {
		try {
			const { userId } = req.params;
			const { extractApiKey } = require('../utils/auth');
			const apiKey = extractApiKey(req);
			const requesterId = req.verifiedTelegramUser?.id || req.headers['x-telegram-id'] || req.query.telegramId;
			// Require either matching owner or valid API key (admin)
			if (requesterId?.toString() !== userId.toString() && apiKey !== process.env.API_KEY) {
				return res.status(403).json({ success: false, error: 'Forbidden' });
			}
			// Get both buy and sell orders for the user
			const buyOrders = await BuyOrder.find({ telegramId: userId })
				.sort({ dateCreated: -1 })
				.lean();
			
			const sellOrders = await SellOrder.find({ telegramId: userId })
				.sort({ dateCreated: -1 })
				.lean();

			// Combine and format the data (redacted)
			const transactions = [
				...buyOrders.map(order => ({
					id: order.id,
					type: 'Buy Stars',
					amount: order.stars,
					status: order.status?.toLowerCase(),
					date: order.dateCreated,
					details: order.isPremium ? 
						`Premium order for ${order.premiumDuration} months` : 
						`Buy order for ${order.stars} stars`,
					usdtValue: order.amount,
					isPremium: order.isPremium,
					premiumDuration: order.premiumDuration
				})),
				...sellOrders.map(order => ({
					id: order.id,
					type: 'Sell Stars',
					amount: order.stars,
					status: order.status?.toLowerCase(),
					date: order.dateCreated,
					details: `Sell order for ${order.stars} stars`,
					usdtValue: null 
				}))
			];

			res.json({ success: true, transactions });
		} catch (error) {
			console.error('Error fetching order history:', error);
			res.status(500).json({ success: false, error: 'Internal server error' });
		}
	});

	// Get order details by order ID
	router.get('/order-details/:orderId', requireTelegramAuth, async (req, res) => {
		try {
			const { orderId } = req.params;
			const { extractApiKey } = require('../utils/auth');
			const apiKey = extractApiKey(req);
			const requesterId = req.verifiedTelegramUser?.id || req.headers['x-telegram-id'] || req.query.telegramId;
			
			// Try to find the order in both buy and sell orders
			let order = await BuyOrder.findOne({ id: orderId }).lean();
			let orderType = 'buy';
			
			if (!order) {
				order = await SellOrder.findOne({ id: orderId }).lean();
				orderType = 'sell';
			}
			
			if (!order) {
				return res.status(404).json({ success: false, error: 'Order not found' });
			}

			// Authorization: owner or admin API key
			if (requesterId?.toString() !== order.telegramId?.toString() && apiKey !== process.env.API_KEY) {
				return res.status(403).json({ success: false, error: 'Forbidden' });
			}

			// Redact sensitive fields
			const redacted = {
				id: order.id,
				type: orderType,
				telegramId: order.telegramId,
				username: order.username,
				status: order.status,
				dateCreated: order.dateCreated,
				dateCompleted: order.dateCompleted,
				dateDeclined: order.dateDeclined
			};

			if (orderType === 'buy') {
				redacted.amount = order.amount;
				redacted.stars = order.stars;
				redacted.isPremium = order.isPremium;
				redacted.premiumDuration = order.premiumDuration;
				// walletAddress, recipients, adminMessages intentionally omitted
			} else {
				redacted.stars = order.stars;
				// walletAddress, memoTag, telegram_payment_charge_id, adminMessages omitted
			}

			res.json({ success: true, order: redacted });
		} catch (error) {
			console.error('Error fetching order details:', error);
			res.status(500).json({ success: false, error: 'Internal server error' });
		}
	});

	return router;
}

module.exports = createOrderRoutes;
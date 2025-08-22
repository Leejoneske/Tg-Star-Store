const { SellOrder, Warning } = require('../models');

function setupMaintenanceJobs(bot, reversalRequests) {
	async function cleanupExpiredOrders() {
		try {
			const expiredOrders = await SellOrder.find({ status: 'pending', sessionExpiry: { $lt: new Date() } }).limit(20);
			for (const order of expiredOrders) {
				try { await bot.sendMessage(order.telegramId, `⏰ Your sell order #${order.id} has expired.\n\nIf you still wish to sell, please create a new order.`); } catch {}
				order.status = 'expired';
				await order.save();
			}
		} catch (error) {}
	}

	setInterval(cleanupExpiredOrders, 5 * 60 * 1000);

	setInterval(() => {
		const now = Date.now();
		const expiredSessions = [];
		reversalRequests.forEach((value, chatId) => {
			if (now - value.timestamp > 300000) expiredSessions.push(chatId);
		});
		expiredSessions.forEach(chatId => { bot.sendMessage(chatId, '⌛ Session expired').catch(() => {}); reversalRequests.delete(chatId); });
	}, 60000);
}

module.exports = { setupMaintenanceJobs };
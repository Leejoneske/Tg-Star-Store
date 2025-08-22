async function getUserDisplayName(bot, telegramId) {
	try {
		const chat = await bot.getChat(telegramId);
		let displayName = '';
		if (chat.first_name) {
			displayName = chat.first_name;
			if (chat.last_name) displayName += ` ${chat.last_name}`;
		} else {
			displayName = `User ${telegramId}`;
		}
		return displayName;
	} catch (error) {
		return `User ${telegramId}`;
	}
}

const { ReferralTracker } = require('../models');

async function trackStars(userId, stars, type) {
	try {
		const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
		if (!tracker) return;
		if (type === 'buy') {
			tracker.totalBoughtStars = (tracker.totalBoughtStars || 0) + (stars || 0);
		} else if (type === 'sell') {
			tracker.totalSoldStars = (tracker.totalSoldStars || 0) + (stars || 0);
		}
		if (!tracker.dateActivated && tracker.status === 'active') tracker.dateActivated = new Date();
		await tracker.save();
	} catch {}
}

async function trackPremiumActivation(userId) {
	try {
		const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
		if (!tracker) return;
		tracker.premiumActivated = true;
		if (!tracker.dateActivated) tracker.dateActivated = new Date();
		await tracker.save();
	} catch {}
}

module.exports = { getUserDisplayName, trackStars, trackPremiumActivation };
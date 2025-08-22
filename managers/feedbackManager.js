const express = require('express');
const { Feedback, SellOrder } = require('../models');

function createFeedbackRouter(bot, adminIds) {
	const router = express.Router();
	const feedbackSessions = {};
	const completedFeedbacks = new Set();

	router.post('/survey', async (req, res) => {
		try {
			const surveyData = req.body;
			let message = `📊 *New Survey Submission*\n\n`;
			message += `*Usage Frequency*: ${surveyData.usageFrequency}\n`;
			if (surveyData.favoriteFeatures) {
				const features = Array.isArray(surveyData.favoriteFeatures) ? surveyData.favoriteFeatures.join(', ') : surveyData.favoriteFeatures;
				message += `*Favorite Features*: ${features}\n`;
			}
			message += `*Desired Features*: ${surveyData.desiredFeatures}\n`;
			message += `*Overall Rating*: ${surveyData.overallRating}/5\n`;
			if (surveyData.improvementFeedback) message += `*Improvement Feedback*: ${surveyData.improvementFeedback}\n`;
			message += `*Technical Issues*: ${surveyData.technicalIssues || 'No'}\n`;
			if (surveyData.technicalIssues === 'yes' && surveyData.technicalIssuesDetails) message += `*Issue Details*: ${surveyData.technicalIssuesDetails}\n`;
			message += `\n📅 Submitted: ${new Date().toLocaleString()}`;
			await Promise.all(adminIds.map(chatId => bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })));
			res.status(200).json({ success: true });
		} catch (error) {
			res.status(500).json({ success: false, error: 'Failed to process survey' });
		}
	});

	bot.onText(/\/sell_complete (.+)/, async (msg, match) => {
		const chatId = msg.chat.id;
		if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
		const orderId = match[1].trim();
		const order = await SellOrder.findOne({ id: orderId });
		if (!order) return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
		try {
			const confirmationMessage = `🎉 Order #${orderId} Completed!\n\nWe've successfully processed your sell order for ${order.stars} stars.\n\nPayment was sent to:\n\`${order.walletAddress}\`\n\nWe'd love to hear about your experience!`;
			const feedbackKeyboard = { inline_keyboard: [ [ { text: '⭐ Leave Feedback', callback_data: `start_feedback_${orderId}` } ], [ { text: 'Skip Feedback', callback_data: `skip_feedback_${orderId}` } ] ] };
			await bot.sendMessage(order.telegramId, confirmationMessage, { parse_mode: 'Markdown', reply_markup: feedbackKeyboard });
			await bot.sendMessage(chatId, `✅ Sent completion notification for order ${orderId} to user @${order.username}`);
		} catch (error) {
			if (error.response?.error_code === 403) await bot.sendMessage(chatId, `❌ Failed to notify user @${order.username} (user blocked the bot)`);
			else await bot.sendMessage(chatId, `❌ Failed to send notification for order ${orderId}`);
		}
	});

	bot.on('callback_query', async (query) => {
		const data = query.data;
		const chatId = query.message.chat.id;
		const messageId = query.message.message_id;
		if (data.startsWith('start_feedback_')) {
			const orderId = data.split('_')[2];
			const order = await SellOrder.findOne({ id: orderId });
			if (!order) return;
			if (completedFeedbacks.has(chatId.toString() + '_' + orderId)) {
				await bot.sendMessage(chatId, 'You have already submitted feedback for this order. Thank you!');
				return await bot.answerCallbackQuery(query.id);
			}
			feedbackSessions[chatId] = { orderId, telegramId: order.telegramId, username: order.username, currentQuestion: 1, responses: {}, active: true };
			await askFeedbackQuestion(chatId, 1);
			return await bot.answerCallbackQuery(query.id);
		} else if (data.startsWith('skip_feedback_')) {
			await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✓ Feedback Skipped', callback_data: 'feedback_skipped' }]] }, { chat_id: chatId, message_id: messageId });
			await bot.sendMessage(chatId, 'Thank you for your order! We appreciate your business.');
			return await bot.answerCallbackQuery(query.id);
		} else if (data.startsWith('feedback_rating_')) {
			const rating = parseInt(data.split('_')[2]);
			const session = feedbackSessions[chatId];
			if (session && session.active) {
				session.responses.satisfaction = rating;
				session.currentQuestion = 2;
				await askFeedbackQuestion(chatId, 2);
				return await bot.answerCallbackQuery(query.id);
			}
		}
	});

	async function askFeedbackQuestion(chatId, questionNumber) {
		const session = feedbackSessions[chatId];
		if (!session) return;
		let questionText = '';
		let replyMarkup = {};
		switch (questionNumber) {
			case 1:
				questionText = 'How satisfied are you with our service? (1-5 stars)';
				replyMarkup = { inline_keyboard: [ [ { text: '⭐', callback_data: 'feedback_rating_1' }, { text: '⭐⭐', callback_data: 'feedback_rating_2' }, { text: '⭐⭐⭐', callback_data: 'feedback_rating_3' }, { text: '⭐⭐⭐⭐', callback_data: 'feedback_rating_4' }, { text: '⭐⭐⭐⭐⭐', callback_data: 'feedback_rating_5' } ], [ { text: 'Skip', callback_data: 'feedback_skip_1' } ] ] };
				break;
			case 2:
				questionText = 'Could you tell us why you gave this rating?';
				replyMarkup = { inline_keyboard: [ [ { text: 'Skip', callback_data: 'feedback_skip_2' } ] ] };
				break;
			case 3:
				questionText = 'What could we improve or add to make your experience better?';
				replyMarkup = { inline_keyboard: [ [ { text: 'Skip', callback_data: 'feedback_skip_3' } ] ] };
				break;
			case 4:
				questionText = 'Any additional comments? (Optional - you can skip this)';
				replyMarkup = { inline_keyboard: [ [ { text: 'Skip and Submit', callback_data: 'feedback_complete' } ] ] };
				break;
		}
		if (questionText) {
			const message = await bot.sendMessage(chatId, questionText, { reply_markup: replyMarkup });
			session.lastQuestionMessageId = message.message_id;
		}
	}

	bot.on('message', async (msg) => {
		if (!msg.text || msg.text.startsWith('/')) return;
		const chatId = msg.chat.id.toString();
		const session = feedbackSessions[chatId];
		if (!session || !session.active) return;
		try {
			switch (session.currentQuestion) {
				case 2:
					session.responses.reasons = msg.text; session.currentQuestion = 3; await askFeedbackQuestion(chatId, 3); break;
				case 3:
					session.responses.suggestions = msg.text; session.currentQuestion = 4; await askFeedbackQuestion(chatId, 4); break;
				case 4:
					session.responses.additionalInfo = msg.text; await completeFeedback(chatId); break;
			}
		} catch {}
	});

	async function completeFeedback(chatId) {
		const session = feedbackSessions[chatId];
		if (!session) return;
		try {
			const feedback = new Feedback({ orderId: session.orderId, telegramId: session.telegramId, username: session.username, satisfaction: session.responses.satisfaction, reasons: session.responses.reasons, suggestions: session.responses.suggestions, additionalInfo: session.responses.additionalInfo });
			await feedback.save();
			completedFeedbacks.add(chatId.toString() + '_' + session.orderId);
			const adminMessage = `📝 New Feedback Received\n\nOrder: ${session.orderId}\nUser: @${session.username}\nRating: ${session.responses.satisfaction}/5\nReasons: ${session.responses.reasons || 'Not provided'}\nSuggestions: ${session.responses.suggestions || 'Not provided'}\nAdditional Info: ${session.responses.additionalInfo || 'None'}`;
			for (const adminId of adminIds) { try { await bot.sendMessage(adminId, adminMessage); } catch {} }
			await bot.sendMessage(chatId, 'Thank you for your feedback! We appreciate your time.');
		} catch {
			await bot.sendMessage(chatId, "Sorry, we couldn't save your feedback. Please try again later.");
		} finally {
			delete feedbackSessions[chatId];
		}
	}

	bot.on('callback_query', async (query) => {
		const data = query.data;
		const chatId = query.message.chat.id;
		if (data.startsWith('feedback_skip_')) {
			const questionNumber = parseInt(data.split('_')[2]);
			const session = feedbackSessions[chatId];
			if (session) {
				if (questionNumber < 4) { session.currentQuestion = questionNumber + 1; await askFeedbackQuestion(chatId, session.currentQuestion); }
				else { await completeFeedback(chatId); }
			}
			return await bot.answerCallbackQuery(query.id);
		} else if (data === 'feedback_complete') {
			await completeFeedback(chatId);
			return await bot.answerCallbackQuery(query.id);
		}
	});

	return router;
}

module.exports = { createFeedbackRouter };
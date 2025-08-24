const TelegramBot = require('node-telegram-bot-api');
const { SellOrder, Feedback } = require('../models');

class FeedbackManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.feedbackSessions = {};
        this.completedFeedbacks = new Set();
        this.userFeedbackState = {};
        this.setupFeedbackHandlers();
    }

    setupFeedbackHandlers() {
        // Handle feedback callback queries
        this.bot.on('callback_query', async (query) => {
            await this.handleFeedbackCallbacks(query);
        });

        // Handle feedback text messages
        this.bot.on('message', async (msg) => {
            await this.handleFeedbackMessages(msg);
        });

        // Start cleanup for expired feedback states
        this.startFeedbackCleanup();
    }

    async handleFeedbackCallbacks(query) {
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        
        if (data.startsWith('start_feedback_')) {
            await this.handleStartFeedback(query);
        } else if (data.startsWith('skip_feedback_')) {
            await this.handleSkipFeedback(query);
        } else if (data.startsWith('feedback_rating_')) {
            await this.handleRatingSelection(query);
        } else if (data.startsWith('feedback_skip_')) {
            await this.handleSkipQuestion(query);
        } else if (data === 'feedback_complete') {
            await this.completeFeedback(chatId);
        } else if (data.startsWith('reversal_feedback_')) {
            await this.handleReversalFeedback(query);
        }
        
        await this.bot.answerCallbackQuery(query.id);
    }

    async handleStartFeedback(query) {
        const orderId = query.data.split('_')[2];
        const chatId = query.message.chat.id;
        const order = await SellOrder.findOne({ id: orderId });
        
        if (!order) return;
        
        // Check if user has already completed feedback for this order
        if (this.completedFeedbacks.has(chatId.toString() + '_' + orderId)) {
            await this.bot.sendMessage(chatId, "You have already submitted feedback for this order. Thank you!");
            return;
        }
        
        // Initialize feedback session
        this.feedbackSessions[chatId] = {
            orderId: orderId,
            telegramId: order.telegramId,
            username: order.username,
            currentQuestion: 1, // 1 = satisfaction, 2 = reasons, 3 = suggestions, 4 = additional info
            responses: {},
            active: true
        };

        // Ask first question
        await this.askFeedbackQuestion(chatId, 1);
    }

    async handleSkipFeedback(query) {
        const orderId = query.data.split('_')[2];
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        
        // Update message to show feedback was skipped
        await this.bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: "✓ Feedback Skipped", callback_data: 'feedback_skipped' }]] },
            { chat_id: chatId, message_id: messageId }
        );
        
        await this.bot.sendMessage(chatId, "Thank you for your order! We appreciate your business.");
    }

    async handleRatingSelection(query) {
        const rating = parseInt(query.data.split('_')[2]);
        const chatId = query.message.chat.id;
        const session = this.feedbackSessions[chatId];
        
        if (session && session.active) {
            session.responses.satisfaction = rating;
            session.currentQuestion = 2;
            
            await this.askFeedbackQuestion(chatId, 2);
        }
    }

    async handleSkipQuestion(query) {
        const questionNumber = parseInt(query.data.split('_')[2]);
        const chatId = query.message.chat.id;
        const session = this.feedbackSessions[chatId];
        
        if (session) {
            if (questionNumber < 4) {
                // Move to next question
                session.currentQuestion = questionNumber + 1;
                await this.askFeedbackQuestion(chatId, session.currentQuestion);
            } else {
                // Complete feedback if on last question
                await this.completeFeedback(chatId);
            }
        }
    }

    async handleReversalFeedback(query) {
        const orderId = query.data.split('_')[2];
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        
        // Update buttons to show feedback submitted
        await this.bot.editMessageReplyMarkup(
            {
                inline_keyboard: [
                    [{ text: "✓ Feedback Submitted", callback_data: `feedback_submitted_${orderId}` }]
                ]
            },
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
        
        // Prompt for feedback
        await this.bot.sendMessage(
            chatId,
            `Please tell us why the stars were reversed and how we can improve:`
        );
        
        // Set temporary state to collect feedback
        this.userFeedbackState[chatId] = {
            orderId: orderId,
            timestamp: Date.now()
        };
    }

    async handleFeedbackMessages(msg) {
        if (!msg.text || msg.text.startsWith('/')) return;
        
        const chatId = msg.chat.id.toString();
        const session = this.feedbackSessions[chatId];
        const feedbackState = this.userFeedbackState[chatId];
        
        // Handle reversal feedback
        if (feedbackState && Date.now() - feedbackState.timestamp < 600000) { // 10 minute window
            await this.handleReversalFeedbackMessage(msg, feedbackState);
            return;
        }
        
        // Handle regular feedback
        if (session && session.active) {
            await this.handleRegularFeedbackMessage(msg, session);
        }
    }

    async handleReversalFeedbackMessage(msg, feedbackState) {
        const chatId = msg.chat.id.toString();
        const orderId = feedbackState.orderId;
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        
        // Notify admins
        const adminMessage = `📝 Reversal Feedback\n\n` +
                            `Order: ${orderId}\n` +
                            `User: ${username}\n` +
                            `Feedback: ${msg.text}`;
        
        for (const adminId of this.adminIds) {
            try {
                await this.bot.sendMessage(adminId, adminMessage);
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }
        
        // Confirm receipt
        await this.bot.sendMessage(chatId, `Thank you for your feedback!`);
        
        // Clear state
        delete this.userFeedbackState[chatId];
    }

    async handleRegularFeedbackMessage(msg, session) {
        const chatId = msg.chat.id.toString();
        
        try {
            switch(session.currentQuestion) {
                case 2: // Reasons for rating
                    session.responses.reasons = msg.text;
                    session.currentQuestion = 3;
                    await this.askFeedbackQuestion(chatId, 3);
                    break;
                    
                case 3: // Suggestions
                    session.responses.suggestions = msg.text;
                    session.currentQuestion = 4;
                    await this.askFeedbackQuestion(chatId, 4);
                    break;
                    
                case 4: // Additional info
                    session.responses.additionalInfo = msg.text;
                    await this.completeFeedback(chatId);
                    break;
            }
        } catch (error) {
            console.error('Feedback processing error:', error);
        }
    }

    async askFeedbackQuestion(chatId, questionNumber) {
        const session = this.feedbackSessions[chatId];
        if (!session) return;
        
        let questionText = '';
        let replyMarkup = {};
        
        switch(questionNumber) {
            case 1: // Satisfaction rating
                questionText = "How satisfied are you with our service? (1-5 stars)";
                replyMarkup = {
                    inline_keyboard: [
                        [
                            { text: "⭐", callback_data: `feedback_rating_1` },
                            { text: "⭐⭐", callback_data: `feedback_rating_2` },
                            { text: "⭐⭐⭐", callback_data: `feedback_rating_3` },
                            { text: "⭐⭐⭐⭐", callback_data: `feedback_rating_4` },
                            { text: "⭐⭐⭐⭐⭐", callback_data: `feedback_rating_5` }
                        ],
                        [{ text: "Skip", callback_data: `feedback_skip_1` }]
                    ]
                };
                break;
                
            case 2: // Reasons for rating
                questionText = "Could you tell us why you gave this rating?";
                replyMarkup = {
                    inline_keyboard: [
                        [{ text: "Skip", callback_data: `feedback_skip_2` }]
                    ]
                };
                break;
                
            case 3: // Suggestions
                questionText = "What could we improve or add to make your experience better?";
                replyMarkup = {
                    inline_keyboard: [
                        [{ text: "Skip", callback_data: `feedback_skip_3` }]
                    ]
                };
                break;
                
            case 4: // Additional info
                questionText = "Any additional comments? (Optional - you can skip this)";
                replyMarkup = {
                    inline_keyboard: [
                        [{ text: "Skip and Submit", callback_data: `feedback_complete` }]
                    ]
                };
                break;
        }
        
        // If we're moving to a new question, send it
        if (questionText) {
            const message = await this.bot.sendMessage(chatId, questionText, { reply_markup: replyMarkup });
            session.lastQuestionMessageId = message.message_id;
        }
    }

    async completeFeedback(chatId) {
        const session = this.feedbackSessions[chatId];
        if (!session) return;
        
        try {
            // Save feedback to database
            const feedback = new Feedback({
                orderId: session.orderId,
                telegramId: session.telegramId,
                username: session.username,
                satisfaction: session.responses.satisfaction,
                reasons: session.responses.reasons,
                suggestions: session.responses.suggestions,
                additionalInfo: session.responses.additionalInfo
            });
            
            await feedback.save();
            
            // Add to completed feedbacks set
            this.completedFeedbacks.add(chatId.toString() + '_' + session.orderId);
            
            // Notify admins
            const adminMessage = `📝 New Feedback Received\n\n` +
                                `Order: ${session.orderId}\n` +
                                `User: @${session.username}\n` +
                                `Rating: ${session.responses.satisfaction}/5\n` +
                                `Reasons: ${session.responses.reasons || 'Not provided'}\n` +
                                `Suggestions: ${session.responses.suggestions || 'Not provided'}\n` +
                                `Additional Info: ${session.responses.additionalInfo || 'None'}`;
            
            for (const adminId of this.adminIds) {
                try {
                    await this.bot.sendMessage(adminId, adminMessage);
                } catch (err) {
                    console.error(`Failed to notify admin ${adminId}:`, err);
                }
            }
            
            // Thank user
            await this.bot.sendMessage(chatId, "Thank you for your feedback! We appreciate your time.");
            
        } catch (error) {
            console.error('Error saving feedback:', error);
            await this.bot.sendMessage(chatId, "Sorry, we couldn't save your feedback. Please try again later.");
        } finally {
            // Clean up session
            delete this.feedbackSessions[chatId];
        }
    }

    startFeedbackCleanup() {
        // Cleanup expired feedback states (runs hourly)
        setInterval(() => {
            const now = Date.now();
            for (const [chatId, state] of Object.entries(this.userFeedbackState)) {
                if (now - state.timestamp > 600000) { // 10 minutes
                    delete this.userFeedbackState[chatId];
                }
            }
        }, 60 * 60 * 1000);
    }

    // Method to send completion notification with feedback request
    async sendCompletionNotification(orderId) {
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) return;

            const confirmationMessage = `🎉 Order #${orderId} Completed!\n\n` +
                                     `We've successfully processed your sell order for ${order.stars} stars.\n\n` +
                                     `Payment was sent to:\n` +
                                     `\`${order.walletAddress}\`\n\n` +
                                     `We'd love to hear about your experience!`;
            
            const feedbackKeyboard = {
                inline_keyboard: [
                    [{ text: "⭐ Leave Feedback", callback_data: `start_feedback_${orderId}` }],
                    [{ text: "Skip Feedback", callback_data: `skip_feedback_${orderId}` }]
                ]
            };

            await this.bot.sendMessage(
                order.telegramId,
                confirmationMessage,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: feedbackKeyboard 
                }
            );

            return true;
        } catch (error) {
            console.error('Error sending completion notification:', error);
            return false;
        }
    }

    // Method to send reversal notification with feedback request
    async sendReversalNotification(orderId) {
        try {
            const order = await SellOrder.findOne({ id: orderId });
            if (!order) return;

            const reversalMessage = `⚠️ Order #${orderId} Notification\n\n` +
                                  `Your order was canceled because the stars were reversed during our 21-day holding period.\n\n` +
                                  `Since the transaction cannot be completed after any reversal, you'll need to submit a new order if you still wish to sell your stars.\n\n` +
                                  `We'd appreciate your feedback to help us improve:`;
            
            const feedbackKeyboard = {
                inline_keyboard: [
                    [
                        { text: "Provide Feedback", callback_data: `reversal_feedback_${orderId}` },
                        { text: "Skip", callback_data: `skip_feedback_${orderId}` }
                    ]
                ]
            };

            await this.bot.sendMessage(
                order.telegramId,
                reversalMessage,
                { reply_markup: feedbackKeyboard }
            );

            return true;
        } catch (error) {
            console.error('Error sending reversal notification:', error);
            return false;
        }
    }
}

module.exports = FeedbackManager;
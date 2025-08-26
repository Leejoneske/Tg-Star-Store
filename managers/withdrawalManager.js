const { ReferralWithdrawal, Referral, User } = require('../models');
const { validateTelegramId, validateTransactionId } = require('../utils/validation');
const { formatAdminNotification } = require('../utils/markdown');

class WithdrawalManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.setupWithdrawalHandlers();
    }

    setupWithdrawalHandlers() {
        // Handle withdrawal callback queries
        this.bot.on('callback_query', async (query) => {
            const { data } = query;
            
            if (data.startsWith('complete_withdrawal_')) {
                await this.handleCompleteWithdrawal(query);
            } else if (data.startsWith('decline_withdrawal_')) {
                await this.handleDeclineWithdrawal(query);
            }
        });
    }

    async handleCompleteWithdrawal(query) {
        const session = await require('mongoose').startSession();
        session.startTransaction();

        try {
            const from = query.from;
            if (!this.adminIds.includes(from.id.toString())) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Access denied" });
                return;
            }

            const withdrawalId = query.data.replace('complete_withdrawal_', '');
            if (!withdrawalId) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Invalid withdrawal ID" });
                return;
            }

            await this.bot.answerCallbackQuery(query.id, { text: "⏳ Processing completion..." });

            const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
                { _id: new require('mongoose').Types.ObjectId(withdrawalId), status: 'pending' },
                { 
                    $set: { 
                        status: 'completed',
                        processedBy: from.id,
                        processedAt: new Date()
                    } 
                },
                { new: true, session }
            );

            if (!withdrawal) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found or already processed" });
                await session.abortTransaction();
                return;
            }

            const userMessage = `✅ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Completed!\n\n` +
                              `Amount: ${withdrawal.amount} USDT\n` +
                              `Wallet: ${withdrawal.walletAddress}\n\n` +
                              `Funds have been sent to your wallet.`;

            await this.bot.sendMessage(withdrawal.userId, userMessage);

            const statusText = '✅ Completed';
            const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;
            
            await this.updateAdminMessages(withdrawal, statusText, processedBy);

            await session.commitTransaction();
            await this.bot.answerCallbackQuery(query.id, { text: "✔️ Withdrawal completed" });

        } catch (error) {
            await session.abortTransaction();
            console.error('Withdrawal completion error:', error);
            
            let errorMsg = "❌ Processing failed";
            if (error.message.includes("network error")) {
                errorMsg = "⚠️ Network issue - please retry";
            } else if (error.message.includes("Cast to ObjectId failed")) {
                errorMsg = "❌ Invalid withdrawal ID";
            }
            
            await this.bot.answerCallbackQuery(query.id, { text: errorMsg });
        } finally {
            session.endSession();
        }
    }

    async handleDeclineWithdrawal(query) {
        const session = await require('mongoose').startSession();
        session.startTransaction();

        try {
            const from = query.from;
            if (!this.adminIds.includes(from.id.toString())) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Access denied" });
                return;
            }

            const withdrawalId = query.data.replace('decline_withdrawal_', '');
            if (!withdrawalId) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Invalid withdrawal ID" });
                return;
            }

            await this.bot.answerCallbackQuery(query.id, { text: "⏳ Processing decline..." });

            const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
                { _id: new require('mongoose').Types.ObjectId(withdrawalId), status: 'pending' },
                { 
                    $set: { 
                        status: 'declined',
                        processedBy: from.id,
                        processedAt: new Date()
                    } 
                },
                { new: true, session }
            );

            if (!withdrawal) {
                await this.bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found or already processed" });
                await session.abortTransaction();
                return;
            }

            // Mark referrals as not withdrawn so they can be used again
            await Referral.updateMany(
                { _id: { $in: withdrawal.referralIds } },
                { $set: { withdrawn: false } },
                { session }
            );

            const userMessage = `❌ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Declined\n\n` +
                              `Amount: ${withdrawal.amount} USDT\n` +
                              `Contact support for more information.`;

            await this.bot.sendMessage(withdrawal.userId, userMessage);

            const statusText = '❌ Declined';
            const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;
            
            await this.updateAdminMessages(withdrawal, statusText, processedBy);

            await session.commitTransaction();
            await this.bot.answerCallbackQuery(query.id, { text: "✔️ Withdrawal declined" });

        } catch (error) {
            await session.abortTransaction();
            console.error('Withdrawal decline error:', error);
            
            let errorMsg = "❌ Processing failed";
            if (error.message.includes("network error")) {
                errorMsg = "⚠️ Network issue - please retry";
            } else if (error.message.includes("Cast to ObjectId failed")) {
                errorMsg = "❌ Invalid withdrawal ID";
            }
            
            await this.bot.answerCallbackQuery(query.id, { text: errorMsg });
        } finally {
            session.endSession();
        }
    }

    async updateAdminMessages(withdrawal, statusText, processedBy) {
        if (!withdrawal.adminMessages || withdrawal.adminMessages.length === 0) return;
        
        for (const msg of withdrawal.adminMessages) {
            try {
                const updatedText = `${msg.originalText}\n\n` +
                                  `Status: ${statusText}\n` +
                                  `${processedBy}\n` +
                                  `Processed at: ${new Date().toLocaleString()}`;

                await this.bot.editMessageText(updatedText, {
                    chat_id: msg.adminId,
                    message_id: msg.messageId
                });
            } catch (err) {
                console.error(`Failed to update admin message for ${msg.adminId}:`, err.message);
            }
        }
    }

    async createWithdrawal(userId, amount, walletAddress) {
        const session = await require('mongoose').startSession();
        session.startTransaction();

        try {
            // Validate inputs
            const userValidation = validateTelegramId(userId);
            if (!userValidation.valid) {
                throw new Error('Invalid user ID');
            }

            const amountNum = parseFloat(amount);
            if (isNaN(amountNum) || amountNum < 0.5) {
                throw new Error('Minimum withdrawal is 0.5 USDT');
            }

            if (!walletAddress || walletAddress.trim().length < 10) {
                throw new Error('Invalid wallet address');
            }

            const user = await User.findOne({ 
                $or: [{ id: userId }, { telegramId: userId }] 
            }).session(session);

            if (!user) {
                throw new Error('User not found');
            }

            // Get available referrals
            const availableReferrals = await Referral.find({
                referrerId: userId,
                status: { $in: ['completed', 'active'] },
                withdrawn: { $ne: true }
            }).session(session);

            const availableBalance = availableReferrals.length * 0.5;

            if (amountNum > availableBalance) {
                throw new Error(`Available: ${availableBalance.toFixed(2)} USDT`);
            }

            const referralsNeeded = Math.ceil(amountNum / 0.5);
            const referralsToMark = availableReferrals.slice(0, referralsNeeded);

            const withdrawal = new ReferralWithdrawal({
                userId,
                username: user.username || `User_${userId.substring(0, 6)}`,
                amount: amountNum,
                walletAddress: walletAddress.trim(),
                referralIds: referralsToMark.map(r => r._id),
                status: 'pending',
                adminMessages: [],
                createdAt: new Date()
            });

            await withdrawal.save({ session });

            // Mark referrals as withdrawn
            await Referral.updateMany(
                { _id: { $in: referralsToMark.map(r => r._id) } },
                { $set: { withdrawn: true } },
                { session }
            );

            // Send user notification
            const userMessage = `💰 Withdrawal Request Submitted\n\n` +
                              `Amount: ${amountNum} USDT\n` +
                              `Wallet: ${walletAddress}\n` +
                              `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                              `Status: Pending approval`;

            await this.bot.sendMessage(userId, userMessage);

            // Send admin notifications
            const adminMessage = formatAdminNotification({
                orderId: `WD${withdrawal._id.toString().slice(-8).toUpperCase()}`,
                username: user.username || `User_${userId.substring(0, 6)}`,
                userId: userId,
                stars: amountNum,
                reason: `Referral withdrawal - ${referralsNeeded} referrals`,
                type: 'withdrawal'
            });

            const adminKeyboard = {
                inline_keyboard: [
                    [
                        { text: "✅ Complete", callback_data: `complete_withdrawal_${withdrawal._id}` },
                        { text: "❌ Decline", callback_data: `decline_withdrawal_${withdrawal._id}` }
                    ]
                ]
            };

            // Send to all admins
            for (const adminId of this.adminIds) {
                try {
                    const message = await this.bot.sendMessage(
                        parseInt(adminId),
                        adminMessage,
                        { 
                            reply_markup: adminKeyboard,
                            parse_mode: 'MarkdownV2'
                        }
                    );
                    
                    withdrawal.adminMessages.push({
                        adminId: adminId,
                        messageId: message.message_id,
                        originalText: adminMessage
                    });
                } catch (err) {
                    console.error(`Failed to notify admin ${adminId}:`, err);
                }
            }

            await withdrawal.save({ session });
            await session.commitTransaction();
            
            return withdrawal;

        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }

    async getWithdrawalHistory(userId) {
        try {
            return await ReferralWithdrawal.find({ userId })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean();
        } catch (error) {
            console.error('Error getting withdrawal history:', error);
            return [];
        }
    }

    async getPendingWithdrawals() {
        try {
            return await ReferralWithdrawal.find({ status: 'pending' })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();
        } catch (error) {
            console.error('Error getting pending withdrawals:', error);
            return [];
        }
    }
}

module.exports = WithdrawalManager;
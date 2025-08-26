const TelegramBot = require('node-telegram-bot-api');
const { User, BuyOrder, SellOrder, Referral, Warning, BannedUser } = require('../models');

class MaintenanceManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
        this.setupMaintenanceJobs();
    }

    setupMaintenanceJobs() {
        console.log('🔧 Setting up maintenance jobs...');
        
        // Start all maintenance jobs
        this.startExpiredSellOrderCleanup();
        this.startUserCleanup();
        this.startReferralCleanup();
        this.startWarningCleanup();
        this.startRefundRequestCleanup();
        this.startStickerCleanup();
        // Start withdrawal cleanup (daily)
        setInterval(() => {
            this.startWithdrawalCleanup();
        }, 24 * 60 * 60 * 1000); // Daily
        
        console.log('✅ All maintenance jobs started');
    }

    // Cleanup expired warnings every hour
    startWarningCleanup() {
        setInterval(async () => {
            try {
                const expiredWarnings = await Warning.find({
                    isActive: true,
                    autoRemove: true,
                    expiresAt: { $lte: new Date() }
                });
                
                if (expiredWarnings.length > 0) {
                    console.log(`🧹 Cleaning up ${expiredWarnings.length} expired warnings`);
                    
                    for (const warning of expiredWarnings) {
                        await Warning.updateOne(
                            { _id: warning._id },
                            { isActive: false }
                        );
                        
                        // Remove from banned users list
                        await BannedUser.updateOne({}, { $pull: { users: warning.userId } });
                        
                        // Notify user
                        try {
                            await this.bot.sendMessage(warning.userId, 
                                `✅ Your account restrictions have been lifted. You can now resume normal activities.`
                            );
                        } catch (error) {
                            console.error('Failed to notify user of auto-unban:', error);
                        }
                    }
                }
            } catch (error) {
                console.error('Error in warning cleanup:', error);
            }
        }, 60 * 60 * 1000); // Every hour
    }

    // Cleanup old completed orders (older than 30 days)
    startOrderCleanup() {
        setInterval(async () => {
            try {
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                
                const oldCompletedOrders = await SellOrder.find({
                    status: { $in: ['completed', 'refunded', 'cancelled'] },
                    dateCompleted: { $lt: thirtyDaysAgo }
                });
                
                if (oldCompletedOrders.length > 0) {
                    console.log(`🧹 Archiving ${oldCompletedOrders.length} old completed orders`);
                    
                    // Archive old orders (you might want to move them to a separate collection)
                    // For now, we'll just log them
                    for (const order of oldCompletedOrders) {
                        console.log(`Archiving order: ${order.id} - ${order.status} - ${order.dateCompleted}`);
                    }
                }
            } catch (error) {
                console.error('Error in order cleanup:', error);
            }
        }, 24 * 60 * 60 * 1000); // Daily
    }

    // Cleanup expired sell orders (expired payment sessions)
    startExpiredSellOrderCleanup() {
        setInterval(async () => {
            try {
                const expiredOrders = await SellOrder.find({
                    status: 'pending',
                    sessionExpiry: { $lt: new Date() }
                });
                
                if (expiredOrders.length > 0) {
                    console.log(`⏰ Cleaning up ${expiredOrders.length} expired sell orders`);
                    
                    for (const order of expiredOrders) {
                        // Update order status to expired
                        order.status = 'expired';
                        await order.save();
                        
                        // Notify user about expired order
                        try {
                            await this.bot.sendMessage(order.telegramId, 
                                `⏰ Your sell order #${order.id} has expired.\n\n` +
                                `The payment session has timed out. Please create a new order if you still want to sell your stars.`
                            );
                        } catch (error) {
                            console.error(`Failed to notify user ${order.telegramId} about expired order:`, error);
                        }
                    }
                    
                    // Log cleanup summary
                    console.log(`✅ Cleaned up ${expiredOrders.length} expired sell orders`);
                }
            } catch (error) {
                console.error('Error in expired sell order cleanup:', error);
            }
        }, 15 * 60 * 1000); // Every 15 minutes
    }

    // Cleanup inactive users (no activity for 90 days)
    startUserCleanup() {
        setInterval(async () => {
            try {
                const ninetyDaysAgo = new Date();
                ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
                
                const inactiveUsers = await User.find({
                    $or: [
                        { lastSeen: { $lt: ninetyDaysAgo }, joinDate: { $lt: ninetyDaysAgo } },
                        { lastSeen: { $exists: false }, joinDate: { $lt: ninetyDaysAgo } }
                    ],
                    isActive: true
                });
                
                if (inactiveUsers.length > 0) {
                    console.log(`🧹 Marking ${inactiveUsers.length} users as inactive`);
                    
                    // Mark users as inactive instead of deleting them
                    await User.updateMany(
                        { _id: { $in: inactiveUsers.map(u => u._id) } },
                        { 
                            $set: { 
                                isActive: false,
                                inactiveDate: new Date()
                            }
                        }
                    );
                    
                    console.log(`✅ Marked ${inactiveUsers.length} users as inactive`);
                }
            } catch (error) {
                console.error('Error in user cleanup:', error);
            }
        }, 24 * 60 * 60 * 1000); // Daily
    }

    // Cleanup old referral records
    startReferralCleanup() {
        setInterval(async () => {
            try {
                const sixMonthsAgo = new Date();
                sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
                
                const oldReferrals = await Referral.find({
                    dateCreated: { $lt: sixMonthsAgo },
                    status: 'pending'
                });
                
                if (oldReferrals.length > 0) {
                    console.log(`🧹 Cleaning up ${oldReferrals.length} old pending referrals`);
                    
                    for (const referral of oldReferrals) {
                        referral.status = 'expired';
                        referral.expiredDate = new Date();
                        await referral.save();
                    }
                }
            } catch (error) {
                console.error('Error in referral cleanup:', error);
            }
        }, 7 * 24 * 60 * 60 * 1000); // Weekly
    }

    // Cleanup expired refund requests (older than 30 days)
    startRefundRequestCleanup() {
        setInterval(async () => {
            try {
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                
                const expiredRequests = await Reversal.find({
                    status: 'pending',
                    createdAt: { $lt: thirtyDaysAgo }
                });
                
                if (expiredRequests.length > 0) {
                    console.log(`🧹 Marking ${expiredRequests.length} expired refund requests as expired`);
                    
                    await Reversal.updateMany(
                        { _id: { $in: expiredRequests.map(r => r._id) } },
                        { 
                            $set: { 
                                status: 'expired',
                                processedAt: new Date()
                            }
                        }
                    );
                    
                    console.log(`✅ Marked ${expiredRequests.length} refund requests as expired`);
                }
            } catch (error) {
                console.error('Error in refund request cleanup:', error);
            }
        }, 24 * 60 * 60 * 1000); // Daily
    }

    // Cleanup old stickers (optional maintenance)
    startStickerCleanup() {
        setInterval(async () => {
            try {
                const { Sticker } = require('../models');
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
                
                const oldStickers = await Sticker.find({
                    updated_at: { $lt: thirtyDaysAgo },
                    set_name: { $exists: false } // Only delete stickers without set names
                });
                
                if (oldStickers.length > 0) {
                    console.log(`🧹 Cleaning up ${oldStickers.length} old stickers`);
                    
                    await Sticker.deleteMany({
                        updated_at: { $lt: thirtyDaysAgo },
                        set_name: { $exists: false }
                    });
                    
                    console.log(`✅ Cleaned up ${oldStickers.length} old stickers`);
                }
            } catch (error) {
                console.error('Error in sticker cleanup:', error);
            }
        }, 7 * 24 * 60 * 60 * 1000); // Weekly
    }

    async startWithdrawalCleanup() {
        try {
            // Mark old pending withdrawals as expired (older than 30 days)
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            
            const result = await ReferralWithdrawal.updateMany(
                { 
                    status: 'pending', 
                    createdAt: { $lt: thirtyDaysAgo } 
                },
                { 
                    $set: { 
                        status: 'expired',
                        processedAt: new Date(),
                        processedBy: 'system'
                    } 
                }
            );

            if (result.modifiedCount > 0) {
                console.log(`✅ Cleaned up ${result.modifiedCount} expired withdrawal requests`);
            }
        } catch (error) {
            console.error('❌ Withdrawal cleanup error:', error);
        }
    }

    // Daily report to admins
    startDailyReport() {
        // Send daily report at 9 AM
        const scheduleDailyReport = () => {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            
            const timeUntilReport = tomorrow.getTime() - now.getTime();
            
            setTimeout(async () => {
                await this.sendDailyReport();
                scheduleDailyReport(); // Schedule next report
            }, timeUntilReport);
        };
        
        scheduleDailyReport();
    }

    async sendDailyReport() {
        try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            // Get statistics
            const newUsers = await User.countDocuments({
                joinDate: { $gte: yesterday, $lt: today }
            });
            
            const newOrders = await SellOrder.countDocuments({
                dateCreated: { $gte: yesterday, $lt: today }
            });
            
            const completedOrders = await SellOrder.countDocuments({
                status: 'completed',
                dateCompleted: { $gte: yesterday, $lt: today }
            });
            
            const totalRevenue = await SellOrder.aggregate([
                {
                    $match: {
                        status: 'completed',
                        dateCompleted: { $gte: yesterday, $lt: today }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' }
                    }
                }
            ]);
            
            const revenue = totalRevenue.length > 0 ? totalRevenue[0].total : 0;
            
            const report = `📊 **Daily Report - ${yesterday.toLocaleDateString()}**\n\n` +
                `👥 **New Users**: ${newUsers}\n` +
                `📋 **New Orders**: ${newOrders}\n` +
                `✅ **Completed Orders**: ${completedOrders}\n` +
                `💰 **Revenue**: $${revenue.toFixed(2)}\n\n` +
                `📈 **System Status**: All systems operational`;
            
            // Send to all admins
            for (const adminId of this.adminIds) {
                try {
                    await this.bot.sendMessage(adminId, report, { parse_mode: 'Markdown' });
                } catch (error) {
                    console.error(`Failed to send daily report to admin ${adminId}:`, error);
                }
            }
            
        } catch (error) {
            console.error('Error sending daily report:', error);
        }
    }

    // Manual maintenance commands
    async handleMaintenanceCommand(msg, command) {
        if (!this.adminIds.includes(msg.from.id.toString())) {
            return this.bot.sendMessage(msg.chat.id, '⛔ Access denied');
        }

        switch (command) {
            case 'cleanup_warnings':
                await this.manualWarningCleanup(msg);
                break;
            case 'cleanup_orders':
                await this.manualOrderCleanup(msg);
                break;
            case 'system_status':
                await this.systemStatus(msg);
                break;
            default:
                await this.bot.sendMessage(msg.chat.id, '❌ Unknown maintenance command');
        }
    }

    async manualWarningCleanup(msg) {
        try {
            const expiredWarnings = await Warning.find({
                isActive: true,
                autoRemove: true,
                expiresAt: { $lte: new Date() }
            });
            
            let cleaned = 0;
            for (const warning of expiredWarnings) {
                await Warning.updateOne(
                    { _id: warning._id },
                    { isActive: false }
                );
                await BannedUser.updateOne({}, { $pull: { users: warning.userId } });
                cleaned++;
            }
            
            await this.bot.sendMessage(msg.chat.id, `✅ Manually cleaned up ${cleaned} expired warnings`);
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, `❌ Error during manual cleanup: ${error.message}`);
        }
    }

    async manualOrderCleanup(msg) {
        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            
            const oldOrders = await SellOrder.countDocuments({
                status: { $in: ['completed', 'refunded', 'cancelled'] },
                dateCompleted: { $lt: thirtyDaysAgo }
            });
            
            await this.bot.sendMessage(msg.chat.id, `📊 Found ${oldOrders} orders older than 30 days`);
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, `❌ Error checking old orders: ${error.message}`);
        }
    }

    async systemStatus(msg) {
        try {
            const totalUsers = await User.countDocuments();
            const activeUsers = await User.countDocuments({ isActive: { $ne: false } });
            const pendingOrders = await SellOrder.countDocuments({ status: 'processing' });
            const activeWarnings = await Warning.countDocuments({ isActive: true });
            
            const status = `🔧 **System Status**\n\n` +
                `👥 **Total Users**: ${totalUsers}\n` +
                `✅ **Active Users**: ${activeUsers}\n` +
                `📋 **Pending Orders**: ${pendingOrders}\n` +
                `⚠️ **Active Warnings**: ${activeWarnings}\n\n` +
                `🟢 **Status**: All systems operational`;
            
            await this.bot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bot.sendMessage(msg.chat.id, `❌ Error getting system status: ${error.message}`);
        }
    }
}

module.exports = MaintenanceManager;
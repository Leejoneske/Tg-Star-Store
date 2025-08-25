const { User, Referral, ReferralTracker } = require('../models');

class ReferralTrackingManager {
    constructor(bot, adminIds) {
        this.bot = bot;
        this.adminIds = adminIds;
    }

    // Track stars for referral activation
    async trackStars(userId, stars, type) {
        try {
            const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
            if (!tracker) return;

            // Update star counts based on transaction type
            if (type === 'buy') tracker.totalBoughtStars += stars || 0;
            if (type === 'sell') tracker.totalSoldStars += stars || 0;

            const totalStars = tracker.totalBoughtStars + tracker.totalSoldStars;
            
            // Activation logic (100+ stars or premium)
            if ((totalStars >= 100 || tracker.premiumActivated) && tracker.status === 'pending') {
                await this.handleReferralActivation(tracker);
            } else {
                await tracker.save();
            }
        } catch (error) {
            console.error('Tracking error:', error);
        }
    }

    // Track premium activation for referral
    async trackPremiumActivation(userId) {
        try {
            const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
            if (!tracker) return;

            if (!tracker.premiumActivated) {
                tracker.premiumActivated = true;
                if (tracker.status === 'pending') {
                    await this.handleReferralActivation(tracker);
                } else {
                    await tracker.save();
                }
            }
        } catch (error) {
            console.error('Premium activation error:', error);
        }
    }

    // Handle referral activation when conditions are met
    async handleReferralActivation(tracker) {
        try {
            // Get user details
            const [referrer, referred] = await Promise.all([
                User.findOne({ id: tracker.referrerUserId }),
                User.findOne({ id: tracker.referredUserId })
            ]);

            // Update both tracker and referral
            tracker.status = 'active';
            tracker.dateActivated = new Date();
            await tracker.save();

            if (tracker.referral) {
                await Referral.findByIdAndUpdate(tracker.referral, {
                    status: 'active',
                    activatedDate: new Date()
                });
            }

            // Format detailed admin notification
            const adminMessage = `🎉 REFERRAL ACTIVATED!\n\n` +
                `🔗 Referral ID: ${tracker.referral}\n` +
                `👤 Referrer: @${referrer?.username || 'unknown'} (ID: ${tracker.referrerUserId})\n` +
                `👥 Referred: @${referred?.username || tracker.referredUsername || 'unknown'} (ID: ${tracker.referredUserId})\n` +
                `⭐ Total Stars Bought: ${tracker.totalBoughtStars}\n` +
                `⭐ Total Stars Sold: ${tracker.totalSoldStars}\n` +
                `🎖️ Premium Activated: ${tracker.premiumActivated ? 'Yes' : 'No'}\n` +
                `📅 Date Referred: ${tracker.dateReferred.toLocaleDateString()}\n` +
                `📅 Date Activated: ${new Date().toLocaleDateString()}`;

            // Send to all admins
            for (const adminId of this.adminIds) {
                try {
                    await this.bot.sendMessage(adminId, adminMessage, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });
                } catch (err) {
                    console.error(`Failed to notify admin ${adminId}:`, err);
                }
            }

            // Send notification to referrer
            await this.bot.sendMessage(
                tracker.referrerUserId,
                `🎉 Your referral @${referred?.username || tracker.referredUsername} just became active!\n` +
                `You earned 0.5 USDT referral bonus.`
            );
        } catch (error) {
            console.error('Referral activation error:', error);
        }
    }

    // Create referral tracker when user starts with referral
    async createReferralTracker(referrerUserId, referredUserId, referredUsername) {
        try {
            const existing = await ReferralTracker.findOne({ referredUserId: referredUserId.toString() });
            if (existing) return existing;

            const referral = await Referral.create({
                referrerId: referrerUserId,
                referredId: referredUserId.toString(),
                referredUsername,
                status: 'pending',
                dateCreated: new Date()
            });
            
            const tracker = await ReferralTracker.create({
                referral: referral._id,
                referrerUserId,
                referredUserId: referredUserId.toString(),
                referredUsername,
                status: 'pending',
                dateReferred: new Date()
            });

            await this.bot.sendMessage(referrerUserId, `🎉 Someone used your referral link and joined StarStore!`);
            
            return tracker;
        } catch (error) {
            console.error('Error creating referral tracker:', error);
            throw error;
        }
    }
}

module.exports = ReferralTrackingManager;
const { Sticker } = require('../models');

class StickerManager {
    constructor(bot) {
        this.bot = bot;
        this.setupStickerHandler();
    }

    setupStickerHandler() {
        this.bot.on('sticker', async (msg) => {
            await this.handleSticker(msg);
        });
    }

    async handleSticker(msg) {
        try {
            const sticker = msg.sticker;
            if (!sticker) return;

            console.log('Processing sticker:', {
                id: sticker.file_unique_id,
                set: sticker.set_name,
                type: sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
            });

            // Get file info from Telegram
            const fileInfo = await this.bot.getFile(sticker.file_id);
            if (!fileInfo.file_path) {
                console.error('No file path for sticker:', sticker.file_unique_id);
                return;
            }

            const updateData = {
                file_id: sticker.file_id,
                file_path: fileInfo.file_path,
                is_animated: sticker.is_animated || false,
                is_video: sticker.is_video || false,
                emoji: sticker.emoji || '',
                set_name: sticker.set_name || '',
                updated_at: new Date()
            };

            // Update or create sticker record
            await Sticker.updateOne(
                { file_unique_id: sticker.file_unique_id },
                { 
                    $set: updateData, 
                    $setOnInsert: { created_at: new Date() } 
                },
                { upsert: true }
            );

            console.log('Sticker processed successfully:', sticker.file_unique_id);

        } catch (error) {
            console.error('Sticker processing error:', error.message);
        }
    }

    // Get sticker by unique ID
    async getStickerByUniqueId(fileUniqueId) {
        try {
            return await Sticker.findOne({ file_unique_id: fileUniqueId });
        } catch (error) {
            console.error('Error getting sticker:', error);
            return null;
        }
    }

    // Get stickers by set name
    async getStickersBySet(setName, limit = 50, offset = 0) {
        try {
            return await Sticker.find(
                { set_name: setName },
                {
                    file_unique_id: 1,
                    emoji: 1,
                    set_name: 1,
                    is_animated: 1,
                    is_video: 1,
                    created_at: 1
                }
            )
            .sort({ created_at: -1 })
            .skip(parseInt(offset))
            .limit(parseInt(limit));
        } catch (error) {
            console.error('Error getting stickers by set:', error);
            return [];
        }
    }

    // Get all stickers with pagination
    async getAllStickers(limit = 50, offset = 0) {
        try {
            return await Sticker.find(
                {},
                {
                    file_unique_id: 1,
                    emoji: 1,
                    set_name: 1,
                    is_animated: 1,
                    is_video: 1,
                    created_at: 1
                }
            )
            .sort({ created_at: -1 })
            .skip(parseInt(offset))
            .limit(parseInt(limit));
        } catch (error) {
            console.error('Error getting all stickers:', error);
            return [];
        }
    }

    // Get sticker statistics
    async getStickerStats() {
        try {
            const [total, animated, video, static_count] = await Promise.all([
                Sticker.countDocuments({}),
                Sticker.countDocuments({ is_animated: true }),
                Sticker.countDocuments({ is_video: true }),
                Sticker.countDocuments({ is_animated: false, is_video: false })
            ]);

            const sets = await Sticker.distinct('set_name');
            const uniqueSets = sets.filter(set => set && set.trim() !== '');

            return {
                total,
                animated,
                video,
                static: static_count,
                sets: uniqueSets.length,
                setNames: uniqueSets
            };
        } catch (error) {
            console.error('Error getting sticker stats:', error);
            return {
                total: 0,
                animated: 0,
                video: 0,
                static: 0,
                sets: 0,
                setNames: []
            };
        }
    }

    // Delete sticker by unique ID
    async deleteSticker(fileUniqueId) {
        try {
            const result = await Sticker.deleteOne({ file_unique_id: fileUniqueId });
            return result.deletedCount > 0;
        } catch (error) {
            console.error('Error deleting sticker:', error);
            return false;
        }
    }

    // Clean up old stickers (optional maintenance function)
    async cleanupOldStickers(daysOld = 30) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);

            const result = await Sticker.deleteMany({
                updated_at: { $lt: cutoffDate },
                set_name: { $exists: false } // Only delete stickers without set names
            });

            console.log(`Cleaned up ${result.deletedCount} old stickers`);
            return result.deletedCount;
        } catch (error) {
            console.error('Error cleaning up old stickers:', error);
            return 0;
        }
    }

    // Send sticker to user
    async sendStickerToUser(userId, stickerUniqueId) {
        try {
            const sticker = await this.getStickerByUniqueId(stickerUniqueId);
            if (!sticker) {
                throw new Error('Sticker not found');
            }

            await this.bot.sendSticker(userId, sticker.file_id);
            return true;
        } catch (error) {
            console.error('Error sending sticker to user:', error);
            return false;
        }
    }

    // Get sticker info for API responses
    async getStickerInfo(fileUniqueId) {
        try {
            return await Sticker.findOne(
                { file_unique_id: fileUniqueId },
                { 
                    _id: 0, 
                    file_unique_id: 1, 
                    is_animated: 1, 
                    is_video: 1, 
                    emoji: 1, 
                    set_name: 1,
                    created_at: 1,
                    updated_at: 1
                }
            );
        } catch (error) {
            console.error('Error getting sticker info:', error);
            return null;
        }
    }
}

module.exports = StickerManager;
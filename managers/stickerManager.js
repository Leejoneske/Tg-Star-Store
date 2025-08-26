const { Sticker } = require('../models');

class StickerManager {
    constructor(bot) {
        this.bot = bot;
        this.processingQueue = new Map(); // Track processing stickers
        this.errorCount = new Map(); // Track error counts for backoff
        this.setupStickerHandler();
    }

    setupStickerHandler() {
        this.bot.on('sticker', async (msg) => {
            await this.handleSticker(msg);
        });
    }

    async handleSticker(msg) {
        let fileUniqueId = null;
        
        try {
            const sticker = msg.sticker;
            if (!sticker) return;

            fileUniqueId = sticker.file_unique_id;
            
            // Check if already processing this sticker
            if (this.processingQueue.has(fileUniqueId)) {
                console.log('Sticker already being processed:', fileUniqueId);
                return;
            }

            // Check error backoff
            const errorCount = this.errorCount.get(fileUniqueId) || 0;
            if (errorCount >= 3) {
                console.log('Skipping sticker due to too many errors:', fileUniqueId);
                return;
            }

            // Add to processing queue
            this.processingQueue.set(fileUniqueId, Date.now()); // Store timestamp

            console.log('Processing sticker:', {
                id: fileUniqueId,
                set: sticker.set_name,
                type: sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
            });

            // Get file info from Telegram with timeout and retry
            const fileInfo = await this.getFileWithRetry(sticker.file_id);
            if (!fileInfo || !fileInfo.file_path) {
                console.error('No file path for sticker:', fileUniqueId);
                this.incrementErrorCount(fileUniqueId);
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
                { file_unique_id: fileUniqueId },
                { 
                    $set: updateData, 
                    $setOnInsert: { created_at: new Date() } 
                },
                { upsert: true }
            );

            // Clear error count on success
            this.errorCount.delete(fileUniqueId);
            console.log('Sticker processed successfully:', fileUniqueId);

        } catch (error) {
            console.error('Sticker processing error:', error.message);
            if (fileUniqueId) {
                this.incrementErrorCount(fileUniqueId);
            }
        } finally {
            // Remove from processing queue - ensure this always happens
            if (fileUniqueId) {
                this.processingQueue.delete(fileUniqueId);
            }
        }
    }

    // Get file with retry and timeout
    async getFileWithRetry(fileId, maxRetries = 2) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const fileInfo = await Promise.race([
                    this.bot.getFile(fileId),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), 10000)
                    )
                ]);
                return fileInfo;
            } catch (error) {
                console.error(`File retrieval attempt ${attempt} failed:`, error.message);
                if (attempt === maxRetries) {
                    throw error;
                }
                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    // Increment error count for backoff
    incrementErrorCount(fileUniqueId) {
        const currentCount = this.errorCount.get(fileUniqueId) || 0;
        this.errorCount.set(fileUniqueId, currentCount + 1);
        
        // Clean up error count after 1 hour
        setTimeout(() => {
            this.errorCount.delete(fileUniqueId);
        }, 60 * 60 * 1000);
    }

    // Get processing queue status
    getProcessingStatus() {
        return {
            processingCount: this.processingQueue.size,
            errorCounts: Object.fromEntries(this.errorCount.entries()),
            queueHealth: this.processingQueue.size < 100 ? 'healthy' : 'warning'
        };
    }

    // Clean up stale queue entries (safety mechanism)
    cleanupStaleQueueEntries() {
        const now = Date.now();
        const staleThreshold = 5 * 60 * 1000; // 5 minutes
        
        for (const [fileUniqueId, timestamp] of this.processingQueue.entries()) {
            if (now - timestamp > staleThreshold) {
                console.warn(`Removing stale queue entry: ${fileUniqueId}`);
                this.processingQueue.delete(fileUniqueId);
            }
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
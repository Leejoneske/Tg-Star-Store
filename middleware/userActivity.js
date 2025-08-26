const { User } = require('../models');

// Middleware to track user activity and update lastSeen
const trackUserActivity = async (req, res, next) => {
    try {
        const telegramId = req.headers['x-telegram-id'] || req.query.telegramId;
        
        if (telegramId) {
            // Update user's lastSeen timestamp
            await User.updateOne(
                { $or: [{ id: telegramId }, { telegramId: telegramId }] },
                { 
                    $set: { 
                        lastSeen: new Date(),
                        isActive: true 
                    },
                    $unset: { inactiveDate: 1 }
                }
            );
        }
    } catch (error) {
        console.error('Error tracking user activity:', error);
        // Don't block the request if activity tracking fails
    }
    
    next();
};

// Middleware to track user activity for bot interactions
const trackBotActivity = async (telegramId) => {
    try {
        if (telegramId) {
            await User.updateOne(
                { $or: [{ id: telegramId }, { telegramId: telegramId }] },
                { 
                    $set: { 
                        lastSeen: new Date(),
                        isActive: true 
                    },
                    $unset: { inactiveDate: 1 }
                }
            );
        }
    } catch (error) {
        console.error('Error tracking bot activity:', error);
    }
};

module.exports = {
    trackUserActivity,
    trackBotActivity
};
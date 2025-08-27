const express = require('express');
const { Notification, User } = require('../models');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireTelegramAuth } = require('../middleware/telegramAuth');

const router = express.Router();

// Get user notifications
router.get('/notifications', requireTelegramAuth, async (req, res) => {
    try {
        const { userId, limit = 20, skip = 0 } = req.query;

        if (!userId || userId === 'anonymous') {
            return res.status(400).json({ error: "User ID is required" });
        }

        const query = {
            $or: [
                { userId: 'all' },
                { isGlobal: true },
                { userId: userId }
            ]
        };

        const notifications = await Notification.find(query)
            .sort({ priority: -1, timestamp: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();

        const unreadCount = await Notification.countDocuments({
            ...query,
            read: false
        });

        const formattedNotifications = notifications.map(notification => ({
            id: notification._id.toString(),
            title: notification.title,
            message: notification.message,
            actionUrl: notification.actionUrl,
            icon: notification.icon,
            createdAt: notification.timestamp,
            read: notification.read,
            isGlobal: notification.isGlobal,
            priority: notification.priority,
            type: notification.type
        }));

        res.json({
            notifications: formattedNotifications,
            unreadCount,
            totalCount: await Notification.countDocuments(query)
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

// Create notification (admin only)
router.post('/notifications', requireAdminAuth, async (req, res) => {
    try {
        const { userId, title, message, actionUrl, isGlobal, priority = 0, type = 'manual' } = req.body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: "Valid message is required" });
        }

        const requestUserId = 'admin';

        const newNotification = await Notification.create({
            userId: isGlobal ? 'all' : userId,
            title: title || 'Notification',
            message: message.trim(),
            actionUrl,
            isGlobal: !!isGlobal,
            priority: Math.min(2, Math.max(0, parseInt(priority) || 0)),
            type: type,
            createdBy: requestUserId
        });

        res.status(201).json({
            id: newNotification._id,
            success: true,
            message: "Notification created successfully"
        });
    } catch (error) {
        console.error('Error creating notification:', error);
        res.status(500).json({ error: "Failed to create notification" });
    }
});

// Mark notification as read
router.post('/notifications/:id/read', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        // Check if user can read this notification
        if (notification.userId !== 'all' &&
            !notification.isGlobal &&
            notification.userId !== userId) {
            return res.status(403).json({ error: "Unauthorized to modify this notification" });
        }

        notification.read = true;
        await notification.save();

        res.json({ success: true, message: "Notification marked as read" });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
});

// Mark all notifications as read
router.post('/notifications/mark-all-read', requireTelegramAuth, async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const result = await Notification.updateMany(
            {
                $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }],
                read: false
            },
            { read: true }
        );

        res.json({ 
            success: true, 
            message: "All notifications marked as read",
            updatedCount: result.modifiedCount
        });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: "Failed to mark notifications as read" });
    }
});

// Get notification statistics (admin only)
router.get('/notifications/stats', requireAdminAuth, async (req, res) => {
    try {
        const requestUserId = 'admin';

        const totalNotifications = await Notification.countDocuments();
        const unreadNotifications = await Notification.countDocuments({ read: false });
        const globalNotifications = await Notification.countDocuments({ isGlobal: true });
        const todayNotifications = await Notification.countDocuments({
            timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
        });

        const typeStats = await Notification.aggregate([
            {
                $group: {
                    _id: '$type',
                    count: { $sum: 1 }
                }
            }
        ]);

        res.json({
            totalNotifications,
            unreadNotifications,
            globalNotifications,
            todayNotifications,
            readRate: totalNotifications > 0 ? ((totalNotifications - unreadNotifications) / totalNotifications * 100).toFixed(1) : 0,
            typeStats
        });
    } catch (error) {
        console.error('Error getting notification stats:', error);
        res.status(500).json({ error: "Failed to get notification statistics" });
    }
});

// Delete notification (admin only)
router.delete('/notifications/:id', requireAdminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const requestUserId = 'admin';

        const notification = await Notification.findByIdAndDelete(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        res.json({ success: true, message: "Notification deleted successfully" });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ error: "Failed to delete notification" });
    }
});

// Get unread count
router.get('/notifications/unread-count', async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const unreadCount = await Notification.countDocuments({
            $or: [{ userId: 'all' }, { userId: userId }, { isGlobal: true }],
            read: false
        });

        res.json({ unreadCount });
    } catch (error) {
        console.error('Error getting unread count:', error);
        res.status(500).json({ error: "Failed to get unread count" });
    }
});

module.exports = router;
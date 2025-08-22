const express = require('express');
const { Notification } = require('../models');

const router = express.Router();

router.get('/notifications', async (req, res) => {
    try {
        const { userId, limit = 20, skip = 0 } = req.query;

        const query = {
            $or: [
                { userId: 'all' },
                { isGlobal: true }
            ]
        };

        if (userId && userId !== 'anonymous') {
            query.$or.push({ userId });
        }

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
            priority: notification.priority
        }));

        res.json({
            notifications: formattedNotifications,
            unreadCount,
            totalCount: await Notification.countDocuments(query)
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

router.post('/notifications', async (req, res) => {
    try {
        const { userId, title, message, actionUrl, isGlobal, priority = 0 } = req.body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: "Valid message is required" });
        }

        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ error: "Unauthorized: Admin access required" });
        }

        const newNotification = await Notification.create({
            userId: isGlobal ? 'all' : userId,
            title: title || 'Notification',
            message: message.trim(),
            actionUrl,
            isGlobal: !!isGlobal,
            priority: Math.min(2, Math.max(0, parseInt(priority) || 0))
        });

        res.status(201).json({
            id: newNotification._id,
            success: true,
            message: "Notification created successfully"
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to create notification" });
    }
});

router.post('/notifications/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        if (notification.userId !== 'all' &&
            !notification.isGlobal &&
            notification.userId !== userId) {
            return res.status(403).json({ error: "Unauthorized to modify this notification" });
        }

        await Notification.findByIdAndUpdate(id, { read: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
});

router.post('/notifications/mark-all-read', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const query = {
            read: false,
            $or: [
                { userId: 'all' },
                { isGlobal: true }
            ]
        };

        if (userId !== 'anonymous') {
            query.$or.push({ userId });
        }

        const result = await Notification.updateMany(
            query,
            { $set: { read: true } }
        );

        res.json({ success: true, markedCount: result.modifiedCount });
    } catch (error) {
        res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
});

router.delete('/notifications/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId } = req.body;

        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: "Notification not found" });
        }

        if (!req.user?.isAdmin && (notification.isGlobal || notification.userId === 'all')) {
            return res.status(403).json({ error: "Unauthorized to delete this notification" });
        }

        await Notification.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to dismiss notification" });
    }
});

module.exports = router;
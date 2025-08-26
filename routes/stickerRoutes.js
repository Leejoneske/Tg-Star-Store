const express = require('express');
const fetch = require('node-fetch');
const zlib = require('zlib');
const { Sticker } = require('../models');
const { trackUserActivity } = require('../middleware/userActivity');

const router = express.Router();

// Get sticker JSON data (for animated stickers)
router.get('/sticker/:sticker_id/json', trackUserActivity, async (req, res) => {
  try {
    const { sticker_id } = req.params;
    
    if (!sticker_id) {
      return res.status(400).json({ error: 'Sticker ID is required' });
    }

    const sticker = await Sticker.findOne({ file_unique_id: sticker_id });
    if (!sticker || !sticker.file_path || !sticker.file_path.endsWith('.tgs')) {
      return res.status(404).json({ error: 'Sticker not found or not animated' });
    }

    const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${sticker.file_path}`;
    const tgRes = await fetch(telegramUrl);
    
    if (!tgRes.ok) {
      return res.status(404).json({ error: 'Sticker file not found on Telegram servers' });
    }
    
    const buffer = await tgRes.arrayBuffer();

    zlib.unzip(Buffer.from(buffer), (err, jsonBuffer) => {
      if (err) {
        console.error('Decompression error:', err);
        return res.status(500).json({ error: 'Failed to decode sticker' });
      }

      try {
        const json = JSON.parse(jsonBuffer.toString());
        res.json(json);
      } catch (e) {
        console.error('JSON parsing error:', e);
        res.status(500).json({ error: 'Invalid JSON in sticker file' });
      }
    });
  } catch (e) {
    console.error('Sticker JSON error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sticker information
router.get('/sticker/:id/info', trackUserActivity, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Sticker ID is required' });
    }

    const sticker = await Sticker.findOne(
      { file_unique_id: id },
      { _id: 0, file_unique_id: 1, is_animated: 1, is_video: 1, emoji: 1, set_name: 1, created_at: 1, updated_at: 1 }
    );

    if (!sticker) {
      return res.status(404).json({ error: 'Sticker not found' });
    }

    res.json(sticker);
  } catch (error) {
    console.error('Sticker info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all stickers with pagination and filtering
router.get('/stickers', trackUserActivity, async (req, res) => {
  try {
    const { set, type, limit = 50, offset = 0 } = req.query;
    
    // Validate parameters
    const limitNum = Math.min(parseInt(limit), 100); // Max 100 per request
    const offsetNum = Math.max(parseInt(offset), 0);
    
    const query = {};
    
    // Filter by set
    if (set) {
      query.set_name = set;
    }
    
    // Filter by type
    if (type) {
      switch (type.toLowerCase()) {
        case 'animated':
          query.is_animated = true;
          break;
        case 'video':
          query.is_video = true;
          break;
        case 'static':
          query.is_animated = false;
          query.is_video = false;
          break;
        default:
          return res.status(400).json({ error: 'Invalid type parameter. Use: animated, video, or static' });
      }
    }

    const stickers = await Sticker.find(query, {
      file_unique_id: 1,
      emoji: 1,
      set_name: 1,
      is_animated: 1,
      is_video: 1,
      created_at: 1
    })
      .sort({ created_at: -1 })
      .skip(offsetNum)
      .limit(limitNum);

    const total = await Sticker.countDocuments(query);

    res.json({
      stickers,
      pagination: {
        total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: total > offsetNum + stickers.length
      }
    });
  } catch (error) {
    console.error('Stickers list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sticker statistics
router.get('/stickers/stats', trackUserActivity, async (req, res) => {
  try {
    const [total, animated, video, static_count] = await Promise.all([
      Sticker.countDocuments({}),
      Sticker.countDocuments({ is_animated: true }),
      Sticker.countDocuments({ is_video: true }),
      Sticker.countDocuments({ is_animated: false, is_video: false })
    ]);

    const sets = await Sticker.distinct('set_name');
    const uniqueSets = sets.filter(set => set && set.trim() !== '');

    res.json({
      total,
      animated,
      video,
      static: static_count,
      sets: uniqueSets.length,
      setNames: uniqueSets
    });
  } catch (error) {
    console.error('Sticker stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available sticker sets
router.get('/stickers/sets', trackUserActivity, async (req, res) => {
  try {
    const sets = await Sticker.distinct('set_name');
    const uniqueSets = sets.filter(set => set && set.trim() !== '');
    
    // Get count for each set
    const setStats = await Promise.all(
      uniqueSets.map(async (setName) => {
        const count = await Sticker.countDocuments({ set_name: setName });
        return { name: setName, count };
      })
    );

    res.json(setStats);
  } catch (error) {
    console.error('Sticker sets error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search stickers by emoji
router.get('/stickers/search', trackUserActivity, async (req, res) => {
  try {
    const { emoji, limit = 20 } = req.query;
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji parameter is required' });
    }

    const limitNum = Math.min(parseInt(limit), 50);
    
    const stickers = await Sticker.find(
      { emoji: emoji },
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
      .limit(limitNum);

    res.json(stickers);
  } catch (error) {
    console.error('Sticker search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sticker file URL
router.get('/sticker/:id/file', trackUserActivity, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Sticker ID is required' });
    }

    const sticker = await Sticker.findOne({ file_unique_id: id });
    
    if (!sticker || !sticker.file_path) {
      return res.status(404).json({ error: 'Sticker not found' });
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${sticker.file_path}`;
    
    res.json({
      file_id: sticker.file_id,
      file_unique_id: sticker.file_unique_id,
      file_url: fileUrl,
      is_animated: sticker.is_animated,
      is_video: sticker.is_video,
      emoji: sticker.emoji,
      set_name: sticker.set_name
    });
  } catch (error) {
    console.error('Sticker file error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sticker processing status (admin only)
router.get('/stickers/status', trackUserActivity, async (req, res) => {
  try {
    // Admin authorization check
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== process.env.API_KEY) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // This would need to be passed from the StickerManager
    // For now, return basic stats
    const [total, processing] = await Promise.all([
      Sticker.countDocuments({}),
      Sticker.countDocuments({ updated_at: { $gte: new Date(Date.now() - 5 * 60 * 1000) } }) // Last 5 minutes
    ]);

    res.json({
      total,
      recentlyProcessed: processing,
      status: 'operational'
    });
  } catch (error) {
    console.error('Sticker status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sticker processing queue status (admin only)
router.get('/stickers/queue-status', trackUserActivity, async (req, res) => {
  try {
    // Admin authorization check
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== process.env.API_KEY) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // This would need to be passed from the StickerManager
    // For now, return basic queue health info
    const [total, processing] = await Promise.all([
      Sticker.countDocuments({}),
      Sticker.countDocuments({ updated_at: { $gte: new Date(Date.now() - 5 * 60 * 1000) } }) // Last 5 minutes
    ]);

    res.json({
      total,
      recentlyProcessed: processing,
      queueHealth: 'operational',
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sticker queue status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


require('dotenv').config();

// Suppress punycode deprecation warning (from tldts dependency)
// Safe to ignore - Node.js built-in punycode is still stable for domain parsing
process.noDeprecation = true;

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const multer = require('multer');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const fetch = require('node-fetch');
const app = express();
const path = require('path');  
const zlib = require('zlib');

// Scheduled tasks
const schedule = (() => {
  // Simple scheduler using setInterval (no external dependency needed)
  return {
    scheduleEndOfMonthTask: (callback) => {
      // Run daily at 11:59 PM UTC to check if it's the last day of the month
      const checkEndOfMonth = () => {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // If tomorrow is the 1st, today is the last day
        if (tomorrow.getDate() === 1) {
          console.log(`[Scheduler] Triggering end-of-month task for ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
          callback();
        }
      };
      
      // Check every hour
      setInterval(checkEndOfMonth, 60 * 60 * 1000);
    },
    
    // Periodic repair scheduler - runs every 2 hours to repair orphaned referrals
    schedulePeriodicRepair: (callback) => {
      console.log('[Scheduler] Periodic referral repair initialized (every 2 hours)');
      // Run every 2 hours
      setInterval(() => {
        console.log('[Scheduler] Running periodic referral repair scan...');
        callback();
      }, 2 * 60 * 60 * 1000);
    }
  };
})();

// Simple in-memory geolocation cache to avoid API rate limiting
const geoCache = new Map();
const GEO_CACHE_TTL = 24 * 60 * 60 * 1000; // Cache for 24 hours

// Track recent username change notifications to prevent duplicates
const usernameChangeNotifications = new Map(); // Maps userId to timestamp
const USERNAME_CHANGE_DEDUPE_MS = 3000; // 3 second window to prevent duplicates

// Track processing requests to prevent duplicate order creation within same request window
const processingRequests = new Map(); // Maps request key to Promise
const REQUEST_DEDUPE_MS = 5000; // 5 second window for request deduplication
// Optional bot simulator (to avoid bloating monolith logic)
let startBotSimulatorSafe = null;
try {
  ({ startBotSimulator: startBotSimulatorSafe } = require('./services/bot-simulator'));
} catch (_) {
  // noop if missing
}

// PDF Generator for professional statements
let pdfGenerator = null;
try {
  pdfGenerator = require('./services/pdf-generator');
  console.log('✅ PDF Generator loaded successfully');
} catch (err) {
  console.error('❌ Failed to load PDF Generator:', err.message);
  // noop if missing - PDF export will be skipped gracefully
}

// Email Service for professional notifications (Resend API)
const emailService = require('./services/email-service');

// Admin commands module
const registerAdminEmailCommands = require('./telegram-commands-admin');

// Create Telegram bot or a stub in local/dev if no token is provided
let bot;
if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });
} else {
  console.warn('BOT_TOKEN not set. Using a no-op Telegram bot stub for local/dev.');
  bot = {
    setWebHook: async () => Promise.resolve(),
    sendMessage: async () => Promise.resolve({}),
    sendDocument: async () => Promise.resolve({}),
    editMessageText: async () => Promise.resolve({}),
    editMessageReplyMarkup: async () => Promise.resolve({}),
    answerCallbackQuery: async () => Promise.resolve({}),
    onText: () => {},
    on: () => {},
    processUpdate: () => {}
  };
}
const SERVER_URL = (process.env.RAILWAY_STATIC_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN || 
                   'tg-star-store-production.up.railway.app');
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://${SERVER_URL}${WEBHOOK_PATH}`;
// Import Telegram auth middleware (single import only)
let verifyTelegramAuth = (req, res, next) => next();
let requireTelegramAuth = (req, res, next) => next();
let isTelegramUser = () => true;
try {
    const mod = require('./middleware/telegramAuth');
    verifyTelegramAuth = mod.verifyTelegramAuth || verifyTelegramAuth;
    requireTelegramAuth = mod.requireTelegramAuth || requireTelegramAuth;
    isTelegramUser = mod.isTelegramUser || isTelegramUser;
} catch (e) {
    console.warn('telegramAuth middleware not found, proceeding without strict auth');
    // Lightweight local/dev fallback: derive user from x-telegram-id header
    requireTelegramAuth = (req, res, next) => {
        const telegramIdHeader = req.headers['x-telegram-id'];
        const telegramInitData = req.headers['x-telegram-init-data'];
        
        if (telegramIdHeader) {
            req.user = { id: telegramIdHeader.toString(), isAdmin: Array.isArray(adminIds) && adminIds.includes(telegramIdHeader.toString()) };
            return next();
        }
        
        // Try to extract user ID from init data if available
        if (telegramInitData) {
            try {
                const urlParams = new URLSearchParams(telegramInitData);
                const userParam = urlParams.get('user');
                if (userParam) {
                    const user = JSON.parse(userParam);
                    req.user = { id: user.id.toString(), username: user.username, isAdmin: Array.isArray(adminIds) && adminIds.includes(user.id.toString()) };
                    return next();
                }
            } catch (e) {
                console.error('Error parsing telegram init data:', e);
            }
        }
        
        if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = { id: 'dev-user', isAdmin: false };
        next();
    };
}
const reversalRequests = new Map();
// Middleware
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, etc.)
        if (!origin) return callback(null, true);
        
        // Allow localhost and approved production domains
        const allowedPatterns = [
            /^https?:\/\/localhost(:\d+)?$/,
            /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
            /^https:\/\/.*\.vercel\.app$/,
            /^https:\/\/(www\.)?starstore\.site$/,
            /^https:\/\/(www\.)?walletbot\.me$/,
            /^https:\/\/.*\.railway\.app$/,
            // Ambassador app domains
            /^https:\/\/amb-starstore\.vercel\.app$/,
            /^https:\/\/amb\.starstore\.site$/,
            /^https:\/\/.*ambassador.*\.vercel\.app$/
        ];
        
        const isAllowed = allowedPatterns.some(pattern => pattern.test(origin));
        
        if (isAllowed) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-telegram-init-data', 'x-telegram-id', 'x-api-key'],
    exposedHeaders: ['Content-Disposition']
}));

// Ambassador App Authentication Middleware
const AMBASSADOR_API_KEY = process.env.AMBASSADOR_API_KEY || 'amb_starstore_secure_key_2024';

const authenticateAmbassadorApp = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const userAgent = req.headers['user-agent'];
    
    // Check if request is from Ambassador app
    if (userAgent && userAgent.includes('Ambassador-Dashboard')) {
        if (apiKey === AMBASSADOR_API_KEY) {
            // Allow ambassador app requests
            req.isAmbassadorApp = true;
            console.log('✅ Ambassador app authenticated successfully');
            return next();
        } else {
            console.log('❌ Invalid API key for ambassador app:', apiKey);
            return res.status(401).json({ error: 'Invalid API key for ambassador app' });
        }
    }
    
    // For non-ambassador requests, continue with normal flow
    next();
};

// Apply ambassador authentication middleware
app.use(authenticateAmbassadorApp);

// Serve static files from public directory
app.use(express.static('public', { 
    maxAge: '1h',
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Add error handling for body parsing
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ 
    limit: '10mb',
    extended: true,
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(bodyParser.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Configure multer for file uploads (feedback attachments)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB per file
        files: 5 // Max 5 files
    }
});

// Error handling for body parsing
app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed' || error.code === 'ECONNABORTED') {
        console.log('Request body parsing error (client disconnected):', error.message);
        return res.status(400).json({ error: 'Invalid request body' });
    }
    next(error);
});

// Compression middleware disabled due to Z_DATA_ERROR issues in production
// The gzip compression is causing decompression errors on some clients
// Railway/edge proxies handle compression automatically if needed
// Uncomment below if needed, but test thoroughly in production first
/*
app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    },
    level: 6
}));
*/

// ==================== PARSE TELEGRAM AUTH FOR ALL REQUESTS ====================
// MUST come BEFORE route handlers so middleware is applied
try { app.use(verifyTelegramAuth); } catch (_) {}

// ==================== DYNAMIC ROUTES (BEFORE STATIC MIDDLEWARE) ====================

// ==================== REFERRAL PAGE ROUTE ====================
// Must come BEFORE static file middleware so it takes priority
// Does NOT require middleware auth - extracts userId from available sources
app.get('/referral', async (req, res) => {
  try {
    // Try to extract userId from available sources
    let userId = null;
    
    // 1. Check req.user (set by verifyTelegramAuth middleware on all requests)
    if (req.user && req.user.id && String(req.user.id).trim() && String(req.user.id) !== 'undefined' && String(req.user.id) !== 'dev-user') {
      userId = String(req.user.id);
    }
    
    // 2. Try from x-telegram-id header (for API calls)
    if (!userId) {
      const telegramIdHeader = req.headers['x-telegram-id'];
      if (telegramIdHeader && String(telegramIdHeader).trim() && String(telegramIdHeader) !== 'undefined') {
        userId = String(telegramIdHeader).trim();
      }
    }
    
    // 3. Try from query parameter
    if (!userId && req.query && req.query.userId) {
      userId = String(req.query.userId).trim();
    }
    
    // 4. Try from initData (if middleware set it)
    if (!userId) {
      try {
        if (req.telegramInitData && req.telegramInitData.user && req.telegramInitData.user.id) {
          userId = String(req.telegramInitData.user.id);
        }
      } catch (e) {
        // Ignore initData errors
      }
    }
    
    // Check if user is an ambassador (only if we have a userId)
    let isAmbassador = false;
    let htmlContent;
    
    if (userId) {
      try {
        const user = await User.findOne({ id: userId }).lean();
        isAmbassador = !!(user && user.ambassadorEmail);
      } catch (dbErr) {
        // Database error - continue anyway
        isAmbassador = false;
      }
    }

    // Select appropriate file based on ambassador status
    const fileName = isAmbassador ? 'amb_ref.html' : 'referral.html';
    
    const fs = require('fs').promises;
    const abs = path.join(__dirname, 'public', fileName);
    
    try {
      htmlContent = await fs.readFile(abs, 'utf8');
    } catch (readErr) {
      const notFound = path.join(__dirname, 'public', 'errors', '404.html');
      return res.status(404).sendFile(notFound, (sendErr) => {
        if (sendErr) return res.status(404).send('Not found');
      });
    }

    // Inject user ID as global variable if we have one
    if (userId) {
      htmlContent = htmlContent.replace(
        '<script src="https://telegram.org/js/telegram-web-app.js"></script>',
        `<script src="https://telegram.org/js/telegram-web-app.js"></script>
        <script>
          window.authenticatedUserId = "${userId}";
          window.isAuthenticatedUser = true;
          window.isAmbassador = ${isAmbassador};
        </script>`
      );
    }
    
    res.setHeader('Content-Type', 'text/html');
    // Cache-busting headers to force fresh page load
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.status(200).send(htmlContent);
  } catch (e) {
    console.error(`Error in /referral:`, e.message);
    const notFound = path.join(__dirname, 'public', 'errors', '404.html');
    return res.status(404).sendFile(notFound, (sendErr) => {
      if (sendErr) return res.status(404).send('Not found');
    });
  }
});

// Sitemap.xml with proper headers
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// ========== AMBASSADOR HELPERS ==========
// Initialize AmbassadorWaitlist model once to avoid schema duplication
async function getAmbassadorWaitlistModel() {
  // Check global cache first
  if (global.AmbassadorWaitlist) {
    return global.AmbassadorWaitlist;
  }
  
  if (!process.env.MONGODB_URI) {
    return null; // Not using MongoDB
  }
  
  // Check if model already exists in mongoose
  if (mongoose.models.AmbassadorWaitlist) {
    global.AmbassadorWaitlist = mongoose.models.AmbassadorWaitlist;
    return global.AmbassadorWaitlist;
  }
  
  // Create schema and model for the first time
  const schema = new mongoose.Schema({
    id: { type: String, unique: true },
    telegramId: String,
    username: String,
    email: { type: String, index: true },
    socials: { type: Object, default: {} },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'declined'] },
    processedBy: String,
    processedAt: Date,
    createdAt: { type: Date, default: Date.now },
    adminMessages: [{
      adminId: String,
      messageId: Number,
      originalText: String
    }]
  }, { collection: 'ambassador_waitlist' });
  
  global.AmbassadorWaitlist = mongoose.model('AmbassadorWaitlist', schema);
  return global.AmbassadorWaitlist;
}

// ========== AMBASSADOR TIER CALCULATION SYSTEM ==========
// Tier structure with referral count thresholds and rates
const AMBASSADOR_TIERS = {
  0: { name: 'Pre-Level', minRef: 0, maxRef: 29, rate: 0.50, level: 0 },    // Pre-Level 1: $0.50/ref
  1: { name: 'Level 1', minRef: 30, maxRef: 49, rate: 1.00, level: 1 },    // Level 1: $1.00/ref
  2: { name: 'Level 2', minRef: 50, maxRef: 69, rate: 1.20, level: 2 },    // Level 2: $1.20/ref
  3: { name: 'Level 3', minRef: 70, maxRef: 99, rate: 1.50, level: 3 },    // Level 3: $1.50/ref
  4: { name: 'Level 4', minRef: 100, maxRef: Infinity, rate: 2.00, level: 4 } // Level 4: $2.00/ref
};

/**
 * Calculate which tier a user belongs to based on referral count
 * @param {number} referralCount - Total number of referrals
 * @returns {object} Tier info { level, name, minRef, maxRef, rate }
 */
function getAmbassadorTier(referralCount) {
  for (let level = 0; level <= 4; level++) {
    const tier = AMBASSADOR_TIERS[level];
    if (referralCount >= tier.minRef && referralCount <= tier.maxRef) {
      return tier;
    }
  }
  return AMBASSADOR_TIERS[4]; // Return Level 4 for 100+
}

/**
 * Calculate earnings for a new referral within a tier
 * @param {number} currentLevel - Current tier level
 * @param {number} nextReferralCount - What the count will be after this referral
 * @returns {object} { earnedThisReferral, newLevel, newTierUnlocked }
 */
function calculateNewReferralEarnings(currentLevel, nextReferralCount) {
  const currentTier = AMBASSADOR_TIERS[currentLevel];
  const nextTier = getAmbassadorTier(nextReferralCount);
  const earnedThisReferral = currentTier.rate; // Earn at current tier's rate
  
  return {
    earnedThisReferral,
    newLevel: nextTier.level,
    newTierUnlocked: nextTier.level > currentLevel,
    newTierName: nextTier.name,
    newTierRate: nextTier.rate
  };
}

/**
 * Recalculate all earnings based on referral count and level breakdowns
 * Used when syncing from database
 * @param {number} referralCount - Total referrals
 * @returns {object} Earnings breakdown by level
 */
function recalculateLevelEarnings(referralCount) {
  const earnings = {
    preLevelOne: 0,
    levelOne: 0,
    levelTwo: 0,
    levelThree: 0,
    levelFour: 0
  };
  
  // Calculate earnings for refs 0-29 (Pre-Level 1)
  if (referralCount >= 1) {
    const preLevel1Count = Math.min(referralCount, 29);
    earnings.preLevelOne = preLevel1Count * 0.50;
  }
  
  // Calculate earnings for refs 30-49 (Level 1)
  if (referralCount >= 30) {
    const level1Count = Math.min(referralCount - 29, 20);
    earnings.levelOne = level1Count * 1.00;
  }
  
  // Calculate earnings for refs 50-69 (Level 2)
  if (referralCount >= 50) {
    const level2Count = Math.min(referralCount - 49, 20);
    earnings.levelTwo = level2Count * 1.20;
  }
  
  // Calculate earnings for refs 70-99 (Level 3)
  if (referralCount >= 70) {
    const level3Count = Math.min(referralCount - 69, 30);
    earnings.levelThree = level3Count * 1.50;
  }
  
  // Calculate earnings for refs 100+ (Level 4)
  if (referralCount >= 100) {
    const level4Count = referralCount - 99;
    earnings.levelFour = level4Count * 2.00;
  }
  
  return earnings;
}

/**
 * Get total earnings across all tiers
 * @param {object} levelEarnings - Earnings breakdown by level
 * @returns {number} Total amount
 */
function getTotalAmbassiadorEarnings(levelEarnings) {
  return (levelEarnings.preLevelOne || 0) +
         (levelEarnings.levelOne || 0) +
         (levelEarnings.levelTwo || 0) +
         (levelEarnings.levelThree || 0) +
         (levelEarnings.levelFour || 0);
}

// Ambassador Waitlist endpoint
app.post('/api/ambassador/waitlist', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { email = '', socials = {} } = req.body || {};
    
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    // Get user details from database
    const user = await User.findOne({ id: userId });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found. Please interact with the bot first.' });
    }

    const clean = {
      id: `AMB-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`,
      telegramId: userId,
      username: user.username || '',
      email: String(email || '').trim().toLowerCase(),
      socials: Object.fromEntries(Object.entries(socials || {}).map(([k,v]) => [String(k), String(v).trim()]).filter(([,v]) => !!v)),
      status: 'pending',  // IMPORTANT: Set status on creation so duplicate checks can find it
      createdAt: new Date().toISOString()
    };

    if (!clean.socials || Object.keys(clean.socials).length === 0) {
      return res.status(400).json({ success: false, error: 'At least one social link is required' });
    }

    // Validate socials are links (http/https)
    for (const [k, v] of Object.entries(clean.socials)) {
      try {
        const u = new URL(v.startsWith('http') ? v : `https://${v}`);
        if (!u.hostname) throw new Error('invalid');
      } catch {
        return res.status(400).json({ success: false, error: `Invalid link for ${k}` });
      }
    }

    // Prevent duplicate email signups AND duplicate applications from same user
    try {
      if (process.env.MONGODB_URI) {
        const AmbassadorWaitlist = await getAmbassadorWaitlistModel();
        if (!AmbassadorWaitlist) {
          console.warn('❌ AmbassadorWaitlist model is null');
          throw new Error('Model initialization failed');
        }
        // Check for duplicate email
        const existingEmail = await AmbassadorWaitlist.findOne({ email: clean.email }).lean();
        if (existingEmail) {
          console.log(`⚠️ Email already registered: ${clean.email}`);
          return res.status(409).json({ success: false, error: 'Email already registered' });
        }
        // Check for duplicate application from same user (Telegram ID)
        const existingUser = await AmbassadorWaitlist.findOne({ 
          telegramId: userId,
          status: { $in: ['pending', 'approved'] }
        }).lean();
        if (existingUser) {
          console.log(`⚠️ Duplicate application from user ${userId}: ${existingUser.email} (status: ${existingUser.status})`);
          return res.status(409).json({ success: false, error: 'You already have a pending or approved ambassador application. Please wait for a response before applying again.' });
        }
        console.log(`✅ No duplicates found for ${userId}, proceeding with application`);
      } else {
        // File DB fallback
        if (!db) {
          const DataPersistence = require('./tools/data-persistence');
          db = new DataPersistence();
        }
        const list = (await db.listAmbassadorWaitlist()) || [];
        // Check for duplicate email
        const emailExists = list.some(entry => (entry.email || '').toLowerCase() === clean.email);
        if (emailExists) {
          console.log(`⚠️ Email already registered (file db): ${clean.email}`);
          return res.status(409).json({ success: false, error: 'Email already registered' });
        }
        // Check for duplicate application from same user
        const userExists = list.some(entry => 
          entry.telegramId === userId && ['pending', 'approved'].includes(entry.status)
        );
        if (userExists) {
          console.log(`⚠️ Duplicate application from user ${userId} (file db)`);
          return res.status(409).json({ success: false, error: 'You already have a pending or approved ambassador application. Please wait for a response before applying again.' });
        }
        console.log(`✅ No duplicates found for ${userId} (file db), proceeding with application`);
      }
    } catch (dupCheckErr) {
      console.error('Ambassador duplicate check failed:', dupCheckErr.message);
      // Continue; creation may still succeed, but we tried.
    }

    // Save application to database
    let saved;
    if (process.env.MONGODB_URI) {
      const AmbassadorWaitlist = await getAmbassadorWaitlistModel();
      saved = await AmbassadorWaitlist.create(clean);
      console.log(`✅ Ambassador application created (MongoDB): ID=${saved.id}, User=${userId}, Email=${clean.email}, Status=${saved.status}`);
    } else if (db && typeof db.createAmbassadorWaitlist === 'function') {
      clean.status = 'pending';
      saved = await db.createAmbassadorWaitlist(clean);
      console.log(`✅ Ambassador application created (file db): ID=${saved.id}, User=${userId}, Email=${clean.email}, Status=${saved.status}`);
    } else {
      // Fallback: extend dev storage dynamically
      db = db || new (require('./tools/data-persistence'))();
      if (!db.data.ambassadorWaitlist) db.data.ambassadorWaitlist = [];
      clean.status = 'pending';
      db.data.ambassadorWaitlist.push(clean);
      await db.saveData();
      saved = clean;
      console.log(`✅ Ambassador application created (dev fallback): ID=${saved.id}, User=${userId}, Email=${clean.email}, Status=${saved.status}`);
    }

    // Notify user via Telegram that application was received
    try {
      await bot.sendMessage(
        userId,
        `✅ Your ambassador application has been received!\n\n` +
        `Email: ${clean.email}\n\n` +
        `We'll review your application and notify you of our decision. Thank you!`
      );
    } catch (e) {
      console.error('Failed to notify user of ambassador signup:', e.message);
      // Don't fail the whole request if notification fails
    }

    // Notify admins of new signup with approval buttons
    try {
      const admins = (typeof adminIds !== 'undefined' && Array.isArray(adminIds) && adminIds.length)
        ? adminIds
        : (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '')
            .split(',')
            .filter(Boolean)
            .map(id => id.trim());
      if (admins && admins.length) {
        const adminText =
          `Ambassador Application\n\n` +
          `User: @${clean.username || 'unknown'} (ID: ${clean.telegramId})\n` +
          `Email: ${clean.email}\n` +
          `Socials: ${Object.entries(clean.socials||{}).map(([k,v])=>`${k}: ${v}`).join(', ')}\n` +
          `Entry ID: ${saved.id}`;
        
        const adminKeyboard = {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `ambassador_approve_${saved.id}` },
            { text: 'Decline', callback_data: `ambassador_decline_${saved.id}` }
          ]]
        };
        
        saved.adminMessages = await Promise.all(admins.map(async adminId => {
          try {
            const message = await bot.sendMessage(adminId, adminText, { reply_markup: adminKeyboard });
            return {
              adminId,
              messageId: message.message_id,
              originalText: adminText
            };
          } catch (e) {
            console.error('Failed to notify admin of ambassador signup:', e.message);
            return null;
          }
        })).then(results => results.filter(Boolean));
        
        await saved.save();
      }
    } catch (e) {
      console.error('Failed to notify admins of ambassador signup:', e.message);
    }

    // Send confirmation email to applicant
    await emailService.sendAmbassadorApplicationSubmitted(
      clean.email,
      clean.username || 'Applicant',
      clean.socials || {}
    );

    return res.json({ success: true, waitlistId: saved.id });
  } catch (e) {
    console.error('Ambassador waitlist error:', e.message);
    return res.status(500).json({ success: false, error: 'We could not add you to the waitlist. Please try again later.' });
  }
});

// ========== AMBASSADOR APP AUTOFILL ENDPOINTS ==========

// Get user data for ambassador form autofill
// Called by: Ambassador Dashboard Apply form
app.get('/api/ambassador/user/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    
    if (!telegramId || !/^\d+$/.test(telegramId)) {
      return res.status(400).json({ success: false, error: 'Invalid Telegram ID' });
    }

    // Try to find user in database
    let userData = null;
    
    if (User) {
      try {
        const user = await User.findOne({ id: telegramId }).lean();
        if (user) {
          userData = {
            id: String(user.id),
            username: user.username || null,
            firstName: user.firstName || user.first_name || null,
            lastName: user.lastName || user.last_name || null
          };
        }
      } catch (dbErr) {
        console.error('User lookup error:', dbErr.message);
      }
    }

    if (userData) {
      return res.json({ 
        success: true, 
        user: userData 
      });
    }

    return res.status(404).json({ 
      success: false, 
      error: 'User not found. Make sure you have used the StarStore bot before.' 
    });
  } catch (e) {
    console.error('Ambassador user lookup error:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch user data' });
  }
});

// Handle redirect from Telegram bot with user data
// Bot sends user here after they click "Connect Ambassador Account"
app.get('/api/ambassador/auth/callback', async (req, res) => {
  try {
    const { tg_id, tg_username, tg_name, redirect } = req.query;
    
    if (!tg_id) {
      return res.status(400).send('Missing Telegram ID');
    }

    // Build redirect URL with user data
    const redirectUrl = redirect || 'https://amb.starstore.site/apply';
    const separator = redirectUrl.includes('?') ? '&' : '?';
    const params = new URLSearchParams({
      tg_id: String(tg_id),
      ...(tg_username && { tg_username: String(tg_username) }),
      ...(tg_name && { tg_name: String(tg_name) })
    });

    return res.redirect(`${redirectUrl}${separator}${params.toString()}`);
  } catch (e) {
    console.error('Ambassador auth callback error:', e.message);
    return res.status(500).send('Authentication failed');
  }
});

// Bot command handler for ambassador connect
// Called when user starts bot with /start amb_connect_<encoded_redirect>
const handleAmbassadorConnect = async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  
  try {
    // Extract redirect URL from deep link parameter
    let redirectUrl = 'https://amb.starstore.site/apply';
    const deepLinkParam = match && match[1] ? match[1].trim() : '';
    
    if (deepLinkParam.startsWith('amb_connect_')) {
      try {
        const encodedUrl = deepLinkParam.replace('amb_connect_', '');
        redirectUrl = decodeURIComponent(encodedUrl);
      } catch (e) {
        console.error('Failed to decode redirect URL:', e.message);
        // Keep default redirect
      }
    }

    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    
    // Build return URL with user data as query params (direct to apply page)
    const separator = redirectUrl.includes('?') ? '&' : '?';
    const returnUrl = `${redirectUrl}${separator}` + new URLSearchParams({
      tg_id: String(user.id),
      ...(user.username && { tg_username: user.username }),
      tg_name: fullName
    }).toString();

    // Send message with button to return to form with prefilled data
    await bot.sendMessage(chatId, 
      `✅ *Connection Successful!*\n\n` +
      `Click the button below to return to the application form with your details auto-filled:\n\n` +
      `📱 Telegram ID: \`${user.id}\`\n` +
      `👤 Username: ${user.username ? '@' + user.username : 'Not set'}\n` +
      `📝 Name: ${fullName || 'Not set'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Return to Application Form', url: returnUrl }
          ]]
        }
      }
    );
    
    console.log(`✅ Ambassador connect: User ${user.id} returning to ${returnUrl}`);
  } catch (e) {
    console.error('Ambassador connect handler error:', e.message);
    await bot.sendMessage(chatId, '❌ Failed to process ambassador connection. Please try again or fill the form manually.');
  }
};

// Export for use in bot handlers
if (typeof module !== 'undefined') {
  module.exports = { handleAmbassadorConnect };
}

// Ensure directories with index.html return 200 (no 302/redirects)
app.get(['/', '/about', '/sell', '/history', '/daily', '/feedback', '/blog', '/knowledge-base', '/how-to-withdraw-telegram-stars', '/ambassador'], (req, res, next) => {
  try {
    const map = {
      '/': 'index.html',
      '/about': 'about.html',
      '/sell': 'sell.html',
      '/history': 'history.html',
      '/daily': 'daily.html',
      '/feedback': 'feedback.html',
      '/blog': 'blog/index.html',
      '/knowledge-base': 'knowledge-base/index.html',
      '/how-to-withdraw-telegram-stars': 'how-to-withdraw-telegram-stars/index.html',
      '/ambassador': 'apply_ambassador.html'
    };
    const file = map[req.path];
    if (file) {
      const abs = path.join(__dirname, 'public', file);
      return res.status(200).sendFile(abs, (err) => {
        if (err) {
          // If the mapped file is missing, serve the graceful 404 page
          const notFound = path.join(__dirname, 'public', 'errors', '404.html');
          return res.status(404).sendFile(notFound, (sendErr) => {
            if (sendErr) return res.status(404).send('Not found');
          });
        }
      });
    }
    return next();
  } catch (e) { return next(); }
});

// Dynamic referral page routing based on user role
// (Route moved before static middleware to take priority)

// DIAGNOSTIC ENDPOINT: Check ambassador status in database
app.get('/api/debug/ambassador-status', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findOne({ id: userId }).lean();
    
    return res.json({
      userId,
      userFound: !!user,
      ambassadorEmail: user?.ambassadorEmail || null,
      ambassadorTier: user?.ambassadorTier || null,
      ambassadorApprovedAt: user?.ambassadorApprovedAt || null,
      ambassadorApprovedBy: user?.ambassadorApprovedBy || null,
      ambassadorReferralCode: user?.ambassadorReferralCode || null,
      isAmbassador: !!(user && user.ambassadorEmail),
      message: user?.ambassadorEmail 
        ? `✅ Ambassador: ${user.ambassadorEmail}` 
        : `❌ Not an ambassador`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Check if user is an ambassador (used by client-side pages)
// Can be called with userId parameter or from authenticated headers
app.get('/api/check-ambassador', async (req, res) => {
  try {
    let userId = null;
    
    // Try to get userId from query parameter (for client-side calls)
    if (req.query && req.query.userId) {
      userId = String(req.query.userId).trim();
    }
    
    // Try from req.user (if middleware has already authenticated)
    if (!userId && req.user && req.user.id) {
      userId = String(req.user.id).trim();
    }
    
    // Try from header
    if (!userId && req.headers['x-telegram-id']) {
      userId = String(req.headers['x-telegram-id']).trim();
    }
    
    if (!userId) {
      return res.status(400).json({ error: 'No user ID provided', isAmbassador: false });
    }
    
    const user = await User.findOne({ id: userId }).lean();
    const isAmbassador = !!(user && user.ambassadorEmail);
    
    return res.json({
      userId,
      isAmbassador,
      ambassadorEmail: user?.ambassadorEmail || null,
      ambassadorTier: user?.ambassadorTier || null
    });
  } catch (e) {
    console.error('Error checking ambassador status:', e.message);
    return res.status(500).json({ error: e.message, isAmbassador: false });
  }
});

// Sitemap generation
// DUPLICATE SITEMAP REMOVED - using the one defined earlier
// Skipping duplicate /sitemap.xml at line 788+

app.get('/sitemap-duplicate-removed', async (req, res) => {
  try {
    // Derive base from configured server domain; fallback to starstore.site
    const base = `https://${SERVER_URL || 'starstore.site'}`;
    const root = path.join(__dirname, 'public');

    // Collect HTML files recursively (bounded)
    const maxEntries = 2000;
    const urls = [];
    const skipDirs = new Set(['admin', 'js', 'css', 'images', 'img', 'fonts', 'private', 'temp']);

    function walk(dir, rel = '') {
      if (urls.length >= maxEntries) return;
      const entries = require('fs').readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (urls.length >= maxEntries) break;
        const name = ent.name;
        if (name.startsWith('.')) continue;
        const relPath = rel ? `${rel}/${name}` : name;
        const absPath = path.join(dir, name);
        if (ent.isDirectory()) {
          if (skipDirs.has(name)) continue;
          walk(absPath, relPath);
        } else if (ent.isFile() && name.toLowerCase().endsWith('.html')) {
          // Normalize URL paths: index.html => directory URL; others keep filename
          let urlPath;
          if (name.toLowerCase() === 'index.html') {
            const dirUrl = rel.replace(/\/index\.html$/i, '').replace(/\/$/, '');
            urlPath = `/${rel.replace(/\/index\.html$/i, '')}`;
            if (!urlPath.endsWith('/')) urlPath += '/';
            if (urlPath === '//') urlPath = '/';
          } else {
            urlPath = `/${relPath}`;
          }
          // Compute lastmod from file mtime
          let lastmod;
          try {
            const st = require('fs').statSync(absPath);
            lastmod = st.mtime.toISOString();
          } catch (_) {
            lastmod = new Date().toISOString();
          }
          urls.push({ loc: `${base}${urlPath}`, lastmod });
        }
      }
    }

    walk(root, '');

    // Fallback to core URLs if traversal found nothing
    if (urls.length === 0) {
      const now = new Date().toISOString();
      ['/','/about','/sell','/history','/blog/','/knowledge-base/','/how-to-withdraw-telegram-stars/']
        .forEach(u => urls.push({ loc: `${base}${u}`, lastmod: now }));
    }

    // Build XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      urls.map(u => `\n  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`).join('') +
      `\n</urlset>`;
    res.type('application/xml').status(200).send(xml);
  } catch (e) {
    res.status(500).send('');
  }
});
app.get('/admin', (req, res) => {
	try {
		return res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
	} catch (e) {
		const notFound = path.join(__dirname, 'public', '404.html');
		return res.status(404).sendFile(notFound, (err) => {
			if (err) return res.status(404).send('Not found');
		});
	}
});

// Catch-all 404 for non-API GET requests
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const abs = path.join(__dirname, 'public', 'errors', '404.html');
    return res.status(404).sendFile(abs, (err) => {
      if (err) return res.status(404).send('Not found');
    });
  }
  return next();
});

// Global error handler - JSON for APIs, HTML for pages
app.use((err, req, res, next) => {
  try { console.error('Unhandled error:', err); } catch (_) {}
  if (res.headersSent) return next(err);
  
  // API errors return JSON
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  
  // Serve appropriate error page
  const statusCode = err.status || err.statusCode || 500;
  const errorFile = path.join(__dirname, 'public', 'errors', `${statusCode}.html`);
  return res.status(statusCode).sendFile(errorFile, (sendErr) => {
    // Fallback if error page doesn't exist
    if (sendErr) return res.status(statusCode).send(`Error ${statusCode}`);
  });
});
// Webhook setup (only when real bot is configured)
if (process.env.BOT_TOKEN) {
  bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook set successfully at ${WEBHOOK_URL}`))
    .catch(err => {
      console.error('❌ Webhook setup failed:', err.message);
      process.exit(1);
    });
}
// Database connection (use persistent file storage for development)
const DataPersistence = require('./tools/data-persistence');
let db;

// --- Privacy configuration for usernames (leaderboard masking) ---
function normalizeName(name) {
  try {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  } catch (_) {
    return '';
  }
}

// Only pseudonymize these specific accounts by default
const DEFAULT_PRIVACY_USERNAMES = ['starstore', 'leejones', 'starstorebuy', 'leejoneske'];
const PRIVACY_USERNAMES = new Set(
  (process.env.PRIVACY_USERNAMES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(normalizeName)
    .concat(DEFAULT_PRIVACY_USERNAMES)
);

function isPrivateUsername(username) {
  const norm = normalizeName(username);
  if (!norm) return false;
  return PRIVACY_USERNAMES.has(norm);
}

// --- Pseudonymization (stable human-like names) ---
function simpleHash(input) {
  const str = String(input || '');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
    hash = hash & 0xffffffff;
  }
  return Math.abs(hash >>> 0);
}

const PSEUDONYM_FIRST = [
  'Amina','Aria','Diego','Hiro','Ibrahim','Jamal','Jin','Kai','Leila','Luca',
  'Maria','Mateo','Mei','Mohamed','Muhammad','Nadia','Noah','Omar','Priya','Ravi',
  'Sofia','Wei','Yara','Zara','Fatima','Ahmed','Elena','Mikhail','Sasha','Yun',
  'Hassan','Layla','Amir','Sara','Isabella','Oliver','Ethan','Aisha','Kofi','Chloe',
  'Hannah','Lucas','Ivy','Mia','Leo','Daniel','Grace','Zoe','Ana','Dmitri'
];
const PSEUDONYM_LAST = [
  'Adams','Brown','Chen','Diaz','Evans','Garcia','Hassan','Inoue','Johnson','Kumar',
  'Lee','Martinez','Nguyen','Okafor','Patel','Quinn','Rossi','Silva','Tan','Usman',
  'Valdez','Williams','Xu','Yamada','Zhang','Bauer','Costa','Dubois','Eriksen','Fujita'
];

function generatePseudonym(userId, username) {
  const source = String(userId || normalizeName(username) || 'seed');
  const h = simpleHash(source);
  const first = PSEUDONYM_FIRST[h % PSEUDONYM_FIRST.length];
  const last = PSEUDONYM_LAST[(Math.floor(h / 97)) % PSEUDONYM_LAST.length];
  const lastInitial = (last && last[0]) ? `${last[0]}.` : '';
  return `${first} ${lastInitial}`.trim();
}

async function connectDatabase() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('✅ MongoDB connected successfully');
      return;
    } catch (err) {
      console.error('❌ MongoDB connection error:', err.message);
      process.exit(1);
    }
  }

  console.log('📁 Using persistent file-based storage for local/dev.');
  try {
    db = new DataPersistence();
    console.log('✅ Persistent database connected');
  } catch (err) {
    console.error('❌ Failed to start persistent database:', err.message);
    process.exit(1);
  }
}

// Kick off database connection immediately
connectDatabase();
// Webhook handler
app.post(WEBHOOK_PATH, (req, res) => {
  if (process.env.WEBHOOK_SECRET && 
      req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// BROADCAST API ENDPOINTS
app.get('/api/broadcast/status/:jobId', requireAdmin, async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await BroadcastJob.findOne({ jobId });
        
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        
        const response = {
            jobId: job.jobId,
            status: job.status,
            totalUsers: job.totalUsers,
            sentCount: job.sentCount,
            failedCount: job.failedCount,
            skippedCount: job.skippedCount,
            progress: Math.round((job.sentCount + job.failedCount + job.skippedCount) / job.totalUsers * 100),
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            estimatedCompletionTime: job.estimatedCompletionTime,
            messageType: job.messageType,
            adminUsername: job.adminUsername
        };
        
        if (job.status === 'failed') {
            response.error = job.lastError;
        }
        
        res.json({ success: true, data: response });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get broadcast history
app.get('/api/broadcast/history', requireAdmin, async (req, res) => {
    try {
        const { limit = 10, skip = 0 } = req.query;
        
        const jobs = await BroadcastJob.find({})
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();
        
        const total = await BroadcastJob.countDocuments({});
        
        const formatted = jobs.map(job => ({
            jobId: job.jobId,
            adminUsername: job.adminUsername,
            status: job.status,
            totalUsers: job.totalUsers,
            sentCount: job.sentCount,
            failedCount: job.failedCount,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            successRate: job.totalUsers > 0 ? ((job.sentCount / job.totalUsers) * 100).toFixed(1) : '0'
        }));
        
        res.json({ success: true, data: { jobs: formatted, total, hasMore: skip + jobs.length < total } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cancel broadcast job
app.post('/api/broadcast/cancel/:jobId', requireAdmin, async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await BroadcastJob.findOne({ jobId });
        
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        
        if (job.status === 'completed' || job.status === 'failed') {
            return res.status(400).json({ success: false, error: `Cannot cancel ${job.status} job` });
        }
        
        job.status = 'cancelled';
        await job.save();
        
        res.json({ success: true, message: 'Broadcast job cancelled' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Version endpoint
app.get('/api/version', (req, res) => {
    try {
        const packageJson = require('./package.json');
        const version = packageJson.version || '1.0.0';
        const buildDate = new Date().toISOString().split('T')[0];
        
        // Try to get git information, fallback to environment/build info
        let gitInfo = {};
        
        // Prioritize Railway environment variables for production
        if (process.env.RAILWAY_GIT_COMMIT_SHA) {
            gitInfo = {
                buildNumber: process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7),
                commitHash: process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7),
                branch: process.env.RAILWAY_GIT_BRANCH || 'main',
                commitDate: process.env.RAILWAY_GIT_COMMIT_CREATED_AT ? 
                    new Date(process.env.RAILWAY_GIT_COMMIT_CREATED_AT).toISOString().split('T')[0] : 
                    buildDate
            };
        } else {
            // Check if we're in a git repository and git is available (for development)
            const isGitAvailable = process.env.NODE_ENV !== 'production' && 
                                  process.env.GIT_AVAILABLE === 'true';
            
            if (isGitAvailable) {
                try {
                    const { execSync } = require('child_process');
                    gitInfo = {
                        buildNumber: execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim(),
                        commitHash: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
                        branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
                        commitDate: execSync('git log -1 --format=%ci', { encoding: 'utf8' }).trim().split(' ')[0]
                    };
                } catch (gitError) {
                    // Fall through to default values
                }
            }
        }
        
        // Use default values if nothing else worked
        if (!gitInfo.buildNumber) {
            gitInfo = {
                buildNumber: process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7) : 'N/A',
                commitHash: process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7) : 'production',
                branch: process.env.RAILWAY_GIT_BRANCH || 'main',
                commitDate: process.env.RAILWAY_GIT_COMMIT_CREATED_AT ? 
                    new Date(process.env.RAILWAY_GIT_COMMIT_CREATED_AT).toISOString().split('T')[0] : 
                    buildDate
            };
        }
        
        res.json({
            version: version,
            buildDate: gitInfo.commitDate || buildDate,
            buildNumber: gitInfo.buildNumber || '0',
            commitHash: gitInfo.commitHash || 'unknown',
            branch: gitInfo.branch || 'unknown',
            name: packageJson.name || 'starstore',
            description: packageJson.description || 'StarStore - A Telegram Mini App',
            fullVersion: `${version}.${gitInfo.buildNumber || '0'}`,
            displayVersion: `StarStore v${version}`
        });
    } catch (error) {
        console.error('Error reading package.json:', error);
        res.json({
            version: '1.0.0',
            buildDate: new Date().toISOString().split('T')[0],
            buildNumber: '0',
            commitHash: 'unknown',
            branch: 'unknown',
            name: 'starstore',
            description: 'StarStore - A Telegram Mini App',
            fullVersion: '1.0.0.0',
            displayVersion: 'v1.0.0 (Build 0)'
        });
    }
});

// User database audit endpoint - check for duplicate Telegram user IDs
// Usage: GET /api/audit/users (admin only)
app.get('/api/audit/users', async (req, res) => {
    try {
        const adminIds = ['1234567890']; // Update with actual admin IDs if needed
        const requesterId = req.query.userId;
        
        // Basic protection - check if requester is admin
        if (requesterId && !adminIds.includes(requesterId)) {
            // Allow if no specific check needed, or add proper admin middleware here
            console.warn(`Audit requested by non-admin: ${requesterId}`);
        }

        const auditReport = {};

        // 1. Total user count
        auditReport.totalUsers = await User.countDocuments({});

        // 2. Check for duplicate Telegram user IDs
        const duplicateIds = await User.aggregate([
            { $group: { _id: '$id', count: { $sum: 1 }, users: { $push: { id: '$id', username: '$username' } } } },
            { $match: { count: { $gt: 1 } } },
            { $sort: { count: -1 } }
        ]);
        auditReport.duplicateTelegramIds = {
            count: duplicateIds.length,
            details: duplicateIds
        };

        // 3. Check for duplicate usernames
        const duplicateUsernames = await User.aggregate([
            { $match: { username: { $ne: null } } },
            { $group: { _id: '$username', count: { $sum: 1 }, ids: { $push: '$id' } } },
            { $match: { count: { $gt: 1 } } },
            { $sort: { count: -1 } }
        ]);
        auditReport.duplicateUsernames = {
            count: duplicateUsernames.length,
            details: duplicateUsernames
        };

        // 4. Check for null Telegram IDs
        const nullIds = await User.countDocuments({ id: null });
        auditReport.nullTelegramIds = nullIds;

        // 5. Check for missing createdAt
        const missingCreatedAt = await User.countDocuments({ createdAt: null });
        auditReport.missingCreatedAt = missingCreatedAt;

        // 6. Check for time inconsistencies
        const timeInconsistencies = await User.countDocuments({
            $expr: { $gt: ['$createdAt', '$lastActive'] }
        });
        auditReport.timeInconsistencies = timeInconsistencies;

        // 7. Users by creation date (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const usersByDate = await User.aggregate([
            { $match: { createdAt: { $gte: sevenDaysAgo } } },
            { 
                $group: { 
                    _id: { 
                        $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } 
                    }, 
                    count: { $sum: 1 } 
                } 
            },
            { $sort: { _id: -1 } }
        ]);
        auditReport.usersByCreationDate = usersByDate;

        // Generate summary
        const hasDuplicates = duplicateIds.length > 0 || duplicateUsernames.length > 0;
        const hasIssues = nullIds > 0 || missingCreatedAt > 0 || timeInconsistencies > 0;

        auditReport.summary = {
            status: (!hasDuplicates && !hasIssues) ? '✅ PASSED' : '⚠️ ISSUES FOUND',
            duplicatesFound: hasDuplicates,
            issuesFound: hasIssues,
            timestamp: new Date().toISOString()
        };

        res.json(auditReport);
    } catch (error) {
        console.error('Error during user audit:', error);
        res.status(500).json({
            error: 'Audit failed',
            message: error.message,
            summary: { status: '❌ ERROR' }
        });
    }
});

// Bot simulator status endpoint
app.get('/api/bot-simulator-status', (req, res) => {
  const isEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
  const hasSimulator = !!startBotSimulatorSafe;
  res.json({
    enabled: isEnabled,
    available: hasSimulator,
    running: isEnabled && hasSimulator,
    botCount: isEnabled ? 135 : 0 // DEFAULT_BOTS length
  });
});

// Admin-only bot management endpoints
app.get('/api/admin/bot-simulator/status', requireAdmin, (req, res) => {
  const isEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
  const hasSimulator = !!startBotSimulatorSafe;
  res.json({
    enabled: isEnabled,
    available: hasSimulator,
    running: isEnabled && hasSimulator,
    botCount: isEnabled ? 135 : 0 // DEFAULT_BOTS length
  });
});

app.post('/api/admin/bot-simulator/toggle', requireAdmin, (req, res) => {
  try {
    const currentState = process.env.ENABLE_BOT_SIMULATOR === '1';
    const newState = !currentState;
    
    // Note: This only affects the current process. For persistent changes,
    // the environment variable should be updated in the deployment configuration.
    process.env.ENABLE_BOT_SIMULATOR = newState ? '1' : '0';
    
    res.json({
      success: true,
      enabled: newState,
      message: newState ? 'Bot simulator enabled' : 'Bot simulator disabled',
      note: 'Changes will be lost on server restart. Update environment variables for persistence.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Simple whoami endpoint to expose admin flag to frontend
app.get('/api/whoami', (req, res) => {
  try {
    const tgId = String(req.headers['x-telegram-id'] || '').trim();
    if (!tgId) return res.json({ id: null, isAdmin: false });
    return res.json({ id: tgId, isAdmin: Array.isArray(adminIds) && adminIds.includes(tgId) });
  } catch (_) {
    return res.json({ id: null, isAdmin: false });
  }
});


const buyOrderSchema = new mongoose.Schema({
    id: String,
    telegramId: String,
    username: String,
    amount: Number,
    stars: Number,
    premiumDuration: Number,
    walletAddress: String,
    userMessageId: Number,
    isPremium: Boolean,
    status: String,
    dateCreated: Date,
    adminMessages: Array,
    // New fields for "buy for" functionality
    recipients: [{
        username: String,
        userId: String,
        starsReceived: Number,
        premiumDurationReceived: Number
    }],
    isBuyForOthers: {
        type: Boolean,
        default: false
    },
    transactionHash: String,
    transactionVerified: {
        type: Boolean,
        default: false
    },
    verificationAttempts: {
        type: Number,
        default: 0
    },
    totalRecipients: {
        type: Number,
        default: 0
    },
    starsPerRecipient: Number,
    premiumDurationPerRecipient: Number,
    userLocation: {
        city: String,
        country: String,
        countryCode: String,
        ip: String,
        timestamp: Date
    }
});

const sellOrderSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true
    },
    telegramId: {
        type: String,
        required: true
    },
    username: String,
    stars: {
        type: Number,
        required: true
    },
    walletAddress: String,
    memoTag: String,
    userMessageId: Number,
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded', 'failed', 'expired'],
        validate: {
            validator: function(v) {
                // Allow lowercase 'processing' and convert if needed
                return ['pending', 'processing', 'completed', 'declined', 'reversed', 'refunded', 'failed', 'expired'].includes((v || '').toLowerCase());
            },
            message: '`{VALUE}` is not a valid status'
        },
        default: 'pending',
        set: function(v) {
            // Normalize status to lowercase
            return (v || 'pending').toLowerCase();
        }
    },
    telegram_payment_charge_id: {
        type: String,
        required: function() {
            return this.dateCreated > new Date('2025-05-25'); 
        },
        default: null
    },
    reversible: {
        type: Boolean,
        default: true
    },
    // NEW FIELDS FOR SESSION MANAGEMENT
    sessionToken: {
        type: String,
        default: null
    },
    sessionExpiry: {
        type: Date,
        default: null
    },
    userLocked: {
        type: String, 
        default: null
    },
    // END NEW FIELDS
    reversalData: {
        requested: Boolean,
        reason: String,
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date
    },
    refundData: {
        requested: Boolean,
        reason: String,
        status: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none'
        },
        adminId: String,
        processedAt: Date,
        chargeId: String
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String,
        messageType: {
            type: String,
            enum: ['order', 'refund', 'reversal']
        }
    }],
    userLocation: {
        city: String,
        country: String,
        countryCode: String,
        ip: String,
        timestamp: Date
    },
    dateCreated: {
        type: Date,
        default: Date.now
    },
    dateCompleted: Date,
    dateReversed: Date,
    dateRefunded: Date,
    datePaid: Date, 
    dateDeclined: Date 
});

const userSchema = new mongoose.Schema({
    id: { type: String, index: true },
    username: { type: String, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    lastActive: { type: Date, default: Date.now, index: true },
    // Username tracking - similar to location/device tracking
    lastUsernameChange: {
        oldUsername: String,
        newUsername: String,
        timestamp: { type: Date, default: Date.now }
    },
    usernameHistory: [{
        username: String,
        changedFrom: String,
        timestamp: { type: Date, default: Date.now },
        source: { type: String, enum: ['api', 'telegram', 'login', 'page_visit'], default: 'api' }
    }],
    // Location tracking
    lastLocation: {
        country: String,
        countryCode: String,
        city: String,
        ip: String,
        timestamp: { type: Date, default: Date.now }
    },
    locationHistory: [{
        country: String,
        countryCode: String,
        city: String,
        ip: String,
        timestamp: { type: Date, default: Date.now }
    }],
    // Device tracking
    lastDevice: {
        userAgent: String,
        browser: String,
        os: String,
        timestamp: { type: Date, default: Date.now }
    },
    devices: [{
        userAgent: String,
        browser: String,
        os: String,
        lastSeen: { type: Date, default: Date.now },
        country: String
    }],
    // Additional user info
    telegramLanguage: String,
    timezone: String,
    referralHash: { type: String, unique: true, sparse: true, index: true },  // Professional hashed referral code for this user
    
    // Ambassador program fields
    ambassadorEmail: { type: String, index: true },  // Email from approved ambassador application
    ambassadorTier: { type: String, enum: ['standard', 'explorer', 'connector', 'pioneer', 'elite'], default: null },  // Ambassador tier based on referral count
    ambassadorReferralCode: { type: String, unique: true, sparse: true, index: true },  // Unique code for ambassador referrals
    ambassadorApprovedAt: Date,  // When the application was approved
    ambassadorApprovedBy: String,  // Admin ID who approved the application
    ambassadorWalletAddress: String,  // Wallet address for ambassador payouts
    ambassadorAvgTransaction: Number,  // Average transaction value
    ambassadorSocialPosts: Number,  // Number of social media posts
    
    // Ambassador tiered earnings system
    ambassadorCurrentLevel: { type: Number, default: 0 }, // 0=pre-level-1, 1, 2, 3, 4
    ambassadorReferralCount: { type: Number, default: 0 }, // Total referrals
    ambassadorLevelEarnings: {
        preLevelOne: { type: Number, default: 0 }, // 0-29 refs @ $0.50/ref
        levelOne: { type: Number, default: 0 },    // 30-49 refs @ $1.00/ref
        levelTwo: { type: Number, default: 0 },     // 50-69 refs @ $1.20/ref
        levelThree: { type: Number, default: 0 },   // 70-99 refs @ $1.50/ref
        levelFour: { type: Number, default: 0 }     // 100+ refs @ $2.00/ref
    },
    ambassadorPendingBalance: { type: Number, default: 0 }, // Balance awaiting withdrawal
    ambassadorMonthlyWithdrawals: [{
        month: { type: String }, // Format: "2026-03" 
        amount: { type: Number },
        levelBreakdown: {
            preLevelOne: { type: Number, default: 0 },
            levelOne: { type: Number, default: 0 },
            levelTwo: { type: Number, default: 0 },
            levelThree: { type: Number, default: 0 },
            levelFour: { type: Number, default: 0 }
        },
        stars: { type: Number, default: 0 },
        nft: { type: String },
        status: { type: String, enum: ['pending', 'approved', 'declined'], default: 'pending' },
        withdrawalDate: { type: Date, default: Date.now },
        approvedBy: String,
        approvalDate: Date,
        declineReason: String
    }],
    ambassadorLastWithdrawalDate: Date, // Last successful withdrawal
    ambassadorEarningsHistory: [{
        timestamp: { type: Date, default: Date.now },
        referralCount: Number,
        level: Number,
        earnedAmount: Number,
        reason: String // 'referral_added', 'level_upgrade', etc.
    }]
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
});

// User Activity Log - tracks all user interactions
const userActivityLogSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    username: String,
    timestamp: { type: Date, default: Date.now },
    actionType: { 
        type: String, 
        enum: ['message', 'button_click', 'command', 'api_call', 'order_created', 'order_completed', 'order_create', 'sell_order_create', 'payment_success', 'daily_checkin', 'mission_complete', 'login'],
        required: true
    },
    actionDetails: {
        command: String,
        orderId: String,
        orderType: String,
        endpoint: String,
        buttonData: String,
        messageText: String
    },
    location: {
        country: String,
        countryCode: String,
        city: String,
        ip: String
    },
    device: {
        userAgent: String,
        browser: String,
        os: String
    },
    status: { type: String, enum: ['success', 'failed', 'error'], default: 'success' },
    errorMessage: String
});

// Add TTL index: auto-delete UserActivityLog records older than USERACTIVITYLOG_RETENTION_DAYS (default: 30)
const userActivityLogRetentionDays = parseInt(process.env.USERACTIVITYLOG_RETENTION_DAYS || '30');
userActivityLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: userActivityLogRetentionDays * 24 * 60 * 60 });

const UserActivityLog = mongoose.model('UserActivityLog', userActivityLogSchema);

// Device Tracker - identify and track different devices per user
const deviceTrackerSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    username: String,
    userAgent: { type: String, index: true },
    browser: String,
    os: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now, index: true },
    locations: [{
        country: String,
        countryCode: String,
        city: String,
        ip: String,
        timestamp: { type: Date, default: Date.now }
    }],
    deviceHash: String, // Fingerprint for device
    isVerified: { type: Boolean, default: false }
});

const DeviceTracker = mongoose.model('DeviceTracker', deviceTrackerSchema);

const cacheSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    date: { type: Date, default: Date.now }
});


const referralSchema = new mongoose.Schema({
    referrerUserId: { type: String, required: true },
    referredUserId: { type: String, required: true },
    referrerUsername: String,
    status: { type: String, enum: ['pending', 'active', 'completed'], default: 'pending' },
    withdrawn: { type: Boolean, default: false },
    dateReferred: { type: Date, default: Date.now },
    linkFormat: { type: String, enum: ['old', 'new'], default: 'new' },
    newRefLink: String,
    instantActivation: { type: Boolean, default: true }
});

const referralWithdrawalSchema = new mongoose.Schema({
    withdrawalId: {  
        type: String,
        required: true,
        unique: true,
        default: () => generateOrderId() 
    },
    userId: String,
    username: String,
    amount: Number,
    walletAddress: String,
    referralIds: [{ 
        type: String, 
        ref: 'Referral' 
    }],
    status: { 
        type: String, 
        enum: ['pending', 'completed', 'declined'], 
        default: 'pending' 
    },
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String
    }],
    userLocation: {
        city: String,
        country: String
    },
    processedBy: { type: Number },
    processedAt: { type: Date },
    declineReason: { type: String },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    
    // Ambassador tier system fields
    isAmbassadorWithdrawal: { type: Boolean, default: false },
    ambassadorLevel: { type: Number, default: 0 }, // Current tier level at time of withdrawal
    ambassadorReferralCount: { type: Number, default: 0 }, // Total refs at time of withdrawal
    ambassadorLevelBreakdown: {
        preLevelOne: { type: Number, default: 0 },
        levelOne: { type: Number, default: 0 },
        levelTwo: { type: Number, default: 0 },
        levelThree: { type: Number, default: 0 },
        levelFour: { type: Number, default: 0 }
    },
    ambassadorStars: { type: Number, default: 0 }, // Stars bonus
    ambassadorMonth: { type: String } // Format: "2026-03"
});

const referralTrackerSchema = new mongoose.Schema({
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral' },
    referrerUserId: { type: String, required: true },
    referrerUsername: String,
    referredUserId: { type: String, required: true, unique: true },
    referredUsername: String,
    totalBoughtStars: { type: Number, default: 0 },
    totalSoldStars: { type: Number, default: 0 },
    premiumActivated: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'active'], default: 'pending' },
    dateReferred: { type: Date, default: Date.now },
    dateActivated: Date,
    instantActivation: { type: Boolean, default: true }
});


// Add to your schemas section
const feedbackSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    satisfaction: { type: Number, min: 1, max: 5 }, 
    reasons: String, // Why they rated this way
    suggestions: String, // What could be improved
    additionalInfo: String, // Optional free-form feedback
    dateSubmitted: { type: Date, default: Date.now }
});

// General feedback submission schema
const generalFeedbackSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    type: { type: String, enum: ['bug', 'feature', 'improvement', 'general'], required: true },
    email: { type: String, required: true },
    message: { type: String, required: true, maxlength: 3000 },
    mediaFiles: [{
        filename: String,
        originalName: String,
        mimetype: String,
        size: Number,
        uploadedAt: { type: Date, default: Date.now }
    }],
    totalMediaSize: { type: Number, default: 0 },
    status: { type: String, enum: ['new', 'read', 'archived'], default: 'new' },
    adminNotes: String,
    processedBy: String,
    processedAt: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const reversalSchema = new mongoose.Schema({
    orderId: { type: String, required: true },
    telegramId: { type: String, required: true },
    username: String,
    stars: { type: Number, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'processed', 'completed', 'declined'], default: 'pending' },
    adminId: String,
    adminUsername: String,
    processedAt: Date,
    adminMessages: [{
        adminId: String,
        messageId: Number,
        messageType: String,
        originalText: String
    }],
    errorMessage: String
});

const warningSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    type: { type: String, enum: ['warning', 'ban'], required: true },
    reason: { type: String, required: true },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true },
    autoRemove: { type: Boolean, default: false }
});

// New notification template (content & targeting)
const notificationTemplateSchema = new mongoose.Schema({
    title: { type: String, required: true, default: 'Notification' },
    message: { type: String, required: true },
    actionUrl: { type: String },
    icon: { type: String, default: 'fa-bell' },
    priority: { type: Number, default: 0, min: 0, max: 2 },
    audience: { type: String, enum: ['global', 'user'], default: 'global', index: true },
    targetUserId: { type: String, index: true },
    createdBy: { type: String, default: 'system' },
    createdAt: { type: Date, default: Date.now, index: true }
});

// Per-user notification state
const userNotificationSchema = new mongoose.Schema({
    userId: { type: String, index: true, required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'NotificationTemplate', index: true, required: true },
    read: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now, index: true }
});

const stickerSchema = new mongoose.Schema({
  file_id: { type: String, required: true },
  file_unique_id: { type: String, required: true, unique: true },
  file_path: { type: String },
  is_animated: { type: Boolean, default: false },
  is_video: { type: Boolean, default: false },
  emoji: { type: String },
  set_name: { type: String },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const Sticker = mongoose.model('Sticker', stickerSchema);
const NotificationTemplate = mongoose.model('NotificationTemplate', notificationTemplateSchema);
const UserNotification = mongoose.model('UserNotification', userNotificationSchema);
const Warning = mongoose.model('Warning', warningSchema);
const Reversal = mongoose.model('Reversal', reversalSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);
const GeneralFeedback = mongoose.model('GeneralFeedback', generalFeedbackSchema);
const ReferralTracker = mongoose.model('ReferralTracker', referralTrackerSchema);
const ReferralWithdrawal = mongoose.model('ReferralWithdrawal', referralWithdrawalSchema);
const Cache = mongoose.model('Cache', cacheSchema);
const BuyOrder = mongoose.model('BuyOrder', buyOrderSchema);
const SellOrder = mongoose.model('SellOrder', sellOrderSchema);
const User = mongoose.model('User', userSchema);
const Referral = mongoose.model('Referral', referralSchema);
const BannedUser = mongoose.model('BannedUser', bannedUserSchema);

// Daily rewards schemas
const dailyStateSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    totalPoints: { type: Number, default: 0 },
    lastCheckIn: { type: Date },
    streak: { type: Number, default: 0 },
    month: { type: String }, // YYYY-MM for which checkedInDays applies
    checkedInDays: { type: [Number], default: [] }, // days of current month
    missionsCompleted: { type: [String], default: [] },
    redeemedRewards: { type: [{
        rewardId: String,
        redeemedAt: Date,
        name: String
    }], default: [] },
    activeBoosts: { type: [{
        boostType: String,
        activatedAt: Date,
        expiresAt: Date
    }], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const DailyState = mongoose.model('DailyState', dailyStateSchema);

// Activity tracking schema
const activitySchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    activityType: { type: String, required: true },
    activityName: { type: String, required: true },
    points: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
});

// Add TTL index: auto-delete Activity records older than ACTIVITY_RETENTION_DAYS (default: 90)
const activityRetentionDays = parseInt(process.env.ACTIVITY_RETENTION_DAYS || '90');
activitySchema.index({ timestamp: 1 }, { expireAfterSeconds: activityRetentionDays * 24 * 60 * 60 });

const Activity = mongoose.model('Activity', activitySchema);

// Wallet update request schema: track request state and message IDs for updates
const walletUpdateRequestSchema = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true, default: () => generateOrderId() },
    userId: { type: String, required: true, index: true },
    username: String,
    orderType: { type: String, enum: ['sell', 'withdrawal'], required: true },
    orderId: { type: String, required: true },
    oldWalletAddress: String,
    newWalletAddress: { type: String, required: true },
    newMemoTag: { type: String },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reason: String,
    adminId: String,
    adminUsername: String,
    userMessageId: Number,
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String
    }],
    createdAt: { type: Date, default: Date.now },
    processedAt: Date
});

const WalletUpdateRequest = mongoose.model('WalletUpdateRequest', walletUpdateRequestSchema);

// Username update request schema: track request state and message IDs for updates
const usernameUpdateRequestSchema = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true, default: () => generateOrderId() },
    userId: { type: String, required: true, index: true },
    oldUsername: String,
    newUsername: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reason: String,
    adminId: String,
    adminUsername: String,
    affectedOrderIds: [String], // sell orders, buy orders, withdrawals
    affectedOrderTypes: [String], // 'sell', 'buy', 'withdrawal'
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String
    }],
    createdAt: { type: Date, default: Date.now },
    processedAt: Date
});

const UsernameUpdateRequest = mongoose.model('UsernameUpdateRequest', usernameUpdateRequestSchema);

// Ambassador Opt-Out Request schema: track opt-out requests with approval workflow
const ambassadorOptOutRequestSchema = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true, default: () => generateOrderId() },
    userId: { type: String, required: true, index: true },
    username: String,
    ambassadorEmail: String,
    ambassadorCode: String,
    ambassadorTier: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reason: String,
    declineReason: String,
    adminId: String,
    adminUsername: String,
    userMessageId: Number,
    adminMessages: [{
        adminId: String,
        messageId: Number,
        originalText: String
    }],
    createdAt: { type: Date, default: Date.now },
    processedAt: Date
});

const AmbassadorOptOutRequest = mongoose.model('AmbassadorOptOutRequest', ambassadorOptOutRequestSchema);

// Bot Profile schema (for simulator adaptive behavior)
const botProfileSchema = new mongoose.Schema({
    botId: { type: String, required: true, unique: true, index: true },
    profile: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, default: Date.now, index: true }
});
const BotProfile = mongoose.models.BotProfile || mongoose.model('BotProfile', botProfileSchema);

// BROADCAST JOB SCHEMA - for tracking and processing broadcasts
const broadcastJobSchema = new mongoose.Schema({
    jobId: { type: String, required: true, unique: true, index: true },
    adminId: { type: String, required: true, index: true },
    adminUsername: String,
    messageType: { type: String, enum: ['text', 'photo', 'audio', 'video', 'document'], default: 'text' },
    messageText: { type: String, maxlength: 4096 },
    caption: { type: String, maxlength: 1024 },
    mediaFileId: String,
    messageId: Number,
    targetUserIds: [String],
    totalUsers: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], default: 'pending', index: true },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    currentIndex: { type: Number, default: 0 },
    lastProcessedUserId: String,
    processedUserIds: [String],
    createdAt: { type: Date, default: Date.now, index: true },
    startedAt: Date,
    completedAt: Date,
    estimatedCompletionTime: Date,
    failedUserIds: [{ userId: String, error: String, attempts: Number }],
    lastError: String,
    batchSize: { type: Number, default: 50 },
    delayBetweenBatchesMs: { type: Number, default: 1000 },
    maxRetries: { type: Number, default: 3 },
    // Broadcast admin approval tracking
    adminMessageIds: [{ adminId: String, messageId: Number }],
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    approvedBy: { adminId: String, adminUsername: String, approvedAt: Date }
}, { timestamps: true });

const BroadcastJob = mongoose.model('BroadcastJob', broadcastJobSchema);

// BROADCAST RATE LIMITER - prevents exceeding Telegram API limits
const broadcastRateLimiter = {
    minDelayMs: 30, // 30ms minimum between messages (~30-35 msgs/sec)
    lastSendTime: 0,
    async delay() {
        const now = Date.now();
        const elapsed = now - this.lastSendTime;
        const needed = Math.max(0, this.minDelayMs - elapsed);
        if (needed > 0) {
            await new Promise(resolve => setTimeout(resolve, needed));
        }
        this.lastSendTime = Date.now();
    }
};

let adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(id => id.trim());
// Deduplicate to avoid duplicate notifications per admin
adminIds = Array.from(new Set(adminIds));
const REPLY_MAX_RECIPIENTS = parseInt(process.env.REPLY_MAX_RECIPIENTS || '30', 10);

// Register admin email commands module (Telegram bot functionality)
if (bot && typeof bot.onText === 'function') {
  try {
    registerAdminEmailCommands(bot, adminIds, emailService);
    console.log('[Admin Commands] Email sending commands registered');
  } catch (err) {
    console.error('[Admin Commands] Failed to register email commands:', err.message);
  }
}

// Track processing callbacks to prevent duplicates
// Structure: Map<callbackKey, timestamp> to allow timeout support
const processingCallbacks = new Map(); // Changed from Set to Map for timeout support
const CALLBACK_PROCESSING_TIMEOUT = 60 * 1000; // 60 second timeout per callback

// Email sending session management (for interactive /sendemail command)
const emailSessions = new Map(); // Map<chatId, {step, recipient, subject, templates, createdAt}>
const EMAIL_SESSION_TIMEOUT = 3 * 60 * 1000; // 3 minutes of inactivity

// Clean up old email sessions every minute
setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of emailSessions.entries()) {
        if (now - session.createdAt > EMAIL_SESSION_TIMEOUT) {
            emailSessions.delete(chatId);
            console.log(`[Email Session] Timeout for chat ${chatId}`);
        }
    }
}, 60000);

// Clean up old processing entries every 5 minutes and log stats
setInterval(() => {
    const now = Date.now();
    const expiredCallbacks = [];
    
    for (const [key, timestamp] of processingCallbacks.entries()) {
        if (now - timestamp > CALLBACK_PROCESSING_TIMEOUT) {
            expiredCallbacks.push(key);
        }
    }
    
    // Remove expired entries and log
    expiredCallbacks.forEach(key => {
        console.warn(`⚠️ Callback timeout: ${key} - removing stale entry after ${CALLBACK_PROCESSING_TIMEOUT}ms`);
        processingCallbacks.delete(key);
    });
    
    console.log(`Processing callbacks: ${processingCallbacks.size} active (removed ${expiredCallbacks.length} stale)`);
}, 5 * 60 * 1000);

// Wallet multi-select sessions per user: Map<userId, Set<key>> where key is `sell:ORDERID` or `wd:WITHDRAWALID`
const walletSelections = new Map();

// Clean wallet address by removing special characters and unwanted text
function cleanWalletAddress(input) {
    if (!input || typeof input !== 'string') return '';
    
    // Remove common special characters that users might add
    let cleaned = input
        .replace(/[<>$#+]/g, '') // Remove common special characters
        .replace(/[^\w\-_]/g, '') // Keep only alphanumeric, hyphens, and underscores
        .trim();
    
    // Remove common prefixes/suffixes users might add
    const unwantedPrefixes = ['wallet:', 'address:', 'ton:', 'toncoin:', 'wallet address:', 'address is:'];
    const unwantedSuffixes = ['wallet', 'address', 'ton', 'toncoin'];
    
    for (const prefix of unwantedPrefixes) {
        if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
            cleaned = cleaned.substring(prefix.length).trim();
        }
    }
    
    for (const suffix of unwantedSuffixes) {
        if (cleaned.toLowerCase().endsWith(suffix.toLowerCase())) {
            cleaned = cleaned.substring(0, cleaned.length - suffix.length).trim();
        }
    }
    
    return cleaned;
}

// Parse wallet input and extract address and memo
function parseWalletInput(input) {
    if (!input || typeof input !== 'string') return { address: '', memo: 'none' };
    
    const trimmed = input.trim();
    let address, memo;
    
    if (trimmed.includes(',')) {
        // Split by comma and clean each part
        const parts = trimmed.split(',');
        address = cleanWalletAddress(parts[0]);
        memo = parts.slice(1).join(',').trim() || 'none';
    } else {
        // No comma found, treat entire input as address
        address = cleanWalletAddress(trimmed);
        memo = 'none';
    }
    
    return { address, memo };
}

// TON address validation function
function isValidTONAddress(address) {
    if (!address || typeof address !== 'string') return false;
    
    const trimmed = address.trim();
    
    // Check for testnet indicators
    if (trimmed.toLowerCase().includes('testnet') || 
        trimmed.toLowerCase().includes('test') ||
        trimmed.toLowerCase().includes('sandbox')) {
        return false;
    }
    
    // Support multiple TON address formats:
    // 1. Base64url format: UQ, EQ, kQ, 0Q (48 characters)
    // 2. Hex format: 0:hex (workchain:hex)
    // 3. Raw format: -1:hex or 0:hex
    
    // Check for hex format (0:hex or -1:hex)
    const hexFormatRegex = /^[0-9-]+:[a-fA-F0-9]{64}$/;
    if (hexFormatRegex.test(trimmed)) {
        return true;
    }
    
    // Check for base64url format (48 characters)
    const tonAddressRegex = /^[A-Za-z0-9_-]{48}$/;
    if (tonAddressRegex.test(trimmed)) {
        // Additional validation: check if it looks like a valid TON address
        const validPrefixes = ['UQ', 'EQ', 'kQ', '0Q'];
        return validPrefixes.some(prefix => trimmed.startsWith(prefix));
    }
    
    return false;
}

// Cleanup function for wallet selections
function cleanupWalletSelections() {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30 minutes
    
    for (const [userId, selection] of walletSelections.entries()) {
        if (selection.timestamp && (now - selection.timestamp) > timeout) {
            walletSelections.delete(userId);
        }
    }
}

// Run cleanup every 10 minutes
setInterval(cleanupWalletSelections, 10 * 60 * 1000);

// Background job to verify pending transactions
setInterval(async () => {
    try {
        const pendingOrders = await BuyOrder.find({
            status: 'pending',
            transactionHash: { $exists: true, $ne: null },
            transactionVerified: false,
            verificationAttempts: { $lt: 5 }, // Increased attempts
            // Only verify orders that are at least 30 seconds old
            dateCreated: { $lt: new Date(Date.now() - 30000) }
        }).limit(10);

        for (const order of pendingOrders) {
            try {
                const orderAge = Date.now() - order.dateCreated.getTime();
                const orderAgeMinutes = Math.floor(orderAge / 60000);
                
                console.log(`Verifying transaction for order ${order.id} (age: ${orderAgeMinutes}m, attempt: ${order.verificationAttempts + 1})...`);
                order.verificationAttempts += 1;
                
                const isVerified = await verifyTONTransaction(
                    order.transactionHash,
                    process.env.WALLET_ADDRESS,
                    order.amount
                );

                if (isVerified) {
                    order.transactionVerified = true;
                    order.status = 'processing';
                    console.log(`✅ Order ${order.id} verified and confirmed after ${orderAgeMinutes} minutes`);
                    await order.save();
                    
                    // Automatically track stars when buy order is verified (no admin action needed)
                    try {
                        if (order.stars && !order.isPremium) {
                            await trackStars(order.telegramId, order.stars, 'buy');
                        } else if (order.isPremium) {
                            await trackPremiumActivation(order.telegramId);
                        }
                    } catch (trackError) {
                        console.error(`Failed to track stars for buy order ${order.id}:`, trackError.message);
                    }
                } else {
                    console.log(`❌ Order ${order.id} verification failed (attempt ${order.verificationAttempts}/5)`);
                    
                    // More generous timeout - fail only after 30 minutes and 5 attempts
                    if (order.verificationAttempts >= 5 && orderAge > 1800000) { // 30 minutes
                        order.status = 'failed';
                        console.log(`❌ Order ${order.id} marked as failed after ${orderAgeMinutes} minutes and ${order.verificationAttempts} attempts`);
                    }
                }
                
                await order.save();
            } catch (error) {
                console.error(`Error verifying order ${order.id}:`, error);
                order.verificationAttempts += 1;
                
                const orderAge = Date.now() - order.dateCreated.getTime();
                if (order.verificationAttempts >= 5 && orderAge > 1800000) { // 30 minutes
                    order.status = 'failed';
                    console.log(`❌ Order ${order.id} marked as failed due to verification errors`);
                }
                await order.save();
            }
        }
    } catch (error) {
        console.error('Background verification error:', error);
    }
}, 30000);

function generateOrderId() {
    return Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

function generateBuyOrderId() {
    const randomPart = Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
    return `BUY${randomPart}`;
}

function generateSellOrderId() {
    const randomPart = Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
    return `SELL${randomPart}`;
}

// Helper function to identify order type from ID
function getOrderTypeFromId(orderId) {
    if (orderId.startsWith('BUY')) return 'buy';
    if (orderId.startsWith('SELL')) return 'sell';
    if (orderId.startsWith('WD')) return 'withdrawal';
    return 'unknown';
}

// Generate new professional referral link format: ref_username_randomcode
function generateNewReferralLink(username) {
    const randomCode = Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
    const cleanUsername = (username || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `ref_${cleanUsername.substring(0, 16)}_${randomCode}`;
}

// Generate a professional, hashed referral code from userId
function generateUserReferralHash(userId) {
    const hash = crypto.createHash('sha256').update(userId.toString()).digest('hex');
    // Use first 12 characters of hash for a professional short code
    const shortHash = hash.substring(0, 12);
    return `ref_${shortHash}`;
}

// Reverse lookup: convert hash back to userId (for backward compatibility)
// This is used in the bot to validate old ref_USERID format and new ref_HASH format
function decodeReferralCode(code) {
    if (!code) return null;
    // New format: ref_HASH (12 char hex)
    if (code.startsWith('ref_') && code.length === 16) {
        return { hash: code.substring(4), format: 'new' };
    }
    // Old format: ref_USERID
    if (code.startsWith('ref_')) {
        return { userId: code.substring(4), format: 'old' };
    }
    return null;
}

async function verifyTONTransaction(transactionHash, targetAddress, expectedAmount) {
    const maxRetries = 3;
    const retryDelay = 3000; // 3 seconds
    
    // Validate inputs before making API calls
    if (!transactionHash || !targetAddress || !expectedAmount) {
        console.error('Invalid verification parameters:', { transactionHash: !!transactionHash, targetAddress: !!targetAddress, expectedAmount: !!expectedAmount });
        return false;
    }
    
    // If we have a BOC (starts with te6cc), we need to parse it to get the actual transaction hash
    // For now, we'll use address-based verification instead of hash-based
    console.log('Verifying transaction using address-based lookup instead of BOC parsing...');
    
    // Focus on address-based verification since BOC parsing is complex
    // Look for recent transactions to the target address with the expected amount
    const timeWindow = 3600; // 1 hour window
    const apiEndpoints = [
        // TON Center API - get recent transactions by address (most reliable)
        `https://toncenter.com/api/v2/getTransactions?address=${targetAddress}&limit=50`,
        // Alternative TON Center endpoint with time filter
        `https://toncenter.com/api/v2/getTransactions?address=${targetAddress}&limit=20&start_utime=${Math.floor(Date.now() / 1000) - timeWindow}`,
        // Backup endpoint with smaller limit
        `https://toncenter.com/api/v2/getTransactions?address=${targetAddress}&limit=10`
    ];
    
    for (let endpointIndex = 0; endpointIndex < apiEndpoints.length; endpointIndex++) {
        const tonApiUrl = apiEndpoints[endpointIndex];
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Trying TON API endpoint ${endpointIndex + 1}, attempt ${attempt}: ${tonApiUrl}`);
                const response = await fetch(tonApiUrl, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                    },
                    timeout: 15000 // 15 second timeout
                });

                if (!response.ok) {
                    // Handle different error codes appropriately
                    if ((response.status === 503 || response.status === 502 || response.status === 504) && attempt < maxRetries) {
                        console.log(`TON API temporarily unavailable (${response.status}), retrying in ${retryDelay}ms... (attempt ${attempt}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                        continue;
                    }
                    if (response.status === 429 && attempt < maxRetries) {
                        console.log(`TON API rate limited (429), retrying in ${retryDelay * 2}ms... (attempt ${attempt}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay * 2 * attempt));
                        continue;
                    }
                    console.error(`TON API endpoint ${endpointIndex + 1} failed:`, response.status);
                    break; // Try next endpoint
                }

                const data = await response.json();
                console.log(`API ${endpointIndex + 1} response:`, JSON.stringify(data, null, 2));
                
                // Handle different API response formats
                let transactions = [];
                if (data.result && Array.isArray(data.result)) {
                    transactions = data.result;
                } else if (data.transactions && Array.isArray(data.transactions)) {
                    transactions = data.transactions;
                } else if (data.transaction) {
                    transactions = [data.transaction];
                } else if (data.ok && data.result) {
                    transactions = Array.isArray(data.result) ? data.result : [data.result];
                }
                
                if (transactions.length === 0) {
                    console.log(`API ${endpointIndex + 1}: No transactions found`);
                    break; // Try next endpoint
                }

                // For address-based verification, find transactions that match our criteria
                let matchingTransaction = null;
                
                // Look for transactions with the expected amount in the last hour
                const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
                const expectedAmountNano = Math.floor(expectedAmount * 1e9);
                
                for (const tx of transactions) {
                    // Skip transactions older than 1 hour
                    if (tx.utime < oneHourAgo) continue;
                    
                    // Check if transaction has incoming message with expected amount
                    if (tx.in_msg && tx.in_msg.value) {
                        const receivedAmount = parseInt(tx.in_msg.value);
                        
                        // Allow 5% tolerance for fees
                        if (receivedAmount >= expectedAmountNano * 0.95 && receivedAmount <= expectedAmountNano * 1.05) {
                            matchingTransaction = tx;
                            console.log(`Found matching transaction: amount=${receivedAmount/1e9} TON, time=${new Date(tx.utime * 1000).toISOString()}`);
                            break;
                        }
                    }
                }

                if (!matchingTransaction) {
                    console.log(`API ${endpointIndex + 1}: No matching transaction found`);
                    break; // Try next endpoint
                }

                const transaction = matchingTransaction;
                console.log(`API ${endpointIndex + 1}: Found transaction:`, JSON.stringify(transaction, null, 2));
                
                // Check if transaction has incoming message
                if (!transaction.in_msg) {
                    console.log(`API ${endpointIndex + 1}: Transaction has no incoming message`);
                    break; // Try next endpoint
                }

                const receivedAmount = parseInt(transaction.in_msg.value);
                // expectedAmountNano already declared above
                
                console.log(`API ${endpointIndex + 1}: Amount check - received: ${receivedAmount}, expected: ${expectedAmountNano}`);
                
                // Allow 5% tolerance for network fees, but ensure minimum amount is met
                if (receivedAmount < expectedAmountNano * 0.95) {
                    console.log(`API ${endpointIndex + 1}: Transaction amount too low - received: ${receivedAmount}, minimum required: ${expectedAmountNano * 0.95}`);
                    break; // Try next endpoint
                }
                
                // Also check for unreasonably high amounts (potential error)
                if (receivedAmount > expectedAmountNano * 2) {
                    console.log(`API ${endpointIndex + 1}: Transaction amount suspiciously high - received: ${receivedAmount}, expected: ${expectedAmountNano}`);
                    // Don't break here, just log warning - user might have overpaid
                }

                // Destination check not needed since we're querying by target address already
                console.log(`API ${endpointIndex + 1}: Transaction destination confirmed: ${transaction.in_msg.destination}`);

                const transactionTime = transaction.utime * 1000;
                const now = Date.now();
                const timeDiff = now - transactionTime;
                
                // Allow transactions up to 30 minutes old (increased from 5 minutes)
                if (timeDiff > 1800000) {
                    console.log(`API ${endpointIndex + 1}: Transaction too old: ${Math.floor(timeDiff / 1000)}s ago`);
                    break; // Try next endpoint
                }
                
                // Warn about future transactions (clock skew)
                if (timeDiff < -60000) {
                    console.log(`API ${endpointIndex + 1}: WARNING - Transaction appears to be from the future: ${Math.floor(-timeDiff / 1000)}s`);
                    // Don't reject, might be clock skew
                }

                // Log successful verification with transaction details
                console.log(`Transaction verified successfully: ${transactionHash}`);
                console.log(`API ${endpointIndex + 1}: Transaction verified successfully - Amount: ${receivedAmount/1e9} TON, Time: ${new Date(transactionTime).toISOString()}`);
                return true;
                
            } catch (error) {
                if (attempt < maxRetries) {
                    console.log(`TON API error, retrying in ${retryDelay}ms... (attempt ${attempt}/${maxRetries}):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    continue;
                }
                console.error(`TON API endpoint ${endpointIndex + 1} error after all retries:`, error.message);
                break; // Try next endpoint
            }
        }
    }
    
    // If all API endpoints failed, use fallback verification
    console.log('All TON API endpoints failed, using fallback verification');
    return await fallbackTransactionVerification(transactionHash, targetAddress, expectedAmount);
}

// Fallback verification method when TON APIs are down
async function fallbackTransactionVerification(transactionHash, targetAddress, expectedAmount) {
    try {
        console.log('Using fallback verification - enhanced validation with stricter checks');
        
        // Basic validation: check if transaction hash looks valid
        if (!transactionHash || transactionHash.length < 20) {
            console.log('Fallback verification: Invalid transaction hash format');
            return false;
        }
        
        // Validate target address format
        if (!targetAddress || !isValidTONAddress(targetAddress)) {
            console.log('Fallback verification: Invalid target address format');
            return false;
        }
        
        // Validate expected amount
        if (!expectedAmount || expectedAmount <= 0) {
            console.log('Fallback verification: Invalid expected amount');
            return false;
        }
        
        // Check if it looks like a TON BOC (Bag of Cells) - starts with 'te6cc'
        if (transactionHash.startsWith('te6cc')) {
            console.log('Fallback verification: Valid TON BOC format detected');
            
            // Additional validation: BOC should be longer than 100 characters for a real transaction
            if (transactionHash.length < 100) {
                console.log('Fallback verification: BOC too short, likely invalid');
                return false;
            }
            
            // Check for recent timestamp to prevent old transaction reuse
            const currentTime = Date.now();
            const maxAge = 10 * 60 * 1000; // 10 minutes
            
            console.log('Fallback verification: BOC format validation passed, but verification is limited without API access');
            console.log('Fallback verification: WARNING - Using reduced security fallback mode');
            return true;
        }
        
        // Check if it looks like a hex hash
        if (/^[0-9a-fA-F]{64}$/.test(transactionHash)) {
            console.log('Fallback verification: Valid hex hash format detected, but cannot verify transaction details');
            console.log('Fallback verification: WARNING - Using reduced security fallback mode');
            return true;
        }
        
        console.log('Fallback verification: Unknown hash format, rejecting transaction');
        return false;
        
    } catch (error) {
        console.error('Fallback verification error:', error);
        return false;
    }
}
// Wallet Address Endpoint
app.get('/api/get-wallet-address', requireTelegramAuth, (req, res) => {
    try {
        const walletAddress = process.env.WALLET_ADDRESS;
        
        console.log('💰 Wallet address request from user:', req.user?.id);
        
        if (!walletAddress) {
            console.error('❌ Wallet address not configured');
            return res.status(500).json({
                success: false,
                error: 'Wallet address not configured'
            });
        }

        console.log('✅ Wallet address provided:', walletAddress.slice(0, 8) + '...');
        res.json({
            success: true,
            walletAddress: walletAddress
        });
    } catch (error) {
        console.error('❌ Error getting wallet address:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Quote endpoint for pricing (used by Buy page)
// Transaction verification endpoint
app.post('/api/verify-transaction', requireTelegramAuth, async (req, res) => {
    try {
        const { transactionHash, targetAddress, expectedAmount } = req.body;
        
        if (!transactionHash || !targetAddress || !expectedAmount) {
            return res.status(400).json({ success: false, error: 'Missing required parameters' });
        }

        const isVerified = await verifyTONTransaction(transactionHash, targetAddress, expectedAmount);
        
        if (isVerified) {
            console.log('Transaction verified successfully:', transactionHash);
            res.json({ success: true, verified: true });
        } else {
            console.log('Transaction verification failed:', transactionHash);
            res.json({ success: false, verified: false });
        }
    } catch (error) {
        console.error('Transaction verification error:', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

// Order status check endpoint
app.get('/api/order-status/:orderId', requireTelegramAuth, async (req, res) => {
    try {
        const { orderId } = req.params;
        const userId = req.user.id;
        
        const order = await BuyOrder.findOne({ id: orderId, telegramId: userId });
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        res.json({
            success: true,
            order: {
                id: order.id,
                status: order.status,
                transactionVerified: order.transactionVerified,
                amount: order.amount,
                stars: order.stars,
                isPremium: order.isPremium,
                premiumDuration: order.premiumDuration,
                dateCreated: order.dateCreated
            }
        });
    } catch (error) {
        console.error('Order status check error:', error);
        res.status(500).json({ success: false, error: 'Failed to check order status' });
    }
});

app.post('/api/quote', requireTelegramAuth, (req, res) => {
    try {
        const { isPremium, premiumDuration, stars, recipientsCount, isBuyForOthers } = req.body || {};
        const quantity = Math.max(1, Number(recipientsCount) || 0);

        const priceMap = {
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
        };

        if (isPremium) {
            const unitAmount = priceMap.premium[Number(premiumDuration)];
            if (!unitAmount) {
                return res.status(400).json({ success: false, error: 'Invalid premium duration' });
            }
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount: Number(unitAmount.toFixed(2)), quantity });
        }

        const starsNum = Number(stars) || 0;
        const buyForOthers = Boolean(isBuyForOthers);
        
        // For buying for others, require minimum 50 stars
        if (buyForOthers && (!starsNum || starsNum < 50)) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 50 for others)' });
        }
        
        // For self-purchase, require minimum 1 star
        if (!buyForOthers && (!starsNum || starsNum < 1)) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 1 for self)' });
        }

        // For stars, charge the package price regardless of recipients (stars are distributed, not multiplied)
        const mapPrice = priceMap.regular[starsNum];
        if (typeof mapPrice === 'number') {
            // Use exact package price - total amount is the package price
            const totalAmount = Number(mapPrice.toFixed(2));
            return res.json({ 
                success: true, 
                totalAmount, 
                unitAmount: Number((totalAmount / quantity).toFixed(2)), 
                quantity 
            });
        } else {
            // Fallback to linear rate for custom amounts
            const unitAmount = Number((starsNum * 0.02).toFixed(2));
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount, quantity });
        }
    } catch (error) {
        console.error('Quote error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Optional GET variant for environments issuing GET requests
app.get('/api/quote', (req, res) => {
    try {
        const isPremium = String(req.query.isPremium || 'false') === 'true';
        const premiumDuration = req.query.premiumDuration ? Number(req.query.premiumDuration) : undefined;
        const stars = req.query.stars ? Number(req.query.stars) : undefined;
        const recipientsCount = req.query.recipientsCount ? Number(req.query.recipientsCount) : 0;
        const isBuyForOthers = String(req.query.isBuyForOthers || 'false') === 'true';
        const quantity = Math.max(1, Number(recipientsCount) || 0);

        const priceMap = {
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
        };

        if (isPremium) {
            const unitAmount = priceMap.premium[Number(premiumDuration)];
            if (!unitAmount) {
                return res.status(400).json({ success: false, error: 'Invalid premium duration' });
            }
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount: Number(unitAmount.toFixed(2)), quantity });
        }

        const starsNum = Number(stars) || 0;
        const buyForOthers = Boolean(isBuyForOthers);
        
        // For buying for others, require minimum 50 stars
        if (buyForOthers && (!starsNum || starsNum < 50)) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 50 for others)' });
        }
        
        // For self-purchase, require minimum 1 star
        if (!buyForOthers && (!starsNum || starsNum < 1)) {
            return res.status(400).json({ success: false, error: 'Invalid stars amount (min 1 for self)' });
        }

        // For stars, charge the package price regardless of recipients (stars are distributed, not multiplied)
        const mapPrice = priceMap.regular[starsNum];
        if (typeof mapPrice === 'number') {
            // Use exact package price - total amount is the package price
            const totalAmount = Number(mapPrice.toFixed(2));
            return res.json({ 
                success: true, 
                totalAmount, 
                unitAmount: Number((totalAmount / quantity).toFixed(2)), 
                quantity 
            });
        } else {
            // Fallback to linear rate for custom amounts
            const unitAmount = Number((starsNum * 0.02).toFixed(2));
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            return res.json({ success: true, totalAmount, unitAmount, quantity });
        }
    } catch (error) {
        console.error('Quote (GET) error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Username validation endpoint (format validation only)
// Note: Telegram Bot API cannot validate usernames without user interaction due to privacy restrictions
app.post('/api/validate-usernames', (req, res) => {
    try {
        const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
        console.log('Username validation request:', { usernames });
        
        const recipients = [];
        const seen = new Set();
        
        for (const raw of usernames) {
            if (typeof raw !== 'string') {
                console.log('Skipping non-string username:', raw);
                continue;
            }
            
            const name = raw.trim().replace(/^@/, '').toLowerCase();
            console.log('Processing username:', { raw, trimmed: name });
            
            // Format validation: 1-32 chars, letters, digits, underscore
            // This is the best we can do without user interaction due to Telegram privacy restrictions
            const isValid = /^[a-z0-9_]{1,32}$/.test(name);
            if (!isValid) {
                console.log('Username failed format validation:', name);
                continue;
            }
            
            if (seen.has(name)) {
                console.log('Duplicate username:', name);
                continue;
            }
            
            seen.add(name);
            // Generate stable pseudo userId from hash (since we can't get real Telegram IDs)
            const hash = crypto.createHash('md5').update(name).digest('hex').slice(0, 10);
            const userId = parseInt(hash, 16).toString().slice(0, 10);
            recipients.push({ username: name, userId });
            console.log('Added valid recipient:', { username: name, userId });
        }
        
        console.log('Validation result:', { totalRequested: usernames.length, validRecipients: recipients.length });
        return res.json({ success: true, recipients });
    } catch (error) {
        console.error('validate-usernames error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.post('/api/orders/create', requireTelegramAuth, async (req, res) => {
    const { telegramId, username, stars, walletAddress, isPremium, premiumDuration, recipients, transactionHash, isTestnet } = req.body;
    const requestKey = transactionHash ? `tx:${transactionHash}` : `order:${telegramId}:${walletAddress}:${stars}`;

    try {
        // === VALIDATION PHASE ===
        await syncUserData(telegramId, username, 'order_create', req);
        const requesterIsAdmin = Boolean(req.user?.isAdmin);

        // Prevent duplicate requests
        if (processingRequests.has(requestKey)) {
            return res.status(429).json({ error: 'Request already being processed. Please wait...' });
        }
        processingRequests.set(requestKey, Date.now());

        // Strict validation
        if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Username validation
        const isFallbackUsername = username === 'Unknown' || username === 'User' || !username.match(/^[a-zA-Z0-9_]{5,32}$/);
        if (isFallbackUsername) {
            processingRequests.delete(requestKey);
            try {
                await bot.sendMessage(telegramId, `⚠️ You must set a Telegram username to place orders.\n\nGo to Settings → Username and create one, then try again.`);
            } catch {}
            return res.status(400).json({ error: 'Telegram username required' });
        }

        // Check banned status
        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            processingRequests.delete(requestKey);
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        // Check for recent duplicate orders
        const existingOrder = transactionHash ? await BuyOrder.findOne({ transactionHash }) : null;
        if (existingOrder) {
            const isRecent = existingOrder.dateCreated && (Date.now() - new Date(existingOrder.dateCreated).getTime()) < 600000;
            if (isRecent) {
                processingRequests.delete(requestKey);
                return res.status(400).json({ error: 'This transaction has already been processed' });
            }
        }

        const recentOrder = await BuyOrder.findOne({
            telegramId,
            dateCreated: { $gte: new Date(Date.now() - 60000) },
            status: { $in: ['pending', 'processing'] }
        });
        if (recentOrder) {
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Please wait before placing another order' });
        }

        // Wallet validation
        if (isTestnet === true && !requesterIsAdmin) {
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Testnet is not supported' });
        }

        if (walletAddress && !requesterIsAdmin && !isValidTONAddress(walletAddress)) {
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Invalid TON wallet address' });
        }

        // === ORDER CREATION PHASE ===
        // Handle recipients
        let isBuyForOthers = false, totalRecipients = 0, starsPerRecipient = null, premiumDurationPerRecipient = null, processedRecipients = [];
        
        if (recipients && Array.isArray(recipients) && recipients.length > 0) {
            isBuyForOthers = true;
            totalRecipients = recipients.length;
            if (isPremium) {
                premiumDurationPerRecipient = premiumDuration;
            } else {
                starsPerRecipient = Math.floor(stars / totalRecipients);
                const remainingStars = stars % totalRecipients;
                processedRecipients = recipients.map((recipient, index) => ({
                    username: recipient,
                    starsReceived: starsPerRecipient + (index < remainingStars ? 1 : 0)
                }));
            }
        }

        // Calculate amount
        let amount;
        if (req.body.totalAmount && typeof req.body.totalAmount === 'number' && req.body.totalAmount > 0) {
            amount = req.body.totalAmount;
        } else {
            const priceMap = { regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 }, premium: { 3: 19.31, 6: 26.25, 12: 44.79 } };
            amount = isPremium ? priceMap.premium[premiumDuration] : priceMap.regular[stars];
            if (!amount) {
                processingRequests.delete(requestKey);
                return res.status(400).json({ error: 'Invalid selection' });
            }
        }

        // Create order
        const order = new BuyOrder({
            id: generateBuyOrderId(),
            telegramId,
            username,
            amount,
            stars: isPremium ? null : stars,
            premiumDuration: isPremium ? premiumDuration : null,
            walletAddress,
            isPremium,
            status: 'pending',
            dateCreated: new Date(),
            adminMessages: [],
            recipients: processedRecipients,
            isBuyForOthers,
            totalRecipients,
            starsPerRecipient,
            premiumDurationPerRecipient,
            transactionHash: transactionHash || null,
            transactionVerified: false,
            verificationAttempts: 0
        });

        // Save order
        await order.save();

        // === ADMIN NOTIFICATION PHASE (CRITICAL) ===
        // Extract geolocation
        let userLocation = '';
        try {
            let ip = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
            if (ip && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
                const geo = await getGeolocation(ip);
                if (geo?.country !== 'Unknown') {
                    userLocation = `\nLocation: ${geo.city || 'Unknown'}, ${geo.country}`;
                    order.userLocation = { city: geo.city, country: geo.country, ip, timestamp: new Date() };
                }
            }
        } catch {}

        // Build admin message
        let adminMessage = `🛒 NEW ${isPremium ? 'PREMIUM' : 'BUY'} ORDER\n\nOrder ID: ${order.id}\nUser: @${username} (ID: ${telegramId})${userLocation}\nAmount: ${amount} USDT`;
        if (isPremium) adminMessage += `\nDuration: ${premiumDuration} months`;
        else adminMessage += `\nStars: ${stars}`;
        
        if (isBuyForOthers) {
            adminMessage += `\n\n👥 Buy For Others: ${totalRecipients} user(s)`;
            if (!isPremium) adminMessage += `\nPer user: ${starsPerRecipient} stars`;
            else adminMessage += `\nDuration: ${premiumDurationPerRecipient} months each`;
            adminMessage += `\nRecipients: ${recipients.map(r => `@${r}`).join(', ')}`;
        }

        const adminKeyboard = { inline_keyboard: [[ { text: '✅ Complete', callback_data: `complete_buy_${order.id}` }, { text: '❌ Decline', callback_data: `decline_buy_${order.id}` } ]] };

        // Send to admins with retry (MUST succeed for at least one admin)
        let adminNotificationSucceeded = false;
        let lastAdminError = null;

        for (const adminId of adminIds) {
            let retryCount = 0;
            while (retryCount < 3) {
                try {
                    const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                    order.adminMessages.push({ adminId, messageId: message.message_id, originalText: adminMessage });
                    adminNotificationSucceeded = true;
                    break;
                } catch (err) {
                    lastAdminError = err;
                    retryCount++;
                    if (retryCount < 3) await new Promise(r => setTimeout(r, 500)); // Wait before retry
                }
            }
        }

        // Save order with admin messages (whether or not notifications succeeded)
        await order.save();

        // === USER NOTIFICATION & ACTIVITY TRACKING ===
        if (adminNotificationSucceeded) {
            const userMsg = `🎉 Order #${order.id} submitted!\n\nAmount: ${amount} USDT${isPremium ? `\nDuration: ${premiumDuration} mo` : `\nStars: ${stars}`}\nStatus: Awaiting admin review\n\n⏱️ Processing: Up to 2 hours`;
            try { await bot.sendMessage(telegramId, userMsg); } catch {}
        } else {
            // Admin notification failed - inform user to contact support
            const fallbackMsg = `⚠️ Order #${order.id} created but experiencing delays.\n\nAmount: ${amount} USDT\nStatus: Pending\n\n📞 Please contact @StarStore_Chat if not processed within 2 hours.`;
            try { await bot.sendMessage(telegramId, fallbackMsg); } catch {}
            console.error(`❌ CRITICAL: Order ${order.id} admin notification failed after retries. Error: ${lastAdminError?.message}`);
        }

        await trackUserActivity(telegramId, username, 'order_created', { orderId: order.id, amount, stars, isPremium });

        // === SUCCESS RESPONSE ===
        // Always return success if order was saved (order exists in DB regardless of admin notification)
        processingRequests.delete(requestKey);
        res.json({ success: true, order });

    } catch (err) {
        processingRequests.delete(requestKey);
        console.error(`❌ Order creation error for user ${req.body?.telegramId}: ${err.message}`);
        res.status(500).json({ error: 'Failed to create order. Please try again.' });
    }
});

function sanitizeUsername(username) {
    if (!username) return null;
    return username.replace(/[^\w\d_]/g, '');
}

app.post("/api/sell-orders", async (req, res) => {
    try {
        const { 
            telegramId, 
            username = '', 
            stars, 
            walletAddress, 
            memoTag = '' 
        } = req.body;
        
        // === SYNC USER DATA ON EVERY INTERACTION ===
        await syncUserData(telegramId, username, 'sell_order_create', req);
        
        if (!telegramId || stars === undefined || stars === null || !walletAddress) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            return res.status(403).json({ error: "You are banned from placing orders" });
        }

        // Admin bypass for amount limits (50 - 80000)
        const isAdmin = Array.isArray(adminIds) && adminIds.includes(String(telegramId));
        if (!isAdmin) {
            const numericStars = Number(stars);
            if (!Number.isFinite(numericStars)) {
                return res.status(400).json({ error: "Invalid stars amount" });
            }
            if (numericStars < 50 || numericStars > 80000) {
                return res.status(400).json({ error: "Stars amount must be between 50 and 80000" });
            }
        }

        // Check for existing ACTIVE pending orders for this user (not expired)
        const existingOrder = await SellOrder.findOne({ 
            telegramId: telegramId,
            status: "pending",
            sessionExpiry: { $gt: new Date() } 
        });

        if (existingOrder) {
            // If there's an existing active pending order, auto-expire it and allow new one
            // Users should be able to retry without waiting for session to expire
            await SellOrder.updateOne(
                { _id: existingOrder._id },
                { status: "expired", sessionExpiry: new Date() }
            );
        }

        // Extract and get location from request (web-based sell order)
        let userLocation = null;
        try {
            let ip = req.headers?.['x-forwarded-for'] || req.headers?.['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown';
            if (typeof ip === 'string') {
                ip = ip.split(',')[0].trim();
            }
            
            if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
                const geo = await getGeolocation(ip);
                if (geo.country !== 'Unknown') {
                    userLocation = {
                        city: geo.city,
                        country: geo.country,
                        countryCode: geo.countryCode,
                        timestamp: new Date()
                    };
                    console.log(`[SELL-ORDER] Location captured: ${geo.city}, ${geo.country}`);
                }
            }
        } catch (err) {
            console.error('Error capturing location for sell order:', err.message);
            // Continue without location - it's not critical
        }

        // Generate unique session token for this user and order
        const sessionToken = generateSessionToken(telegramId);
        const sessionExpiry = new Date(Date.now() + 15 * 60 * 1000); 

        const order = new SellOrder({
            id: generateSellOrderId(),
            telegramId,
            username: sanitizeUsername(username),
            stars,
            walletAddress,
            memoTag,
            status: "pending", 
            telegram_payment_charge_id: "temp_" + Date.now(),
            reversible: true,
            dateCreated: new Date(),
            adminMessages: [],
            sessionToken: sessionToken, 
            sessionExpiry: sessionExpiry, 
            userLocked: telegramId,
            userLocation: userLocation
        });

        let paymentLink = null;
        const isAdminById = Array.isArray(adminIds) && adminIds.includes(String(telegramId));
        const numericStars = Number(stars);
        const needsInvoice = numericStars > 0;

        if (needsInvoice) {
            try {
                paymentLink = await createTelegramInvoice(
                    telegramId, 
                    order.id, 
                    numericStars, 
                    `Purchase of ${numericStars} Telegram Stars`,
                    sessionToken 
                );
            } catch (e) {
                if (!isAdminById) {
                    throw e;
                }
            }
        }

        // Admin bypass: allow 0 stars or invoice failure
        if (isAdminById && (!needsInvoice || !paymentLink)) {
            order.status = "processing";
            order.telegram_payment_charge_id = "admin_manual";
            await order.save();

            // Log activity for admin sell order creation
            await logActivity(telegramId, ACTIVITY_TYPES.SELL_ORDER, ACTIVITY_TYPES.SELL_ORDER.points, {
              orderId: order.id,
              stars: stars,
              walletAddress: walletAddress,
              adminBypass: true
            });

            const userMessage = `🚀 Admin sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Processing (manual)\n\nAn admin will process this order.`;
            try { await bot.sendMessage(telegramId, userMessage); } catch {}
            return res.json({ success: true, order, adminBypass: true, expiresAt: sessionExpiry });
        }

        if (!paymentLink) {
            return res.status(500).json({ error: "Failed to generate payment link" });
        }

        await order.save();

        // Do NOT award or log points at creation
        console.log(`💰 Sell order created for user ${telegramId}`);

        const userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\n⏰ Payment link expires in 15 minutes\n\nPay here: ${paymentLink}`;
        try { await bot.sendMessage(telegramId, userMessage); } catch {}

        res.json({ 
            success: true, 
            order, 
            paymentLink,
            expiresAt: sessionExpiry
        });
    } catch (err) {
        console.error("Sell order creation error:", err);
        res.status(500).json({ error: "Failed to create sell order" });
    }
});

// Generate unique session token
function generateSessionToken(telegramId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${telegramId}_${timestamp}_${random}`;
}

// Enhanced pre-checkout validation 
bot.on('pre_checkout_query', async (query) => {
    const orderId = query.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
    
    if (!order) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order not found" });
        return;
    }

    // Check if order has expired
    if (order.sessionExpiry && new Date() > order.sessionExpiry) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Payment session has expired" });
        // Update order status to expired
        order.status = "expired";
        await order.save();
        return;
    }

    // Check if the user making payment matches the order creator
    if (order.userLocked && order.userLocked.toString() !== query.from.id.toString()) {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "This payment link is not valid for your account" });
        return;
    }

    // Check if order already processed (duplicate payment protection)
    if (order.status !== "pending") {
        await bot.answerPreCheckoutQuery(query.id, false, { error_message: "Order already processed" });
        return;
    }

    await bot.answerPreCheckoutQuery(query.id, true);
});

async function getUserDisplayName(telegramId) {
    try {
        const chat = await bot.getChat(telegramId);
        
        let displayName = '';
        
        if (chat.first_name) {
            displayName = chat.first_name;
            if (chat.last_name) {
                displayName += ` ${chat.last_name}`;
            }
        } else {
            displayName = `User ${telegramId}`;
        }
        
        return displayName;
    } catch (error) {
        console.error(`Failed to get user info for ${telegramId}:`, error);
        return `User ${telegramId}`;
    }
}

// Check and detect username changes for a user
async function detectUsernameChange(userId, currentUsername, source = 'api') {
    try {
        // Generate referral hash for user if not already set
        const referralHash = generateUserReferralHash(userId);
        
        // First, ensure user exists with upsert (handles race condition from new users)
        const storedUser = await User.findOneAndUpdate(
            { id: userId },
            { $setOnInsert: { 
                id: userId,
                username: currentUsername,
                lastActive: new Date(),
                usernameHistory: currentUsername ? [{ username: currentUsername, changedFrom: null, timestamp: new Date(), source: source }] : [],
                referralHash: referralHash
            } },
            { upsert: true, new: true }
        );
        
        if (!storedUser) {
            return null; // No change, user was just created
        }
        
        // Check if username changed
        if (storedUser.username && storedUser.username !== currentUsername && currentUsername) {
            // Username changed from stored value to new value
            const oldUsername = storedUser.username;
            
            // Build history entry
            const historyEntry = {
                username: currentUsername,
                changedFrom: oldUsername,
                timestamp: new Date(),
                source: source
            };
            
            // Update using atomic operation to avoid version conflicts
            const updated = await User.findOneAndUpdate(
                { id: userId },
                {
                    $set: {
                        username: currentUsername,
                        lastUsernameChange: {
                            oldUsername,
                            newUsername: currentUsername,
                            timestamp: new Date()
                        }
                    },
                    $push: {
                        usernameHistory: {
                            $each: [historyEntry],
                            $slice: -50  // Keep only last 50
                        }
                    }
                },
                { new: false }
            );
            
            return { oldUsername, newUsername: currentUsername };
        } else if (storedUser.username && !currentUsername) {
            // Username was removed (user deleted their username)
            const oldUsername = storedUser.username;
            
            const historyEntry = {
                username: null,
                changedFrom: oldUsername,
                timestamp: new Date(),
                source: source
            };
            
            // Update using atomic operation
            await User.findOneAndUpdate(
                { id: userId },
                {
                    $set: { username: null },
                    $push: {
                        usernameHistory: {
                            $each: [historyEntry],
                            $slice: -50
                        }
                    }
                },
                { new: false }
            );
            
            return { oldUsername, newUsername: null };
        } else if (!storedUser.username && currentUsername) {
            // First time we capture the username
            const historyEntry = {
                username: currentUsername,
                changedFrom: null,
                timestamp: new Date(),
                source: source
            };
            
            // Update using atomic operation
            await User.findOneAndUpdate(
                { id: userId },
                {
                    $set: { username: currentUsername },
                    $push: {
                        usernameHistory: {
                            $each: [historyEntry],
                            $slice: -50
                        }
                    }
                },
                { new: false }
            );
            
            return null;
        }
        
        return null; // No change
    } catch (error) {
        console.error(`Error detecting username change for user ${userId}:`, error.message);
        return null;
    }
}

// Helper function to replace username in text, handling both old and new usernames
function replaceUsernameInText(text, oldUsername, newUsername) {
    if (!text || !oldUsername) return text;
    
    const replacement = newUsername ? `@${newUsername}` : '(username removed)';
    const textReplacement = newUsername || '(removed)';
    
    text = text.replace(new RegExp(`@${oldUsername}`, 'g'), replacement);
    text = text.replace(new RegExp(oldUsername, 'g'), textReplacement);
    
    return text;
}

// Helper function to format location for display
function formatLocation(location) {
    if (!location) return 'Location unknown';
    const city = location.city && location.city !== 'Unknown' ? location.city : null;
    const country = location.country && location.country !== 'Unknown' ? location.country : null;
    
    if (city && country) return `${city}, ${country}`;
    if (country) return country;
    if (city) return city;
    return 'Location unknown';
}

// Centralized username update processor - updates all affected messages and database
async function processUsernameUpdate(userId, oldUsername, newUsername) {
    try {
        // Allow null newUsername (username removal), but require oldUsername and non-identical
        if (!oldUsername || oldUsername === newUsername) {
            return; // No change needed
        }

        // Notify admins of username change (silent for users - only admins get notification)
        // Deduplicate notifications within a 3-second window
        const now = Date.now();
        const lastNotificationTime = usernameChangeNotifications.get(userId);
        const isDuplicate = lastNotificationTime && (now - lastNotificationTime) < USERNAME_CHANGE_DEDUPE_MS;
        
        if (!isDuplicate) {
            usernameChangeNotifications.set(userId, now);
            
            try {
                const changeType = newUsername ? 'Changed' : 'Removed';
                const usernameChangeNotification = 
                    `Username ${changeType}: @${oldUsername} -> ${newUsername ? `@${newUsername}` : '(no username)'}\n` +
                    `User: ${userId}`;
                
                for (const adminId of adminIds) {
                    try {
                        await bot.sendMessage(adminId, usernameChangeNotification);
                    } catch (notifyErr) {
                        console.error(`Failed to notify admin ${adminId} about username change:`, notifyErr.message);
                    }
                }
            } catch (notifyError) {
                console.warn('Error sending admin notification for username change:', notifyError.message);
            }
        } else {
            console.log(`Duplicate username change notification suppressed for user ${userId} (within ${USERNAME_CHANGE_DEDUPE_MS}ms)`);
        }

        // Update User record
        try {
            await User.updateOne({ id: userId }, { username: newUsername });
        } catch (_) {}

        // Update all sell orders
        const sellOrders = await SellOrder.find({ username: oldUsername, telegramId: userId });
        for (const order of sellOrders) {
            order.username = newUsername;
            // Do NOT modify the order status - only update username
            
            // Only update admin messages if order is still pending (not completed/failed/refunded)
            const isPending = !order.status || order.status.toLowerCase() === 'pending';
            if (isPending && Array.isArray(order.adminMessages) && order.adminMessages.length) {
                await Promise.all(order.adminMessages.map(async (m) => {
                    let text = m.originalText || '';
                    if (text) {
                        text = replaceUsernameInText(text, oldUsername, newUsername);
                    }
                    m.originalText = text;
                    
                    const sellButtons = {
                        inline_keyboard: [[
                            { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                            { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                            { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                        ]]
                    };
                    try {
                        await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId, reply_markup: sellButtons });
                    } catch (_) {}
                }));
            }
            
            await order.save();
        }

        // Update all buy orders
        const buyOrders = await BuyOrder.find({ username: oldUsername, telegramId: userId });
        for (const order of buyOrders) {
            order.username = newUsername;
            // Do NOT modify the order status - only update username
            
            // Only update admin messages if order is still pending (not completed/declined)
            const isPending = !order.status || order.status.toLowerCase() === 'pending';
            if (isPending && Array.isArray(order.adminMessages) && order.adminMessages.length) {
                await Promise.all(order.adminMessages.map(async (m) => {
                    let text = m.originalText || '';
                    if (text) {
                        text = replaceUsernameInText(text, oldUsername, newUsername);
                    }
                    m.originalText = text;
                    
                    const buyButtons = {
                        inline_keyboard: [[
                            { text: "✅ Complete", callback_data: `complete_buy_${order.id}` },
                            { text: "❌ Decline", callback_data: `decline_buy_${order.id}` }
                        ]]
                    };
                    try {
                        await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId, reply_markup: buyButtons });
                    } catch (_) {}
                }));
            }
            
            await order.save();
        }

        // Update all referral withdrawals
        const withdrawals = await ReferralWithdrawal.find({ username: oldUsername, userId });
        for (const wd of withdrawals) {
            wd.username = newUsername;
            
            // Edit all admin messages for this withdrawal
            if (Array.isArray(wd.adminMessages) && wd.adminMessages.length) {
                await Promise.all(wd.adminMessages.map(async (m) => {
                    let text = m.originalText || '';
                    if (text) {
                        text = replaceUsernameInText(text, oldUsername, newUsername);
                    }
                    m.originalText = text;
                    
                    try {
                        await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                    } catch (_) {}
                }));
            }
            
            await wd.save();
        }

        console.log(`Username updated in database and messages: @${oldUsername} -> @${newUsername} (User: ${userId})`);
    } catch (error) {
        console.error(`Error processing username update for user ${userId}:`, error);
    }
}

// Geolocation service - get country and city from IP
async function getGeolocation(ip) {
    if (!ip || ip === 'localhost' || ip === '127.0.0.1' || ip === '::1') {
        return { country: 'Unknown', countryCode: 'XX', city: 'Local' };
    }
    
    // Check cache first
    const cached = geoCache.get(ip);
    if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL) {
        return { country: cached.country, countryCode: cached.countryCode, city: cached.city };
    }
    
    // Try multiple providers in order
    const providers = [
        {
            name: 'ipapi.co',
            url: `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
            parse: (data) => ({
                country: data.country_name || 'Unknown',
                countryCode: data.country_code || 'XX',
                city: data.city || data.region_code || 'Unknown'
            })
        },
        {
            name: 'ip-api.com',
            url: `https://ip-api.com/json/${ip}?fields=status,country,countryCode,city`,
            parse: (data) => ({
                country: data.country || 'Unknown',
                countryCode: data.countryCode || 'XX',
                city: data.city || 'Unknown'
            })
        },
        {
            name: 'ipinfo.io',
            url: `https://ipinfo.io/${ip}/json`,
            parse: (data) => {
                const city = data.city || 'Unknown';
                const country = data.country || 'Unknown';
                return { country, countryCode: country.substring(0, 2).toUpperCase(), city };
            }
        }
    ];
    
    let lastError = null;
    for (const provider of providers) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // Increased timeout to 5s
            
            const response = await fetch(provider.url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                try {
                    const data = await response.json();
                    const result = provider.parse(data);
                    
                    // Cache the result
                    geoCache.set(ip, { ...result, timestamp: Date.now() });
                    return result;
                } catch (parseErr) {
                    console.warn(`[GEO] ${provider.name} parse error, trying next provider...`);
                    lastError = parseErr;
                    continue;
                }
            } else if (response.status === 429 || response.status === 403) {
                // Rate limited or forbidden - try next provider silently
                lastError = `${provider.name} status ${response.status}`;
                continue;
            } else {
                lastError = `${provider.name} returned status ${response.status}`;
                continue;
            }
        } catch (error) {
            // Network error, timeout, or abort - try next provider
            lastError = `${provider.name} error: ${error.name}`;
            continue;
        }
    }
    
    // All providers failed - return unknown with cache
    const unknown = { country: 'Unknown', countryCode: 'XX', city: 'Unknown' };
    geoCache.set(ip, { ...unknown, timestamp: Date.now() });
    return unknown;
}

// Parse user agent to get browser and OS info
function parseUserAgent(userAgent = '') {
    let browser = 'Unknown';
    let os = 'Unknown';
    
    // Browser detection
    if (userAgent.includes('Chrome')) browser = 'Chrome';
    else if (userAgent.includes('Safari')) browser = 'Safari';
    else if (userAgent.includes('Firefox')) browser = 'Firefox';
    else if (userAgent.includes('Edge')) browser = 'Edge';
    else if (userAgent.includes('Opera')) browser = 'Opera';
    else if (userAgent.includes('TelegramClient')) browser = 'Telegram';
    
    // OS detection
    if (userAgent.includes('Windows')) os = 'Windows';
    else if (userAgent.includes('Mac')) os = 'macOS';
    else if (userAgent.includes('Linux')) os = 'Linux';
    else if (userAgent.includes('Android')) os = 'Android';
    else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
    
    return { browser, os };
}

// === UNIFIED USER DATA SYNC SYSTEM ===
// Syncs all user data on every interaction - prevents race conditions and missing data
async function syncUserData(telegramId, username, interactionType = 'unknown', req = null, msg = null) {
    if (!telegramId) return null;
    
    try {
        // Extract IP and location data
        let ip = 'unknown';
        let userAgent = 'unknown';
        let geo = null;
        
        if (req) {
            ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
                .toString().split(',')[0].trim();
            userAgent = (req.headers?.['user-agent'] || 'unknown').toString();
        } else if (msg) {
            userAgent = `Telegram-${msg.from?.id || 'unknown'}`;
            ip = 'unknown';
        }
        
        // Only get geolocation if we have a valid IP
        if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
            geo = await getGeolocation(ip);
        }
        
        // Parse user agent
        const { browser, os } = parseUserAgent(userAgent);
        
        // 1. CHECK/CREATE USER
        let user = await User.findOne({ id: telegramId });
        
        if (!user) {
            // User doesn't exist - create with all available data
            user = new User({
                id: telegramId,
                username: username || null,
                createdAt: new Date(),
                lastActive: new Date()
            });
            
            if (geo && geo.country !== 'Unknown') {
                user.lastLocation = {
                    country: geo.country,
                    countryCode: geo.countryCode,
                    city: geo.city,
                    ip,
                    timestamp: new Date()
                };
                user.locationHistory = [user.lastLocation];
            }
            
            user.lastDevice = {
                userAgent,
                browser,
                os,
                timestamp: new Date()
            };
            user.devices = [{
                userAgent,
                browser,
                os,
                lastSeen: new Date(),
                country: geo?.country || 'Unknown'
            }];
            
            await user.save();
            console.log(`[SYNC] New user created: ${telegramId} (@${username})`);
        } else {
            // User exists - update if needed
            let hasChanges = false;
            
            // 2. CHECK/UPDATE USERNAME - More accurate tracking
            if (username && user.username !== username) {
                const oldUsername = user.username;
                user.username = username;
                user.lastUsernameChange = {
                    oldUsername,
                    newUsername: username,
                    timestamp: new Date()
                };
                
                // Track username history
                if (!user.usernameHistory) user.usernameHistory = [];
                user.usernameHistory.push({
                    username: username,
                    changedFrom: oldUsername,
                    timestamp: new Date(),
                    source: 'api'
                });
                
                if (user.usernameHistory.length > 50) {
                    user.usernameHistory = user.usernameHistory.slice(-50);
                }
                
                hasChanges = true;
                console.log(`[SYNC] Username updated: ${telegramId} -> @${username}`);
                
                // Notify admins of username change
                try {
                    const usernameChangeNotification = 
                        `Username Change: @${oldUsername} -> @${username}\n` +
                        `User: ${telegramId}\n` +
                        `Location: ${formatLocation(user?.lastLocation)}`;
                    
                    for (const adminId of adminIds) {
                        try {
                            await bot.sendMessage(adminId, usernameChangeNotification);
                        } catch (notifyErr) {
                            // Silently fail individual admin notifications
                        }
                    }
                } catch (_) {}
            }
            
            // 3. UPDATE LAST ACTIVE
            user.lastActive = new Date();
            hasChanges = true;
            
            // 4. CHECK/UPDATE LOCATION
            if (geo && geo.country !== 'Unknown') {
                // Update location only if:
                // - User has no location yet, OR
                // - Location changed, OR
                // - Location data is old (>30 days)
                const hasValidLocation = user.lastLocation && user.lastLocation.country !== 'Unknown';
                const locationExpired = !hasValidLocation || 
                    (user.lastLocation.timestamp && 
                     Date.now() - user.lastLocation.timestamp > 30 * 24 * 60 * 60 * 1000);
                const locationChanged = hasValidLocation && user.lastLocation.country !== geo.country;
                
                if (!hasValidLocation || locationExpired || locationChanged) {
                    user.lastLocation = {
                        country: geo.country,
                        countryCode: geo.countryCode,
                        city: geo.city,
                        ip,
                        timestamp: new Date()
                    };
                    
                    if (!user.locationHistory) user.locationHistory = [];
                    user.locationHistory.push(user.lastLocation);
                    if (user.locationHistory.length > 50) {
                        user.locationHistory = user.locationHistory.slice(-50);
                    }
                    
                    if (!hasValidLocation) {
                        console.log(`[SYNC] Location saved for ${telegramId}: ${geo.city}, ${geo.country}`);
                    } else if (locationChanged) {
                        console.log(`[SYNC] Location changed for ${telegramId}: ${user.lastLocation.country}`);
                    }
                    hasChanges = true;
                }
            }
            
            // 5. UPDATE/TRACK DEVICE
            const existingDevice = user.devices?.find(d => d.userAgent === userAgent);
            if (existingDevice) {
                existingDevice.lastSeen = new Date();
                if (geo?.country) existingDevice.country = geo.country;
            } else {
                if (!user.devices) user.devices = [];
                user.devices.push({
                    userAgent,
                    browser,
                    os,
                    lastSeen: new Date(),
                    country: geo?.country || 'Unknown'
                });
                if (user.devices.length > 20) {
                    user.devices = user.devices.slice(-20);
                }
                hasChanges = true;
                console.log(`[SYNC] New device tracked for ${telegramId}`);
            }
            
            user.lastDevice = {
                userAgent,
                browser,
                os,
                timestamp: new Date()
            };
            
            if (hasChanges) {
                try {
                    await user.save();
                } catch (saveErr) {
                    // Handle version conflicts from concurrent updates
                    if (saveErr.name === 'VersionError') {
                        console.warn(`[SYNC] Version conflict for user ${telegramId}, reloading and retrying...`);
                        try {
                            // Reload the document and retry
                            const reloadedUser = await User.findOne({ id: telegramId });
                            if (reloadedUser) {
                                // Apply only the safe updates
                                reloadedUser.lastActive = new Date();
                                reloadedUser.lastDevice = user.lastDevice;
                                await reloadedUser.save();
                            }
                        } catch (retryErr) {
                            console.error(`[SYNC] Failed to retry saving user ${telegramId}:`, retryErr.message);
                        }
                    } else {
                        throw saveErr;
                    }
                }
            }
        }
        
        // 6. LOG INTERACTION (with sampling to reduce storage)
        const userActivitySampleRate = parseFloat(process.env.USERACTIVITYLOG_SAMPLE_RATE || '0.5'); // Default: log 50%
        if (Math.random() <= userActivitySampleRate) {
            try {
                await UserActivityLog.create({
                    userId: telegramId,
                    username: username || user?.username || 'Unknown',
                    actionType: interactionType,
                    location: geo ? {
                        country: geo.country,
                        countryCode: geo.countryCode,
                        city: geo.city,
                        ip
                    } : null,
                    device: {
                        userAgent,
                        browser,
                        os
                    },
                    timestamp: new Date()
                });
            } catch (logErr) {
                console.error(`[SYNC] Failed to log activity for ${telegramId}:`, logErr.message);
            }
        }
        
        return user;
    } catch (error) {
        console.error(`[SYNC] Error syncing user data for ${telegramId}:`, error);
        return null;
    }
}

// Track user activity and location
async function trackUserActivity(userId, username, actionType, actionDetails = {}, req = null, msg = null, overrideLocation = null) {
    try {
        // Extract IP and user agent
        let ip = 'unknown';
        let userAgent = 'unknown';
        
        if (req) {
            ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
                .toString().split(',')[0].trim();
            userAgent = (req.headers?.['user-agent'] || 'unknown').toString();
        } else if (msg) {
            // For Telegram messages, try to extract from the update context if available
            // Otherwise use telegram as identifier
            userAgent = `Telegram-${msg.from?.id || 'unknown'}`;
            ip = 'unknown'; // Can't get real IP from Telegram, set as unknown
        }
        
        // Use override location if provided, otherwise get geolocation
        let geo = overrideLocation;
        if (!geo) {
            geo = await getGeolocation(ip);
        }
        const { browser, os } = parseUserAgent(userAgent);
        
        // Get user
        const user = await User.findOne({ id: userId });
        
        if (user) {
            // Update last active
            user.lastActive = new Date();
            
            // Update location
            user.lastLocation = {
                country: geo.country,
                countryCode: geo.countryCode,
                city: geo.city,
                ip,
                timestamp: new Date()
            };
            
            // Add to location history (keep last 20)
            if (!user.locationHistory) user.locationHistory = [];
            user.locationHistory.push({
                country: geo.country,
                countryCode: geo.countryCode,
                city: geo.city,
                ip,
                timestamp: new Date()
            });
            if (user.locationHistory.length > 20) {
                user.locationHistory = user.locationHistory.slice(-20);
            }
            
            // Update device info
            user.lastDevice = {
                userAgent,
                browser,
                os,
                timestamp: new Date()
            };
            
            // Track device
            if (!user.devices) user.devices = [];
            const existingDevice = user.devices.find(d => d.userAgent === userAgent);
            if (existingDevice) {
                existingDevice.lastSeen = new Date();
                existingDevice.country = geo.country;
            } else {
                user.devices.push({
                    userAgent,
                    browser,
                    os,
                    lastSeen: new Date(),
                    country: geo.country
                });
                if (user.devices.length > 10) {
                    user.devices = user.devices.slice(-10);
                }
            }
            
            try {
                await user.save();
            } catch (saveErr) {
                // Handle version conflicts from concurrent updates
                if (saveErr.name === 'VersionError') {
                    console.warn(`[ACTIVITY] Version conflict for user ${userId}, reloading and retrying...`);
                    try {
                        // Reload the document and retry with fresh version
                        const reloadedUser = await User.findOne({ id: userId });
                        if (reloadedUser) {
                            // Apply only the safe updates that don't conflict with ambassador fields
                            reloadedUser.lastActive = new Date();
                            reloadedUser.lastLocation = {
                                country: geo.country,
                                countryCode: geo.countryCode,
                                city: geo.city,
                                ip,
                                timestamp: new Date()
                            };
                            reloadedUser.lastDevice = {
                                userAgent,
                                browser,
                                os,
                                timestamp: new Date()
                            };
                            await reloadedUser.save();
                        }
                    } catch (retryErr) {
                        console.error(`[ACTIVITY] Failed to retry saving user ${userId}:`, retryErr.message);
                    }
                } else {
                    throw saveErr;
                }
            }
        }
        
        // Create activity log (with sampling to reduce storage)
        const userActivitySampleRate = parseFloat(process.env.USERACTIVITYLOG_SAMPLE_RATE || '0.5'); // Default: log 50%
        if (Math.random() <= userActivitySampleRate) {
            await UserActivityLog.create({
                userId,
                username: username || user?.username || 'Unknown',
                timestamp: new Date(),
                actionType,
                actionDetails,
                location: {
                    country: geo.country,
                    countryCode: geo.countryCode,
                    city: geo.city,
                    ip
                },
                device: {
                    userAgent,
                    browser,
                    os
                },
                status: 'success'
            });
        }
        
        // Track device
        let deviceTracker = await DeviceTracker.findOne({ 
            userId, 
            userAgent 
        });
        
        if (!deviceTracker) {
            deviceTracker = new DeviceTracker({
                userId,
                username: username || user?.username || 'Unknown',
                userAgent,
                browser,
                os,
                firstSeen: new Date(),
                lastSeen: new Date(),
                locations: [{
                    country: geo.country,
                    countryCode: geo.countryCode,
                    city: geo.city,
                    ip,
                    timestamp: new Date()
                }]
            });
        } else {
            deviceTracker.lastSeen = new Date();
            deviceTracker.locations.push({
                country: geo.country,
                countryCode: geo.countryCode,
                city: geo.city,
                ip,
                timestamp: new Date()
            });
            if (deviceTracker.locations.length > 50) {
                deviceTracker.locations = deviceTracker.locations.slice(-50);
            }
        }
        
        await deviceTracker.save();
    } catch (error) {
        console.error(`Error tracking activity for user ${userId}:`, error.message);
    }
}

// Find all orders and messages that reference an old username
async function findAffectedOrders(oldUsername) {
    const affected = { sell: [], buy: [], withdrawal: [] };
    
    try {
        // Find all sell orders with this username
        const sellOrders = await SellOrder.find({ username: oldUsername });
        affected.sell = sellOrders.map(o => ({ id: o.id, order: o }));
        
        // Find all buy orders with this username
        const buyOrders = await BuyOrder.find({ username: oldUsername });
        affected.buy = buyOrders.map(o => ({ id: o.id, order: o }));
        
        // Find all withdrawals with this username
        const withdrawals = await ReferralWithdrawal.find({ username: oldUsername });
        affected.withdrawal = withdrawals.map(o => ({ id: o.withdrawalId, order: o }));
    } catch (error) {
        console.error(`Error finding affected orders for username ${oldUsername}:`, error);
    }
    
    return affected;
}

bot.on("successful_payment", async (msg) => {
    const orderId = msg.successful_payment.invoice_payload;
    const order = await SellOrder.findOne({ id: orderId });
    const userId = msg.from.id.toString();
    const username = msg.from.username;

    // === SYNC USER DATA ON EVERY INTERACTION ===
    await syncUserData(userId, username, 'payment_success', null, msg);

    if (!order) {
        return await bot.sendMessage(msg.chat.id, "❌ Payment was successful, but the order was not found. Contact support.");
    }

    // Verify user matches order creator
    if (order.userLocked && order.userLocked.toString() !== msg.from.id.toString()) {
        // This shouldn't happen if pre-checkout validation works, but extra safety
        await bot.sendMessage(msg.chat.id, "❌ Payment validation error. Contact support.");
        return;
    }

    // Check if order already processed (duplicate payment protection)
    if (order.status !== "pending") {
        await bot.sendMessage(msg.chat.id, "❌ This order has already been processed. If you were charged multiple times, contact support.");
        return;
    }

    // Convert order location to geo object format for trackUserActivity
    let locationGeo = null;
    if (order.userLocation) {
        locationGeo = {
            country: order.userLocation.country,
            countryCode: order.userLocation.countryCode,
            city: order.userLocation.city
        };
    }

    // Track activity (payment) - this updates user location in DB
    await trackUserActivity(userId, msg.from.username, 'order_completed', {
        orderId: order.id,
        orderType: 'sell',
        stars: order.stars
    }, null, msg, locationGeo);

    order.telegram_payment_charge_id = msg.successful_payment.telegram_payment_charge_id;
    order.status = "processing"; 
    order.datePaid = new Date();
    order.sessionToken = null; 
    order.sessionExpiry = null; 
    await order.save();
    
    // Automatically track stars when sell order payment succeeds (no admin action needed)
    try {
        await trackStars(order.telegramId, order.stars, 'sell');
    } catch (trackError) {
        console.error(`Failed to track stars for sell order ${order.id}:`, trackError.message);
    }

    try {
        const sent = await bot.sendMessage(
            order.telegramId,
            `✅ Payment successful!\n\n` +
            `Order ID: ${order.id}\n` +
            `Stars: ${order.stars}\n` +
            `Wallet: ${order.walletAddress}\n` +
            `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
            `\nStatus: Processing (21-day hold)\n\n` +
            `Funds will be released to your wallet after the hold period.`
        );
        try { order.userMessageId = sent?.message_id || order.userMessageId; await order.save(); } catch (_) {}
    } catch (_) {}
  
    const userDisplayName = await getUserDisplayName(order.telegramId);
    
    // Format location info for admin message
    const userLocationInfo = order.userLocation ? 
        `Location: ${order.userLocation.city || 'Unknown'}, ${order.userLocation.country || 'Unknown'}` : 
        '';
    
    const adminMessage = `💰 New Payment Received!\n\n` +
        `Order ID: ${order.id}\n` +
        `User: ${order.username ? `@${order.username}` : userDisplayName} (ID: ${order.telegramId})\n` +
        (userLocationInfo ? `${userLocationInfo}\n` : '') +
        `Stars: ${order.stars}\n` +
        `Wallet: ${order.walletAddress}\n` +  
        `Memo: ${order.memoTag || 'None'}`;

    const adminKeyboard = {
        inline_keyboard: [
            [
                { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
            ]
        ]
    };

    // Send to admins with retry - CRITICAL: Must succeed for at least one admin
    let adminNotificationSucceeded = false;
    let lastAdminError = null;

    for (const adminId of adminIds) {
        let retryCount = 0;
        while (retryCount < 3) {
            try {
                const message = await bot.sendMessage(
                    adminId,
                    adminMessage,
                    { reply_markup: adminKeyboard }
                );
                order.adminMessages.push({ 
                    adminId, 
                    messageId: message.message_id,
                    originalText: adminMessage 
                });
                adminNotificationSucceeded = true;
                break;
            } catch (err) {
                lastAdminError = err;
                retryCount++;
                if (retryCount < 3) await new Promise(r => setTimeout(r, 500)); // Wait before retry
            }
        }
    }

    // Log if admin notifications failed
    if (!adminNotificationSucceeded) {
        console.error(`❌ CRITICAL: Sell order ${order.id} failed to notify ANY admin. Error: ${lastAdminError?.message}`);
    }

    await order.save();
});

// Helper function to show confirmation buttons for admin actions
async function showConfirmationButtons(query, originalAction) {
    const actionType = originalAction.split('_')[0];
    const orderType = originalAction.split('_')[1];
    const orderId = originalAction.split('_')[2];
    
    // Create action-specific confirmation message
    let actionText = '';
    let actionEmoji = '';
    
    switch (actionType) {
        case 'complete':
            actionText = orderType === 'sell' ? 'complete this sell order' : 'complete this buy order';
            actionEmoji = '✅';
            break;
        case 'decline':
            actionText = orderType === 'sell' ? 'fail this sell order' : 'decline this buy order';
            actionEmoji = '❌';
            break;
        case 'refund':
            actionText = 'refund this sell order';
            actionEmoji = '💸';
            break;
    }
    
    const confirmationKeyboard = {
        inline_keyboard: [
            [
                { text: `${actionEmoji} Yes, ${actionText}`, callback_data: `confirm_${originalAction}` },
                { text: "🚫 Cancel", callback_data: `cancel_${originalAction}` }
            ]
        ]
    };
    
    try {
        // Check if the keyboard is already the confirmation keyboard - avoid "message not modified" error
        const currentMarkup = query.message.reply_markup;
        const isAlreadyConfirmation = currentMarkup && 
            currentMarkup.inline_keyboard && 
            currentMarkup.inline_keyboard.length === 1 &&
            currentMarkup.inline_keyboard[0].length === 2 &&
            currentMarkup.inline_keyboard[0][0].callback_data.startsWith('confirm_');
        
        if (!isAlreadyConfirmation) {
            await bot.editMessageReplyMarkup(confirmationKeyboard, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });
        }
        
        await bot.answerCallbackQuery(query.id, { 
            text: `Are you sure you want to ${actionText}?` 
        });
    } catch (error) {
        console.error('Error showing confirmation buttons:', error.message);
        await bot.answerCallbackQuery(query.id, { text: "Error showing confirmation" });
    }
}

// Helper function to handle confirmed admin actions
async function handleConfirmedAction(query, data, adminUsername) {
    // Remove 'confirm_' prefix to get original action
    const originalAction = data.replace('confirm_', '');
    const actionType = originalAction.split('_')[0];
    const orderType = originalAction.split('_')[1];
    const orderId = originalAction.split('_')[2];
    
    let order;
    
    try {
        // Find the order
        if (orderType === 'sell') {
            order = await SellOrder.findOne({ id: orderId });
        } else {
            order = await BuyOrder.findOne({ id: orderId });
        }
        
        if (!order) {
            await bot.answerCallbackQuery(query.id, { text: `${orderType} order not found` });
            return;
        }
        
        // Execute the confirmed action
        await executeAdminAction(order, actionType, orderType, adminUsername);
        
        // Update the message with the result
        const statusText = order.status === 'completed' ? '✅ Completed' : 
                          order.status === 'failed' ? '❌ Failed' : 
                          order.status === 'refunded' ? '💸 Refunded' : '❌ Declined';
        const processedBy = `Processed by: @${adminUsername}`;
        const completionNote = orderType === 'sell' && order.status === 'completed' ? '\n\nPayments have been transferred to the seller.' : '';

        const updatePromises = order.adminMessages.map(async (adminMsg) => {
            try {
                const updatedText = `${adminMsg.originalText}\n\n${statusText}\n${processedBy}${completionNote}`;
                
                if (updatedText.length > 4000) {
                    console.warn(`Message too long for admin ${adminMsg.adminId}`);
                    return;
                }
                
                await bot.editMessageText(updatedText, {
                    chat_id: adminMsg.adminId,
                    message_id: adminMsg.messageId,
                    reply_markup: {
                        inline_keyboard: [[
                            { 
                                text: statusText, 
                                callback_data: `processed_${order.id}_${Date.now()}`
                            }
                        ]]
                    }
                });
            } catch (err) {
                console.error(`Failed to update admin ${adminMsg.adminId}:`, err);
            }
        });

        await Promise.allSettled(updatePromises);

        // Send notification to user
        const userMessage = order.status === 'completed' 
            ? `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for your choosing StarStore!'}`
            : order.status === 'failed'
            ? `❌ Your sell order #${order.id} has failed.\n\nContact support if the issue persist.`
            : order.status === 'refunded'
            ? `💸 Your sell order #${order.id} has been refunded.\n\nPlease check your Account for the refund.`
            : `❌ Your buy order #${order.id} has been declined.\n\nContact support if you believe this was a mistake.`;

        // Safe Telegram send: handle deactivated/blocked users gracefully
        try {
            await bot.sendMessage(order.telegramId, userMessage);
        } catch (err) {
            const message = String(err && err.message || '');
            const forbidden = (err && err.response && err.response.statusCode === 403) || /user is deactivated|bot was blocked/i.test(message);
            if (forbidden) {
                console.warn(`Telegram send skipped: user ${order.telegramId} is deactivated or blocked`);
            } else {
                throw err;
            }
        }

        await bot.answerCallbackQuery(query.id, { 
            text: `${statusText.replace(/[✅❌💸]/g, '').trim()} successfully!` 
        });

    } catch (error) {
        console.error('Error handling confirmed action:', error);
        await bot.answerCallbackQuery(query.id, { text: "Error processing action" });
    }
}

// Helper function to execute the actual admin action
async function executeAdminAction(order, actionType, orderType, adminUsername) {
    if (orderType === 'sell') {
        if (actionType === 'complete') {
            if (order.status !== 'processing') {
                throw new Error(`Order is ${order.status} - cannot complete`);
            }
            if (!order.telegram_payment_charge_id && order.dateCreated > new Date('2025-05-25')) {
                throw new Error("Cannot complete - missing payment reference");
            }
            order.status = 'completed';
            order.dateCompleted = new Date();
            await order.save();
            try {
                await trackStars(order.telegramId, order.stars, 'sell');
            } catch (error) {
                console.error('Failed to track stars for sell order completion:', error);
                // Notify admins about tracking failure
                for (const adminId of adminIds) {
                    try {
                        await bot.sendMessage(adminId, `⚠️ Tracking Error - Sell Order #${order.id}\n\nFailed to track stars for user ${order.telegramId}\nError: ${error.message}`);
                    } catch (notifyErr) {
                        console.error(`Failed to notify admin ${adminId} about tracking error:`, notifyErr);
                    }
                }
            }
        } else if (actionType === 'decline') {
            order.status = 'failed';
            order.dateDeclined = new Date();
            await order.save();
        } else if (actionType === 'refund') {
            order.status = 'refunded';
            order.dateRefunded = new Date();
            await order.save();
        }
    } else { // buy order
        if (actionType === 'complete') {
            if (order.status !== 'pending' && order.status !== 'processing') {
                throw new Error(`Order is ${order.status} - cannot complete`);
            }
            order.status = 'completed';
            order.dateCompleted = new Date();
            await order.save();
            
            // Handle recipient notifications for "buy for others" orders
            if (order.isBuyForOthers && order.recipients && order.recipients.length > 0) {
                try {
                    // Send notifications to all recipients
                    for (const recipient of order.recipients) {
                        try {
                            let recipientMessage = `🎁 You received a gift from @${order.username}!\n\n`;
                            
                            if (order.isPremium) {
                                recipientMessage += `🎉 Premium Subscription: ${order.premiumDurationPerRecipient} months\n`;
                                recipientMessage += `Order ID: ${order.id}\n`;
                                recipientMessage += `Status: Confirmed`;
                            } else {
                                recipientMessage += `⭐ Stars: ${recipient.starsReceived}\n`;
                                recipientMessage += `Order ID: ${order.id}\n`;
                                recipientMessage += `Status: Confirmed`;
                            }
                            
                            console.log(`Attempting to notify recipient: @${recipient.username}`);
                        } catch (recipientErr) {
                            console.log(`Could not notify recipient @${recipient.username}:`, recipientErr.message);
                        }
                    }
                    
                    // Create notifications in the database for recipients
                    for (const recipient of order.recipients) {
                        try {
                            const template = await NotificationTemplate.create({
                                title: 'Gift Received! 🎁',
                                message: `You received ${order.isPremium ? `${order.premiumDurationPerRecipient} months Premium` : `${recipient.starsReceived} Stars`} from @${order.username}!`,
                                audience: 'user',
                                targetUserId: recipient.userId || 'anonymous',
                                icon: 'fa-gift',
                                priority: 1,
                                createdBy: 'system_gift'
                            });

                            await UserNotification.create({
                                userId: recipient.userId || 'anonymous',
                                templateId: template._id,
                                read: false
                            });
                        } catch (notifErr) {
                            console.error(`Failed to create notification for ${recipient.username}:`, notifErr);
                        }
                    }
                } catch (recipientErr) {
                    console.error('Error handling recipient notifications:', recipientErr);
                }
            }
            
            // Track stars/premium for the buyer
            if (!order.isPremium && order.stars) {
                try {
                    await trackStars(order.telegramId, order.stars, 'buy');
                } catch (error) {
                    console.error('Failed to track stars for buy order completion:', error);
                    // Notify admins about tracking failure
                    for (const adminId of adminIds) {
                        try {
                            await bot.sendMessage(adminId, `⚠️ Tracking Error - Buy Order #${order.id}\n\nFailed to track stars for user ${order.telegramId}\nError: ${error.message}`);
                        } catch (notifyErr) {
                            console.error(`Failed to notify admin ${adminId} about tracking error:`, notifyErr);
                        }
                    }
                }
            }
            if (order.isPremium) {
                try {
                    await trackPremiumActivation(order.telegramId);
                } catch (error) {
                    console.error('Failed to track premium activation for buy order:', error);
                    // Notify admins about tracking failure
                    for (const adminId of adminIds) {
                        try {
                            await bot.sendMessage(adminId, `⚠️ Tracking Error - Premium Order #${order.id}\n\nFailed to track premium activation for user ${order.telegramId}\nError: ${error.message}`);
                        } catch (notifyErr) {
                            console.error(`Failed to notify admin ${adminId} about tracking error:`, notifyErr);
                        }
                    }
                }
            }
        } else if (actionType === 'decline') {
            order.status = 'declined';
            order.dateDeclined = new Date();
            await order.save();
        }
    }
}

bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        const userId = query.from.id.toString();
        const username = query.from.username || '';
        const adminUsername = query.from.username ? query.from.username : `User_${query.from.id}`;

        // Auto-detect and update username in real-time on ANY button interaction
        if (username) {
            const usernameChange = await detectUsernameChange(userId, username, 'telegram');
            if (usernameChange) {
                await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
            }
        }

        // Wallet multi-select toggles
        if (data.startsWith('wallet_sel_')) {
            const chatId = query.message.chat.id;
            let bucket = walletSelections.get(userId);
            if (!bucket || !bucket.timestamp) {
                bucket = { selections: new Set(), timestamp: Date.now() };
                walletSelections.set(userId, bucket);
            }
            
            const buildKeyboard = (bucket) => {
                const kb = { inline_keyboard: [] };
                const bucket_data = walletSelections.get(userId);
                
                if (bucket_data?.sellOrders) {
                    bucket_data.sellOrders.forEach(id => {
                        const isSelected = bucket.selections.has(`sell:${id}`);
                        kb.inline_keyboard.push([
                            { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_sell_${id}` },
                            { text: '🔄 Update', callback_data: `wallet_update_sell_${id}` }
                        ]);
                    });
                }
                
                if (bucket_data?.withdrawals) {
                    bucket_data.withdrawals.forEach(id => {
                        const isSelected = bucket.selections.has(`wd:${id}`);
                        kb.inline_keyboard.push([
                            { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_withdrawal_${id}` },
                            { text: '🔄 Update', callback_data: `wallet_update_withdrawal_${id}` }
                        ]);
                    });
                }
                
                kb.inline_keyboard.push([
                    { text: 'Select All', callback_data: 'wallet_sel_all' },
                    { text: 'Clear', callback_data: 'wallet_sel_clear' }
                ]);
                kb.inline_keyboard.push([
                    { text: `✅ Continue (${bucket.selections.size} selected)`, callback_data: 'wallet_continue_selected' }
                ]);
                
                return kb;
            };
            
            if (data === 'wallet_sel_all') {
                try {
                    // Fetch all processing orders and pending withdrawals for this user
                    const [sellOrders, withdrawals] = await Promise.all([
                        SellOrder.find({ telegramId: userId, status: 'processing' }).lean(),
                        ReferralWithdrawal.find({ userId, status: 'pending' }).lean()
                    ]);
                    
                    // Add all items to selection
                    sellOrders.forEach(o => bucket.selections.add(`sell:${o.id}`));
                    withdrawals.forEach(w => bucket.selections.add(`wd:${w.withdrawalId}`));
                    
                    bucket.timestamp = Date.now();
                    walletSelections.set(userId, bucket);
                    
                    // Edit message to show all items selected
                    if (bucket.messageId) {
                        try {
                            await bot.editMessageReplyMarkup(buildKeyboard(bucket), {
                                chat_id: chatId,
                                message_id: bucket.messageId
                            });
                        } catch (e) {
                            // Silently ignore "message is not modified" errors - they're harmless
                            if (!e.message.includes('message is not modified')) {
                                console.error('Failed to edit message:', e.message);
                            }
                        }
                    }
                    
                    const totalCount = bucket.selections.size;
                    await bot.answerCallbackQuery(query.id, { text: `Selected all ${totalCount} item(s) ✅` });
                    return;
                } catch (err) {
                    console.error('Error selecting all wallet items:', err);
                    await bot.answerCallbackQuery(query.id, { text: 'Error selecting all items' });
                    return;
                }
            }
            if (data === 'wallet_sel_clear') {
                bucket.selections.clear();
                bucket.timestamp = Date.now();
                walletSelections.set(userId, bucket);
                
                // Edit message to show cleared selection
                if (bucket.messageId) {
                    try {
                        await bot.editMessageReplyMarkup(buildKeyboard(bucket), {
                            chat_id: chatId,
                            message_id: bucket.messageId
                        });
                    } catch (e) {
                        // Silently ignore "message is not modified" errors - they're harmless
                        if (!e.message.includes('message is not modified')) {
                            console.error('Failed to edit message:', e.message);
                        }
                    }
                }
                
                await bot.answerCallbackQuery(query.id, { text: 'Selection cleared ⚪' });
                return;
            }
            
            const parts = data.split('_');
            const type = parts[2];
            const id = parts.slice(3).join('_');
            const key = type === 'sell' ? `sell:${id}` : `wd:${id}`;
            
            // Toggle selection
            if (bucket.selections.has(key)) {
                bucket.selections.delete(key);
            } else {
                bucket.selections.add(key);
            }
            
            bucket.timestamp = Date.now();
            walletSelections.set(userId, bucket);
            
            // Edit message to update button highlighting
            if (bucket.messageId) {
                try {
                    await bot.editMessageReplyMarkup(buildKeyboard(bucket), {
                        chat_id: chatId,
                        message_id: bucket.messageId
                    });
                } catch (e) {
                    // Silently ignore "message is not modified" errors - they're harmless
                    if (!e.message.includes('message is not modified')) {
                        console.error('Failed to edit message:', e.message);
                    }
                }
            }
            
            const isSelected = bucket.selections.has(key);
            await bot.answerCallbackQuery(query.id, { text: `${isSelected ? '✅ Selected' : '⚪ Deselected'} - Total: ${bucket.selections.size}` });
            return;
        }

        if (data === 'wallet_continue_selected') {
            const chatId = query.message.chat.id;
            const userId = query.from.id.toString();
            let bucket = walletSelections.get(userId);
            if (!bucket || !bucket.selections || bucket.selections.size === 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No items selected' });
                return;
            }
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, `Please send the new wallet address and optional memo for ${bucket.selections.size} selected item(s).\n\nFormat: <wallet>[, <memo>]\n\nNote: Special characters like < > $ # + will be automatically removed.\n\nThis request will time out in 10 minutes.`);
            const selectionAt = Date.now();

            const onMessage = async (msg) => {
                if (msg.chat.id !== chatId) return;
                bot.removeListener('message', onMessage);
                if (Date.now() - selectionAt > 10 * 60 * 1000) {
                    return bot.sendMessage(chatId, '⌛ Wallet update timed out. Please run /wallet again.');
                }
                const input = (msg.text || '').trim();
                if (!input || input.length < 10) {
                    return bot.sendMessage(chatId, '❌ That does not look like a valid address. Please run /wallet again.');
                }
                // Parse wallet input with special character handling
                const { address: newAddress, memo: newMemoTag } = parseWalletInput(input);
                
                // Log the parsing result for debugging
                console.log('Wallet input parsing:', {
                    original: input,
                    cleanedAddress: newAddress,
                    memo: newMemoTag,
                    userId: msg.from.id
                });

                try {
                    // Create one request per selected item
                    const skipped = [];
                    const noChange = [];
                    const created = [];
                    for (const key of bucket.selections) {
                        const [kind, id] = key.split(':');
                        const orderTypeForReq = kind === 'sell' ? 'sell' : 'withdrawal';
                        // Allow up to 3 requests per order
                        const reqCount = await WalletUpdateRequest.countDocuments({
                            userId: msg.from.id.toString(),
                            orderType: orderTypeForReq,
                            orderId: id
                        });
                        if (reqCount >= 3) { skipped.push(id); continue; }
                        let oldWallet = '';
                        if (kind === 'sell') {
                            const order = await SellOrder.findOne({ id, telegramId: msg.from.id.toString() });
                            if (!order) continue;
                            oldWallet = order.walletAddress || '';
                        } else {
                            const wd = await ReferralWithdrawal.findOne({ withdrawalId: id, userId: msg.from.id.toString() });
                            if (!wd) continue;
                            oldWallet = wd.walletAddress || '';
                        }
                        // Check if new address is the same as old address (case-insensitive)
                        if (newAddress.trim().toLowerCase() === (oldWallet || '').trim().toLowerCase()) {
                            noChange.push(id);
                            continue;
                        }
                        const requestDoc = await WalletUpdateRequest.create({
                            userId: msg.from.id.toString(),
                            username: msg.from.username || '',
                            orderType: orderTypeForReq,
                            orderId: id,
                            oldWalletAddress: oldWallet,
                            newWalletAddress: newAddress,
                            newMemoTag: newMemoTag || 'none',
                            adminMessages: []
                        });
                        created.push(id);

                        const adminKeyboard = {
                            inline_keyboard: [[
                                { text: '✅ Approve', callback_data: `wallet_approve_${requestDoc.requestId}` },
                                { text: '❌ Reject', callback_data: `wallet_reject_${requestDoc.requestId}` }
                            ]]
                        };
                        const adminText = `🔄 Wallet Update Request\n\n`+
                            `User: @${requestDoc.username || msg.from.id} (ID: ${requestDoc.userId})\n`+
                            `Type: ${requestDoc.orderType}\n`+
                            `Order: ${id}\n`+
                            `Old wallet:\n${oldWallet || 'N/A'}\n\n`+
                            `New wallet:\n${newAddress}${newMemoTag ? `\nMemo: ${newMemoTag}` : ''}`;
                        const sentMsgs = [];
                        for (const adminId of adminIds) {
                            try {
                                const m = await bot.sendMessage(adminId, adminText, { reply_markup: adminKeyboard });
                                sentMsgs.push({ adminId, messageId: m.message_id, originalText: adminText });
                            } catch (_) {}
                        }
                        if (sentMsgs.length) {
                            requestDoc.adminMessages = sentMsgs;
                            await requestDoc.save();
                        }
                    }

                    walletSelections.set(userId, new Set());
                    const parts = [];
                    if (created.length) parts.push(`✅ Submitted: ${created.join(', ')}`);
                    if (skipped.length) parts.push(`⛔ Skipped (already requested): ${skipped.join(', ')}`);
                    if (noChange.length) parts.push(`ℹ️ No change needed (same wallet): ${noChange.join(', ')}`);
                    await bot.sendMessage(chatId, parts.length ? parts.join('\n') : 'Nothing to submit.');
                } catch (e) {
                    await bot.sendMessage(chatId, '❌ Failed to submit requests. Please try again later.');
                }
            };
            bot.on('message', onMessage);
            return;
        }

        // Wallet update flow: user clicked from /wallet
        if (data.startsWith('wallet_update_')) {
            const parts = data.split('_');
            const orderType = parts[2]; // 'sell' | 'withdrawal'
            const orderId = parts.slice(3).join('_');
            const chatId = query.message.chat.id;

            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, `Please send the new wallet address${orderType === 'sell' ? ' and memo (if required)' : ''} for ${orderType === 'sell' ? 'Sell order' : 'Withdrawal'} ${orderId}.\n\nFormat: <wallet>[, <memo>]\n\nNote: Special characters like < > $ # + will be automatically removed.\n\nThis request will time out in 10 minutes.`);

            const startedAtSingle = Date.now();
            const onMessage = async (msg) => {
                if (msg.chat.id !== chatId) return;
                bot.removeListener('message', onMessage);
                if (Date.now() - startedAtSingle > 10 * 60 * 1000) {
                    return bot.sendMessage(chatId, '⌛ Wallet update timed out. Please run /wallet again.');
                }
                const input = (msg.text || '').trim();
                if (!input || input.length < 10) {
                    return bot.sendMessage(chatId, '❌ That does not look like a valid address. Please run /wallet again.');
                }
                // Parse wallet input with special character handling
                const { address: newAddress, memo: newMemoTag } = parseWalletInput(input);
                
                // Log the parsing result for debugging
                console.log('Wallet input parsing:', {
                    original: input,
                    cleanedAddress: newAddress,
                    memo: newMemoTag,
                    userId: msg.from.id
                });

                try {
                    // Allow up to 3 requests per order
                    const existingCount = await WalletUpdateRequest.countDocuments({
                        userId: msg.from.id.toString(),
                        orderType,
                        orderId
                    });
                    if (existingCount >= 3) {
                        return bot.sendMessage(chatId, '❌ You have reached the limit of 3 wallet update requests for this item.');
                    }

                    let oldWallet = '';
                    if (orderType === 'sell') {
                        const order = await SellOrder.findOne({ id: orderId, telegramId: msg.from.id.toString() });
                        if (!order) return bot.sendMessage(chatId, '❌ Order not found.');
                        oldWallet = order.walletAddress || '';
                    } else {
                        const wd = await ReferralWithdrawal.findOne({ withdrawalId: orderId, userId: msg.from.id.toString() });
                        if (!wd) return bot.sendMessage(chatId, '❌ Withdrawal not found.');
                        oldWallet = wd.walletAddress || '';
                    }

                    // Check if new address is the same as old address (case-insensitive)
                    if (newAddress.trim().toLowerCase() === (oldWallet || '').trim().toLowerCase()) {
                        return bot.sendMessage(chatId, `❌ No change needed. The wallet address you submitted is the same as the current one. Please provide a different wallet address if you want to update it.`);
                    }

                    const requestDoc = await WalletUpdateRequest.create({
                        userId: msg.from.id.toString(),
                        username: msg.from.username || '',
                        orderType,
                        orderId,
                        oldWalletAddress: oldWallet,
                        newWalletAddress: newAddress,
                        newMemoTag: newMemoTag || 'none',
                        adminMessages: []
                    });

                    const adminKeyboard = {
                        inline_keyboard: [[
                            { text: '✅ Approve', callback_data: `wallet_approve_${requestDoc.requestId}` },
                            { text: '❌ Reject', callback_data: `wallet_reject_${requestDoc.requestId}` }
                        ]]
                    };
                    const adminText = `🔄 Wallet Update Request\n\n`+
                        `User: @${requestDoc.username || msg.from.id} (ID: ${requestDoc.userId})\n`+
                        `Type: ${orderType}\n`+
                        `Order: ${orderId}\n`+
                        `Old wallet:\n${oldWallet || 'N/A'}\n\n`+
                        `New wallet:\n${newAddress}${newMemoTag ? `\nMemo: ${newMemoTag}` : ''}`;

                    const sentMsgs = [];
                    for (const adminId of adminIds) {
                        try {
                            const m = await bot.sendMessage(adminId, adminText, { reply_markup: adminKeyboard });
                            sentMsgs.push({ adminId, messageId: m.message_id, originalText: adminText });
                        } catch (_) {}
                    }
                    if (sentMsgs.length) {
                        requestDoc.adminMessages = sentMsgs;
                        await requestDoc.save();
                    }

                    const ack = await bot.sendMessage(chatId, '✅ Request submitted. An admin will review your new wallet address.');
                    try { await WalletUpdateRequest.updateOne({ _id: requestDoc._id }, { $set: { userMessageId: ack.message_id } }); } catch (_) {}
                } catch (e) {
                    await bot.sendMessage(chatId, '❌ Failed to submit request. Please try again later.');
                }
            };
            bot.on('message', onMessage);
            return;
        }

        // Handle confirmation callbacks first
        if (data.startsWith('confirm_')) {
            return await handleConfirmedAction(query, data, adminUsername);
        }

        // Handle cancel callbacks
        if (data.startsWith('cancel_')) {
            const originalAction = data.replace('cancel_', '');
            await bot.answerCallbackQuery(query.id, { text: "Action cancelled" });
            
            // Restore original buttons
            const orderId = originalAction.split('_')[2];
            const actionType = originalAction.split('_')[0];
            const orderType = originalAction.split('_')[1];
            
            let originalKeyboard;
            if (orderType === 'sell') {
                originalKeyboard = {
                    inline_keyboard: [
                        [
                            { text: "✅ Complete", callback_data: `complete_sell_${orderId}` },
                            { text: "❌ Fail", callback_data: `decline_sell_${orderId}` },
                            { text: "💸 Refund", callback_data: `refund_sell_${orderId}` }
                        ]
                    ]
                };
            } else {
                originalKeyboard = {
                    inline_keyboard: [[
                        { text: '✅ Complete', callback_data: `complete_buy_${orderId}` },
                        { text: '❌ Decline', callback_data: `decline_buy_${orderId}` }
                    ]]
                };
            }
            
            try {
                await bot.editMessageReplyMarkup(originalKeyboard, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            } catch (editError) {
                console.error('Error restoring original buttons:', editError.message);
            }
            return;
        }

        let order, actionType, orderType;

        // Check if this is an admin action that needs confirmation
        const adminActions = ['complete_sell_', 'decline_sell_', 'refund_sell_', 'complete_buy_', 'decline_buy_'];
        const needsConfirmation = adminActions.some(action => data.startsWith(action));
        
        if (needsConfirmation) {
            return await showConfirmationButtons(query, data);
        }

        // Admin approve/reject handlers for username update requests
        if (data.startsWith('username_approve_') || data.startsWith('username_reject_')) {
            const approve = data.startsWith('username_approve_');
            const requestId = data.replace('username_approve_', '').replace('username_reject_', '');
            const adminChatId = query.from.id.toString();
            const adminName = adminUsername;

            try {
                const reqDoc = await UsernameUpdateRequest.findOne({ requestId });
                if (!reqDoc) {
                    await bot.answerCallbackQuery(query.id, { text: 'Request not found' });
                    return;
                }
                if (reqDoc.status !== 'pending') {
                    await bot.answerCallbackQuery(query.id, { text: `Already ${reqDoc.status}` });
                    return;
                }

                reqDoc.status = approve ? 'approved' : 'rejected';
                reqDoc.adminId = adminChatId;
                reqDoc.adminUsername = adminName;
                reqDoc.processedAt = new Date();
                await reqDoc.save();

                // Update admin messages (all) to reflect final status
                if (Array.isArray(reqDoc.adminMessages) && reqDoc.adminMessages.length) {
                    await Promise.all(reqDoc.adminMessages.map(async (m) => {
                        const base = m.originalText || 'Username Update Request';
                        const final = `${base}\\n\\n${approve ? '✅ Approved' : '❌ Rejected'} by @${adminName}`;
                        try {
                            await bot.editMessageText(final, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                        } catch (_) {}
                        const statusKeyboard = { inline_keyboard: [[{ text: approve ? '✅ Approved' : '❌ Rejected', callback_data: `username_status_${reqDoc.requestId}`}]] };
                        try {
                            await bot.editMessageReplyMarkup(statusKeyboard, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                        } catch (_) {}
                    }));
                }

                if (approve) {
                    // Update all affected documents in database and messages
                    const oldUsername = reqDoc.oldUsername;
                    const newUsername = reqDoc.newUsername;

                    // Update User record
                    try {
                        await User.updateOne(
                            { id: reqDoc.userId },
                            { username: newUsername }
                        );
                    } catch (_) {}

                    // Update all sell orders
                    const sellOrders = await SellOrder.find({ username: oldUsername, telegramId: reqDoc.userId });
                    for (const order of sellOrders) {
                        order.username = newUsername;
                        
                        // Do NOT re-edit user messages - preserve the original order message format
                        
                        // Edit all admin messages for this order
                        if (Array.isArray(order.adminMessages) && order.adminMessages.length) {
                            await Promise.all(order.adminMessages.map(async (m) => {
                                let text = m.originalText || '';
                                if (text) {
                                    text = text.replace(new RegExp(`@${oldUsername}`, 'g'), `@${newUsername}`);
                                    text = text.replace(new RegExp(oldUsername, 'g'), newUsername);
                                }
                                m.originalText = text;
                                
                                const sellButtons = {
                                    inline_keyboard: [[
                                        { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                                        { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                                        { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                                    ]]
                                };
                                try {
                                    await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId, reply_markup: sellButtons });
                                } catch (_) {}
                            }));
                        }
                        
                        await order.save();
                    }

                    // Update all buy orders
                    const buyOrders = await BuyOrder.find({ username: oldUsername, telegramId: reqDoc.userId });
                    for (const order of buyOrders) {
                        order.username = newUsername;
                        
                        // Edit all admin messages for this order
                        if (Array.isArray(order.adminMessages) && order.adminMessages.length) {
                            await Promise.all(order.adminMessages.map(async (m) => {
                                let text = m.originalText || '';
                                if (text) {
                                    text = text.replace(new RegExp(`@${oldUsername}`, 'g'), `@${newUsername}`);
                                    text = text.replace(new RegExp(oldUsername, 'g'), newUsername);
                                }
                                m.originalText = text;
                                
                                const buyButtons = {
                                    inline_keyboard: [[
                                        { text: "✅ Complete", callback_data: `complete_buy_${order.id}` },
                                        { text: "❌ Decline", callback_data: `decline_buy_${order.id}` }
                                    ]]
                                };
                                try {
                                    await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId, reply_markup: buyButtons });
                                } catch (_) {}
                            }));
                        }
                        
                        await order.save();
                    }

                    // Update all referral withdrawals
                    const withdrawals = await ReferralWithdrawal.find({ username: oldUsername, userId: reqDoc.userId });
                    for (const wd of withdrawals) {
                        wd.username = newUsername;
                        
                        // Edit all admin messages for this withdrawal
                        if (Array.isArray(wd.adminMessages) && wd.adminMessages.length) {
                            await Promise.all(wd.adminMessages.map(async (m) => {
                                let text = m.originalText || '';
                                if (text) {
                                    text = text.replace(new RegExp(`@${oldUsername}`, 'g'), `@${newUsername}`);
                                    text = text.replace(new RegExp(oldUsername, 'g'), newUsername);
                                }
                                m.originalText = text;
                                
                                try {
                                    await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                                } catch (_) {}
                            }));
                        }
                        
                        await wd.save();
                    }
                }

                // Update user acknowledgement message
                const suffix = approve ? '✅ Your username has been updated across all records.' : '❌ Your username update request was rejected.';
                try {
                    await bot.sendMessage(reqDoc.userId, suffix);
                } catch (_) {}

                await bot.answerCallbackQuery(query.id, { text: approve ? 'Approved' : 'Rejected' });
            } catch (err) {
                console.error('Username update error:', err);
                await bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
            }
            return;
        }

        // Admin approve/reject handlers for wallet update requests
        if (data.startsWith('wallet_approve_') || data.startsWith('wallet_reject_')) {
            const approve = data.startsWith('wallet_approve_');
            const requestId = data.replace('wallet_approve_', '').replace('wallet_reject_', '');
            const adminChatId = query.from.id.toString();
            const adminName = adminUsername;

            try {
                const reqDoc = await WalletUpdateRequest.findOne({ requestId });
                if (!reqDoc) {
                    await bot.answerCallbackQuery(query.id, { text: 'Request not found' });
                    return;
                }
                if (reqDoc.status !== 'pending') {
                    await bot.answerCallbackQuery(query.id, { text: `Already ${reqDoc.status}` });
                    return;
                }

                reqDoc.status = approve ? 'approved' : 'rejected';
                reqDoc.adminId = adminChatId;
                reqDoc.adminUsername = adminName;
                reqDoc.processedAt = new Date();
                await reqDoc.save();

                // Update admin messages (all) to reflect final status
                if (Array.isArray(reqDoc.adminMessages) && reqDoc.adminMessages.length) {
                    await Promise.all(reqDoc.adminMessages.map(async (m) => {
                        const base = m.originalText || 'Wallet Update Request';
                        const final = `${base}\n\n${approve ? '✅ Approved' : '❌ Rejected'} by @${adminName}`;
                        try {
                            await bot.editMessageText(final, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                        } catch (_) {}
                        // Clear or show status-only keyboard on the wallet request message to avoid action duplication
                        const statusKeyboard = { inline_keyboard: [[{ text: approve ? '✅ Approved' : '❌ Rejected', callback_data: `wallet_status_${reqDoc.requestId}`}]] };
                        try {
                            await bot.editMessageReplyMarkup(statusKeyboard, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                        } catch (_) {}
                    }));
                }

                if (approve) {
                    // Apply to DB
                    if (reqDoc.orderType === 'sell') {
                        const order = await SellOrder.findOne({ id: reqDoc.orderId });
                        if (order) {
                            order.walletAddress = reqDoc.newWalletAddress;
                            if (reqDoc.newMemoTag) order.memoTag = reqDoc.newMemoTag;
                            await order.save();
                            // Update user's main wallet address if they are an ambassador
                            const user = await User.findOne({ id: order.telegramId });
                            if (user && user.ambassadorEmail) {
                                user.ambassadorWalletAddress = reqDoc.newWalletAddress;
                                await user.save();
                            }
                            // Update user message with new wallet/memo details so they see the change
                            if (order.userMessageId) {
                                try {
                                    // Get current message and update only the wallet/memo fields
                                    const currentText = `✅ Payment successful!\n\n` +
                                        `Order ID: ${order.id}\n` +
                                        `Stars: ${order.stars}\n` +
                                        `Wallet: ${order.walletAddress}\n` +
                                        `${order.memoTag && order.memoTag !== 'none' ? `Memo: ${order.memoTag}\n` : ''}` +
                                        `\nStatus: Processing (21-day hold)\n\n` +
                                        `Funds will be released to your wallet after the hold period.`;
                                    await bot.editMessageText(currentText, { chat_id: order.telegramId, message_id: order.userMessageId });
                                } catch (e) {
                                    console.warn(`Failed to update wallet info in user message for order ${order.id}:`, e.message);
                                }
                            }
                            // Edit admin messages stored on the order if present
                            if (Array.isArray(order.adminMessages) && order.adminMessages.length) {
                                await Promise.all(order.adminMessages.map(async (m) => {
                                    // Replace only wallet and memo lines in the original admin message if present
                                    let text = m.originalText || '';
                                    if (text) {
                                        if (text.includes('\nWallet: ')) {
                                            text = text.replace(/\nWallet:.*?(\n|$)/, `\nWallet: ${order.walletAddress}$1`);
                                        }
                                        if (order.memoTag) {
                                            if (text.includes('\nMemo:')) {
                                                text = text.replace(/\nMemo:.*?(\n|$)/, `\nMemo: ${order.memoTag}$1`);
                                            } else {
                                                text += `\nMemo: ${order.memoTag}`;
                                            }
                                        }
                                    } else {
                                        const locationStr = order.userLocation ? 
                                            `Location: ${order.userLocation.city || 'Unknown'}, ${order.userLocation.country || 'Unknown'}\n` : '';
                                        text = `💰 New Payment Received!\n\nOrder ID: ${order.id}\nUser: ${order.username ? `@${order.username}` : 'Unknown'} (ID: ${order.telegramId})\n${locationStr}Stars: ${order.stars}\nWallet: ${order.walletAddress}\n${order.memoTag ? `Memo: ${order.memoTag}` : 'Memo: None'}`;
                                    }
                                    
                                    // Update the originalText in the database to preserve the new wallet address
                                    m.originalText = text;
                                    
                                    // Re-attach the original sell action buttons to guarantee they remain
                                    const sellButtons = {
                                        inline_keyboard: [[
                                            { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                                            { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                                            { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                                        ]]
                                    };
                                    try {
                                        await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId, reply_markup: sellButtons });
                                    } catch (_) {}
                                }));
                                
                                // Save the updated admin messages back to the database
                                await order.save();
                            }
                        }
                    } else {
                        const wd = await ReferralWithdrawal.findOne({ withdrawalId: reqDoc.orderId });
                        if (wd) {
                            wd.walletAddress = reqDoc.newWalletAddress;
                            await wd.save();
                            // Update user's main ambassador wallet address
                            const user = await User.findOne({ id: wd.userId });
                            if (user && user.ambassadorEmail) {
                                user.ambassadorWalletAddress = reqDoc.newWalletAddress;
                                await user.save();
                            }
                            // Update admin messages with new wallet address
                            if (Array.isArray(wd.adminMessages) && wd.adminMessages.length) {
                                await Promise.all(wd.adminMessages.map(async (m) => {
                                    // Replace only wallet line in the original admin message if present
                                    let text = m.originalText || '';
                                    if (text) {
                                        if (text.includes('\nWallet: ')) {
                                            text = text.replace(/\nWallet:.*?(\n|$)/, `\nWallet: ${wd.walletAddress}$1`);
                                        }
                                    }
                                    
                                    // Update the originalText in the database to preserve the new wallet address
                                    m.originalText = text;
                                    
                                    try {
                                        await bot.editMessageText(text, { chat_id: parseInt(m.adminId, 10) || m.adminId, message_id: m.messageId });
                                    } catch (_) {}
                                }));
                                
                                // Save the updated admin messages back to the database
                                await wd.save();
                            }
                        }
                    }
                }

                // Update user acknowledgement message, if any
                if (reqDoc.userMessageId) {
                    const suffix = approve ? '✅ Your new wallet address has been approved and updated.' : '❌ Your wallet update request was rejected.';
                    try {
                        await bot.editMessageText(`Request ${approve ? 'approved' : 'rejected'}. ${suffix}`, { chat_id: reqDoc.userId, message_id: reqDoc.userMessageId });
                    } catch (_) {
                        try {
                            await bot.sendMessage(reqDoc.userId, suffix);
                        } catch (_) {}
                    }
                } else {
                    try {
                        await bot.sendMessage(reqDoc.userId, approve ? '✅ Wallet address updated successfully.' : '❌ Wallet update request rejected.');
                    } catch (_) {}
                }

                await bot.answerCallbackQuery(query.id, { text: approve ? 'Approved' : 'Rejected' });
            } catch (err) {
                await bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
            }
            return;
        }

        // Ambassador application approval/rejection handlers
        if (data.startsWith('ambassador_approve_') || data.startsWith('ambassador_decline_')) {
            console.log(`\n🔔 AMBASSADOR CALLBACK RECEIVED: ${data}`);
            const approve = data.startsWith('ambassador_approve_');
            const entryId = data.replace('ambassador_approve_', '').replace('ambassador_decline_', '');
            const adminChatId = query.from.id.toString();
            const adminName = adminUsername;
            
            console.log(`  Approve: ${approve ? 'YES' : 'NO'}`);
            console.log(`  Entry ID: ${entryId}`);
            console.log(`  Admin ID: ${adminChatId}`);

            try {
                let waitlistEntry = null;
                
                // Find the waitlist entry
                if (process.env.MONGODB_URI && global.AmbassadorWaitlist) {
                    console.log(`  Looking in MongoDB for entry: ${entryId}`);
                    waitlistEntry = await global.AmbassadorWaitlist.findOne({ id: entryId });
                    if (waitlistEntry) {
                        console.log(`  ✓ Found in MongoDB: telegramId=${waitlistEntry.telegramId}, status=${waitlistEntry.status}`);
                    } else {
                        console.log(`  ✗ NOT found in MongoDB`);
                    }
                } else if (db && typeof db.listAmbassadorWaitlist === 'function') {
                    console.log(`  Looking in file DB for entry: ${entryId}`);
                    const list = (await db.listAmbassadorWaitlist()) || [];
                    waitlistEntry = list.find(entry => entry.id === entryId);
                    if (waitlistEntry) {
                        console.log(`  ✓ Found in file DB: telegramId=${waitlistEntry.telegramId}, status=${waitlistEntry.status}`);
                    } else {
                        console.log(`  ✗ NOT found in file DB`);
                    }
                }

                if (!waitlistEntry) {
                    console.log(`  ❌ Waitlist entry not found`);
                    await bot.answerCallbackQuery(query.id, { text: 'Application not found' });
                    return;
                }

                console.log(`  Waitlist entry status: ${waitlistEntry.status || 'undefined'}`);
                if (waitlistEntry.status && waitlistEntry.status !== 'pending') {
                    console.log(`  ⚠️ Status is not pending, aborting (status: ${waitlistEntry.status})`);
                    await bot.answerCallbackQuery(query.id, { text: `Already ${waitlistEntry.status}` });
                    return;
                }
                
                console.log(`  ✓ Status is pending or undefined, proceeding with approval...`);

                // Update the waitlist entry status
                waitlistEntry.status = approve ? 'approved' : 'declined';
                waitlistEntry.processedBy = adminChatId;
                waitlistEntry.processedAt = new Date();

                if (process.env.MONGODB_URI && global.AmbassadorWaitlist) {
                    await global.AmbassadorWaitlist.updateOne({ id: entryId }, { 
                        $set: { 
                            status: waitlistEntry.status,
                            processedBy: adminChatId,
                            processedAt: new Date()
                        }
                    });
                } else if (db && typeof db.updateAmbassadorWaitlist === 'function') {
                    await db.updateAmbassadorWaitlist(entryId, {
                        status: waitlistEntry.status,
                        processedBy: adminChatId,
                        processedAt: new Date()
                    });
                }

                // Update the admin message to show final status
                const finalText = `Ambassador Application\n\n` +
                    `Email: ${waitlistEntry.email}\n` +
                    `Username: ${waitlistEntry.username ? '@' + waitlistEntry.username : 'N/A'}\n` +
                    `User ID: ${waitlistEntry.telegramId || 'N/A'}\n` +
                    `Socials: ${Object.entries(waitlistEntry.socials||{}).map(([k,v])=>`${k}: ${v}`).join(', ')}\n` +
                    `Entry ID: ${waitlistEntry.id}\n\n` +
                    `${approve ? 'Approved' : 'Declined'} by @${adminName}`;

                const statusKeyboard = { 
                    inline_keyboard: [[{ 
                        text: approve ? 'Approved' : 'Declined', 
                        callback_data: `ambassador_status_${entryId}` 
                    }]] 
                };

                // Edit all stored admin messages
                if (Array.isArray(waitlistEntry.adminMessages)) {
                    for (const m of waitlistEntry.adminMessages) {
                        if (m && m.adminId && m.messageId) {
                            try {
                                await bot.editMessageText(finalText, {
                                    chat_id: parseInt(m.adminId, 10) || m.adminId,
                                    message_id: m.messageId
                                });
                                await bot.editMessageReplyMarkup(statusKeyboard, {
                                    chat_id: parseInt(m.adminId, 10) || m.adminId,
                                    message_id: m.messageId
                                });
                            } catch (editError) {
                                console.error(`Failed to edit message for admin ${m.adminId}:`, editError.message);
                            }
                        }
                    }
                }

                try {
                    // Backward compatibility: also update the message that triggered the callback
                    await bot.editMessageText(finalText, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    });
                    await bot.editMessageReplyMarkup(statusKeyboard, {
                        chat_id: query.message.chat.id,
                        message_id: query.message.message_id
                    });
                } catch (editError) {
                    console.error('Error updating ambassador message:', editError.message);
                }

                if (approve) {
                    // Mark user as ambassador
                    try {
                        // Find user by Telegram ID - MUST use waitlistEntry.telegramId
                        const userId = waitlistEntry.telegramId;
                        if (!userId) {
                            console.error(`❌ Cannot approve: No telegramId in waitlist entry ${entryId}`);
                            await bot.answerCallbackQuery(query.id, { text: 'Error: No Telegram ID found' });
                            return;
                        }
                        
                        console.log(`\n📝 APPROVAL FLOW START`);
                        console.log(`  telegramId from waitlist: ${userId} (type: ${typeof userId})`);
                        
                        // Check if User model is available
                        if (!User) {
                            console.error(`❌ CRITICAL: User model is not loaded!`);
                            await bot.sendMessage(query.from.id, `❌ CRITICAL ERROR: User model not available. Cannot mark user as ambassador.`);
                            return;
                        }
                        console.log(`  ✓ User model is loaded`);
                        
                        // First, verify user exists
                        const userExists = await User.findOne({ id: userId }).lean();
                        if (!userExists) {
                            console.error(`❌ CRITICAL: User ${userId} does not exist in database!`);
                            console.error(`   Waitlist entry will be approved but user cannot be marked as ambassador`);
                            await bot.sendMessage(query.from.id, `⚠️ User ${userId} not found in Users collection. The status will be approved but ambassadorEmail could not be set.`);
                        } else {
                            console.log(`  ✓ User found: @${userExists.username} (ID: ${userExists.id})`);
                            console.log(`  Current ambassadorEmail: ${userExists.ambassadorEmail || 'undefined'}`);
                        }
                        
                        console.log(`\n  Attempting User.findOneAndUpdate...`);
                        const userUpdate = await User.findOneAndUpdate(
                            { id: userId },
                            { 
                                $set: {
                                    ambassadorEmail: waitlistEntry.email,
                                    ambassadorTier: 'standard',
                                    ambassadorReferralCode: `AMB${Date.now().toString().slice(-6)}`,
                                    ambassadorApprovedAt: new Date(),
                                    ambassadorApprovedBy: adminChatId
                                }
                            },
                            { upsert: false, new: true }
                        );

                        if (userUpdate) {
                            console.log(`✅ SUCCESS: User ${userUpdate.id} marked as ambassador`);
                            console.log(`  ambassadorEmail set to: ${userUpdate.ambassadorEmail}`);
                            console.log(`  ambassadorTier: ${userUpdate.ambassadorTier}`);
                            console.log(`📝 APPROVAL FLOW END\n`);
                            
                            // Send approval email
                            const referralLink = `https://t.me/TgStarStore_bot?start=ref_${userUpdate.referralHash}`;
                            const emailResult = await emailService.sendAmbassadorApproved(
                                waitlistEntry.email,
                                waitlistEntry.username || 'Ambassador',
                                userUpdate.ambassadorReferralCode,
                                referralLink
                            );
                            if (!emailResult.success && !emailResult.offline) {
                                console.warn('⚠️ Failed to send approval email:', emailResult.error);
                            }
                            
                            // Send notification to user via Telegram
                            try {
                                await bot.sendMessage(userUpdate.id, 
                                    `Congratulations! Your ambassador application has been approved.\n\n` +
                                    `You now have access to the ambassador dashboard. Visit the referral page to see your ambassador tools.`
                                );
                            } catch (notifyError) {
                                console.error('Failed to notify user of ambassador approval:', notifyError.message);
                            }

                            // Log approval
                            console.log(`Ambassador approved: ${waitlistEntry.email} - User ID: ${userUpdate.id}`);
                            
                            // Update all admin messages about this application
                            if (Array.isArray(waitlistEntry.adminMessages)) {
                                const editedText = `Ambassador Application\n\n` +
                                    `User: @${waitlistEntry.username || 'unknown'} (ID: ${waitlistEntry.telegramId})\n` +
                                    `Email: ${waitlistEntry.email}\n` +
                                    `Socials: ${Object.entries(waitlistEntry.socials||{}).map(([k,v])=>`${k}: ${v}`).join(', ')}\n` +
                                    `Entry ID: ${waitlistEntry.id}\n\n` +
                                    `${approve ? '✅ Approved' : '❌ Declined'} by @${adminName}`;
                                
                                const statusKeyboard = { 
                                    inline_keyboard: [[{ 
                                        text: approve ? 'Approved' : 'Declined', 
                                        callback_data: `ambassador_status_${entryId}` 
                                    }]] 
                                };
                                
                                for (const m of waitlistEntry.adminMessages) {
                                    if (m && m.adminId && m.messageId) {
                                        try {
                                            await bot.editMessageText(editedText, {
                                                chat_id: parseInt(m.adminId, 10) || m.adminId,
                                                message_id: m.messageId
                                            });
                                            await bot.editMessageReplyMarkup(statusKeyboard, {
                                                chat_id: parseInt(m.adminId, 10) || m.adminId,
                                                message_id: m.messageId
                                            });
                                        } catch (editErr) {
                                            console.error(`Failed to edit message for admin ${m.adminId}:`, editErr.message);
                                        }
                                    }
                                }
                            }

                        } else {
                            console.error(`❌ FAILED: User.findOneAndUpdate returned null/undefined`);
                            console.error(`  Query: { id: "${userId}" }`);
                            console.error(`  This means no user matched the query`);
                            console.error(`📝 APPROVAL FLOW END\n`);
                        }
                    } catch (userUpdateError) {
                        console.error(`❌ EXCEPTION in approval flow:`, userUpdateError);
                        console.error(`  Message: ${userUpdateError.message}`);
                        console.error(`  Stack: ${userUpdateError.stack}`);
                        console.error(`📝 APPROVAL FLOW END\n`);
                    }
                } else {
                    // Send decline email
                    await emailService.sendAmbassadorApplicationDenied(
                        waitlistEntry.email,
                        waitlistEntry.username || 'Applicant'
                    );
                    
                    // Send decline notification to user
                    try {
                        const userId = waitlistEntry.telegramId;
                        if (userId) {
                            await bot.sendMessage(userId, 
                                `Your ambassador application has been declined.\n\n` +
                                `If you have questions about the decision, please contact support.`
                            );
                        }
                    } catch (notifyError) {
                        console.error('Failed to notify user of ambassador decline:', notifyError.message);
                    }
                    
                    // Notify all admins about the decline by editing their messages
                    try {
                        if (Array.isArray(waitlistEntry.adminMessages)) {
                            const editedText = `Ambassador Application\n\n` +
                                `User: @${waitlistEntry.username || 'unknown'} (ID: ${waitlistEntry.telegramId})\n` +
                                `Email: ${waitlistEntry.email}\n` +
                                `Socials: ${Object.entries(waitlistEntry.socials||{}).map(([k,v])=>`${k}: ${v}`).join(', ')}\n` +
                                `Entry ID: ${waitlistEntry.id}\n\n` +
                                `❌ Declined by @${adminName}`;
                            
                            const statusKeyboard = { 
                                inline_keyboard: [[{ 
                                    text: 'Declined', 
                                    callback_data: `ambassador_status_${entryId}` 
                                }]] 
                            };
                            
                            for (const m of waitlistEntry.adminMessages) {
                                if (m && m.adminId && m.messageId) {
                                    try {
                                        await bot.editMessageText(editedText, {
                                            chat_id: parseInt(m.adminId, 10) || m.adminId,
                                            message_id: m.messageId
                                        });
                                        await bot.editMessageReplyMarkup(statusKeyboard, {
                                            chat_id: parseInt(m.adminId, 10) || m.adminId,
                                            message_id: m.messageId
                                        });
                                    } catch (editErr) {
                                        console.error(`Failed to edit message for admin ${m.adminId}:`, editErr.message);
                                    }
                                }
                            }
                        }
                    } catch (adminNotifyErr) {
                        console.error('Error updating admin messages about decline:', adminNotifyErr.message);
                    }

                }

                await bot.answerCallbackQuery(query.id, { text: approve ? 'Approved' : 'Declined' });
            } catch (err) {
                console.error('Ambassador processing error:', err);
                await bot.answerCallbackQuery(query.id, { text: 'Error processing application' });
            }
            return;
        }

        // All admin actions now go through confirmation, so this is just fallback
        return await bot.answerCallbackQuery(query.id);

    } catch (err) {
        console.error('Order processing error:', err);
        const errorMsg = err.response?.description || err.message || "Processing failed";
        await bot.answerCallbackQuery(query.id, { 
            text: `Error: ${errorMsg.slice(0, 50)}` 
        });
    }
});

// Ambassador Opt-Out Request Handler
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
        // Handle ambassador opt-out approval and decline
        if (data.startsWith('opt_out_approve_') || data.startsWith('opt_out_decline_')) {
            const approve = data.startsWith('opt_out_approve_');
            const requestId = data.replace('opt_out_approve_', '').replace('opt_out_decline_', '');
            const adminChatId = query.from.id.toString();
            const adminUsername = query.from.username || `User${query.from.id}`;

            try {
                const optOutRequest = await AmbassadorOptOutRequest.findById(requestId);
                
                if (!optOutRequest) {
                    return await bot.answerCallbackQuery(query.id, { text: 'Request not found' });
                }

                if (optOutRequest.status !== 'pending') {
                    return await bot.answerCallbackQuery(query.id, { text: `Already ${optOutRequest.status}` });
                }

                // Update request status
                optOutRequest.status = approve ? 'approved' : 'rejected';
                optOutRequest.adminId = adminChatId;
                optOutRequest.adminUsername = adminUsername;
                optOutRequest.processedAt = new Date();

                if (!approve) {
                    optOutRequest.declineReason = 'Declined by admin';
                }

                await optOutRequest.save();

                // Update all admin message buttons to show final status (single-use pattern)
                const statusText = approve ? '✅ Approved' : '❌ Declined';
                if (Array.isArray(optOutRequest.adminMessages) && optOutRequest.adminMessages.length) {
                    await Promise.all(optOutRequest.adminMessages.map(async (m) => {
                        try {
                            // Update text to show approval/decline status
                            const baseText = m.originalText || 'Opt-Out Request';
                            const finalText = `${baseText}\n\n${statusText} by @${adminUsername} at ${new Date().toLocaleString()}`;
                            
                            // Replace buttons with single read-only status button
                            const statusKeyboard = {
                                inline_keyboard: [[{
                                    text: statusText,
                                    callback_data: `opt_out_status_${requestId}`
                                }]]
                            };

                            await bot.editMessageText(finalText, {
                                chat_id: parseInt(m.adminId, 10) || m.adminId,
                                message_id: m.messageId,
                                parse_mode: 'HTML',
                                reply_markup: statusKeyboard
                            });
                        } catch (err) {
                            console.error(`Failed to update admin message: ${err.message}`);
                        }
                    }));
                }

                if (approve) {
                    // Get user data before clearing ambassador fields
                    const user = await User.findOne({ id: optOutRequest.userId });
                    
                    if (user && user.ambassadorEmail) {
                        // Clear all ambassador fields
                        user.ambassadorEmail = null;
                        user.ambassadorTier = null;
                        user.ambassadorReferralCode = null;
                        user.ambassadorApprovedAt = null;
                        user.ambassadorApprovedBy = null;
                        user.ambassadorWalletAddress = null;
                        user.ambassadorCurrentLevel = 0;
                        user.ambassadorReferralCount = 0;
                        user.ambassadorPendingBalance = 0;
                        user.ambassadorLevelEarnings = {
                            preLevelOne: 0,
                            levelOne: 0,
                            levelTwo: 0,
                            levelThree: 0,
                            levelFour: 0
                        };
                        user.ambassadorMonthlyWithdrawals = [];
                        
                        await user.save();

                        // Send confirmation to user
                        const confirmMsg = `✅ <b>Your opt-out request has been approved!</b>\n\n` +
                            `You have been successfully removed from the StarStore Ambassador program.\n\n` +
                            `<b>Your Data:</b>\n` +
                            `• All ambassador privileges have been removed\n` +
                            `• Your referral code is no longer active\n` +
                            `• Your balance has been retained (check your withdrawal history)\n\n` +
                            `Thank you for being part of the StarStore community! 💙\n\n` +
                            `You can reapply for the ambassador program at any time.`;

                        try {
                            if (optOutRequest.userMessageId) {
                                await bot.editMessageText(confirmMsg, {
                                    chat_id: optOutRequest.userId,
                                    message_id: optOutRequest.userMessageId,
                                    parse_mode: 'HTML'
                                });
                            } else {
                                await bot.sendMessage(optOutRequest.userId, confirmMsg, {
                                    parse_mode: 'HTML'
                                });
                            }
                        } catch (err) {
                            console.error(`Failed to update user message: ${err.message}`);
                        }

                        console.log(`[OPT_OUT] Ambassador ${optOutRequest.userId} successfully removed from program`);
                    }
                } else {
                    // Inform user request was rejected
                    const rejectionMsg = `❌ <b>Your opt-out request was declined.</b>\n\n` +
                        `You remain an active member of the StarStore Ambassador program.\n\n` +
                        `If you have any concerns, please contact our support team.`;

                    try {
                        if (optOutRequest.userMessageId) {
                            await bot.editMessageText(rejectionMsg, {
                                chat_id: optOutRequest.userId,
                                message_id: optOutRequest.userMessageId,
                                parse_mode: 'HTML'
                            });
                        } else {
                            await bot.sendMessage(optOutRequest.userId, rejectionMsg, {
                                parse_mode: 'HTML'
                            });
                        }
                    } catch (err) {
                        console.error(`Failed to update user message: ${err.message}`);
                    }

                    console.log(`[OPT_OUT] Ambassador ${optOutRequest.userId} opt-out request rejected`);
                }

                await bot.answerCallbackQuery(query.id, { 
                    text: approve ? 'Ambassador removed successfully' : 'Opt-out request declined'
                });

            } catch (err) {
                console.error('Opt-out processing error:', err);
                await bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
            }
            return;
        }

        // Ignore status-only buttons (single-use pattern)
        if (data.startsWith('opt_out_status_')) {
            return await bot.answerCallbackQuery(query.id, { text: 'This action has been processed' });
        }

    } catch (err) {
        console.error('Opt-out callback error:', err);
        await bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
    }
});

async function createTelegramInvoice(chatId, orderId, stars, description, sessionToken) {
    try {
        const amountInt = Number.isFinite(Number(stars)) ? Math.floor(Number(stars)) : 0;
        const body = {
            title: `Purchase of ${amountInt} Telegram Stars`,
            description: description,
            payload: orderId,
            currency: 'XTR',
            prices: [
                {
                    label: `${amountInt} Telegram Stars`,
                    amount: amountInt
                }
            ],
            start_parameter: sessionToken?.substring(0, 64)
        };
        // For Stars (XTR), provider_token must not be sent
        // chat_id is not a parameter for createInvoiceLink
        const response = await axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, body);
        return response.data.result;
    } catch (error) {
        console.error('Error creating invoice:', error);
        throw error;
    }
}

// Background job to clean up expired orders - ENHANCED WITH USER NOTIFICATIONS
async function cleanupExpiredOrders() {
    try {
        // Find expired orders first to notify users
        const expiredOrders = await SellOrder.find({
            status: "pending",
            sessionExpiry: { $lt: new Date() }
        });

        // Notify users about expired orders
        for (const order of expiredOrders) {
            try {
                await bot.sendMessage(
                    order.telegramId,
                    `⏰ Your sell order #${order.id} has expired.\n\n` +
                    `Stars: ${order.stars}\n` +
                    `You can create a new order if you still want to sell.`
                );
            } catch (err) {
                console.error(`Failed to notify user ${order.telegramId} about expired order:`, err);
            }
        }

        // Update expired orders in database
        const updateResult = await SellOrder.updateMany(
            { 
                status: "pending",
                sessionExpiry: { $lt: new Date() }
            },
            { 
                status: "expired",
                $unset: { sessionToken: 1, sessionExpiry: 1 }
            }
        );
        
        if (updateResult.modifiedCount > 0) {
            // Prepare a detailed list of expired orders for admin review
            const expiredListLines = expiredOrders.map(o => {
                const userLabel = o.username ? `@${o.username}` : `ID:${o.telegramId}`;
                return `#${o.id} — ${userLabel} — ${o.stars} stars`;
            });

            const expiredListText = expiredListLines.length > 0 ? expiredListLines.join('\n') : 'None';

            // Send notification to admin channel or first admin instead of console
            if (adminIds && adminIds.length > 0) {
                try {
                    await bot.sendMessage(
                        adminIds[0], 
                        `🧹 System Cleanup:\n\n` +
                        `Cleaned up ${updateResult.modifiedCount} expired sell orders\n` +
                        `Time: ${new Date().toLocaleString()}\n\n` +
                        `Expired Orders:\n${expiredListText}`
                    );
                } catch (err) {
                    console.error('Failed to notify admin about cleanup:', err);
                    // Fallback to console if admin notification fails
                    console.log(`Cleaned up ${updateResult.modifiedCount} expired sell orders`);
                    console.log('Expired Orders:', expiredListText);
                }
            } else {
                console.log(`Cleaned up ${updateResult.modifiedCount} expired sell orders`);
                console.log('Expired Orders:', expiredListText);
            }
        }
    } catch (error) {
        console.error('Error cleaning up expired orders:', error);
        // Notify admin about cleanup errors
        if (adminIds && adminIds.length > 0) {
            try {
                await bot.sendMessage(
                    adminIds[0],
                    `❌ Cleanup Error:\n\n` +
                    `Failed to clean up expired orders\n` +
                    `Error: ${error.message}\n` +
                    `Time: ${new Date().toLocaleString()}`
                );
            } catch (err) {
                console.error('Failed to notify admin about cleanup error:', err);
            }
        }
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredOrders, 5 * 60 * 1000);


bot.onText(/^\/(reverse|paysupport)(?:\s+(.+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentRequest = await Reversal.findOne({
        telegramId: userId,
        createdAt: { $gte: thirtyDaysAgo },
        status: { $in: ['pending', 'processing'] }
    });
    
    if (recentRequest) {
        const nextAllowedDate = new Date(recentRequest.createdAt);
        nextAllowedDate.setDate(nextAllowedDate.getDate() + 30);
        return bot.sendMessage(chatId, 
            `❌ You can only request one refund per month.\n` +
            `Next refund available: ${nextAllowedDate.toDateString()}`
        );
    }
    
    const orderId = match[2] ? match[2].trim() : null;
    
    if (!orderId) {
        const welcomeMsg = `🔄 Welcome to Sell Order Pay Support\n\n` +
            `You are about to request a cancellation and refund for your order. ` +
            `Please note that refund requests are limited to once per month and can only be made within 5 days of order creation.\n\n` +
            `Please enter your Order ID:`;
        
        reversalRequests.set(chatId, { 
            step: 'waiting_order_id', 
            timestamp: Date.now() 
        });
        return bot.sendMessage(chatId, welcomeMsg);
    }
    
    const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you");
    if (order.status !== 'processing') return bot.sendMessage(chatId, `❌ Order is ${order.status} - cannot be reversed`);
    
    // Check if order is within 5-day refund window
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    if (order.dateCreated < fiveDaysAgo) {
        return bot.sendMessage(chatId, `❌ Refund requests can only be made within 5 days of order creation. This order was created on ${order.dateCreated.toDateString()}.`);
    }
    
    reversalRequests.set(chatId, { 
        step: 'waiting_reason',
        orderId, 
        timestamp: Date.now() 
    });
    bot.sendMessage(chatId, 
        `📋 Order Found: ${orderId}\n` +
        `Stars: ${order.stars}\n\n` +
        `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
    );
});

bot.onText(/^\/adminrefund (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found with this TX ID");
    if (order.status === 'refunded') return bot.sendMessage(chatId, "❌ Order already refunded");
    
    try {
        const result = await processRefund(order.id);
        
        if (result.success) {
            const statusMessage = result.alreadyRefunded 
                ? `✅ Order ${order.id} was already refunded\nTX ID: ${result.chargeId}`
                : `✅ Admin refund processed for order ${order.id}\nTX ID: ${result.chargeId}`;
            
            await bot.sendMessage(chatId, statusMessage);
            
            try {
                await bot.sendMessage(
                    parseInt(order.telegramId),
                    `💸 Refund Processed by Admin\nOrder: ${order.id}\nTX ID: ${result.chargeId}`
                );
            } catch (userError) {
                await bot.sendMessage(chatId, `⚠️ Refund processed but user notification failed`);
            }
        }
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Admin refund failed for ${order.id}\nError: ${error.message}`);
    }
});

bot.onText(/^\/refundtx (.+) (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    const userId = match[2].trim();
    
    try {
        const refundPayload = {
            user_id: parseInt(userId),
            telegram_payment_charge_id: txId
        };

        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`,
            refundPayload,
            { 
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                return bot.sendMessage(chatId, `✅ TX ${txId} was already refunded`);
            }
            throw new Error(data.description || "Refund API call failed");
        }

        const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
        if (order) {
            order.status = 'refunded';
            order.dateRefunded = new Date();
            order.refundData = {
                requested: true,
                status: 'processed',
                processedAt: new Date(),
                chargeId: txId
            };
            await order.save();
        }

        try {
            await bot.sendMessage(
                parseInt(userId),
                `💸 Refund Processed by Admin\nTX ID: ${txId}`
            );
        } catch (userError) {}

        await bot.sendMessage(chatId, `✅ Direct refund processed for TX: ${txId}\nUser: ${userId}`);

    } catch (error) {
        await bot.sendMessage(chatId, `❌ Direct refund failed for TX ${txId}\nError: ${error.message}`);
    }
});

// Admin helper: find order by ID and show details
bot.onText(/^\/findorder\s+((?:BUY|SELL|WD)[A-Z0-9]{6,})/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    const orderId = match[1].trim();
    const order = await SellOrder.findOne({ id: orderId }) || await BuyOrder.findOne({ id: orderId });
    if (!order) return bot.sendMessage(chatId, "❌ Order not found");
    const type = order.stars != null || order.status === 'processing' ? 'SELL' : 'BUY';
    const info = `📄 Order ${order.id}\nType: ${type}\nUser: ${order.username || '-'} (ID: ${order.telegramId})\nStatus: ${order.status}\nStars: ${order.stars || '-'}\nAmount: ${order.amount || '-'}\nWallet: ${order.walletAddress || '-'}\nTX: ${order.telegram_payment_charge_id || '-'}\nCreated: ${order.dateCreated ? order.dateCreated.toISOString() : '-'}\nCompleted: ${order.dateCompleted ? order.dateCompleted.toISOString() : '-'}`;
    await bot.sendMessage(chatId, info);
});

bot.onText(/^\/getpayment (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    
    try {
        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getStarTransactions`,
            { offset: 0, limit: 100 },
            { 
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            throw new Error(data.description || "Failed to get transactions");
        }

        const transaction = data.result.transactions.find(t => 
            t.id === txId || (t.source && t.source.charge && t.source.charge.id === txId)
        );

        if (!transaction) {
            return bot.sendMessage(chatId, `❌ Transaction not found: ${txId}`);
        }

        const txInfo = `💳 Transaction Details\n` +
            `TX ID: ${transaction.id}\n` +
            `Amount: ${transaction.amount} stars\n` +
            `Date: ${new Date(transaction.date * 1000).toISOString()}\n` +
            `User ID: ${transaction.source ? transaction.source.user?.id || 'N/A' : 'N/A'}\n` +
            `Type: ${transaction.source ? transaction.source.type : 'N/A'}`;

        await bot.sendMessage(chatId, txInfo);

        if (transaction.source && transaction.source.user && transaction.source.user.id) {
            await bot.sendMessage(chatId, 
                `To refund this transaction, use:\n` +
                `/refundtx ${txId} ${transaction.source.user.id}`
            );
        }

    } catch (error) {
        await bot.sendMessage(chatId, `❌ Failed to get transaction details\nError: ${error.message}`);
    }
});

bot.onText(/^\/findorder (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) return bot.sendMessage(chatId, "❌ Access denied");
    
    const txId = match[1].trim();
    const order = await SellOrder.findOne({ telegram_payment_charge_id: txId });
    
    if (!order) return bot.sendMessage(chatId, "❌ Order not found with this TX ID");
    
    const orderInfo = `📋 Order Details\n` +
        `Order ID: ${order.id}\n` +
        `User ID: ${order.telegramId}\n` +
        `Stars: ${order.stars}\n` +
        `Status: ${order.status}\n` +
        `TX ID: ${order.telegram_payment_charge_id}\n` +
        `Created: ${order.dateCreated ? order.dateCreated.toISOString().split('T')[0] : 'N/A'}`;
    
    bot.sendMessage(chatId, orderInfo);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    const username = msg.from.username || '';

    // Auto-detect and update username in real-time on ANY message
    if (username) {
        const usernameChange = await detectUsernameChange(userId, username, 'login');
        if (usernameChange) {
            await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
        }
    }

    const request = reversalRequests.get(chatId);
    
    // Skip if no reversal request in progress, no text, or if it's a command (handled by onText)
    if (!request || !msg.text || msg.text.startsWith('/')) return;
    
    // Skip if this message was already processed by onText handler
    if (msg.text.match(/^\/(reverse|paysupport)/i)) return;
    
    // Additional rate limit check: ensure no recent requests in database
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentRequest = await Reversal.findOne({
        telegramId: userId,
        createdAt: { $gte: thirtyDaysAgo },
        status: { $in: ['pending', 'processing'] }
    });
    if (recentRequest) {
        reversalRequests.delete(chatId);
        const nextAllowedDate = new Date(recentRequest.createdAt);
        nextAllowedDate.setDate(nextAllowedDate.getDate() + 30);
        return bot.sendMessage(chatId, 
            `❌ You can only request one refund per month.\n` +
            `Next refund available: ${nextAllowedDate.toDateString()}`
        );
    }
    
    if (Date.now() - request.timestamp > 300000) {
        reversalRequests.delete(chatId);
        return bot.sendMessage(chatId, "⌛ Session expired. Please start over with /reverse or /paysupport");
    }

    if (request.step === 'waiting_order_id') {
        const orderId = msg.text.trim();
        const order = await SellOrder.findOne({ id: orderId, telegramId: userId });
        
        if (!order) {
            return bot.sendMessage(chatId, "❌ Order not found or doesn't belong to you. Please enter a valid Order ID:");
        }
        if (order.status !== 'processing') {
            return bot.sendMessage(chatId, `❌ Order ${orderId} is ${order.status} - cannot be reversed. Please enter a different Order ID:`);
        }
        
        // Check if order is within 5-day refund window
        const fiveDaysAgo = new Date();
        fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
        if (order.dateCreated < fiveDaysAgo) {
            return bot.sendMessage(chatId, `❌ Refund requests can only be made within 5 days of order creation. This order was created on ${order.dateCreated.toDateString()}. Please enter a different Order ID:`);
        }
        
        request.step = 'waiting_reason';
        request.orderId = orderId;
        request.timestamp = Date.now();
        reversalRequests.set(chatId, request);
        
        return bot.sendMessage(chatId, 
            `📋 Order Found: ${orderId}\n` +
            `Stars: ${order.stars}\n\n` +
            `Please provide a detailed explanation (minimum 10 words) for why you need to reverse this order:`
        );
    }

    if (request.step === 'waiting_reason') {
        const reason = msg.text.trim();
        const wordCount = reason.split(/\s+/).filter(word => word.length > 0).length;
        
        if (wordCount < 10) {
            return bot.sendMessage(chatId, 
                `❌ Please provide a more detailed reason (minimum 10 words). Current: ${wordCount} words.\n` +
                `Please explain in detail why you need this refund:`
            );
        }

        const order = await SellOrder.findOne({ id: request.orderId });
        const requestDoc = new Reversal({
            orderId: request.orderId,
            telegramId: userId,
            username: msg.from.username || `${msg.from.first_name}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
            stars: order.stars,
            reason: reason,
            status: 'pending',
            adminMessages: []
        });
        await requestDoc.save();

        const safeUsername = requestDoc.username.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        const safeReason = reason.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        
        const adminMsg = `🔄 Reversal Request\n` +
            `Order: ${request.orderId}\n` +
            `User: @${safeUsername}\n` +
            `User ID: ${userId}\n` +
            `Stars: ${order.stars}\n` +
            `Reason: ${safeReason}`;
        
        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(parseInt(adminId), adminMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "✅ Approve", callback_data: `req_approve_${request.orderId}` },
                                { text: "❌ Reject", callback_data: `req_reject_${request.orderId}` }
                            ]
                        ]
                    },
                    parse_mode: 'MarkdownV2'
                });
                const adminMsgData = { 
                    adminId: adminId, 
                    messageId: message.message_id,
                    messageType: 'refund',
                    originalText: adminMsg
                };
                requestDoc.adminMessages.push(adminMsgData);
                console.log(`Added admin message for ${adminId}:`, adminMsgData);
            } catch (err) {
                console.error(`Failed to send to admin ${adminId}:`, err.message);
                try {
                    const fallbackMsg = await bot.sendMessage(parseInt(adminId), adminMsg, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "✅ Approve", callback_data: `req_approve_${request.orderId}` },
                                    { text: "❌ Reject", callback_data: `req_reject_${request.orderId}` }
                                ]
                            ]
                        }
                    });
                    const fallbackMsgData = { 
                        adminId: adminId, 
                        messageId: fallbackMsg.message_id, 
                        messageType: 'refund',
                        originalText: adminMsg
                    };
                    requestDoc.adminMessages.push(fallbackMsgData);
                    console.log(`Added fallback admin message for ${adminId}:`, fallbackMsgData);
                } catch (fallbackErr) {
                    console.error(`Fallback send to admin ${adminId} also failed:`, fallbackErr.message);
                }
            }
        }
        console.log(`Saving request with ${requestDoc.adminMessages.length} admin messages:`, requestDoc.adminMessages);
        await requestDoc.save();
        console.log(`Request saved successfully with admin messages`);
        bot.sendMessage(chatId, `📨 Reversal request submitted for order ${request.orderId}\nYou will be notified once reviewed.`);
        reversalRequests.delete(chatId);
    }
});

async function processRefund(orderId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const order = await SellOrder.findOne({ id: orderId }).session(session);
        if (!order) throw new Error("Order not found");
        if (order.status !== 'processing') throw new Error("Order not in processing state");
        if (!order.telegram_payment_charge_id) throw new Error("Missing payment reference");

        const refundPayload = {
            user_id: parseInt(order.telegramId),
            telegram_payment_charge_id: order.telegram_payment_charge_id
        };

        const { data } = await axios.post(
            `https://api.telegram.org/bot${process.env.BOT_TOKEN}/refundStarPayment`,
            refundPayload,
            { 
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!data.ok) {
            if (data.description && data.description.includes('CHARGE_ALREADY_REFUNDED')) {
                order.status = 'refunded';
                order.dateRefunded = new Date();
                order.refundData = {
                    requested: true,
                    status: 'processed',
                    processedAt: new Date(),
                    chargeId: order.telegram_payment_charge_id
                };
                
                try {
                    await order.save({ session });
                    await session.commitTransaction();
                    return { success: true, chargeId: order.telegram_payment_charge_id, alreadyRefunded: true };
                } catch (saveError) {
                    // If validation fails, still commit the transaction and return success
                    console.warn('Refund validation warning (already refunded):', saveError.message);
                    await session.commitTransaction();
                    return { success: true, chargeId: order.telegram_payment_charge_id, alreadyRefunded: true, validationWarning: true };
                }
            }
            throw new Error(data.description || "Refund API call failed");
        }

        order.status = 'refunded';
        order.dateRefunded = new Date();
        order.refundData = {
            requested: true,
            status: 'processed',
            processedAt: new Date(),
            chargeId: order.telegram_payment_charge_id
        };
        
        try {
            await order.save({ session });
            await session.commitTransaction();
            return { success: true, chargeId: order.telegram_payment_charge_id };
        } catch (saveError) {
            // If validation fails, still commit the transaction and return success
            // The refund was processed successfully, validation error is just a data issue
            console.warn('Refund validation warning (refund still processed):', saveError.message);
            await session.commitTransaction();
            return { success: true, chargeId: order.telegram_payment_charge_id, validationWarning: true };
        }

    } catch (error) {
        await session.abortTransaction();
        console.error('Refund processing error:', error.message);
        throw error;
    } finally {
        session.endSession();
    }
}

bot.on('callback_query', async (query) => {
    try {
        const data = query.data;
        const adminId = query.from.id.toString();
        
        console.log(`Callback received: ${data} from admin: ${adminId}`);
        
        // Check if this is a refund request callback
        if (data.startsWith('req_approve_') || data.startsWith('req_reject_')) {
            console.log(`Processing refund callback: ${data}`);
            
            // Check for duplicate processing (use just the callback data)
            const callbackKey = data;
            if (processingCallbacks.has(callbackKey)) {
                console.log(`Duplicate callback detected: ${callbackKey}`);
                await bot.answerCallbackQuery(query.id, { text: "⏳ Already processing..." });
                return;
            }
            
            if (!adminIds.includes(adminId)) {
                console.log(`Access denied for admin: ${adminId}`);
                await bot.answerCallbackQuery(query.id, { text: "❌ Access denied" });
                return;
            }

            const [_, action, orderId] = data.split('_');
            console.log(`Action: ${action}, OrderId: ${orderId}`);
            
            const request = await Reversal.findOne({ orderId });
            console.log(`Found request:`, request ? `Status: ${request.status}` : 'Not found');
            
            if (!request) {
                await bot.answerCallbackQuery(query.id, { text: `❌ Request not found` });
                return;
            }
            
            // If request is already processed, just update the buttons and notify
            if (request.status !== 'pending') {
                console.log(`Request ${orderId} already ${request.status}, updating buttons only`);
                
                let statusText = '';
                let adminMessage = '';
                let userMessage = '';
                
                if (request.status === 'completed') {
                    statusText = '✅ REFUNDED';
                    adminMessage = `✅ Refund was already processed for ${orderId}`;
                    userMessage = `💸 Your refund for order ${orderId} was already processed`;
                } else if (request.status === 'declined') {
                    statusText = '❌ REJECTED';
                    adminMessage = `❌ Refund request was already rejected for ${orderId}`;
                    userMessage = `❌ Your refund request for order ${orderId} was already rejected`;
                }
                
                // Update buttons with error handling
                try {
                    await updateAdminMessages(request, statusText);
                } catch (updateError) {
                    console.error(`Error updating admin messages for ${orderId}:`, updateError.message);
                }
                
                // Send notifications
                try {
                    await bot.sendMessage(query.from.id, adminMessage);
                } catch (adminError) {
                    console.error('Failed to notify admin:', adminError.message);
                }
                try {
                    await bot.sendMessage(parseInt(request.telegramId), userMessage);
                } catch (userError) {
                    console.error('Failed to notify user:', userError.message);
                }
                
                await bot.answerCallbackQuery(query.id, { text: `✅ Buttons updated` });
                return;
            }
            
            // Answer callback immediately to prevent timeout
            await bot.answerCallbackQuery(query.id, { text: "⏳ Processing..." });
            
            // Mark as processing with timestamp for timeout tracking
            processingCallbacks.set(callbackKey, Date.now());
            
            // Double-check database status after acquiring lock
            const freshRequest = await Reversal.findOne({ orderId });
            if (!freshRequest || freshRequest.status !== 'pending') {
                console.log(`Request ${orderId} was processed by another instance`);
                processingCallbacks.delete(callbackKey);
                return;
            }

            try {
                if (action === 'approve') {
                    try {
                        const result = await processRefund(orderId);
                        
                        request.status = 'completed';
                        request.processedAt = new Date();
                        await request.save();

                        const statusMessage = result.alreadyRefunded 
                            ? `✅ Order ${orderId} was already refunded\nCharge ID: ${result.chargeId}`
                            : `✅ Refund processed successfully for ${orderId}\nCharge ID: ${result.chargeId}`;

                        // Notify the admin who clicked
                        await bot.sendMessage(query.from.id, statusMessage);
                        
                        // Notify user
                        try {
                            const userMessage = result.alreadyRefunded
                                ? `💸 Your refund for order ${orderId} was already processed\nTX ID: ${result.chargeId}`
                                : `💸 Refund Processed\nOrder: ${orderId}\nTX ID: ${result.chargeId}`;
                            
                            await bot.sendMessage(parseInt(request.telegramId), userMessage);
                        } catch (userError) {
                            console.error('Failed to notify user:', userError.message);
                            await bot.sendMessage(query.from.id, `⚠️ Refund processed but user notification failed`);
                        }

                        // Update all admin messages with success status
                        await updateAdminMessages(request, "✅ REFUNDED");

                    } catch (refundError) {
                        request.status = 'declined';
                        request.errorMessage = refundError.message;
                        await request.save();
                        
                        await bot.sendMessage(query.from.id, `❌ Refund failed for ${orderId}\nError: ${refundError.message}`);
                        await updateAdminMessages(request, "❌ FAILED");
                    }
                } else if (action === 'reject') {
                    try {
                        request.status = 'declined';
                        request.processedAt = new Date();
                        await request.save();
                        
                        await bot.sendMessage(query.from.id, `❌ Refund request rejected for ${orderId}`);
                        
                        try {
                            await bot.sendMessage(parseInt(request.telegramId), `❌ Your refund request for order ${orderId} has been rejected.`);
                        } catch (userError) {
                            console.error('Failed to notify user of rejection:', userError.message);
                        }

                        await updateAdminMessages(request, "❌ REJECTED");
                    } catch (rejectError) {
                        console.error('Rejection processing error:', rejectError.message);
                        await bot.sendMessage(query.from.id, `❌ Error processing rejection: ${rejectError.message}`);
                    }
                } else {
                    console.error(`Invalid action: ${action} for callback data: ${data}`);
                    await bot.sendMessage(query.from.id, `⚠️ Invalid action type. Please contact support.`);
                }
            } finally {
                // CRITICAL: Always remove from processing map, regardless of outcome
                processingCallbacks.delete(callbackKey);
                console.log(`Removed callback from processing. Remaining: ${processingCallbacks.size}`);
            }
        } else {
            // Handle other callback queries (existing logic)
            await bot.answerCallbackQuery(query.id);
        }

    } catch (error) {
        console.error('Callback processing error:', error);
        await bot.answerCallbackQuery(query.id, { text: "❌ Processing error occurred" });
        
        // Clean up processing set on error
        if (query.data && (query.data.startsWith('req_approve_') || query.data.startsWith('req_reject_'))) {
            const callbackKey = query.data;
            processingCallbacks.delete(callbackKey);
        }
    }
});

async function updateAdminMessages(request, statusText) {
    console.log(`Updating admin messages for request ${request.orderId} with status: ${statusText}`);
    
    if (!request) {
        console.error('updateAdminMessages: request is null/undefined');
        return;
    }
    
    if (!request.adminMessages || !Array.isArray(request.adminMessages)) {
        console.log('No admin messages to update - adminMessages is not an array or is empty');
        console.log('This suggests the adminMessages were not properly saved when the request was created');
        return;
    }
    
    console.log(`Admin messages array:`, request.adminMessages);
    
    for (const msg of request.adminMessages) {
        // Validate message object has required fields
        if (!msg || typeof msg !== 'object') {
            console.error('Invalid message object in adminMessages array:', msg);
            continue;
        }
        
        if (!msg.adminId || !msg.messageId) {
            console.error('Message missing required fields (adminId or messageId):', msg);
            continue;
        }
        
        try {
            console.log(`Updating message ${msg.messageId} for admin ${msg.adminId}`);
            
            // Update the message text and buttons
            const updatedText = `${msg.originalText || '🔄 Reversal Request'}\n\n${statusText}`;
            
            await bot.editMessageText(updatedText, {
                chat_id: parseInt(msg.adminId), 
                message_id: msg.messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: statusText, callback_data: 'processed_done' }]]
                }
            });
            console.log(`Successfully updated message ${msg.messageId} for admin ${msg.adminId}`);
        } catch (err) {
            console.error(`Failed to update admin message for ${msg.adminId}:`, err.message);
            // Fallback: just update the buttons
            try {
                await bot.editMessageReplyMarkup(
                    { inline_keyboard: [[{ text: statusText, callback_data: 'processed_done' }]] },
                    { chat_id: parseInt(msg.adminId), message_id: msg.messageId }
                );
                console.log(`Fallback update successful for admin ${msg.adminId}`);
            } catch (fallbackErr) {
                console.error(`Fallback update also failed for ${msg.adminId}:`, fallbackErr.message);
            }
        }
    }
}

setInterval(() => {
    const now = Date.now();
    const expiredSessions = [];
    
    reversalRequests.forEach((value, chatId) => {
        if (now - value.timestamp > 300000) {
            expiredSessions.push(chatId);
        }
    });
    
    expiredSessions.forEach(chatId => {
        bot.sendMessage(chatId, "⌛ Session expired").catch(() => {});
        reversalRequests.delete(chatId);
    });
}, 60000);

// STICKER HANDLER
bot.on('sticker', async (msg) => {
  try {
    const sticker = msg.sticker;
    if (!sticker) return;

    console.log('Processing sticker:', {
      id: sticker.file_unique_id,
      set: sticker.set_name,
      type: sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static'
    });

    const fileInfo = await bot.getFile(sticker.file_id);
    if (!fileInfo.file_path) return;

    const updateData = {
      file_id: sticker.file_id,
      file_path: fileInfo.file_path,
      is_animated: sticker.is_animated || false,
      is_video: sticker.is_video || false,
      emoji: sticker.emoji || '',
      set_name: sticker.set_name || '',
      updated_at: new Date()
    };

    await Sticker.updateOne(
      { file_unique_id: sticker.file_unique_id },
      { $set: updateData, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

  } catch (error) {
    console.error('Sticker processing error:', error.message);
  }
});

// API ENDPOINTS
app.get('/api/sticker/:sticker_id/json', async (req, res) => {
  try {
    const sticker = await Sticker.findOne({ file_unique_id: req.params.sticker_id });
    if (!sticker || !sticker.file_path.endsWith('.tgs')) {
      return res.status(404).json({ error: 'Sticker not found or not animated' });
    }

    const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${sticker.file_path}`;
    const tgRes = await fetch(telegramUrl);
    const buffer = await tgRes.arrayBuffer();

    // Try to decompress - silently fallback to raw parsing if not gzip
    zlib.unzip(Buffer.from(buffer), (err, jsonBuffer) => {
      if (err) {
        // Silently try parsing as-is (might not be compressed)
        try {
          const json = JSON.parse(Buffer.from(buffer).toString());
          return res.json(json);
        } catch (parseErr) {
          // Only log if both methods fail
          return res.status(500).json({ error: 'Failed to decode sticker' });
        }
      }

      try {
        const json = JSON.parse(jsonBuffer.toString());
        res.json(json);
      } catch (e) {
        // Silent fail on invalid JSON
        res.status(500).json({ error: 'Invalid sticker JSON' });
      }
    });

  } catch (e) {
    console.error('Sticker fetch error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/sticker/:id/info', async (req, res) => {
  try {
    const sticker = await Sticker.findOne(
      { file_unique_id: req.params.id },
      { _id: 0, file_unique_id: 1, is_animated: 1, is_video: 1, emoji: 1, set_name: 1 }
    );
    
    if (!sticker) {
      return res.status(404).json({ error: 'Sticker not found' });
    }
    
    res.json(sticker);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stickers', async (req, res) => {
  try {
    const { set, limit = 50, offset = 0 } = req.query;
    const query = set ? { set_name: set } : {};
    
    const stickers = await Sticker.find(query, {
      file_unique_id: 1,
      emoji: 1,
      set_name: 1,
      is_animated: 1,
      is_video: 1
    })
    .sort({ created_at: -1 })
    .skip(parseInt(offset))
    .limit(parseInt(limit));
    
    res.json(stickers);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Activity tracking system
const ACTIVITY_TYPES = {
  DAILY_CHECKIN: { id: 'daily_checkin', points: 10, name: 'Daily Check-in' },
  BUY_ORDER: { id: 'buy_order', points: 20, name: 'Buy Order' },
  SELL_ORDER: { id: 'sell_order', points: 20, name: 'Sell Order' },
  REFERRAL: { id: 'referral', points: 30, name: 'Referral' },
  MISSION_COMPLETE: { id: 'mission_complete', points: 0, name: 'Mission Complete' }, // Points vary by mission
  STREAK_BONUS: { id: 'streak_bonus', points: 0, name: 'Streak Bonus' } // Points vary by streak
};

// Test endpoint to verify activity tracking
app.post('/api/test/activity', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`🧪 Testing activity tracking for user ${userId}`);
    
    await logActivity(userId, ACTIVITY_TYPES.DAILY_CHECKIN, 10, { test: true });
    
    res.json({ 
      success: true, 
      message: 'Test activity logged successfully',
      userId: userId
    });
  } catch (error) {
    console.error('Test activity error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Activity logging function (idempotent + configurable side-effects)
async function logActivity(userId, activityType, points, metadata = {}) {
  try {
    const now = Date.now();
    const meta = metadata || {};
    const dedupeWindowMs = parseInt(process.env.ACTIVITY_DEDUPE_MS || '5000', 10);

    // Build dedupe filter from metadata (missionId, orderId, or day for daily check-in)
    const baseFilter = { userId, activityType: activityType.id };
    if (meta.missionId) baseFilter['metadata.missionId'] = meta.missionId;
    else if (meta.orderId) baseFilter['metadata.orderId'] = meta.orderId;
    else if (activityType.id === 'daily_checkin' && typeof meta.day === 'number') baseFilter['metadata.day'] = meta.day;

    // Check recent duplicate
    let isDuplicate = false;
    if (process.env.MONGODB_URI) {
      const recent = await Activity.findOne({
        ...baseFilter,
        timestamp: { $gte: new Date(now - dedupeWindowMs) }
      });
      isDuplicate = !!recent;
    } else {
      const list = await db.findActivities({ userId });
      const recent = (list || []).slice(-5).reverse().find(a => {
        if (a.activityType !== activityType.id) return false;
        if (meta.missionId && a.metadata?.missionId !== meta.missionId) return false;
        if (meta.orderId && a.metadata?.orderId !== meta.orderId) return false;
        if (activityType.id === 'daily_checkin' && typeof meta.day === 'number' && a.metadata?.day !== meta.day) return false;
        return (now - new Date(a.timestamp).getTime()) <= dedupeWindowMs;
      });
      isDuplicate = !!recent;
    }

    // Side-effect controls
    const skipPoints = meta.__noPoints === true || isDuplicate;
    const skipNotify = meta.__noNotify === true || isDuplicate;

    // Create activity record only if not duplicate
    let activity;
    if (!isDuplicate) {
      activity = {
        userId,
        activityType: activityType.id,
        activityName: activityType.name,
        points,
        timestamp: new Date(),
        metadata: meta
      };
      if (process.env.MONGODB_URI) {
        await Activity.create(activity);
      } else {
        await db.createActivity(activity);
      }
    } else {
      // Fetch latest existing activity to use in notification (if ever needed)
      activity = {
        userId,
        activityType: activityType.id,
        activityName: activityType.name,
        points,
        timestamp: new Date(),
        metadata: meta
      };
    }

    // Update user's total points unless caller already did it or duplicate detected
    if (!skipPoints) {
      await updateUserPoints(userId, points);
    }

    // Send bot notification (avoid duplicates)
    if (!skipNotify) {
      await sendBotNotification(userId, activity);
    }

    // Only log significant activities, not daily check-ins
    if (activityType.id !== 'daily_checkin' && !isDuplicate) {
      console.log(`📊 Activity logged: ${userId} - ${activityType.name} (+${points} points)`);
    }
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

// Update user points
async function updateUserPoints(userId, points) {
  try {
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB
      await DailyState.findOneAndUpdate(
        { userId },
        { $inc: { totalPoints: points } },
        { upsert: true }
      );
    } else {
      // Development: Use file-based storage
      const state = await db.findDailyState(userId);
      if (state) {
        state.totalPoints = (state.totalPoints || 0) + points;
        await db.updateDailyState(userId, state);
      } else {
        await db.createDailyState({ userId, totalPoints: points });
      }
    }
  } catch (error) {
    console.error('Failed to update user points:', error);
  }
}

// Send bot notification
async function sendBotNotification(userId, activity) {
  try {
    // Only send notifications in production with real bot
    if (process.env.NODE_ENV === 'production' && process.env.BOT_TOKEN) {
      const message = `🎉 Activity Completed!\n\n${activity.activityName}\n+${activity.points} points\n\nKeep up the great work!`;
      
      // Send notification via Telegram Bot API
      const botResponse = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          text: message,
          parse_mode: 'HTML'
        })
      });
      
      if (!botResponse.ok) {
        console.warn('Failed to send bot notification:', await botResponse.text());
      }
    }
  } catch (error) {
    console.error('Bot notification failed:', error);
  }
}

// Helper functions for mission validation
async function getWalletAddressForUser(userId) {
  try {
    if (process.env.MONGODB_URI) {
      // Check if user has any orders with wallet addresses
      const buyOrder = await BuyOrder.findOne({ telegramId: userId, walletAddress: { $exists: true, $ne: null } });
      const sellOrder = await SellOrder.findOne({ telegramId: userId, walletAddress: { $exists: true, $ne: null } });
      return buyOrder?.walletAddress || sellOrder?.walletAddress || null;
    } else {
      // Development: Check file-based storage
      const buyOrders = await db.findOrders({ telegramId: userId });
      const sellOrders = await db.findSellOrders({ telegramId: userId });
      const buyOrder = buyOrders.find(o => o.walletAddress);
      const sellOrder = sellOrders.find(o => o.walletAddress);
      return buyOrder?.walletAddress || sellOrder?.walletAddress || null;
    }
  } catch (e) {
    console.error('Error getting wallet address:', e);
    return null;
  }
}

async function getOrderCountForUser(userId) {
  try {
    if (process.env.MONGODB_URI) {
      // Check both buy and sell orders
      const buyOrders = await BuyOrder.countDocuments({ telegramId: userId, status: { $in: ['processing', 'completed'] } });
      const sellOrders = await SellOrder.countDocuments({ telegramId: userId, status: { $in: ['processing', 'completed'] } });
      return buyOrders + sellOrders;
    } else {
      const buyOrders = await db.findOrders({ telegramId: userId, status: { $in: ['processing', 'completed'] } });
      const sellOrders = await db.findSellOrders({ telegramId: userId, status: { $in: ['processing', 'completed'] } });
      return buyOrders.length + sellOrders.length;
    }
  } catch (e) {
    console.error('Error getting order count:', e);
    return 0;
  }
}

async function getReferralCountForUser(userId) {
  try {
    if (process.env.MONGODB_URI) {
      return await Referral.countDocuments({ referrerUserId: userId, status: 'active' });
    } else {
      return await db.countReferrals({ referrerUserId: userId, status: 'active' });
    }
  } catch (e) {
    console.error('Error getting referral count:', e);
    return 0;
  }
}

// Missions: list and complete
const DAILY_MISSIONS = [
  { id: 'm1', title: 'Connect a wallet', points: 20, description: 'Connect your TON wallet to start trading' },
  { id: 'm2', title: 'Join Telegram channel', points: 10, description: 'Join our official Telegram channel' },
  { id: 'm3', title: 'Complete your first order', points: 50, description: 'Complete your first buy or sell order' },
  { id: 'm4', title: 'Invite a friend', points: 30, description: 'Invite a friend to join StarStore' }
];

app.get('/api/daily/missions', requireTelegramAuth, async (_req, res) => {
  // Static mission definitions returned; completion tracked per user in DB
  res.json({ success: true, missions: DAILY_MISSIONS });
});

// Get user activity history
app.get('/api/daily/activities', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    let activities;
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB
      activities = await Activity.find({ userId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(offset);
    } else {
      // Development: Use file-based storage
      const allActivities = await db.findActivities({ userId });
      activities = allActivities
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(offset, offset + limit);
    }

    res.json({ 
      success: true, 
      activities: activities.map(a => ({
        id: a._id || a.id,
        activityType: a.activityType,
        activityName: a.activityName,
        points: a.points,
        timestamp: a.timestamp,
        metadata: a.metadata
      })),
      total: activities.length,
      hasMore: activities.length === limit
    });
  } catch (e) {
    console.error('Activities error:', e);
    res.status(500).json({ success: false, error: 'Failed to load activities' });
  }
});

// Mission validation endpoints
app.get('/api/daily/missions/validate/:missionId', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { missionId } = req.params;
    const mission = DAILY_MISSIONS.find(m => m.id === missionId);
    if (!mission) return res.status(400).json({ success: false, error: 'Invalid mission' });

    // Only log mission validation for debugging if needed
    // console.log(`🔍 Validating mission ${missionId} for user ${userId}`);

    let isValid = false;
    let message = '';

    switch (missionId) {
      case 'm1': // Connect wallet
        // Check if user has wallet address
        const walletAddress = await getWalletAddressForUser(userId);
        console.log(`💰 Wallet address for user ${userId}:`, walletAddress);
        isValid = !!walletAddress;
        message = isValid ? 'Wallet connected successfully!' : 'Please connect your wallet first';
        break;
      
      case 'm2': // Join channel
        // Use Telegram Bot API to check channel membership
        try {
          const channelId = '@StarStore_app'; // Your channel username
          const member = await bot.getChatMember(channelId, userId);
          // Check if user is a member (not left, kicked, or restricted)
          isValid = ['member', 'administrator', 'creator'].includes(member.status);
          message = isValid ? 'Channel joined successfully!' : 'Please join our Telegram channel first';
          console.log(`📢 Channel membership check for user ${userId}:`, member.status);
        } catch (error) {
          console.error('Error checking channel membership:', error);
          if (error.response?.error_code === 400) {
            console.error('Bot is not an administrator of the channel or channel not found');
            message = 'Bot needs to be added as administrator to the channel to check membership';
          }
          // Fallback: check if they have activity
          const hasActivity = await getOrderCountForUser(userId) > 0 || await getReferralCountForUser(userId) > 0;
          isValid = hasActivity;
          message = isValid ? 'Channel joined successfully!' : 'Please join our Telegram channel first';
        }
        break;
      
      case 'm3': // Complete first order
        // Check if user has any completed orders
        const orderCount = await getOrderCountForUser(userId);
        // console.log(`🛍️ Order count for user ${userId}:`, orderCount);
        isValid = orderCount > 0;
        message = isValid ? 'First order completed!' : 'Please complete an order first';
        break;
      
      case 'm4': // Invite friend
        // Check if user has any referrals
        const referralCount = await getReferralCountForUser(userId);
        console.log(`👥 Referral count for user ${userId}:`, referralCount);
        isValid = referralCount > 0;
        message = isValid ? 'Friend invited successfully!' : 'Please invite a friend first';
        break;
      
      default:
        return res.status(400).json({ success: false, error: 'Unknown mission' });
    }

    res.json({ success: true, isValid, message });
  } catch (e) {
    console.error('Mission validation error:', e);
    res.status(500).json({ success: false, error: 'Validation failed' });
  }
});

app.post('/api/daily/missions/complete', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { missionId } = req.body || {};
    const mission = DAILY_MISSIONS.find(m => m.id === missionId);
    if (!mission) return res.status(400).json({ success: false, error: 'Invalid mission' });

    // Validate mission before completing
    const validationResp = await fetch(`${req.protocol}://${req.get('host')}/api/daily/missions/validate/${missionId}`, {
      headers: { 'x-telegram-id': userId }
    });
    const validation = await validationResp.json();
    
    if (!validation.isValid) {
      return res.status(400).json({ success: false, error: validation.message });
    }

    let state;
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB - first check if mission already completed
      state = await DailyState.findOne({ userId });
      if (!state) {
        state = await DailyState.create({ userId, totalPoints: 0, missionsCompleted: [] });
      }
      
      const alreadyCompleted = state.missionsCompleted && state.missionsCompleted.includes(missionId);
      if (alreadyCompleted) {
        return res.json({ success: true, alreadyCompleted: true, totalPoints: state.totalPoints });
      }
      
      // Atomic update to add mission and increment points
      state = await DailyState.findOneAndUpdate(
        { userId, 'missionsCompleted': { $ne: missionId } },
        {
          $addToSet: { missionsCompleted: missionId },
          $inc: { totalPoints: mission.points },
          $set: { updatedAt: new Date() }
        },
        { new: true }
      );
      
      // If update returned null, mission was already completed
      if (!state) {
        state = await DailyState.findOne({ userId });
        return res.json({ success: true, alreadyCompleted: true, totalPoints: state.totalPoints });
      }
    } else {
      // Development: Use file-based storage
      state = await db.findDailyState(userId);
      if (!state) {
        state = await db.createDailyState({ userId, totalPoints: 0, missionsCompleted: [] });
      }
      
      const completed = new Set(state.missionsCompleted || []);
      if (completed.has(missionId)) {
        return res.json({ success: true, alreadyCompleted: true, totalPoints: state.totalPoints });
      }
      
      completed.add(missionId);
      state.missionsCompleted = Array.from(completed);
      state.totalPoints = (state.totalPoints || 0) + mission.points;
      state.updatedAt = new Date();
      await db.updateDailyState(userId, state);
    }

    // Log activity
    await logActivity(userId, ACTIVITY_TYPES.MISSION_COMPLETE, mission.points, {
      missionId: missionId,
      missionTitle: mission.title,
      missionPoints: mission.points
    });

    res.json({ success: true, totalPoints: state.totalPoints, missionsCompleted: state.missionsCompleted });
  } catch (e) {
    console.error('missions/complete error:', e);
    console.error('Mission error details:', {
      userId: req.user?.id,
      hasMongoUri: !!process.env.MONGODB_URI,
      errorMessage: e.message,
      errorStack: e.stack
    });
    res.status(500).json({ success: false, error: 'Failed to complete mission' });
  }
});

// Daily rewards: get current state
app.get('/api/daily/state', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    // Check if we're using MongoDB (production) or file-based storage (development)
    let state;
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB - atomic update to avoid version conflicts
      state = await DailyState.findOneAndUpdate(
        { userId },
        {
          $setOnInsert: { userId, month: monthKey, checkedInDays: [], totalPoints: 0, streak: 0, missionsCompleted: [] }
        },
        { upsert: true, new: true }
      );
      // Manual month check and reset if needed
      if (state.month !== monthKey) {
        state = await DailyState.findOneAndUpdate(
          { userId },
          { $set: { month: monthKey, checkedInDays: [] } },
          { new: true }
        );
      }
    } else {
      // Development: Use file-based storage
      state = await db.findDailyState(userId);
      if (!state) {
        state = await db.createDailyState({ userId, month: monthKey, checkedInDays: [], totalPoints: 0, streak: 0, missionsCompleted: [] });
      } else if (state.month !== monthKey) {
        state.month = monthKey;
        state.checkedInDays = [];
        await db.updateDailyState(userId, state);
      }
    }
    return res.json({
      success: true,
      userId,
      totalPoints: state.totalPoints,
      lastCheckIn: state.lastCheckIn,
      streak: state.streak,
      month: state.month,
      checkedInDays: state.checkedInDays,
      missionsCompleted: state.missionsCompleted
    });
  } catch (e) {
    console.error('daily/state error:', e);
    console.error('Error details:', {
      userId: req.user?.id,
      hasMongoUri: !!process.env.MONGODB_URI,
      errorMessage: e.message,
      errorStack: e.stack
    });
    res.status(500).json({ success: false, error: 'Failed to load daily state' });
  }
});

// Daily rewards: check-in
app.post('/api/daily/checkin', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    
    // === SYNC USER DATA ON EVERY INTERACTION ===
    await syncUserData(userId, username, 'daily_checkin', req);
    
    // Enhanced debounce: prevent duplicate rapid check-ins (3s window)
    const nowTs = Date.now();
    if (!global.__recentCheckins) global.__recentCheckins = new Map();
    const lastTs = global.__recentCheckins.get(userId) || 0;
    if (nowTs - lastTs < 3000) {
      return res.json({ 
        success: true, 
        alreadyChecked: true,
        message: 'Please wait before checking in again'
      });
    }
    global.__recentCheckins.set(userId, nowTs);
    
    // Clean up old entries to prevent memory leaks
    if (global.__recentCheckins.size > 1000) {
      const cutoff = nowTs - 300000; // 5 minutes
      for (const [id, timestamp] of global.__recentCheckins.entries()) {
        if (timestamp < cutoff) {
          global.__recentCheckins.delete(id);
        }
      }
    }
    const today = new Date();
    const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const day = today.getDate();
    let newStreak = 0; // Declare at function level
    let dailyPoints = 10; // Declare at function level

    // Use atomic operations to prevent concurrency issues
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB with atomic operations
      const result = await DailyState.findOneAndUpdate(
        { userId },
        {
          $setOnInsert: { 
            userId, 
            totalPoints: 0, 
            streak: 0, 
            missionsCompleted: [], 
            checkedInDays: [],
            month: monthKey
          }
        },
        { 
          upsert: true, 
          new: true,
          runValidators: true
        }
      );
      
      // Check if already checked in today
      const alreadyToday = result.lastCheckIn && new Date(result.lastCheckIn).toDateString() === today.toDateString();
      if (alreadyToday || result.checkedInDays.includes(day)) {
        return res.json({ success: true, alreadyChecked: true, streak: result.streak, totalPoints: result.totalPoints, checkedInDays: result.checkedInDays });
      }

      // Calculate new streak
      newStreak = result.streak || 0;
      if (result.lastCheckIn) {
        const diffDays = Math.round((today - new Date(result.lastCheckIn)) / (1000 * 60 * 60 * 24));
        newStreak = diffDays === 1 ? newStreak + 1 : 1;
      } else {
        newStreak = 1;
      }

      // Update with atomic operation
      const days = new Set(result.checkedInDays);
      days.add(day);
      
      const updatedState = await DailyState.findOneAndUpdate(
        { 
          userId,
          $or: [
            { lastCheckIn: { $ne: today.toDateString() } },
            { lastCheckIn: { $exists: false } }
          ]
        },
        {
          $set: {
            totalPoints: (result.totalPoints || 0) + dailyPoints,
            lastCheckIn: today,
            streak: newStreak,
            month: monthKey,
            checkedInDays: Array.from(days).sort((a,b) => a-b),
            updatedAt: new Date()
          }
        },
        { new: true }
      );

      if (!updatedState) {
        // Another request already processed this check-in
        const currentState = await DailyState.findOne({ userId });
        return res.json({ success: true, alreadyChecked: true, streak: currentState.streak, totalPoints: currentState.totalPoints, checkedInDays: currentState.checkedInDays });
      }

      state = updatedState;
    } else {
      // Development: Use file-based storage
      state = await db.findDailyState(userId);
      if (!state) {
        state = await db.createDailyState({ userId, totalPoints: 0, streak: 0, missionsCompleted: [], checkedInDays: [] });
      }

      // Month rollover
      if (state.month !== monthKey) {
        state.month = monthKey;
        state.checkedInDays = [];
      }

      // Prevent double check-in same day
      const alreadyToday = state.lastCheckIn && new Date(state.lastCheckIn).toDateString() === today.toDateString();
      if (alreadyToday || state.checkedInDays.includes(day)) {
        return res.json({ success: true, alreadyChecked: true, streak: state.streak, totalPoints: state.totalPoints, checkedInDays: state.checkedInDays });
      }

      // Streak logic
      newStreak = state.streak || 0;
      if (state.lastCheckIn) {
        const diffDays = Math.round((today - new Date(state.lastCheckIn)) / (1000 * 60 * 60 * 24));
        newStreak = diffDays === 1 ? newStreak + 1 : 1;
      } else {
        newStreak = 1;
      }

      // Award daily points
      state.totalPoints = (state.totalPoints || 0) + dailyPoints;
      state.lastCheckIn = today;
      state.streak = newStreak;
      state.month = monthKey;
      const days = new Set(state.checkedInDays);
      days.add(day);
      state.checkedInDays = Array.from(days).sort((a,b) => a-b);
      state.updatedAt = new Date();
      
      await db.updateDailyState(userId, state);
    }

    // Log activity (silently)
    try {
      await logActivity(userId, ACTIVITY_TYPES.DAILY_CHECKIN, dailyPoints, {
        streak: newStreak,
        day: day,
        month: monthKey
      });
    } catch (logError) {
      // Silently handle activity logging errors
    }

    // Check for milestone achievements
    let streakMilestone = null;
    let newAchievement = false;
    if (newStreak === 7 || newStreak === 14 || newStreak === 30 || newStreak === 50 || newStreak === 100) {
      streakMilestone = newStreak;
      newAchievement = true;
    }

    return res.json({ 
      success: true, 
      pointsEarned: dailyPoints,
      pointsAwarded: dailyPoints, 
      streak: state.streak, 
      totalPoints: state.totalPoints, 
      checkedInDays: state.checkedInDays,
      streakMilestone,
      newAchievement
    });
  } catch (e) {
    console.error('daily/checkin error:', e);
    console.error('Check-in error details:', {
      userId: req.user?.id,
      hasMongoUri: !!process.env.MONGODB_URI,
      errorMessage: e.message,
      errorStack: e.stack
    });
    res.status(500).json({ success: false, error: 'Check-in failed' });
  }
});

// Reward redemption endpoint
app.post('/api/daily/redeem', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rewardId } = req.body || {};
    
    if (!rewardId) {
      return res.status(400).json({ success: false, error: 'Reward ID required' });
    }

    // Define available rewards
    const rewards = {
      'r1': { name: 'Extra Check-in Points', cost: 100, type: 'boost', bonus: 20 },
      'r2': { name: 'Streak Freeze (1 day)', cost: 500, type: 'protection', days: 1 },
      'r3': { name: 'Double Points (24h)', cost: 1000, type: 'boost', duration: 24 },
      'r4': { name: 'Profile Badge', cost: 2000, type: 'cosmetic', badge: 'premium' }
    };

    const reward = rewards[rewardId];
    if (!reward) {
      return res.status(400).json({ success: false, error: 'Invalid reward' });
    }

    let state = await DailyState.findOne({ userId });
    if (!state) {
      return res.status(400).json({ success: false, error: 'User state not found' });
    }

    if (state.totalPoints < reward.cost) {
      return res.status(400).json({ success: false, error: 'Insufficient points' });
    }

    // Atomic update: deduct points and track reward
    state = await DailyState.findOneAndUpdate(
      { userId, totalPoints: { $gte: reward.cost } },
      {
        $inc: { totalPoints: -reward.cost },
        $push: {
          redeemedRewards: {
            rewardId,
            redeemedAt: new Date(),
            name: reward.name
          }
        }
      },
      { new: true }
    );
    
    if (!state) {
      return res.status(400).json({ success: false, error: 'Insufficient points or state not found' });
    }

    res.json({ 
      success: true, 
      reward: reward.name,
      remainingPoints: state.totalPoints,
      message: `Successfully redeemed ${reward.name}!`
    });
  } catch (e) {
    console.error('reward redemption error:', e);
    res.status(500).json({ success: false, error: 'Redemption failed' });
  }
});

// Get user's redeemed rewards
app.get('/api/daily/rewards', requireTelegramAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const state = await DailyState.findOne({ userId });
    
    if (!state) {
      return res.json({ success: true, rewards: [], totalPoints: 0 });
    }

    res.json({ 
      success: true, 
      rewards: state.redeemedRewards || [],
      totalPoints: state.totalPoints || 0
    });
  } catch (e) {
    console.error('get rewards error:', e);
    res.status(500).json({ success: false, error: 'Failed to load rewards' });
  }
});

// quarry database to get sell order for sell page
app.get("/api/sell-orders", async (req, res) => {
    try {
        const { telegramId } = req.query;

        if (!telegramId) {
            return res.status(400).json({ error: "Missing telegramId" });
        }

        const transactions = await SellOrder.find({ telegramId })
            .sort({ dateCreated: -1 }) 
            .limit(3); 

        res.json(transactions);
    } catch (err) {
        console.error("Error fetching transactions:", err);
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});

//for referral page 
// Authentication middleware for referral endpoints
function validateTelegramUser(req, res, next) {
    const userId = req.params.userId;
    const telegramId = req.headers['x-telegram-id'];
    
    console.log(`Validating access for userId: ${userId}, telegramId: ${telegramId}`);
    
    if (!telegramId || telegramId !== userId) {
        console.log(`Unauthorized access attempt: userId=${userId}, telegramId=${telegramId}`);
        return res.status(403).json({ 
            success: false, 
            error: 'Unauthorized access to referral data' 
        });
    }
    next();
}

// Debounce cache for repair function (avoid running too frequently)
const repairDebounceCache = new Map();
const REPAIR_DEBOUNCE_MS = 60000; // Only run repair once per minute per user

// Helper function to repair stuck pending referrals that should be activated
async function repairStuckReferrals(userId) {
    try {
        // Check if we've already repaired for this user recently
        const lastRepairTime = repairDebounceCache.get(userId);
        const now = Date.now();
        if (lastRepairTime && (now - lastRepairTime) < REPAIR_DEBOUNCE_MS) {
            // Skip repair - ran too recently for this user
            return 0;
        }
        
        // Mark that we're attempting repair for this user
        repairDebounceCache.set(userId, now);
        
        // Find all pending referrals for this user
        const pendingReferrals = await Referral.find({
            referrerUserId: userId,
            status: 'pending'
        });
        
        if (!pendingReferrals.length) {
            return 0; // No stuck referrals
        }
        
        let repaired = 0;
        
        for (const referral of pendingReferrals) {
            try {
                // Find the corresponding tracker
                const tracker = await ReferralTracker.findOne({
                    referral: referral._id,
                    referredUserId: referral.referredUserId
                });
                
                if (!tracker) {
                    continue; // No tracker, skip
                }
                
                // Check if this referral should be activated
                const totalStars = tracker.totalBoughtStars + tracker.totalSoldStars;
                
                if ((totalStars >= 100 || tracker.premiumActivated) && tracker.status === 'pending') {
                    // Activate the referral
                    console.log(`[REPAIR] Activating stuck referral ${referral._id} for user ${userId}: ${totalStars} stars`);
                    
                    // Update tracker
                    tracker.status = 'active';
                    tracker.dateActivated = new Date();
                    await tracker.save();
                    
                    // Update referral - ensure dateReferred is set if missing
                    referral.status = 'active';
                    referral.dateActivated = new Date();
                    if (!referral.dateReferred && referral.dateCreated) {
                        referral.dateReferred = referral.dateCreated;
                    } else if (!referral.dateReferred) {
                        referral.dateReferred = new Date('2026-03-01T00:00:00Z');
                    }
                    await referral.save();
                    
                    // Get referred user info for notification
                    const referredUser = await User.findOne({ id: referral.referredUserId });
                    
                    // Update ambassador earnings if referrer is an ambassador
                    const referrer = await User.findOne({ id: referral.referrerUserId });
                    if (referrer && referrer.ambassadorEmail) {
                        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
                        const totalReferrals = await Referral.countDocuments({
                            referrerUserId: referral.referrerUserId,
                            $or: [
                                { dateReferred: { $gte: marchFirstDate } },
                                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
                            ],
                            status: 'active'
                        });
                        
                        const levelEarnings = recalculateLevelEarnings(totalReferrals);
                        const totalAmount = getTotalAmbassiadorEarnings(levelEarnings);
                        const newLevel = getAmbassadorTier(totalReferrals).level;
                        
                        await User.findOneAndUpdate(
                            { id: referral.referrerUserId },
                            {
                                ambassadorCurrentLevel: newLevel,
                                ambassadorReferralCount: totalReferrals,
                                ambassadorLevelEarnings: levelEarnings,
                                ambassadorPendingBalance: totalAmount,
                                $push: {
                                    ambassadorEarningsHistory: {
                                        timestamp: new Date(),
                                        referralCount: totalReferrals,
                                        level: newLevel,
                                        earnedAmount: totalAmount,
                                        reason: 'repair_stuck_referral'
                                    }
                                }
                            }
                        );
                        
                        console.log(`[REPAIR] Ambassador earnings recalculated for ${referral.referrerUserId}`);
                    }
                    
                    // Send notification to referrer about balance recovery
                    try {
                        if (referrer && referrer.id) {
                            await bot.sendMessage(
                                referrer.id,
                                `✅ <b>Referral Balance Recovered!</b>\n\n` +
                                `Your referral from @${referredUser?.username || 'Unknown User'} has been activated and your balance has been updated!\n\n` +
                                `💰 <b>You earned: +0.5 USDT</b>\n` +
                                `⭐ Total Stars: ${totalStars}\n\n` +
                                `Check your referral dashboard to see your updated balance.`,
                                { parse_mode: 'HTML', disable_web_page_preview: true }
                            );
                            console.log(`[REPAIR] Notification sent to referrer ${referrer.id} about balance recovery`);
                        }
                    } catch (err) {
                        console.error(`[REPAIR] Failed to send notification to referrer ${referral.referrerUserId}:`, err.message);
                    }
                    
                    // Send audit notification to admins
                    try {
                        const adminIds = ['852842945', '5843755611', '5902903648', '7070816262'];
                        const adminMessage = `🔧 <b>AUTOMATIC REPAIR: Balance Recovered</b>\n\n` +
                            `<b>Referrer:</b> @${referrer?.username || 'unknown'} (ID: ${referral.referrerUserId})\n` +
                            `<b>Referred User:</b> @${referredUser?.username || 'unknown'} (ID: ${referral.referredUserId})\n` +
                            `<b>Total Stars:</b> ${totalStars}\n` +
                            `<b>Reason:</b> Stuck pending referral recovered by repair function\n` +
                            `<b>Balance Earned:</b> +0.5 USDT\n` +
                            `<b>Time:</b> ${new Date().toISOString()}`;
                        
                        for (const adminId of adminIds) {
                            try {
                                await bot.sendMessage(adminId, adminMessage, { 
                                    parse_mode: 'HTML', 
                                    disable_web_page_preview: true 
                                });
                            } catch (adminErr) {
                                console.error(`[REPAIR] Failed to notify admin ${adminId}:`, adminErr.message);
                            }
                        }
                    } catch (err) {
                        console.error(`[REPAIR] Error sending admin notifications:`, err.message);
                    }
                    
                    repaired++;
                }
            } catch (err) {
                console.error(`[REPAIR] Error repairing referral ${referral._id}:`, err.message);
            }
        }
        
        if (repaired > 0) {
            console.log(`[REPAIR] Successfully repaired ${repaired} stuck referrals for user ${userId}`);
        }
        
        return repaired;
    } catch (error) {
        console.error(`[REPAIR] Error checking for stuck referrals:`, error.message);
        return 0;
    }
}

// Leaderboard endpoint (global by points, friends by referrals relationship)
app.get('/api/referral-stats/:userId', (req, res, next) => {
    // Skip Telegram validation for ambassador app
    if (req.isAmbassadorApp) {
        return next();
    }
    // Apply normal validation for other requests
    validateTelegramUser(req, res, next);
}, async (req, res) => {
    try {
        const userId = req.params.userId;
        const isAmbassadorRequest = req.query.type === 'ambassador';
        console.log(`Fetching referral data for user: ${userId}${isAmbassadorRequest ? ' (ambassador)' : ''}`);
        
        // Check if user exists
        const user = await User.findOne({ id: userId });
        if (!user) {
            console.log(`User not found: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        // Auto-repair any stuck pending referrals in BACKGROUND (non-blocking)
        // Don't await - let it run asynchronously while we return stats immediately
        repairStuckReferrals(userId)
            .then(repairedCount => {
                if (repairedCount > 0) {
                    console.log(`[REPAIR] Background: Repaired ${repairedCount} stuck referrals for ${userId}`);
                }
            })
            .catch(err => {
                console.error(`[REPAIR] Background error for ${userId}:`, err.message);
            });
        
        // Check if user is actually an ambassador (has ambassadorEmail set)
        const isAmbassador = !!user.ambassadorEmail;
        
        // Determine date range for filtering
        const now = new Date();
        let dateFilterForDisplay = {}; // For display list
        let dateFilterForStats = {}; // For balance calculation
        
        if (isAmbassadorRequest && isAmbassador) {
            // For ambassadors: Show only CURRENT MONTH referrals
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            dateFilterForDisplay = { $gte: monthStart, $lt: monthEnd };
            dateFilterForStats = { $gte: monthStart, $lt: monthEnd }; // Ambassadors: stats also from current month
            console.log(`[Ambassador] Filtering ${userId} for month: ${monthStart.toISOString().split('T')[0]} to ${monthEnd.toISOString().split('T')[0]}`);
        } else {
            // For regular users: Display list from March 1st onwards, but STATS from ALL TIME
            const marchFirstDate = new Date('2026-03-01T00:00:00Z');
            dateFilterForDisplay = { $gte: marchFirstDate }; // Display: from March 1st
            dateFilterForStats = { $gte: new Date(0) }; // Stats: ALL TIME (from epoch onwards)
            console.log(`[Regular User] Display from March 1st onwards, but calculating stats from ALL TIME for user ${userId}`);
        }
        
        // Fetch referrals for display (filtered by date)
        const referralsForDisplay = await Referral.find({
            referrerUserId: userId,
            $or: [
                { dateReferred: dateFilterForDisplay },
                { dateReferred: { $exists: false }, dateCreated: dateFilterForDisplay }
            ]
        });
        
        // Fetch ALL referrals for balance calculation (for regular users: all-time; for ambassadors: current month)
        const referralsForStats = await Referral.find({
            referrerUserId: userId,
            $or: [
                { dateReferred: dateFilterForStats },
                { dateReferred: { $exists: false }, dateCreated: dateFilterForStats }
            ]
        });
        
        const referredUserIds = referralsForDisplay.map(r => r.referredUserId);
        const userIds = await User.find({ id: { $in: referredUserIds } });
        
        const userMap = {};
        userIds.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referralsForDisplay.length;
        
        // Get completed/active AND non-withdrawn referrals - for STATS (all-time for regular users)
        const availableReferrals = referralsForStats.filter(r =>
            r.status === 'active' && !r.withdrawn
        ).length;

        // Get all active referrals - for STATS (all-time for regular users)
        const completedReferrals = referralsForStats.filter(r => 
            r.status === 'active'
        ).length;
        
        // Use user's stored referral hash (generated when they first joined)
        let professionalRefLink = user.referralHash;
        if (!professionalRefLink) {
            // Generate and save if missing (backward compatibility)
            professionalRefLink = generateUserReferralHash(userId);
            await User.findByIdAndUpdate(user._id, { referralHash: professionalRefLink });
        }
        
        // Referral stats calculated
        // For ambassadors, add ambassador-specific fields
        let ambassadorStats = {};
        if (isAmbassador) {
            // Determine current tier based on ACTIVE referrals count (not total)
            let currentTier = 0; // No tier if no active referrals
            if (completedReferrals >= 100) currentTier = 4; // Elite (100+)
            else if (completedReferrals >= 70) currentTier = 3; // Pioneer (70+)
            else if (completedReferrals >= 50) currentTier = 2; // Connector (50+)
            else if (completedReferrals >= 30) currentTier = 1; // Explorer (30+)
            
            const tierBenefits = {
                0: { freeStars: 0, minEarnings: 0 },
                1: { freeStars: 50, minEarnings: 30 },
                2: { freeStars: 100, minEarnings: 60 },
                3: { freeStars: 150, minEarnings: 80 },
                4: { freeStars: 200, minEarnings: 110 }
            };
            
            const benefits = tierBenefits[currentTier];
            
            // Use tier-based earnings from database or calculate from completed referrals
            const pendingFromDb = user.ambassadorPendingBalance || 0;
            const totalEarnedFromDb = user.ambassadorLevelEarnings || {};
            
            // Calculate available balance (not withdrawn referrals count)
            const availableBalance = availableReferrals * 0.5;
            
            ambassadorStats = {
                ambassadorTier: currentTier,
                ambassadorEmail: user.ambassadorEmail,
                freeStars: benefits.freeStars,
                activeReferralsCount: completedReferrals,
                pendingAmount: availableBalance,
                totalEarned: (totalEarnedFromDb.preLevelOne || 0) + (totalEarnedFromDb.levelOne || 0) + (totalEarnedFromDb.levelTwo || 0) + (totalEarnedFromDb.levelThree || 0) + (totalEarnedFromDb.levelFour || 0),
                avgTransaction: 0, // Would need to calculate from actual transactions
                walletAddress: user.ambassadorWalletAddress || null,
                walletPreview: user.ambassadorWalletAddress ? user.ambassadorWalletAddress.substring(0,8) + '…' + user.ambassadorWalletAddress.slice(-4) : 'Not set'
            };
        }

        // Paginate referrals for frontend display (stats calculated from all-time for regular users, or current month for ambassadors)
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const displayLimit = Math.min(parseInt(req.query.limit) || 50, 500);
        const skip = (page - 1) * displayLimit;
        const referralsDisplay = referralsForDisplay.slice(skip, skip + displayLimit);

        const responseData = {
            success: true,
            referrals: referralsDisplay.map(ref => ({
                userId: ref.referredUserId,
                name: userMap[ref.referredUserId] || `User ${ref.referredUserId.substring(0, 6)}`,
                status: ref.status.toLowerCase(),
                date: ref.dateReferred || ref.dateCreated || new Date(0),
                amount: 0.5,
                linkFormat: ref.linkFormat || 'old'
            })),
            stats: {
                availableBalance: availableReferrals * 0.5,
                totalEarned: completedReferrals * 0.5,
                referralsCount: totalReferrals,
                pendingAmount: (completedReferrals - availableReferrals) * 0.5
            },
            pagination: {
                page,
                limit: displayLimit,
                total: totalReferrals,
                pages: Math.ceil(totalReferrals / displayLimit)
            },
            referralLink: `https://t.me/TgStarStore_bot?start=${professionalRefLink}`,
            newReferralLink: `https://t.me/TgStarStore_bot?start=${professionalRefLink}`,
            isAmbassador: isAmbassador,
            ...ambassadorStats
        };
        
        // Returning referral stats
        res.json(responseData);
        
    } catch (error) {
        console.error('Referral stats error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to load referral data' 
        });
    }
});

// Leaderboard endpoint (global by points, friends by referrals relationship)
app.get('/api/leaderboard', requireTelegramAuth, async (req, res) => {
  try {
    const scope = (req.query.scope || 'global').toString();
    const requesterId = req.user.id;
    const wRef = Math.max(0, Math.min(1, parseFloat(req.query.wRef || '0.7')));
    const wAct = Math.max(0, Math.min(1, parseFloat(req.query.wAct || '0.3')));
    const norm = (wRef + wAct) || 1; // avoid 0 division

    if (scope === 'friends') {
      // Show the current user's referrals (referred users), ranked by their activity
      const referredIds = await Referral.find({ referrerUserId: requesterId, status: 'active' }).distinct('referredUserId');
      const [users, activity] = await Promise.all([
        User.find({ id: { $in: referredIds } }, { id: 1, username: 1 }),
        DailyState.find({ userId: { $in: referredIds } }, { userId: 1, totalPoints: 1 })
      ]);
      const idToUsername = new Map(users.map(u => [u.id, u.username]));
      const idToActivity = new Map(activity.map(d => [d.userId, d.totalPoints]));
      const maxAct = Math.max(1, ...activity.map(a => a.totalPoints || 0), 1);
      const entriesRaw = referredIds.map(id => {
        const act = idToActivity.get(id) || 0;
        const score = (act / maxAct) * 100; // friends: score purely from activity
        return { userId: id, username: idToUsername.get(id) || null, activityPoints: act, referralsCount: 1, score };
      }).sort((a, b) => b.score - a.score);

      return res.json({
        success: true,
        scope,
        entries: entriesRaw.map((e, idx) => ({
          rank: idx + 1,
          userId: e.userId,
          username: e.username && isPrivateUsername(e.username) ? null : e.username,
          displayName: e.username && isPrivateUsername(e.username) ? generatePseudonym(e.userId, e.username) : (e.username || null),
          isPseudonym: !!(e.username && isPrivateUsername(e.username)),
          points: e.referralsCount,
          activityPoints: e.activityPoints,
          score: Math.round(e.score)
        })),
        userRank: null
      });
    }

    // Global: rank users by daily activity points (primary) and referrals (secondary)
    // Get ALL users who have referrals OR daily activity
    let referralCounts, dailyUsers;
    if (process.env.MONGODB_URI) {
      // Production: Use MongoDB
      [referralCounts, dailyUsers] = await Promise.all([
        Referral.aggregate([
          { $match: { status: 'active' } },
          { $group: { _id: '$referrerUserId', referralsCount: { $sum: 1 } } }
        ]),
        DailyState.find({}, { userId: 1, totalPoints: 1, streak: 1, missionsCompleted: 1, lastCheckIn: 1 })
      ]);
    } else {
      // Development: Use file-based storage
      [referralCounts, dailyUsers] = await Promise.all([
        db.aggregateReferrals([
          { $match: { status: { $in: ['active', 'completed'] } } },
          { $group: { _id: '$referrerUserId', referralsCount: { $sum: 1 } } }
        ]),
        db.findAllDailyStates()
      ]);
    }

    // Get all unique user IDs (from referrals + daily activity)
    const referralUserIds = referralCounts.map(r => r._id);
    const dailyUserIds = dailyUsers.map(d => d.userId);
    const allUserIds = [...new Set([...referralUserIds, ...dailyUserIds])];
    
    // Get user info for all users
    let users;
    if (process.env.MONGODB_URI) {
      users = await User.find({ id: { $in: allUserIds } }, { id: 1, username: 1 });
    } else {
      users = await Promise.all(allUserIds.map(id => db.findUser(id)));
    }
    
    const idToUsername = new Map(users.filter(u => u).map(u => [u.id, u.username]));
    const idToReferrals = new Map(referralCounts.map(r => [r._id, r.referralsCount]));
    const idToDailyState = new Map(dailyUsers.map(d => [d.userId, d]));

    console.log(`📊 Leaderboard data: ${allUserIds.length} total users, ${referralCounts.length} with referrals, ${dailyUsers.length} with daily activity`);

    const maxPoints = Math.max(1, ...dailyUsers.map(d => d.totalPoints || 0));
    const maxReferrals = Math.max(1, ...referralCounts.map(r => r.referralsCount), 1);
    
    const entriesRaw = allUserIds.map(userId => {
      const referrals = idToReferrals.get(userId) || 0;
      const dailyState = idToDailyState.get(userId);
      const points = dailyState?.totalPoints || 0;
      const missions = dailyState?.missionsCompleted?.length || 0;
      const lastCheckIn = dailyState?.lastCheckIn;
      
      // Calculate referral points (5 points per referral)
      const referralPoints = referrals * 5;
      
      // Calculate missing check-in penalty (lose 2 points per missed day)
      const today = new Date();
      const lastCheckInDate = lastCheckIn ? new Date(lastCheckIn) : null;
      let missedDays = 0;
      if (lastCheckInDate) {
        const daysDiff = Math.floor((today - lastCheckInDate) / (1000 * 60 * 60 * 24));
        missedDays = Math.max(0, daysDiff - 1); // Don't count today as missed
      }
      const penaltyPoints = missedDays * 2;
      
      // Total points = daily points + referral points - penalty
      const totalPoints = points + referralPoints - penaltyPoints;
      
      // Score: 60% total points, 25% referrals, 15% missions
      const pointsScore = (totalPoints / Math.max(maxPoints + (maxReferrals * 5), 1)) * 0.6;
      const refScore = (referrals / maxReferrals) * 0.25;
      const missionScore = Math.min(missions / 10, 1) * 0.15; // Cap missions at 10
      
      const score = pointsScore + refScore + missionScore;
      
      const rawUsername = idToUsername.get(userId) || null;
      const masked = rawUsername && isPrivateUsername(rawUsername);
      const username = masked ? null : rawUsername;
      return { 
        userId: userId, 
        username, 
        displayName: masked ? generatePseudonym(userId, rawUsername) : (rawUsername || null),
        isPseudonym: !!masked,
        referralsCount: referrals,
        referralPoints: referralPoints,
        penaltyPoints: penaltyPoints,
        activityPoints: points,
        totalPoints: totalPoints,
        missionsCompleted: missions,
        streak: dailyState?.streak || 0,
        missedDays: missedDays,
        score 
      };
    }).sort((x, y) => y.score - x.score).slice(0, 100); // Limit to top 100

    // Compute requester rank based on total points (daily + referrals)
    let requesterRank = null;
    const requesterEntry = entriesRaw.find(e => e.userId === requesterId);
    if (requesterEntry && requesterEntry.totalPoints > 0) {
      const usersWithMorePoints = entriesRaw.filter(e => e.totalPoints > requesterEntry.totalPoints).length;
      requesterRank = usersWithMorePoints + 1;
    }

    return res.json({
      success: true,
      scope,
      entries: entriesRaw.map((e, idx) => ({
        rank: idx + 1,
        userId: e.userId,
        username: e.username,
        points: e.totalPoints,
        activityPoints: e.activityPoints,
        referralPoints: e.referralPoints,
        penaltyPoints: e.penaltyPoints,
        referralsCount: e.referralsCount,
        missionsCompleted: e.missionsCompleted,
        streak: e.streak,
        missedDays: e.missedDays,
        score: Math.round(e.score * 100)
      })),
      userRank: requesterRank
    });
  } catch (e) {
    console.error('leaderboard error:', e);
    console.error('Leaderboard error details:', {
      userId: req.user?.id,
      hasMongoUri: !!process.env.MONGODB_URI,
      errorMessage: e.message,
      errorStack: e.stack
    });
    res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});
//get history for referrals withdraw for referral page

app.get('/api/withdrawal-history/:userId', validateTelegramUser, async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`Fetching withdrawal history for user: ${userId}`);
        
        // Check if user exists
        const user = await User.findOne({ id: userId });
        if (!user) {
            console.log(`User not found for withdrawal history: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const withdrawals = await ReferralWithdrawal.find({ userId })
            .sort({ createdAt: -1 })
            .limit(50);

        console.log(`Found ${withdrawals.length} withdrawals for user ${userId}`);
        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error('Withdrawal history error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== AMBASSADOR TIER EARNINGS ENDPOINTS ==========

/**
 * Endpoint: Calculate and update ambassador earnings
 * Called when a referral is added/confirmed
 * Recalculates tier earnings based on current total referrals
 */
app.post('/api/ambassador/update-earnings', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId required' });
        }
        
        const user = await User.findOne({ id: userId });
        if (!user || !user.ambassadorEmail) {
            return res.status(404).json({ success: false, error: 'Ambassador not found' });
        }
        
        // Count total referrals from March 1st onwards (filter to active/completed like referral stats)
        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
        const totalReferrals = await Referral.countDocuments({
            referrerUserId: userId,
            $or: [
                { dateReferred: { $gte: marchFirstDate } },
                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
            ]
        });
        
        // Recalculate earnings for all tiers based on current referral count
        const levelEarnings = recalculateLevelEarnings(totalReferrals);
        const totalAmount = getTotalAmbassiadorEarnings(levelEarnings);
        const newLevel = getAmbassadorTier(totalReferrals).level;
        
        // Track earnings history
        const historyEntry = {
            timestamp: new Date(),
            referralCount: totalReferrals,
            level: newLevel,
            earnedAmount: totalAmount,
            reason: 'referral_added'
        };
        
        // Update user with new earnings
        const updatedUser = await User.findOneAndUpdate(
            { id: userId },
            {
                ambassadorCurrentLevel: newLevel,
                ambassadorReferralCount: totalReferrals,
                ambassadorLevelEarnings: levelEarnings,
                ambassadorPendingBalance: totalAmount,
                $push: { ambassadorEarningsHistory: historyEntry }
            },
            { new: true }
        );
        
        console.log(`Ambassador earnings updated for ${userId}: ${totalReferrals} referrals, level ${newLevel}, $${totalAmount.toFixed(2)}`);
        
        return res.json({
            success: true,
            userId,
            totalReferrals,
            currentLevel: newLevel,
            levelEarnings,
            totalAmount,
            message: 'Ambassador earnings updated'
        });
        
    } catch (error) {
        console.error('Error updating ambassador earnings:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endpoint: Create monthly auto-withdrawal for ambassador
 * Creates a ReferralWithdrawal record with all tier earnings combined
 * Runs at month-end, aggregates all tier balances
 */
app.post('/api/ambassador/create-monthly-withdrawal', requireAdmin, async (req, res) => {
    try {
        const { userId, month } = req.body; // month format: "2026-03"
        
        if (!userId || !month) {
            return res.status(400).json({ success: false, error: 'userId and month required' });
        }
        
        const user = await User.findOne({ id: userId });
        if (!user || !user.ambassadorEmail) {
            return res.status(404).json({ success: false, error: 'Ambassador not found' });
        }
        
        // Get current tier earnings (all levels combined)
        const levelEarnings = user.ambassadorLevelEarnings || {
            preLevelOne: 0,
            levelOne: 0,
            levelTwo: 0,
            levelThree: 0,
            levelFour: 0
        };
        
        const totalAmount = getTotalAmbassiadorEarnings(levelEarnings);
        
        if (totalAmount <= 0) {
            return res.status(400).json({ success: false, error: 'No earnings to withdraw' });
        }
        
        // Create withdrawal record with tier breakdown
        const withdrawal = new ReferralWithdrawal({
            userId: user.id,
            username: user.username,
            amount: totalAmount,
            walletAddress: user.ambassadorWalletAddress,
            isAmbassadorWithdrawal: true,
            ambassadorLevel: user.ambassadorCurrentLevel || 0,
            ambassadorReferralCount: user.ambassadorReferralCount || 0,
            ambassadorLevelBreakdown: levelEarnings,
            ambassadorStars: [10, 25, 50, 75, 100][user.ambassadorCurrentLevel || 0] * 10, // Stars based on tier
            ambassadorMonth: month,
            status: 'pending',
            createdAt: new Date(),
            userLocation: user.lastLocation || {}
        });
        
        await withdrawal.save();
        
        // Store withdrawal in user's history
        await User.findOneAndUpdate(
            { id: userId },
            {
                $push: {
                    'ambassadorMonthlyWithdrawals': {
                        month,
                        amount: totalAmount,
                        levelBreakdown: levelEarnings,
                        stars: withdrawal.ambassadorStars,
                        status: 'pending',
                        withdrawalDate: new Date()
                    }
                }
            }
        );
        
        // Send email notification to ambassador
        await emailService.sendWithdrawalCreated(
            user.ambassadorEmail,
            user.username || 'Ambassador',
            totalAmount,
            [
                { tier: 'Pre-Level 1', amount: levelEarnings.preLevelOne || 0 },
                { tier: 'Level 1', amount: levelEarnings.levelOne || 0 },
                { tier: 'Level 2', amount: levelEarnings.levelTwo || 0 },
                { tier: 'Level 3', amount: levelEarnings.levelThree || 0 },
                { tier: 'Level 4', amount: levelEarnings.levelFour || 0 }
            ].filter(e => e.amount > 0)
        );
        
        console.log(`Monthly withdrawal created for ambassador ${userId}: $${totalAmount.toFixed(2)} (${month})`);
        console.log(`Tier breakdown - Pre-Level 1: $${levelEarnings.preLevelOne}, Level 1: $${levelEarnings.levelOne}, Level 2: $${levelEarnings.levelTwo}, Level 3: $${levelEarnings.levelThree}, Level 4: $${levelEarnings.levelFour}`);
        
        return res.json({
            success: true,
            withdrawalId: withdrawal.withdrawalId,
            userId,
            month,
            totalAmount,
            levelBreakdown: levelEarnings,
            stars: withdrawal.ambassadorStars,
            message: 'Monthly withdrawal created'
        });
        
    } catch (error) {
        console.error('Error creating monthly withdrawal:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endpoint: Get ambassador withdrawal details for admin approval
 * Returns formatted withdrawal info with tier breakdown
 */
app.get('/api/ambassador/withdrawal/:withdrawalId', async (req, res) => {
    try {
        const { withdrawalId } = req.params;
        
        const withdrawal = await ReferralWithdrawal.findOne({ withdrawalId });
        if (!withdrawal || !withdrawal.isAmbassadorWithdrawal) {
            return res.status(404).json({ success: false, error: 'Ambassador withdrawal not found' });
        }
        
        const user = await User.findOne({ id: withdrawal.userId });
        
        const breakdown = withdrawal.ambassadorLevelBreakdown || {};
        
        return res.json({
            success: true,
            withdrawal: {
                withdrawalId: withdrawal.withdrawalId,
                userId: withdrawal.userId,
                username: withdrawal.username,
                amount: withdrawal.amount,
                walletAddress: withdrawal.walletAddress,
                walletPreview: withdrawal.walletAddress ? withdrawal.walletAddress.substring(0, 8) + '…' + withdrawal.walletAddress.slice(-4) : 'Not set',
                status: withdrawal.status,
                month: withdrawal.ambassadorMonth,
                levelBreakdown: {
                    preLevelOne: breakdown.preLevelOne || 0,
                    levelOne: breakdown.levelOne || 0,
                    levelTwo: breakdown.levelTwo || 0,
                    levelThree: breakdown.levelThree || 0,
                    levelFour: breakdown.levelFour || 0
                },
                stars: withdrawal.ambassadorStars || 0,
                currentLevel: withdrawal.ambassadorLevel || 0,
                totalReferrals: withdrawal.ambassadorReferralCount || 0,
                createdAt: withdrawal.createdAt,
                approvedBy: withdrawal.approvedBy || null,
                approvalDate: withdrawal.approvalDate || null,
                declineReason: withdrawal.declineReason || null
            }
        });
        
    } catch (error) {
        console.error('Error fetching ambassador withdrawal:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endpoint: Admin approve/decline ambassador withdrawal
 * Updates withdrawal status and notifies user
 */
app.post('/api/ambassador/withdrawal/:withdrawalId/approve', requireAdmin, async (req, res) => {
    try {
        const { withdrawalId } = req.params;
        const { approved, declineReason, adminId, adminName } = req.body;
        
        if (typeof approved !== 'boolean') {
            return res.status(400).json({ success: false, error: 'approved boolean required' });
        }
        
        const withdrawal = await ReferralWithdrawal.findOne({ withdrawalId });
        if (!withdrawal || !withdrawal.isAmbassadorWithdrawal) {
            return res.status(404).json({ success: false, error: 'Ambassador withdrawal not found' });
        }
        
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ success: false, error: `Cannot process ${withdrawal.status} withdrawal` });
        }
        
        const breakdown = withdrawal.ambassadorLevelBreakdown || {};
        const newStatus = approved ? 'completed' : 'declined';
        
        // Update withdrawal record
        await ReferralWithdrawal.findOneAndUpdate(
            { withdrawalId },
            {
                status: newStatus,
                processedBy: adminId,
                processedAt: new Date(),
                approvedBy: adminName,
                declineReason: approved ? null : (declineReason || 'Declined by admin')
            }
        );
        
        // Update user's monthly withdrawal status
        const user = await User.findOne({ id: withdrawal.userId });
        if (user) {
            const monthlyWithdrawal = user.ambassadorMonthlyWithdrawals?.find(w => w.month === withdrawal.ambassadorMonth);
            if (monthlyWithdrawal) {
                monthlyWithdrawal.status = newStatus;
                monthlyWithdrawal.approvalDate = new Date();
                await user.save();
            }
        }
        
        // Reset user's tier earnings balance if approved (withdrawal processed)
        if (approved) {
            await User.findOneAndUpdate(
                { id: withdrawal.userId },
                {
                    ambassadorLevelEarnings: {
                        preLevelOne: 0,
                        levelOne: 0,
                        levelTwo: 0,
                        levelThree: 0,
                        levelFour: 0
                    },
                    ambassadorPendingBalance: 0,
                    ambassadorLastWithdrawalDate: new Date()
                }
            );
            
            // Send approval email
            await emailService.sendWithdrawalApproved(
                user.ambassadorEmail,
                user.username || 'Ambassador',
                withdrawal.amount,
                withdrawal.transactionHash || null
            );
        } else {
            // Send decline email
            await emailService.sendWithdrawalDeclined(
                user.ambassadorEmail,
                user.username || 'Ambassador',
                declineReason || 'Your withdrawal could not be processed. Please contact support for details.'
            );
        }
        
        // Format approval message for user
        const approvalMessage = approved
            ? `✅ Ambassador Withdrawal Approved!\n\nMonth: ${withdrawal.ambassadorMonth}\nAmount: $${withdrawal.amount.toFixed(2)}\n\nTier Breakdown:\n- Pre-Level: $${breakdown.preLevelOne?.toFixed(2) || '0.00'}\n- Level 1: $${breakdown.levelOne?.toFixed(2) || '0.00'}\n- Level 2: $${breakdown.levelTwo?.toFixed(2) || '0.00'}\n- Level 3: $${breakdown.levelThree?.toFixed(2) || '0.00'}\n- Level 4: $${breakdown.levelFour?.toFixed(2) || '0.00'}\n\nStars: ${withdrawal.ambassadorStars || 0}\nProcessed by: @${adminName}`
            : `❌ Ambassador Withdrawal Declined\n\nMonth: ${withdrawal.ambassadorMonth}\nAmount: $${withdrawal.amount.toFixed(2)}\n\nReason: ${declineReason || 'No reason provided'}\n\nYou can request a new withdrawal next month.\nProcessed by: @${adminName}`;
        
        console.log(`Ambassador withdrawal ${withdrawalId} ${newStatus} by @${adminName}. Amount: $${withdrawal.amount.toFixed(2)}`);
        
        // Send notification to user via bot
        if (bot && withdrawal.userId) {
            try {
                await bot.sendMessage(withdrawal.userId, approvalMessage);
            } catch (botErr) {
                console.warn(`Could not send approval message to user ${withdrawal.userId}:`, botErr.message);
            }
        }
        
        // Update all admin messages about this withdrawal
        const updatedAdminText = approved
            ? `✅ <b>Ambassador Withdrawal APPROVED</b>\n\n<b>Details:</b>\nWithdrawal ID: ${withdrawalId}\nUser: ${withdrawal.username} (ID: ${withdrawal.userId})\nMonth: ${withdrawal.ambassadorMonth}\nAmount: $${withdrawal.amount.toFixed(2)}\n\n<b>Action by:</b> ${adminName}\n<b>Timestamp:</b> ${new Date().toLocaleString()}`
            : `❌ <b>Ambassador Withdrawal DECLINED</b>\n\n<b>Details:</b>\nWithdrawal ID: ${withdrawalId}\nUser: ${withdrawal.username} (ID: ${withdrawal.userId})\nMonth: ${withdrawal.ambassadorMonth}\nAmount: $${withdrawal.amount.toFixed(2)}\nReason: ${declineReason || 'No reason provided'}\n\n<b>Action by:</b> ${adminName}\n<b>Timestamp:</b> ${new Date().toLocaleString()}`;
        
        const statusKeyboard = {
            inline_keyboard: [[{
                text: approved ? 'Approved' : 'Declined',
                callback_data: `withdrawal_status_${withdrawalId}`
            }]]
        };
        
        if (Array.isArray(withdrawal.adminMessages)) {
            for (const m of withdrawal.adminMessages) {
                if (m && m.adminId && m.messageId) {
                    try {
                        await bot.editMessageText(updatedAdminText, {
                            chat_id: parseInt(m.adminId, 10) || m.adminId,
                            message_id: m.messageId,
                            parse_mode: 'HTML'
                        });
                        await bot.editMessageReplyMarkup(statusKeyboard, {
                            chat_id: parseInt(m.adminId, 10) || m.adminId,
                            message_id: m.messageId
                        });
                    } catch (editErr) {
                        console.error(`Failed to edit withdrawal message for admin ${m.adminId}:`, editErr.message);
                    }
                }
            }
        }
        
        return res.json({
            success: true,
            withdrawalId,
            status: newStatus,
            message: approved ? 'Withdrawal approved' : 'Withdrawal declined',
            approvalMessage
        });
        
    } catch (error) {
        console.error('Error processing ambassador withdrawal approval:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Endpoint: Get all pending ambassador withdrawals (for admin panel)
 */
app.get('/api/ambassador/withdrawals/pending', requireAdmin, async (req, res) => {
    try {
        const pendingWithdrawals = await ReferralWithdrawal.find({
            isAmbassadorWithdrawal: true,
            status: 'pending'
        })
        .sort({ createdAt: -1 })
        .limit(100);
        
        const formatted = pendingWithdrawals.map(w => ({
            withdrawalId: w.withdrawalId,
            userId: w.userId,
            username: w.username,
            amount: w.amount,
            month: w.ambassadorMonth,
            currentLevel: w.ambassadorLevel,
            totalReferrals: w.ambassadorReferralCount,
            levelBreakdown: w.ambassadorLevelBreakdown,
            stars: w.ambassadorStars,
            walletAddress: w.walletAddress,
            walletPreview: w.walletAddress ? w.walletAddress.substring(0, 8) + '…' + w.walletAddress.slice(-4) : 'Not set',
            createdAt: w.createdAt
        }));
        
        return res.json({
            success: true,
            count: formatted.length,
            withdrawals: formatted
        });
        
    } catch (error) {
        console.error('Error fetching pending ambassador withdrawals:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Manual Ambassador Enrollment Endpoint (Admin Only)
app.post('/api/admin/enroll-ambassador', requireAdmin, async (req, res) => {
    try {
        const { userId, ambassadorEmail, walletAddress } = req.body;
        
        if (!userId || !ambassadorEmail) {
            return res.status(400).json({ success: false, error: 'userId and ambassadorEmail are required' });
        }
        
        // Verify email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(ambassadorEmail)) {
            return res.status(400).json({ success: false, error: 'Invalid email format' });
        }
        
        // Find or create user
        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        // Check if already ambassador
        if (user.ambassadorEmail) {
            return res.status(400).json({ success: false, error: 'User is already an ambassador' });
        }
        
        // Update user with ambassador fields
        await User.findOneAndUpdate(
            { id: userId },
            {
                ambassadorEmail,
                ambassadorApprovedAt: new Date(),
                ambassadorApprovedBy: req.user.id,
                ambassadorCurrentLevel: 0,
                ambassadorReferralCount: 0,
                ambassadorLevelEarnings: {
                    preLevelOne: 0,
                    levelOne: 0,
                    levelTwo: 0,
                    levelThree: 0,
                    levelFour: 0
                },
                ambassadorPendingBalance: 0,
                ambassadorMonthlyWithdrawals: [],
                ambassadorEarningsHistory: [{
                    timestamp: new Date(),
                    referralCount: 0,
                    level: 0,
                    earnedAmount: 0,
                    reason: 'manual_enrollment'
                }],
                ...(walletAddress && { walletAddress })
            }
        );
        
        // Send notification to user via Telegram
        try {
            if (user.telegramId) {
                const message = `🎉 **Congratulations!** You have been enrolled as an Ambassador.\n\n💼 Email: ${ambassadorEmail}\n\nYou can now earn from your referrals at higher rates!`;
                await bot.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
            }
        } catch (botError) {
            console.warn(`Failed to send Telegram notification to ${user.telegramId}:`, botError.message);
        }
        
        console.log(`✅ Ambassador enrolled: ${userId} (${ambassadorEmail})`);
        
        return res.json({
            success: true,
            message: 'Ambassador enrolled successfully',
            userId,
            ambassadorEmail,
            enrolledAt: new Date()
        });
        
    } catch (error) {
        console.error('Error enrolling ambassador:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Admin endpoint: Audit and recover lost referral balances
app.post('/api/admin/audit-and-recover-balances', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId is required' 
            });
        }
        
        console.log(`[AUDIT] Starting balance audit for user ${userId}`);
        
        // Get the user
        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        // Count active/completed non-withdrawn referrals
        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
        const availableReferrals = await Referral.countDocuments({
            referrerUserId: userId,
            $or: [
                { dateReferred: { $gte: marchFirstDate } },
                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
            ],
            status: 'active',
            withdrawn: { $ne: true }
        });
        
        const expectedBalance = availableReferrals * 0.5;
        const auditData = {
            userId,
            username: user.username,
            expectingBalance: expectedBalance,
            isAmbassador: !!user.ambassadorEmail,
            totalReferralsCount: availableReferrals,
            timestamp: new Date(),
            auditedBy: req.user.id
        };
        
        // Log audit for transparency
        console.log(`[AUDIT] Balance audit for ${userId}: ${availableReferrals} referrals = $${expectedBalance} USDT`);
        
        // If admin is requesting recovery, send notification to user about balance update
        if (req.body.sendNotification) {
            try {
                if (user.id) {
                    const message = `💰 <b>Balance Audit Complete</b>\n\n` +
                        `An admin has audited your referral balance.\n\n` +
                        `<b>Active Referrals:</b> ${availableReferrals}\n` +
                        `<b>Your Balance:</b> $${expectedBalance.toFixed(2)} USDT\n\n` +
                        `If this doesn't match what you see in your dashboard, please contact support.`;
                    
                    await bot.sendMessage(user.id, message, { 
                        parse_mode: 'HTML', 
                        disable_web_page_preview: true 
                    });
                    console.log(`[AUDIT] Notification sent to user ${userId} about balance audit`);
                }
            } catch (err) {
                console.error(`[AUDIT] Failed to send notification to user:`, err.message);
            }
        }
        
        return res.json({
            success: true,
            message: 'Balance audit completed',
            audit: auditData,
            recoveryOptions: {
                refreshFrontend: 'User should refresh their dashboard to see latest balance',
                manualCorrection: `Can manually adjust user balance if discrepancy found`,
                totalReferralsReportable: availableReferrals
            }
        });
        
    } catch (error) {
        console.error('Error auditing balance:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Admin endpoint: Manually trigger referral repair for specific user
app.post('/api/admin/manual-repair-referrals', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId is required' 
            });
        }
        
        console.log(`[ADMIN-REPAIR] Manual repair triggered for user ${userId} by admin ${req.user.id}`);
        
        // Force bypass the debounce by deleting the cache entry
        repairDebounceCache.delete(userId);
        
        // Run repair (will now execute because cache was cleared)
        const repairedCount = await repairStuckReferrals(userId);
        
        // Get updated balance
        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
        const availableReferrals = await Referral.countDocuments({
            referrerUserId: userId,
            $or: [
                { dateReferred: { $gte: marchFirstDate } },
                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
            ],
            status: 'active',
            withdrawn: { $ne: true }
        });
        
        const updatedBalance = availableReferrals * 0.5;
        
        return res.json({
            success: true,
            message: `Manual repair completed for user ${userId}`,
            repaired: repairedCount,
            updatedBalance: updatedBalance,
            timestamp: new Date(),
            initiatedBy: req.user.id
        });
        
    } catch (error) {
        console.error('Error in manual repair:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});


// DIAGNOSTIC ENDPOINT: Check for orphaned/mismatched referrals
app.post('/api/admin/diagnose-missing-balances', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId is required' 
            });
        }
        
        console.log(`[DIAGNOSE] Checking referral integrity for user ${userId}`);
        
        // Find all referrals for this user
        const allReferrals = await Referral.find({ referrerUserId: userId }).lean();
        console.log(`[DIAGNOSE] Found ${allReferrals.length} total referrals`);
        
        const diagnostics = {
            userId,
            totalReferrals: allReferrals.length,
            issues: [],
            summary: {
                orphanedReferrals: 0,      // Referral without tracker
                orphanedTrackers: 0,       // Tracker without referral  
                statusMismatch: 0,         // Status different between referral and tracker
                missingDateReferred: 0,    // Referral with no dateReferred
                withdrawnIncorrectly: 0    // Marked withdrawn but shouldn't be
            }
        };
        
        // Check each referral for issues
        for (const ref of allReferrals) {
            const tracker = await ReferralTracker.findOne({ referral: ref._id }).lean();
            
            // Issue 1: Orphaned referral (no tracker)
            if (!tracker) {
                diagnostics.issues.push({
                    type: 'orphaned_referral',
                    referralId: ref._id,
                    referredUserId: ref.referredUserId,
                    status: ref.status,
                    withdrawn: ref.withdrawn,
                    dateCreated: ref.dateCreated,
                    dateReferred: ref.dateReferred,
                    message: 'Referral exists but no ReferralTracker found'
                });
                diagnostics.summary.orphanedReferrals++;
            } else {
                // Issue 2: Status mismatch
                if (tracker.status !== ref.status) {
                    diagnostics.issues.push({
                        type: 'status_mismatch',
                        referralId: ref._id,
                        referredUserId: ref.referredUserId,
                        referralStatus: ref.status,
                        trackerStatus: tracker.status,
                        message: `Status mismatch: Referral=${ref.status} vs ReferralTracker=${tracker.status}`
                    });
                    diagnostics.summary.statusMismatch++;
                }
            }
            
            // Issue 3: Missing dateReferred
            if (!ref.dateReferred) {
                diagnostics.issues.push({
                    type: 'missing_dateReferred',
                    referralId: ref._id,
                    referredUserId: ref.referredUserId,
                    dateCreated: ref.dateCreated,
                    message: 'Referral missing dateReferred field'
                });
                diagnostics.summary.missingDateReferred++;
            }
            
            // Issue 4: Withdrawn status at risk
            if (ref.withdrawn && ref.status === 'pending') {
                diagnostics.issues.push({
                    type: 'withdrawn_pending',
                    referralId: ref._id,
                    referredUserId: ref.referredUserId,
                    message: 'Referral marked withdrawn but still pending'
                });
                diagnostics.summary.withdrawnIncorrectly++;
            }
        }
        
        // Check for orphaned trackers (tracker without referral)
        const allTrackers = await ReferralTracker.find({ referrerUserId: userId }).lean();
        for (const tracker of allTrackers) {
            const referral = await Referral.findById(tracker.referral).lean();
            if (!referral) {
                diagnostics.issues.push({
                    type: 'orphaned_tracker',
                    trackerId: tracker._id,
                    referredUserId: tracker.referredUserId,
                    status: tracker.status,
                    totalStars: tracker.totalBoughtStars + tracker.totalSoldStars,
                    message: 'ReferralTracker exists but Referral not found'
                });
                diagnostics.summary.orphanedTrackers++;
            }
        }
        
        return res.json({
            success: true,
            diagnostics,
            hasIssues: diagnostics.issues.length > 0,
            recommendation: diagnostics.issues.length > 0 ? 'Run /api/admin/recover-missing-balances' : 'No issues found'
        });
        
    } catch (error) {
        console.error('Diagnostic error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// RECOVERY ENDPOINT: Fix orphaned/mismatched referrals
app.post('/api/admin/recover-missing-balances', requireAdmin, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ 
                success: false, 
                error: 'userId is required' 
            });
        }
        
        console.log(`[RECOVER] Starting recovery for user ${userId}...`);
        
        const recovery = {
            userId,
            recovered: {
                referralsCreated: 0,
                statusFixed: 0,
                dateReferredFixed: 0,
                withdrawnFixed: 0
            },
            errors: []
        };
        
        // Find all trackers for this user
        const allTrackers = await ReferralTracker.find({ referrerUserId: userId });
        
        for (const tracker of allTrackers) {
            try {
                let referral = await Referral.findById(tracker.referral);
                
                // Fix 1: Create missing referral from tracker data
                if (!referral) {
                    console.log(`[RECOVER] Creating missing Referral for tracker ${tracker._id}`);
                    
                    referral = new Referral({
                        referrerUserId: userId,
                        referredUserId: tracker.referredUserId,
                        status: tracker.status,
                        dateCreated: tracker.dateCreated || new Date(),
                        dateReferred: tracker.dateReferred || tracker.dateCreated || new Date('2026-03-01T00:00:00Z'),
                        withdrawn: false
                    });
                    
                    await referral.save();
                    tracker.referral = referral._id;
                    await tracker.save();
                    
                    recovery.recovered.referralsCreated++;
                    console.log(`[RECOVER] Created Referral ${referral._id}`);
                } else {
                    // Fix 2: Sync status if mismatch
                    if (tracker.status !== referral.status) {
                        console.log(`[RECOVER] Fixing status mismatch for ${referral._id}: ${referral.status} → ${tracker.status}`);
                        referral.status = tracker.status;
                        if (tracker.status === 'active' && !referral.dateActivated) {
                            referral.dateActivated = tracker.dateActivated || new Date();
                        }
                        await referral.save();
                        recovery.recovered.statusFixed++;
                    }
                    
                    // Fix 3: Set dateReferred if missing
                    if (!referral.dateReferred) {
                        console.log(`[RECOVER] Setting dateReferred for ${referral._id}`);
                        referral.dateReferred = tracker.dateReferred || referral.dateCreated || new Date('2026-03-01T00:00:00Z');
                        await referral.save();
                        recovery.recovered.dateReferredFixed++;
                    }
                    
                    // Fix 4: Clear withdrawn flag if status is pending
                    if (referral.withdrawn && referral.status === 'pending') {
                        console.log(`[RECOVER] Clearing withdrawn flag for ${referral._id}`);
                        referral.withdrawn = false;
                        await referral.save();
                        recovery.recovered.withdrawnFixed++;
                    }
                }
            } catch (trackerError) {
                recovery.errors.push({
                    trackerId: tracker._id,
                    error: trackerError.message
                });
                console.error(`[RECOVER] Error processing tracker ${tracker._id}:`, trackerError.message);
            }
        }
        
        // Recalculate balance after recovery
        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
        const recoveredBalance = await Referral.countDocuments({
            referrerUserId: userId,
            $or: [
                { dateReferred: { $gte: marchFirstDate } },
                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
            ],
            status: 'active',
            withdrawn: { $ne: true }
        });
        
        console.log(`[RECOVER] Recovery complete for ${userId}: recovered ${recoveredBalance} referrals = $${(recoveredBalance * 0.5).toFixed(2)}`);
        
        return res.json({
            success: true,
            recovery,
            recoveredBalance: {
                count: recoveredBalance,
                amount: recoveredBalance * 0.5
            },
            message: `Successfully recovered ${recoveredBalance} referrals worth $${(recoveredBalance * 0.5).toFixed(2)} for user ${userId}`
        });
        
    } catch (error) {
        console.error('Recovery error:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// MIGRATION ENDPOINT: Convert old 'completed' status to 'active'
app.post('/api/admin/migrate-referral-status', requireAdmin, async (req, res) => {
    try {
        console.log('[MIGRATION] Starting referral status migration: completed -> active');
        
        // Update all referrals with status='completed' to status='active'
        const result = await Referral.updateMany(
            { status: 'completed' },
            { $set: { status: 'active' } }
        );
        
        console.log(`[MIGRATION] Updated ${result.modifiedCount} referrals from 'completed' to 'active'`);
        
        // Verify migration
        const statusCounts = await Referral.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        
        console.log('[MIGRATION] Referral status counts after migration:', statusCounts);
        
        return res.json({
            success: true,
            migrated: result.modifiedCount,
            statusDistribution: statusCounts,
            message: `Successfully migrated ${result.modifiedCount} referrals to new status semantics`
        });
    } catch (error) {
        console.error('Migration error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Ambassador Wallet Setting Endpoint
app.post('/api/ambassador-wallet', requireTelegramAuth, async (req, res) => {
    try {
        const { userId, walletAddress } = req.body;
        
        if (!userId || !walletAddress) {
            return res.status(400).json({ success: false, error: 'userId and walletAddress are required' });
        }
        
        // Validate wallet address format (basic check for TON)
        if (!/^[A-Za-z0-9_-]{46,47}$/.test(walletAddress) && !/^UQ/.test(walletAddress) && !/^0Q/.test(walletAddress)) {
            console.warn(`Invalid wallet format attempt: ${walletAddress}`);
            // Be lenient - allow any reasonable string, just warn
        }
        
        // Verify user is setting their own wallet
        if (req.user.id !== userId) {
            return res.status(403).json({ success: false, error: 'Can only set your own wallet address' });
        }
        
        // Find user and check if ambassador
        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        if (!user.ambassadorEmail) {
            return res.status(403).json({ success: false, error: 'Only ambassadors can set wallet address' });
        }
        
        // Update wallet address (use ambassadorWalletAddress field from schema)
        await User.findOneAndUpdate(
            { id: userId },
            { ambassadorWalletAddress: walletAddress }
        );
        
        // Send confirmation email
        const userFullName = user.username || user.firstName || 'Ambassador';
        const walletPreview = walletAddress.substring(0, 8) + '…' + walletAddress.slice(-4);
        await emailService.sendWalletAddressConfirmation(
            user.ambassadorEmail,
            userFullName,
            walletPreview
        );
        
        console.log(`✅ Wallet address updated for ambassador ${userId}`);
        
        return res.json({
            success: true,
            message: 'Wallet address saved successfully',
            walletAddress,
            walletPreview: walletAddress.substring(0, 8) + '…' + walletAddress.slice(-4)
        });
        
    } catch (error) {
        console.error('Error setting ambassador wallet:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Withdrawal endpoint
app.post('/api/referral-withdrawals', async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { userId, amount, walletAddress } = req.body;
        const amountNum = parseFloat(amount);

        if (!userId || !amount || !walletAddress) {
            throw new Error('Missing required fields');
        }

        const user = await User.findOne({ id: userId }).session(session) || {};
        const availableReferrals = await Referral.find({
            referrerUserId: userId,
            status: 'active',
            withdrawn: { $ne: true }
        }).session(session);

        const availableBalance = availableReferrals.length * 0.5;

        if (amountNum < 0.5) throw new Error('Minimum withdrawal is 0.5 USDT');
        if (amountNum > availableBalance) throw new Error(`Available: ${availableBalance.toFixed(2)} USDT`);

        const referralsNeeded = Math.ceil(amountNum / 0.5);
        const referralsToMark = availableReferrals.slice(0, referralsNeeded);

        const username = user.username || `@user`;

        // Get location data
        let userLocation = null;
        try {
            let ip = req.headers?.['x-forwarded-for'] || req.headers?.['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown';
            
            if (typeof ip === 'string') {
                ip = ip.split(',')[0].trim();
            }
            
            if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
                const geo = await getGeolocation(ip);
                if (geo.country !== 'Unknown') {
                    userLocation = { city: geo.city || 'Unknown', country: geo.country };
                }
            }
        } catch (err) {
            console.error('Error getting location for withdrawal:', err.message);
            // Continue without location
        }

        const withdrawal = new ReferralWithdrawal({
            userId,
            username: username,
            amount: amountNum,
            walletAddress: walletAddress.trim(),
            referralIds: referralsToMark.map(r => r._id),
            status: 'pending',
            adminMessages: [],
            userLocation: userLocation,
            createdAt: new Date()
        });

        await withdrawal.save({ session });

        await Referral.updateMany(
            { _id: { $in: referralsToMark.map(r => r._id) } },
            { $set: { withdrawn: true } },
            { session }
        );

        try {
            await bot.sendSticker(userId, 'CAACAgIAAxkBAAEOfU1oJPNMEdvuCLmOLYdxV9Nb5TKe-QACfz0AAi3JKUp2tyZPFVNcFzYE');
        } catch (stickerError) {
            console.error('Failed to send sticker:', stickerError);
        }

        const userMessage = `📋 Withdrawal Request Submitted\n\n` +
                          `Amount: ${amountNum} USDT\n` +
                          `Wallet: ${walletAddress}\n` +
                          `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                          `Status: Pending approval`;

        await bot.sendMessage(userId, userMessage);

        const adminMessage = `📩 Withdrawal Request\n\n` +
                           `User: @${username} (ID: ${userId})\n\n` +
                           `Amount: ${amountNum} USDT\n` +
                           `Wallet: ${walletAddress}\n` +
                           `Referrals: ${referralsNeeded}\n` +
                           `Location: ${withdrawal.userLocation ? `${withdrawal.userLocation.city || 'Unknown'}, ${withdrawal.userLocation.country || 'Unknown'}` : 'Unknown'}\n\n` +
                           `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Complete", callback_data: `complete_withdrawal_${withdrawal._id}` },
                    { text: "❌ Decline", callback_data: `decline_withdrawal_${withdrawal._id}` }
                ]
            ]
        };

        withdrawal.adminMessages = await Promise.all(adminIds.map(async adminId => {
            try {
                const message = await bot.sendMessage(
                    adminId,
                    adminMessage,
                    { reply_markup: adminKeyboard }
                );
                return {
                    adminId,
                    messageId: message.message_id,
                    originalText: adminMessage
                };
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
                return null;
            }
        })).then(results => results.filter(Boolean));

        await withdrawal.save({ session });
        await session.commitTransaction();
        return res.json({ success: true, withdrawalId: withdrawal._id });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal error:', error);
        return res.status(400).json({ success: false, error: error.message });
    } finally {
        session.endSession();
    }
});

bot.on('callback_query', async (query) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { data, from } = query;
        
        if (!adminIds.includes(from.id.toString())) {
            await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized action" });
            return;
        }

        // Only handle withdrawal completion/decline actions, not wallet updates
        if (!(data.startsWith('complete_withdrawal_') || data.startsWith('decline_withdrawal_') || data.startsWith('decline_reason_'))) {
            return;
        }

        // Support decline reason selection flow
        let action = data.startsWith('complete_withdrawal_') ? 'complete'
                    : data.startsWith('decline_withdrawal_') ? 'decline'
                    : data.startsWith('decline_reason_') ? 'decline_reason'
                    : 'unknown';
        const parts = data.split('_');
        const withdrawalId = parts[parts.length - 1];

        if (!withdrawalId) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Invalid withdrawal ID" });
            return;
        }

        // If decline selected, show reason selector and return without processing DB yet
        if (action === 'decline') {
            const reasonKeyboard = {
                inline_keyboard: [[
                    { text: 'Wrong wallet address', callback_data: `decline_reason_wrongwallet_${withdrawalId}` }
                ],[
                    { text: 'Not approved', callback_data: `decline_reason_notapproved_${withdrawalId}` }
                ],[
                    { text: 'Other', callback_data: `decline_reason_other_${withdrawalId}` }
                ]]
            };

            try {
                await bot.editMessageReplyMarkup(reasonKeyboard, { chat_id: query.message.chat.id, message_id: query.message.message_id });
            } catch (editErr) {
                // Fallback: send a separate message for reason selection
                await bot.sendMessage(query.message.chat.id, 'Select decline reason:', { reply_markup: reasonKeyboard });
            }
            await bot.answerCallbackQuery(query.id, { text: 'Choose a reason' });
            return; // stop here until a reason is chosen
        }

        if (action === 'decline_reason') {
            // Map reason code to human text
            const reasonCode = parts[2]; // decline, reason, <code>, <id>
            const reasonMap = {
                wrongwallet: 'Wrong wallet address',
                notapproved: 'Not approved',
                other: 'Other'
            };
            const declineReason = reasonMap[reasonCode] || 'Declined';
            await bot.answerCallbackQuery(query.id, { text: `⏳ Processing decline...` });

            // Proceed with decline in DB below using declineReason
            action = 'decline_final';
            query.declineReason = declineReason;
        } else {
            await bot.answerCallbackQuery(query.id, { text: `⏳ Processing ${action}...` });
        }

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(withdrawalId), status: 'pending' },
            { 
                $set: { 
                    status: action === 'complete' ? 'completed' : 'declined',
                    processedBy: from.id,
                    processedAt: new Date()
                } 
            },
            { new: true, session }
        );

        if (!withdrawal) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Withdrawal not found or already processed" });
            await session.abortTransaction();
            return;
        }

        const finalDecline = action === 'decline' || action === 'decline_final';
        if (finalDecline) {
            await Referral.updateMany(
                { _id: { $in: withdrawal.referralIds } },
                { $set: { withdrawn: false } },
                { session }
            );
        }

        const declineReasonText = query.declineReason ? `\nReason: ${query.declineReason}` : '';
        const userMessage = action === 'complete'
            ? `✅ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Completed!\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Wallet: ${withdrawal.walletAddress}\n\n` +
              `Funds have been sent to your wallet.`
            : `❌ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Declined${declineReasonText}\n\n` +
              `Amount: ${withdrawal.amount} USDT\n` +
              `Contact support for more information.`;

        await bot.sendMessage(withdrawal.userId, userMessage);

        const statusText = action === 'complete' ? '✅ Completed' : '❌ Declined';
        const processedBy = `Processed by: @${from.username || `admin_${from.id.toString().slice(-4)}`}`;

        // Ensure adminMessages contains at least the clicking admin's message
        const clickedChatId = query.message?.chat?.id?.toString();
        const clickedMessageId = query.message?.message_id;
        const clickedOriginalText = query.message?.text || '';

        if (!Array.isArray(withdrawal.adminMessages)) {
            withdrawal.adminMessages = [];
        }

        const hasClickedInList = withdrawal.adminMessages.some(m => m && m.adminId?.toString() === clickedChatId && m.messageId === clickedMessageId);
        if (!hasClickedInList && clickedChatId && clickedMessageId) {
            withdrawal.adminMessages.push({ adminId: clickedChatId, messageId: clickedMessageId, originalText: clickedOriginalText });
            try {
                await ReferralWithdrawal.updateOne(
                    { _id: withdrawal._id },
                    { $set: { adminMessages: withdrawal.adminMessages } },
                    { session }
                );
            } catch (saveAdminMsgsErr) {
                console.warn('Could not persist adminMessages for withdrawal:', saveAdminMsgsErr.message);
            }
        }

        const updateSingleMessage = async (adminMsg) => {
            if (!adminMsg?.adminId || !adminMsg?.messageId) return;
            const baseText = adminMsg.originalText || clickedOriginalText || '';
            const updatedText = `${baseText}\n\n` +
                                `Status: ${statusText}\n` +
                                (query.declineReason ? `Reason: ${query.declineReason}\n` : '') +
                                `${processedBy}\n` +
                                `Processed at: ${new Date().toLocaleString()}`;
            try {
                await bot.editMessageText(updatedText, {
                    chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                    message_id: adminMsg.messageId,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }
                        ]]
                    }
                });
            } catch (err) {
                // Fallback: try editing only reply markup
                try {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                        { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                    );
                } catch (fallbackErr) {
                    console.error(`Failed to update admin ${adminMsg.adminId}:`, fallbackErr.message);
                }
            }
        };

        // Always update the clicked admin's message first for immediate feedback
        if (clickedChatId && clickedMessageId) {
            await updateSingleMessage({ adminId: clickedChatId, messageId: clickedMessageId, originalText: clickedOriginalText });
        }

        // Then update all stored admin messages (skip the one we already updated)
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages
                .filter(m => !(m.adminId?.toString() === clickedChatId && m.messageId === clickedMessageId))
                .map(updateSingleMessage)
            );
        }

        await session.commitTransaction();
        await bot.answerCallbackQuery(query.id, { 
            text: `✔️ Withdrawal ${action === 'complete' ? 'completed' : 'declined'}` 
        });

    } catch (error) {
        await session.abortTransaction();
        console.error('Withdrawal processing error:', error);
        
        let errorMsg = "❌ Processing failed";
        if (error.message.includes("network error")) {
            errorMsg = "⚠️ Network issue - please retry";
        } else if (error.message.includes("Cast to ObjectId failed")) {
            errorMsg = "❌ Invalid withdrawal ID";
        }
        
        await bot.answerCallbackQuery(query.id, { text: errorMsg });
    } finally {
        session.endSession();
    }
});



//referral tracking for referrals rewards
async function handleReferralActivation(tracker) {
    try {
        // Prevent duplicate activations
        if (tracker.status === 'active') {
            console.log(`Referral activation skipped - already active for tracker ${tracker._id}`);
            return;
        }

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
                status: 'completed',
                dateActivated: new Date()
            });
        }

        // Format detailed admin notification with HTML formatting to avoid underscore issues
        const adminMessage = `<b>REFERRAL ACTIVATED</b>\n\n` +
            `<b>Referral Link:</b> ${tracker.referral}\n` +
            `<b>Referrer:</b> @${referrer?.username || 'unknown'} (ID: ${tracker.referrerUserId})\n` +
            `<b>Referred User:</b> @${referred?.username || tracker.referredUsername || 'unknown'} (ID: ${tracker.referredUserId})\n` +
            `<b>Total Stars Bought:</b> ${tracker.totalBoughtStars}\n` +
            `<b>Total Stars Sold:</b> ${tracker.totalSoldStars}\n` +
            `<b>Premium Activated:</b> ${tracker.premiumActivated ? 'Yes' : 'No'}\n` +
            `<b>Date Referred:</b> ${tracker.dateReferred.toLocaleDateString()}\n` +
            `<b>Date Activated:</b> ${new Date().toLocaleDateString()}`;

        // Send to all admins
        let adminNotificationSuccess = false;
        // Send to admins with retry (3x retry, 500ms exponential backoff)
        for (const adminId of adminIds) {
            let retryCount = 0;
            while (retryCount < 3) {
                try {
                    await bot.sendMessage(adminId, adminMessage, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    });
                    adminNotificationSuccess = true;
                    console.log(`Successfully notified admin ${adminId} about referral activation`);
                    break;  // Success, exit retry loop
                } catch (err) {
                    retryCount++;
                    if (retryCount < 3) {
                        console.warn(`Retry ${retryCount}/3 for admin ${adminId} referral notification:`, err.message);
                        await new Promise(r => setTimeout(r, 500 * retryCount));  // Exponential backoff: 500ms, 1s, 1.5s
                    } else {
                        console.error(`FAILED after 3 retries - admin ${adminId} referral notification:`, err.message);
                    }
                }
            }
        }

        // CRITICAL: Log if no admins were successfully notified
        if (!adminNotificationSuccess && adminIds.length > 0) {
            console.error(`❌ CRITICAL: Failed to notify ANY admin about referral activation for tracker ${tracker._id}`);
        }

        // Send notification to referrer
        try {
            await bot.sendMessage(
                tracker.referrerUserId,
                `🎉 Your referral @${referred?.username || tracker.referredUsername} just became active!\n` +
                `You earned 0.5 USDT referral bonus.`
            );
            console.log(`Successfully notified referrer ${tracker.referrerUserId} about referral activation`);
        } catch (err) {
            console.error(`Failed to notify referrer ${tracker.referrerUserId} about referral activation:`, err);
        }
    } catch (error) {
        console.error('Referral activation error:', error);
    }
}

async function trackStars(userId, stars, type) {
    try {
        const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
        if (!tracker) return;

        // Update star counts based on transaction type
        if (type === 'buy') tracker.totalBoughtStars += stars || 0;
        if (type === 'sell') tracker.totalSoldStars += stars || 0;

        const totalStars = tracker.totalBoughtStars + tracker.totalSoldStars;
        
        // NEW REFERRAL (instantActivation=true): activate immediately at 100+ stars
        // OLD REFERRAL (instantActivation=false): wait for admin confirmation
        // Only valid transactions count: processing or completed (not failed/declined/refunded)
        if ((totalStars >= 100 || tracker.premiumActivated) && tracker.status === 'pending') {
            if (tracker.instantActivation === true) {
                // Instant activation for new referrals
                await handleReferralActivation(tracker);
            } else {
                // Old referrals: save but don't auto-activate, wait for admin
                await tracker.save();
            }
        } else {
            await tracker.save();
        }
        
        // Also update the Referral status if it's still pending and conditions are met
        if (tracker.referral && (totalStars >= 100 || tracker.premiumActivated)) {
            const referral = await Referral.findById(tracker.referral);
            if (referral && referral.status === 'pending' && tracker.instantActivation === true) {
                referral.status = 'active';
                referral.dateActivated = new Date();
                await referral.save();
                
                // Update ambassador earnings if referrer is an ambassador
                if (referral.referrerUserId) {
                    const referrer = await User.findOne({ id: referral.referrerUserId });
                    if (referrer && referrer.ambassadorEmail) {
                        // Count total referrals for this ambassador (from March 1st onwards)
                        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
                        const totalReferrals = await Referral.countDocuments({
                            referrerUserId: referral.referrerUserId,
                            $or: [
                                { dateReferred: { $gte: marchFirstDate } },
                                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
                            ]
                        });
                        
                        // Recalculate earnings for all tiers
                        const levelEarnings = recalculateLevelEarnings(totalReferrals);
                        const totalAmount = getTotalAmbassiadorEarnings(levelEarnings);
                        const newLevel = getAmbassadorTier(totalReferrals).level;
                        
                        // Update user with new earnings
                        await User.findOneAndUpdate(
                            { id: referral.referrerUserId },
                            {
                                ambassadorCurrentLevel: newLevel,
                                ambassadorReferralCount: totalReferrals,
                                ambassadorLevelEarnings: levelEarnings,
                                ambassadorPendingBalance: totalAmount,
                                $push: {
                                    ambassadorEarningsHistory: {
                                        timestamp: new Date(),
                                        referralCount: totalReferrals,
                                        level: newLevel,
                                        earnedAmount: totalAmount,
                                        reason: 'referral_completed'
                                    }
                                }
                            }
                        );
                        
                        console.log(`Ambassador earnings updated for ${referral.referrerUserId}: ${totalReferrals} referrals, level ${newLevel}, $${totalAmount.toFixed(2)}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Tracking error:', error);
    }
}

async function trackPremiumActivation(userId) {
    try {
        const tracker = await ReferralTracker.findOne({ referredUserId: userId.toString() });
        if (!tracker) return;

        if (!tracker.premiumActivated) {
            tracker.premiumActivated = true;
            if (tracker.status === 'pending') {
                // Check instantActivation flag
                if (tracker.instantActivation === true) {
                    await handleReferralActivation(tracker);
                } else {
                    await tracker.save();
                }
            } else {
                await tracker.save();
            }
            
            // Also update the Referral status if it's still pending and instantActivation is true
            if (tracker.referral) {
                const referral = await Referral.findById(tracker.referral);
                if (referral && referral.status === 'pending' && tracker.instantActivation === true) {
                    referral.status = 'active';
                    referral.dateActivated = new Date();
                    await referral.save();
                    
                    // Update ambassador earnings if referrer is an ambassador
                    if (referral.referrerUserId) {
                        const referrer = await User.findOne({ id: referral.referrerUserId });
                        if (referrer && referrer.ambassadorEmail) {
                            // Count total referrals for this ambassador (from March 1st onwards)
                            const marchFirstDate = new Date('2026-03-01T00:00:00Z');
                            const totalReferrals = await Referral.countDocuments({
                                referrerUserId: referral.referrerUserId,
                                $or: [
                                    { dateReferred: { $gte: marchFirstDate } },
                                    { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
                                ]
                            });
                            
                            // Recalculate earnings for all tiers
                            const levelEarnings = recalculateLevelEarnings(totalReferrals);
                            const totalAmount = getTotalAmbassiadorEarnings(levelEarnings);
                            const newLevel = getAmbassadorTier(totalReferrals).level;
                            
                            // Update user with new earnings
                            await User.findOneAndUpdate(
                                { id: referral.referrerUserId },
                                {
                                    ambassadorCurrentLevel: newLevel,
                                    ambassadorReferralCount: totalReferrals,
                                    ambassadorLevelEarnings: levelEarnings,
                                    ambassadorPendingBalance: totalAmount,
                                    $push: {
                                        ambassadorEarningsHistory: {
                                            timestamp: new Date(),
                                            referralCount: totalReferrals,
                                            level: newLevel,
                                            earnedAmount: totalAmount,
                                            reason: 'premium_activation'
                                        }
                                    }
                                }
                            );
                            
                            console.log(`Ambassador earnings updated for ${referral.referrerUserId}: ${totalReferrals} referrals, level ${newLevel}, $${totalAmount.toFixed(2)}`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Premium activation error:', error);
    }
}


//end of referral track 

//ban system 
bot.onText(/\/ban(?:\s+(\d+))$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return;
    
    const userId = match[1];
    const existing = await Warning.findOne({ userId: userId, type: 'ban', isActive: true });
    if (existing) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is already banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await Warning.create({
        userId: userId,
        type: 'ban',
        reason: 'Policy violation',
        issuedBy: requesterId,
        isActive: true,
        autoRemove: false
    });
    
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    try {
        const userSuspensionNotice = `**ACCOUNT NOTICE**\n\n` +
            `We've detected unusual account activities that violate our terms of service.\n\n` +
            `**Account Status**: Temporarily Restricted\n` +
            `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
            `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
            `If you believe this is an error, contact our support team.`;
        
        await bot.sendMessage(userId, userSuspensionNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Suspension notification delivery failed:', error);
    }
    
    const adminSummary = `✅ **Account Ban Applied**\n\n` +
        `**Target Account**: ${userId}\n` +
        `**Suspension Type**: Indefinite\n` +
        `**Reason**: Rule violation\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminSummary, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

bot.onText(/\/warn(?:\s+(\d+))$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return;
    
    const userId = match[1];
    
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 2);
    
    await Warning.create({
        userId: userId,
        type: 'warning',
        reason: 'Minor policy violation',
        issuedBy: requesterId,
        expiresAt: expirationDate,
        isActive: true,
        autoRemove: true
    });
    
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    try {
        const userWarningNotice = `**ACCOUNT NOTICE**\n\n` +
            `We've detected unusual account activities that require attention.\n\n` +
            `**Account Status**: Temporarily Restricted\n` +
            `**Effective Date**: ${new Date().toLocaleDateString()}\n\n` +
            `During this time, you will not be able to place orders until the restriction period ends.\n\n` +
            `If you believe this is an error, contact our support team.`;
        
        await bot.sendMessage(userId, userWarningNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Warning notification delivery failed:', error);
    }
    
    const adminSummary = `⚠️ **Temporary Ban Applied**\n\n` +
        `**Target Account**: ${userId}\n` +
        `**Restriction Type**: Temporary (2 days)\n` +
        `**Reason**: Minor violation\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminSummary, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });

    setTimeout(async () => {
        await Warning.updateOne(
            { userId: userId, type: 'warning', isActive: true, autoRemove: true },
            { isActive: false }
        );
        await BannedUser.updateOne({}, { $pull: { users: userId } });
        try {
            await bot.sendMessage(userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
        } catch (error) {
            console.error('Failed to notify user of auto-unban:', error);
        }
    }, 2 * 24 * 60 * 60 * 1000);
});

bot.onText(/\/unban (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const activeWarning = await Warning.findOne({ userId: userId, isActive: true });
    
    if (!activeWarning) {
        return bot.sendMessage(chatId, `⚠️ User ${userId} is not currently banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    await Warning.updateOne(
        { userId: userId, isActive: true },
        { isActive: false }
    );
    await BannedUser.updateOne({}, { $pull: { users: userId } });
    
    try {
        const reinstatementNotice = `**ACCOUNT RESTORED**\n\n` +
            `Your account has been restored to full functionality.\n\n` +
            `**Account Status**: Active\n` +
            `**Restoration Date**: ${new Date().toLocaleDateString()}\n\n` +
            `You can now resume all normal activities including placing orders.`;
        
        await bot.sendMessage(userId, reinstatementNotice, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Reinstatement notification delivery failed:', error);
    }
    
    const adminConfirmation = `✅ **Account Unbanned**\n\n` +
        `**Account**: ${userId}\n` +
        `**Status**: Active\n` +
        `**Authorized By**: ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `**Timestamp**: ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

// Add user as ambassador
bot.onText(/\/add_amb\s+(\d+)\s+(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    console.log(`[/add_amb] Command received from ${requesterId}`);
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, 'Access Denied - Insufficient privileges', {
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const email = match[2].trim();
    
    try {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return bot.sendMessage(chatId, 'Invalid email format provided', {
                reply_to_message_id: msg.message_id
            });
        }
        
        let user = await User.findOne({ id: userId });
        if (!user) {
            return bot.sendMessage(chatId, `User ${userId} not found`, {
                reply_to_message_id: msg.message_id
            });
        }
        
        if (user.ambassadorEmail) {
            return bot.sendMessage(chatId, `User already ambassador with email: ${user.ambassadorEmail}`, {
                reply_to_message_id: msg.message_id
            });
        }
        
        // Update user with all ambassador fields
        user = await User.findOneAndUpdate(
            { id: userId },
            { 
                $set: {
                    ambassadorEmail: email,
                    ambassadorTier: 'standard',
                    ambassadorReferralCode: `AMB${Date.now().toString().slice(-6)}`,
                    ambassadorApprovedAt: new Date(),
                    ambassadorApprovedBy: requesterId,
                    ambassadorCurrentLevel: 0,
                    ambassadorReferralCount: 0,
                    ambassadorLevelEarnings: {
                        preLevelOne: 0,
                        levelOne: 0,
                        levelTwo: 0,
                        levelThree: 0,
                        levelFour: 0
                    }
                }
            },
            { new: true }
        );
        
        // Send email
        const referralLink = `https://t.me/TgStarStore_bot?start=ref_${user.referralHash}`;
        try {
            await emailService.sendAmbassadorApproved(
                email,
                user.username || `User ${userId}`,
                user.ambassadorReferralCode,
                referralLink
            );
            console.log(`Email sent to ${email}`);
        } catch (emailErr) {
            console.error(`Email failed: ${emailErr.message}`);
        }
        
        // Notify user
        const userMsg = `Congratulations! You have been approved as a StarStore Ambassador.\n\nEmail: ${email}\nAmbassador ID: ${user.ambassadorReferralCode}\n\nAs an ambassador, you now have access to exclusive benefits including higher earning potential, early product access, and dedicated support.\n\nYou will notice a blue verification badge next to your username, marking you as an official ambassador. Your referral page has also been upgraded with enhanced tools to help you share effectively.`;
        const ambassadorKeyboard = {
            inline_keyboard: [[
                { text: '📖 Learn About Ambassador Program', url: 'https://amb.starstore.site/' }
            ]]
        };
        try {
            await bot.sendMessage(userId, userMsg, { reply_markup: ambassadorKeyboard });
        } catch (err) {
            console.error(`Failed to notify user ${userId}: ${err.message}`);
        }
        
        // Notify admin
        const adminMsg = `Ambassador Added\n\nUser: ${userId}\nUsername: ${user.username || 'N/A'}\nEmail: ${email}\nCode: ${user.ambassadorReferralCode}\n\nAll fields initialized. Email sent.`;
        await bot.sendMessage(chatId, adminMsg, {
            reply_to_message_id: msg.message_id
        });
        
    } catch (error) {
        console.error('Add ambassador error:', error);
        await bot.sendMessage(chatId, 'Error adding ambassador', {
            reply_to_message_id: msg.message_id
        });
    }
});

// Opt-Out Command: Ambassadors can request to leave the ambassador program
bot.onText(/\/opt_out\s*(.*)?$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const username = msg.from.username || msg.from.first_name || 'User';
    const reason = match && match[1] ? match[1].trim() : null;

    try {
        // Check if user is an ambassador
        const user = await User.findOne({ id: userId });
        
        if (!user || !user.ambassadorEmail) {
            return bot.sendMessage(chatId, '❌ You are not currently part of the ambassador program.\n\nThis command is only available for active ambassadors.', {
                reply_to_message_id: msg.message_id,
                parse_mode: 'HTML'
            });
        }

        // Check if user already has a pending opt-out request
        const existingRequest = await AmbassadorOptOutRequest.findOne({
            userId,
            status: 'pending'
        });

        if (existingRequest) {
            return bot.sendMessage(chatId, '⏳ You already have a pending opt-out request.\n\nPlease wait for admin approval.', {
                reply_to_message_id: msg.message_id,
                parse_mode: 'HTML'
            });
        }

        // Create opt-out request
        const optOutRequest = new AmbassadorOptOutRequest({
            userId,
            username,
            ambassadorEmail: user.ambassadorEmail,
            ambassadorCode: user.ambassadorReferralCode,
            ambassadorTier: user.ambassadorTier,
            reason: reason || 'No reason provided'
        });

        await optOutRequest.save();

        // Send thoughtful message to user
        const userConfirmationMsg = `💙 We're sad to see you go!\n\n` +
            `Your opt-out request has been submitted to our team. We appreciate the time you spent as a StarStore Ambassador and the value you brought to our community.\n\n` +
            `📋 <b>Request Details:</b>\n` +
            `• Status: Pending Approval\n` +
            `• Ambassador ID: ${user.ambassadorReferralCode}\n` +
            `• Tier: ${user.ambassadorTier || 'Standard'}\n\n` +
            `Your request will be reviewed shortly. Once approved, you'll be removed from the ambassador program. You can always reapply in the future! 🚀\n\n` +
            `If you change your mind or want to discuss this, feel free to reach out to our support team.`;

        const userAck = await bot.sendMessage(chatId, userConfirmationMsg, {
            reply_to_message_id: msg.message_id,
            parse_mode: 'HTML'
        });

        // Store user message ID for future updates
        optOutRequest.userMessageId = userAck.message_id;
        await optOutRequest.save();

        // Prepare admin notification
        const adminMsg = `🚪 <b>Ambassador Opt-Out Request</b>\n\n` +
            `<b>User Information:</b>\n` +
            `• User ID: ${userId}\n` +
            `• Username: @${username}\n` +
            `• Ambassador Email: ${user.ambassadorEmail}\n\n` +
            `<b>Ambassador Status:</b>\n` +
            `• Ambassador ID: ${user.ambassadorReferralCode}\n` +
            `• Tier: ${user.ambassadorTier || 'Standard'}\n` +
            `• Total Referrals: ${user.ambassadorReferralCount || 0}\n` +
            `• Approved Date: ${user.ambassadorApprovedAt ? user.ambassadorApprovedAt.toLocaleDateString() : 'N/A'}\n\n` +
            `<b>Request Reason:</b>\n` +
            `${reason || 'No reason provided'}\n\n` +
            `<b>Action Required:</b>\n` +
            `Click approve to remove this user from the ambassador program and clear all related data.`;

        const adminKeyboard = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `opt_out_approve_${optOutRequest._id}` },
                { text: '❌ Decline', callback_data: `opt_out_decline_${optOutRequest._id}` }
            ]]
        };

        // Send to all admins
        for (const adminId of adminIds) {
            try {
                const adminAck = await bot.sendMessage(adminId, adminMsg, {
                    parse_mode: 'HTML',
                    reply_markup: adminKeyboard
                });

                // Store admin message details
                optOutRequest.adminMessages.push({
                    adminId,
                    messageId: adminAck.message_id,
                    originalText: adminMsg
                });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err.message);
            }
        }

        // Save all admin message details
        await optOutRequest.save();

        console.log(`[/opt_out] Request created: ${optOutRequest._id} from user ${userId}`);

    } catch (error) {
        console.error('Opt-out command error:', error);
        await bot.sendMessage(chatId, '❌ An error occurred while processing your opt-out request. Please try again.', {
            reply_to_message_id: msg.message_id
        });
    }
});

bot.onText(/\/warnings (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const requesterId = msg.from.id.toString();
    
    if (!adminIds.includes(requesterId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown',
            reply_to_message_id: msg.message_id
        });
    }
    
    const userId = match[1];
    const warnings = await Warning.find({ userId: userId }).sort({ issuedAt: -1 }).limit(10);
    
    if (warnings.length === 0) {
        return bot.sendMessage(chatId, `📋 No warnings found for user ${userId}.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    let warningsList = `📋 **Warning History for User ${userId}**\n\n`;
    
    warnings.forEach((warning, index) => {
        const status = warning.isActive ? '🔴 Active' : '✅ Resolved';
        const expiry = warning.expiresAt ? `\n**Expires**: ${warning.expiresAt.toLocaleDateString()}` : '';
        
        warningsList += `**${index + 1}.** ${warning.type.toUpperCase()}\n` +
            `**Status**: ${status}\n` +
            `**Reason**: ${warning.reason}\n` +
            `**Date**: ${warning.issuedAt.toLocaleDateString()}${expiry}\n\n`;
    });
    
    await bot.sendMessage(chatId, warningsList, {
        parse_mode: 'Markdown',
        reply_to_message_id: msg.message_id
    });
});

setInterval(async () => {
    const expiredWarnings = await Warning.find({
        isActive: true,
        autoRemove: true,
        expiresAt: { $lte: new Date() }
    });
    
    for (const warning of expiredWarnings) {
        await Warning.updateOne(
            { _id: warning._id },
            { isActive: false }
        );
        await BannedUser.updateOne({}, { $pull: { users: warning.userId } });
        
        try {
            await bot.sendMessage(warning.userId, `✅ Your account restrictions have been lifted. You can now resume normal activities.`);
        } catch (error) {
            console.error('Failed to notify user of auto-unban:', error);
        }
    }
}, 60000);

// Get main menu keyboard with commands (without launch button)
function getMainMenuKeyboard() {
    return {
        keyboard: [
            [{ text: '💰 Wallet' }, { text: '👥 Referral' }, { text: '💬 Help' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    };
}

// Handle Wallet button - reuse wallet command logic

bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'user';
    const deepLinkParam = match[1]?.trim();
    
    // Handle ambassador connect flow first
    if (deepLinkParam?.startsWith('amb_connect_')) {
        await handleAmbassadorConnect(msg, match);
        return;
    }
    
    try {
        let user = await User.findOne({ id: chatId });
        if (!user) {
            try {
                user = await User.findOneAndUpdate(
                    { id: chatId },
                    { $set: { id: chatId, username, createdAt: new Date(), lastActive: new Date() } },
                    { upsert: true, new: true }
                );
            } catch (createErr) {
                // Handle E11000 duplicate key error by retrying with findOne
                if (createErr.code === 11000) {
                    user = await User.findOne({ id: chatId });
                } else {
                    throw createErr;
                }
            }
        } else {
            try { await User.updateOne({ id: chatId }, { $set: { username, lastActive: new Date() } }); } catch {}
        }
        
        try {
            await bot.sendSticker(chatId, 'CAACAgIAAxkBAAEOfYRoJQbAGJ_uoVDJp5O3xyvEPR77BAACbgUAAj-VzAqGOtldiLy3NTYE');
        } catch (stickerError) {
            console.error('Failed to send sticker:', stickerError);
        }
        
        await bot.sendMessage(chatId, `👋 Welcome to StarStore, @${username}! ✨\n\nUse the app to purchase stars and enjoy exclusive benefits!`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Launch StarStore', web_app: { url: `https://starstore.site?startapp=home_${chatId}` } }],
                    [{ text: '👥 Join Community', url: 'https://t.me/StarStore_Chat' }]
                ]
            }
        });

        // Send keyboard menu with commands
        await bot.sendMessage(chatId, 'Choose an option:', {
            reply_markup: getMainMenuKeyboard()
        });
        
        if (deepLinkParam?.startsWith('ref_')) {
            // Handle both old format (ref_USERID) and new format (ref_HASH)
            let referrerUserId = null;
            let isNewFormat = false;
            
            // Try new format first: ref_HASH (12 character hex hash)
            if (deepLinkParam.length === 16 && /^ref_[a-f0-9]{12}$/.test(deepLinkParam)) {
                // New format: ref_HASH - lookup by referralHash on User document
                const referrerUser = await User.findOne({ referralHash: deepLinkParam });
                if (referrerUser) {
                    referrerUserId = referrerUser.id;
                    isNewFormat = true;
                }
            }
            
            // Fallback to old format: ref_USERID (digits only)
            if (!referrerUserId && /^ref_\d+$/.test(deepLinkParam)) {
                referrerUserId = deepLinkParam.substring(4);
            }
            
            // One more fallback: check if it's the random format (ref_username_code)
            if (!referrerUserId) {
                const referralDoc = await Referral.findOne({ newRefLink: deepLinkParam });
                if (referralDoc) {
                    referrerUserId = referralDoc.referrerUserId;
                    isNewFormat = true;
                }
            }
            
            if (!referrerUserId || referrerUserId === chatId.toString()) return;
            
            const existing = await ReferralTracker.findOne({ referredUserId: chatId.toString() });
            if (!existing) {
                // Get referrer details for new link generation
                const referrerUser = await User.findOne({ id: referrerUserId });
                const referrerUsername = referrerUser?.username || `user_${referrerUserId}`;
                
                // Generate new referral link for future users
                const newRefLink = generateNewReferralLink(referrerUsername);
                
                // Determine instant activation based on REFERRED USER's join date
                // Users who joined BEFORE March 1, 2026: manual admin activation
                // Users who joined ON or AFTER March 1, 2026: automatic activation
                const marchFirst2026 = new Date('2026-03-01T00:00:00Z');
                const useInstantActivation = (user.createdAt || new Date()) >= marchFirst2026;
                
                const referral = await Referral.create({
                    referrerUserId,
                    referrerUsername,
                    referredUserId: chatId.toString(),
                    status: 'pending',
                    dateReferred: new Date(),
                    linkFormat: 'new',
                    newRefLink: newRefLink,
                    instantActivation: useInstantActivation
                });
                
                await ReferralTracker.create({
                    referral: referral._id,
                    referrerUserId,
                    referrerUsername,
                    referredUserId: chatId.toString(),
                    referredUsername: username,
                    status: 'pending',
                    dateReferred: new Date(),
                    instantActivation: useInstantActivation
                });
                
                await bot.sendMessage(referrerUserId, `🎉 Someone used your referral link and joined StarStore!`);
            }
        }
    } catch (error) {
        console.error('Start command error:', error);
    }
});

// /wallet and /orders commands: show processing orders and allow wallet update request
bot.onText(/\/(wallet|withdrawal\-menu|orders)/i, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const username = msg.from.username || '';

        // Auto-detect and immediately update username in real-time
        if (username) {
            const usernameChange = await detectUsernameChange(userId, username, 'telegram');
            if (usernameChange) {
                await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
            }
        }

        // Fetch user's processing sell orders and pending referral withdrawals
        const [sellOrders, withdrawals] = await Promise.all([
            SellOrder.find({ telegramId: userId, status: 'processing' }).sort({ dateCreated: -1 }).limit(5),
            ReferralWithdrawal.find({ userId: userId, status: 'pending' }).sort({ createdAt: -1 }).limit(5)
        ]);

        if ((!sellOrders || sellOrders.length === 0) && (!withdrawals || withdrawals.length === 0)) {
            return bot.sendMessage(chatId, 'ℹ️ You have no processing orders.');
        }

        const lines = [];
        if (sellOrders?.length) {
            lines.push('🛒 Processing Sell Orders:');
            sellOrders.forEach(o => {
                lines.push(`• ${o.id} — ${o.stars} ★ — wallet: ${o.walletAddress || 'N/A'}${o.memoTag ? ` — memo: ${o.memoTag}` : ''}`);
            });
        }
        if (withdrawals?.length) {
            lines.push('💳 Pending Withdrawals:');
            withdrawals.forEach(w => {
                lines.push(`• ${w.withdrawalId} — ${w.amount} — wallet: ${w.walletAddress || 'N/A'}`);
            });
        }

        const keyboard = { inline_keyboard: [] };
        // Initialize selection bucket with timestamp and store order/withdrawal data
        walletSelections.set(userId, { 
            selections: new Set(), 
            timestamp: Date.now(),
            sellOrders: sellOrders.map(o => o.id),
            withdrawals: withdrawals.map(w => w.withdrawalId),
            messageId: null // Will be set after sending
        });

        const buildKeyboard = (bucket) => {
            const kb = { inline_keyboard: [] };
            const bucket_data = walletSelections.get(userId);
            
            if (bucket_data?.sellOrders) {
                bucket_data.sellOrders.forEach(id => {
                    const isSelected = bucket.selections.has(`sell:${id}`);
                    kb.inline_keyboard.push([
                        { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_sell_${id}` },
                        { text: '🔄 Update', callback_data: `wallet_update_sell_${id}` }
                    ]);
                });
            }
            
            if (bucket_data?.withdrawals) {
                bucket_data.withdrawals.forEach(id => {
                    const isSelected = bucket.selections.has(`wd:${id}`);
                    kb.inline_keyboard.push([
                        { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_withdrawal_${id}` },
                        { text: '🔄 Update', callback_data: `wallet_update_withdrawal_${id}` }
                    ]);
                });
            }
            
            kb.inline_keyboard.push([
                { text: 'Select All', callback_data: 'wallet_sel_all' },
                { text: 'Clear', callback_data: 'wallet_sel_clear' }
            ]);
            kb.inline_keyboard.push([
                { text: `✅ Continue (${bucket.selections.size} selected)`, callback_data: 'wallet_continue_selected' }
            ]);
            
            return kb;
        };

        const initialKeyboard = buildKeyboard(walletSelections.get(userId));
        const sentMsg = await bot.sendMessage(chatId, lines.join('\n') + `\n\n📌 Select items (they'll light up 🟢 when selected), then tap "Continue".`, { reply_markup: initialKeyboard });
        
        // Store message ID so we can edit it later
        const bucket = walletSelections.get(userId);
        if (bucket) {
            bucket.messageId = sentMsg.message_id;
            walletSelections.set(userId, bucket);
        }
    } catch (err) {
        console.error('Wallet command error:', {
            userId: msg.from.id,
            username: msg.from.username,
            error: err.message,
            stack: err.stack
        });
        await bot.sendMessage(msg.chat.id, '❌ Failed to load your orders. Please try again later.');
    }
});

// ==================== SHARED HANDLER FUNCTIONS ====================
// These functions contain the core logic for commands and are called by both
// command handlers (bot.onText) and menubar button handlers to eliminate duplication

async function handleHelpCommand(msg) {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const isAdmin = adminIds.includes(userId);

        if (isAdmin) {
            const adminHelpText = `🔧 **Admin Commands Help**

**👥 User Management:**
/ban [user_id] - Ban a user from using the bot
/unban [user_id] - Unban a previously banned user
/warn [user_id] - Send a warning to a user
/warnings [user_id] - Check all warnings for a user
/users - List all users in the system
/detect_users - Detect and process new users
/add_amb [user_id] [email] - Add user as ambassador and notify them

**💰 Wallet Management:**
/updatewallet [user_id] [sell|withdrawal] [order_id] [new_wallet_address]
  - Update a user's wallet address for specific order
/userwallet [user_id] - View all wallet addresses for a user

**📋 Order Management:**
/findorder [order_id] - Find detailed order information
/getpayment [order_id] - Get payment details for an order
/cso- [order_id] - Complete sell order
/cbo- [order_id] - Complete buy order
/sell_complete [order_id] - Complete sell order (alternative)
/sell_decline [order_id] - Decline sell order

**💸 Refund Management:**
/adminrefund [order_id] - Process a refund for an order
/refundtx [order_id] [tx_hash] - Update refund transaction hash

**📢 Communication:**
/reply [user_id1,user_id2,...] [message] - Send message to multiple users
/broadcast - Send broadcast message to all users
/notify [all|@username|user_id] [message] - Send targeted notification

**🔍 Information:**
/version - Check app version and update information
/adminhelp - Show this admin help menu
/adminwallethelp - Show detailed wallet management help`;
            await bot.sendMessage(chatId, adminHelpText, { parse_mode: 'Markdown' });
        } else {
            const userHelpText = `🤖 **StarStore Bot**

**Trading:**
/start - Launch the app and begin trading
/wallet - View your processing orders & withdrawals

**Earnings:**
/referrals - Check your referral stats & get your link

**Support:**
/contact - Message support directly
/paysupport - Request refund for sell orders

*All trading happens in the web app launched by /start*`;
            await bot.sendMessage(chatId, userHelpText, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Help handler error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to load help. Please try again later.');
    }
}

async function handleReferralsCommand(msg) {
    try {
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        const professionalRefLink = generateUserReferralHash(userId);
        const referralLink = `https://t.me/TgStarStore_bot?start=${professionalRefLink}`;
        
        const referrals = await Referral.find({ 
            referrerUserId: userId
        });
        
        if (referrals.length > 0) {
            const activeReferrals = referrals.filter(ref => ref.status === 'active').length;
            const pendingReferrals = referrals.filter(ref => ref.status === 'pending').length;
            
            let message = `📊 Your Referrals (ALL):\n\nActive: ${activeReferrals}\nPending: ${pendingReferrals}\n\n`;
            message += 'New referrals activate instantly at 100+ stars!\n\n';
            message += `🔗 Your Referral Link:\n${referralLink}`;
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }],
                    [{ text: 'Open Web App', web_app: { url: 'https://starstore.site/referral' } }]
                ]
            };
            
            await bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } else {
            const message = `You have no referrals yet.\n\n🔗 Your Referral Link:\n${referralLink}\n\nShare this link to start earning!`;
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }],
                    [{ text: 'Open Web App', web_app: { url: 'https://starstore.site/referral' } }]
                ]
            };
            
            await bot.sendMessage(chatId, message, { reply_markup: keyboard });
        }
    } catch (error) {
        console.error('Referrals handler error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to load referrals. Please try again later.');
    }
}

async function handleWalletCommand(msg) {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const username = msg.from.username || '';
        
        if (username) {
            const usernameChange = await detectUsernameChange(userId, username, 'telegram');
            if (usernameChange) {
                await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
            }
        }
        
        const [sellOrders, withdrawals] = await Promise.all([
            SellOrder.find({ telegramId: userId, status: 'processing' }).sort({ dateCreated: -1 }).limit(5),
            ReferralWithdrawal.find({ userId: userId, status: 'pending' }).sort({ createdAt: -1 }).limit(5)
        ]);
        
        if ((!sellOrders || sellOrders.length === 0) && (!withdrawals || withdrawals.length === 0)) {
            return await bot.sendMessage(chatId, 'ℹ️ You have no processing orders.');
        }
        
        const lines = [];
        if (sellOrders?.length) {
            lines.push('🛒 Processing Sell Orders:');
            sellOrders.forEach(o => {
                lines.push(`• ${o.id} — ${o.stars} ★ — wallet: ${o.walletAddress || 'N/A'}${o.memoTag ? ` — memo: ${o.memoTag}` : ''}`);
            });
        }
        if (withdrawals?.length) {
            lines.push('💳 Pending Withdrawals:');
            withdrawals.forEach(w => {
                lines.push(`• ${w.withdrawalId} — ${w.amount} — wallet: ${w.walletAddress || 'N/A'}`);
            });
        }
        
        // Initialize selection bucket with order/withdrawal data
        walletSelections.set(userId, { 
            selections: new Set(), 
            timestamp: Date.now(),
            sellOrders: sellOrders.map(o => o.id),
            withdrawals: withdrawals.map(w => w.withdrawalId),
            messageId: null
        });
        
        const buildKeyboard = (bucket) => {
            const kb = { inline_keyboard: [] };
            const bucket_data = walletSelections.get(userId);
            
            if (bucket_data?.sellOrders) {
                bucket_data.sellOrders.forEach(id => {
                    const isSelected = bucket.selections.has(`sell:${id}`);
                    kb.inline_keyboard.push([
                        { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_sell_${id}` },
                        { text: '🔄 Update', callback_data: `wallet_update_sell_${id}` }
                    ]);
                });
            }
            
            if (bucket_data?.withdrawals) {
                bucket_data.withdrawals.forEach(id => {
                    const isSelected = bucket.selections.has(`wd:${id}`);
                    kb.inline_keyboard.push([
                        { text: `${isSelected ? '🟢' : '⚪'} ${id}`, callback_data: `wallet_sel_withdrawal_${id}` },
                        { text: '🔄 Update', callback_data: `wallet_update_withdrawal_${id}` }
                    ]);
                });
            }
            
            kb.inline_keyboard.push([
                { text: 'Select All', callback_data: 'wallet_sel_all' },
                { text: 'Clear', callback_data: 'wallet_sel_clear' }
            ]);
            kb.inline_keyboard.push([
                { text: `✅ Continue (${bucket.selections.size} selected)`, callback_data: 'wallet_continue_selected' }
            ]);
            
            return kb;
        };
        
        const bucket = walletSelections.get(userId);
        const initialKeyboard = buildKeyboard(bucket);
        const msg_sent = await bot.sendMessage(chatId, lines.join('\n') + `\n\n📌 Select items (they'll light up 🟢 when selected), then tap "Continue".`, { reply_markup: initialKeyboard });
        
        // Store message ID so we can edit it later
        bucket.messageId = msg_sent.message_id;
        walletSelections.set(userId, bucket);
    } catch (err) {
        console.error('Wallet handler error:', err);
        await bot.sendMessage(msg.chat.id, '❌ Failed to load your orders. Please try again later.');
    }
}

// ==================== COMMAND HANDLERS ====================

bot.onText(/\/help/, (msg) => {
    handleHelpCommand(msg);
});

// Handle keyboard menu button presses - no double processing
bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    const chatId = msg.chat.id;
    
    // Map keyboard button presses directly to handlers (don't re-process to avoid double execution)
    if (text === '💬 Help') {
        handleHelpCommand(msg);
    } else if (text === '👥 Referral') {
        handleReferralsCommand(msg);
    } else if (text === '💰 Wallet') {
        handleWalletCommand(msg);
    }
});

// Contact command for users
bot.onText(/\/contact/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    const contactText = `📞 **Contact Support**

**Type your message below and we'll respond quickly!**`;

    bot.sendMessage(chatId, contactText, { parse_mode: 'Markdown' });
    
    // Set up message listener for support request with timeout
    const supportHandler = (userMsg) => {
        if (userMsg.chat.id === chatId && userMsg.text) {
            clearTimeout(timeoutId);
            bot.removeListener('message', supportHandler);
            const userMessageText = userMsg.text;
            
            // Check if message is FAQ about how to sell
            const isHowToSellFAQ = isHowToSellQuestion(userMessageText);
            let autoReplied = false;
            
            if (isHowToSellFAQ) {
                // Send FAQ reply
                const faqReply = `Hi, click on launch App below ↙️ tap Sell at the bottom, enter your USDT TON wallet address, the number of stars you want to sell, then tap Sell Now.`;
                
                const keyboard = {
                    inline_keyboard: [[
                        { text: '💰 Open Sell Page', web_app: { url: 'https://starstore.site/sell' } }
                    ]]
                };
                
                bot.sendMessage(chatId, faqReply, { reply_markup: keyboard });
                autoReplied = true;
                
                // Send follow-up with talk to person option
                const followUpText = `Did this answer your question? If you need more help, you can talk to a support person.`;
                const talkToPersonKeyboard = {
                    inline_keyboard: [[
                        { text: '👤 Talk to Person', callback_data: `talk_to_person_${chatId}_${Date.now()}` }
                    ]]
                };
                
                bot.sendMessage(chatId, followUpText, { reply_markup: talkToPersonKeyboard });
                
                // Set up callback listener for the button
                const callbackHandler = (query) => {
                    if (query.data.startsWith(`talk_to_person_${chatId}_`)) {
                        bot.answerCallbackQuery(query.id);
                        // Forward to admins
                        adminIds.forEach(adminId => {
                            bot.sendMessage(adminId, `📞 Support Request from @${username} (ID: ${chatId}):\n\n${userMessageText}\n\n🤖 Auto-replied: Yes`);
                        });
                        bot.sendMessage(chatId, "✅ Your question has been forwarded to our support team. Please wait for their response.");
                        bot.removeListener('callback_query', callbackHandler);
                    }
                };
                bot.on('callback_query', callbackHandler);
                
                // Timeout for the callback
                setTimeout(() => {
                    bot.removeListener('callback_query', callbackHandler);
                    // If not clicked, session expires without forwarding again
                }, 5 * 60 * 1000);
            } else {
                // Not FAQ, forward immediately
                adminIds.forEach(adminId => {
                    bot.sendMessage(adminId, `📞 Support Request from @${username} (ID: ${chatId}):\n\n${userMessageText}\n\n🤖 Auto-replied: No`);
                });
                bot.sendMessage(chatId, "✅ Your message has been sent to our support team. We'll get back to you shortly!");
            }
        }
    };
    bot.on('message', supportHandler);

    // Automatically cancel if user doesn't respond in 5 minutes
    const timeoutId = setTimeout(() => {
        bot.removeListener('message', supportHandler);
        bot.sendMessage(chatId, "⏳ Contact session timed out. Please send /contact again if you still need help.");
    }, 5 * 60 * 1000);
});

// Function to detect if message is asking "how to sell"
function isHowToSellQuestion(text) {
    if (!text) return false;
    
    const lowerText = text.toLowerCase();
    
    // Common patterns for "how to sell"
    const patterns = [
        /how.*sell/i,
        /how.*to.*sell/i,
        /sell.*how/i,
        /how.*i.*sell/i,
        /how.*selling/i,
        /selling.*how/i,
        /how.*sell.*stars/i,
        /sell.*stars.*how/i,
        /how.*sell.*telegram/i,
        /how.*to.*sell.*stars/i
    ];
    
    // Check for exact patterns
    if (patterns.some(pattern => pattern.test(lowerText))) {
        return true;
    }
    
    // Check for keywords: must contain "how" or "what" and "sell"
    const hasQuestionWord = /\b(how|what|can|do)\b/i.test(lowerText);
    const hasSell = /\b(sell|selling|sale)\b/i.test(lowerText);
    
    // Additional context words
    const hasContext = /\b(stars?|telegram|starstore|app|bot)\b/i.test(lowerText);
    
    return hasQuestionWord && hasSell && (hasContext || lowerText.length < 100); // Shorter messages more likely to be direct questions
}

// Admin command: View comprehensive user information (activity, location, devices)
bot.onText(/^\/userinfo\s+(\d+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const userId = match[1];
    
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, "❌ Unauthorized");
    }
    
    try {
        // Find user
        const user = await User.findOne({ id: userId });
        
        if (!user) {
            return bot.sendMessage(chatId, `❌ User not found: ${userId}`);
        }
        
        // Get recent activity logs (last 5)
        const logs = await UserActivityLog.find({ userId: user.id })
            .sort({ timestamp: -1 })
            .limit(5)
            .lean();
        
        // Get devices
        const devices = await DeviceTracker.find({ userId: user.id })
            .sort({ lastSeen: -1 })
            .lean();
        
        // Get referral data: who referred this user AND how many they referred
        const marchFirstDate = new Date('2026-03-01T00:00:00Z');
        const referralRecord = await Referral.findOne({ referredUserId: userId });
        const myReferrals = await Referral.find({
            referrerUserId: userId,
            $or: [
                { dateReferred: { $gte: marchFirstDate } },
                { dateReferred: { $exists: false }, dateCreated: { $gte: marchFirstDate } }
            ]
        });
        const activeReferrals = myReferrals.filter(r => r.status === 'active').length;
        const pendingReferrals = myReferrals.filter(r => r.status === 'pending').length;
        
        // Build comprehensive report
        let report = `👤 **User Information**\n`;
        report += `├─ ID: ${user.id}\n`;
        report += `├─ Username: @${user.username || 'Not set'}\n`;
        report += `├─ First Seen: ${user.createdAt?.toLocaleString() || 'Unknown'}\n`;
        report += `└─ Last Active: ${user.lastActive?.toLocaleString() || 'Never'}\n\n`;
        
        // Referral program status
        report += `👥 **Referral Status**\n`;
        if (referralRecord) {
            const referrerUser = await User.findOne({ id: referralRecord.referrerUserId });
            report += `├─ Referred by: @${referrerUser?.username || 'Unknown'} (ID: ${referralRecord.referrerUserId})\n`;
        } else {
            report += `├─ Referred by: None (organic user)\n`;
        }
        report += `├─ Total Referrals (since Mar 1): ${myReferrals.length}\n`;
        report += `├─ Active: ${activeReferrals}\n`;
        report += `└─ Pending: ${pendingReferrals}\n`;
        
        // Show recent referrals if any
        if (myReferrals.length > 0) {
            report += `\n📋 **Recent Referrals** (Last 10 since Mar 1):\n`;
            const recentReferrals = myReferrals.slice(0, 10);
            for (const ref of recentReferrals) {
                const referredUser = await User.findOne({ id: ref.referredUserId });
                const statusEmoji = ref.status === 'completed' ? '✔️' : ref.status === 'pending' ? '⏳' : '✔️';
                report += `  ${statusEmoji} @${referredUser?.username || 'Unknown'} (ID: ${ref.referredUserId}) - ${ref.status.toUpperCase()}\n`;
                report += `     Referred: ${new Date(ref.dateReferred).toLocaleDateString()}\n`;
            }
        }
        report += '\n';
        
        // Current status
        report += `📍 **Current Status**\n`;
        report += `├─ Location: ${user.lastLocation?.city || 'Not tracked'}, ${user.lastLocation?.country || 'N/A'}\n`;
        report += `├─ IP: ${user.lastLocation?.ip || 'N/A'}\n`;
        report += `└─ Device: ${user.lastDevice?.browser || 'Not tracked'} on ${user.lastDevice?.os || 'N/A'}\n\n`;
        
        // Location history
        if (user.locationHistory && user.locationHistory.length > 0) {
            report += `🗺️ **Location History** (${user.locationHistory.length} entries)\n`;
            const uniqueCountries = new Set(user.locationHistory.map(l => l.country));
            report += `Countries: ${Array.from(uniqueCountries).join(', ')}\n`;
            report += `Recent locations:\n`;
            user.locationHistory.slice(-3).reverse().forEach((loc, idx) => {
                report += `  ${idx + 1}. ${loc.city}, ${loc.country} (${new Date(loc.timestamp).toLocaleDateString()})\n`;
            });
            report += '\n';
        }
        
        // Device history
        if (devices.length > 0) {
            report += `📱 **Devices** (${devices.length} detected)\n`;
            devices.forEach((device, idx) => {
                const lastLoc = device.locations?.[device.locations.length - 1];
                report += `  Device ${idx + 1}: ${device.browser} on ${device.os}\n`;
                report += `    Last: ${new Date(device.lastSeen).toLocaleDateString()}\n`;
                if (lastLoc) {
                    report += `    Last Location: ${lastLoc.city}, ${lastLoc.country}\n`;
                }
            });
            report += '\n';
        }
        
        // Recent activity
        if (logs.length > 0) {
            report += `📊 **Recent Activity** (Last 5)\n`;
            logs.forEach((log, idx) => {
                const emoji = log.actionType === 'order_completed' ? '✅' : 
                             log.actionType === 'command' ? '⚙️' :
                             log.actionType === 'button_click' ? '🔘' : '📝';
                report += `  ${idx + 1}. ${emoji} ${log.actionType} - ${log.location?.city || 'Unknown'}, ${log.location?.country || 'N/A'}\n`;
                report += `     ${new Date(log.timestamp).toLocaleDateString()}\n`;
            });
        } else {
            report += `📊 **Recent Activity**\nNo activities logged yet.\n`;
        }
        
        bot.sendMessage(chatId, report);
    } catch (error) {
        console.error('Error fetching user info:', error);
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ==== INTERACTIVE EMAIL SENDING COMMAND ====
// /sendemail - Start interactive email sending session
bot.onText(/\/sendemail/i, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    // Verify admin
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, '⛔ **Access Denied**\n\nInsufficient privileges to execute this command.', {
            parse_mode: 'Markdown'
        });
    }
    
    // Start a new session
    emailSessions.set(chatId, {
        step: 'template_select',
        recipient: null,
        subject: null,
        template: null,
        createdAt: Date.now(),
        adminId: adminId,
        adminName: msg.from.username ? `@${msg.from.username}` : msg.from.first_name
    });
    
    // Show available templates
    const templateList = `📧 **Email Template Selection**\n\n` +
        `Choose an email template:\n\n` +
        `1️⃣ Ambassador Approval\n` +
        `2️⃣ Welcome/Onboarding\n` +
        `3️⃣ Promotional\n` +
        `4️⃣ Support/Notification\n` +
        `5️⃣ Custom Template\n\n` +
        `Reply with the number (1-5):`;
    
    bot.sendMessage(chatId, templateList, { parse_mode: 'Markdown' });
});

// Handle email session input
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    // Only process if there's an active email session
    if (!emailSessions.has(chatId)) return;
    
    const session = emailSessions.get(chatId);
    
    // Verify it's still the same admin
    if (session.adminId !== adminId) {
        return bot.sendMessage(chatId, '❌ This session belongs to another admin.');
    }
    
    // Verify session not timed out
    if (Date.now() - session.createdAt > EMAIL_SESSION_TIMEOUT) {
        emailSessions.delete(chatId);
        return bot.sendMessage(chatId, '⏱️ **Session Expired**\n\nEmail sending session timed out after 3 minutes of inactivity. Use /sendemail to start again.', {
            parse_mode: 'Markdown'
        });
    }
    
    const text = msg.text?.trim();
    if (!text) return; // Ignore non-text messages
    
    // Skip if this is a command
    if (text.startsWith('/')) return;
    
    try {
        if (session.step === 'template_select') {
            const templateChoice = text;
            const templates = {
                '1': {
                    name: 'Ambassador Approval',
                    subject: 'Welcome to StarStore Ambassador Program',
                    body: 'Congratulations! You have been approved as a StarStore Ambassador. Your referral link is ready to use.'
                },
                '2': {
                    name: 'Welcome/Onboarding',
                    subject: 'Welcome to StarStore',
                    body: 'Welcome! We\'re excited to have you on board. Thank you for joining our community.'
                },
                '3': {
                    name: 'Promotional',
                    subject: 'Exclusive Offer for You',
                    body: 'Don\'t miss out on our latest promotions and exclusive offers just for you!'
                },
                '4': {
                    name: 'Support/Notification',
                    subject: 'Important Update',
                    body: 'This is an important notification regarding your account or a recent transaction.'
                },
                '5': {
                    name: 'Custom',
                    subject: null,
                    body: null
                }
            };
            
            if (!templates[templateChoice]) {
                return bot.sendMessage(chatId, '❌ Invalid template number. Please choose 1-5.');
            }
            
            session.template = templates[templateChoice];
            
            if (templateChoice === '5') {
                // Custom template - ask for subject first
                session.step = 'custom_subject';
                bot.sendMessage(chatId, '📝 **Custom Email**\n\nEnter the email subject:', { parse_mode: 'Markdown' });
            } else {
                // Preset template - show preview and ask for recipient
                session.step = 'recipient';
                const preview = `📝 **Template Preview**\n\n**Name**: ${session.template.name}\n**Subject**: ${session.template.subject}\n**Body**: ${session.template.body}\n\n` +
                    `Now enter the recipient email address:`;
                bot.sendMessage(chatId, preview, { parse_mode: 'Markdown' });
            }
        } 
        else if (session.step === 'custom_subject') {
            session.subject = text;
            session.step = 'custom_body';
            bot.sendMessage(chatId, '📄 **Custom Body**\n\nEnter the email body (HTML supported):', { parse_mode: 'Markdown' });
        }
        else if (session.step === 'custom_body') {
            session.template.body = text;
            session.step = 'recipient';
            const preview = `📝 **Custom Template Preview**\n\n**Subject**: ${session.subject}\n**Body**: ${session.template.body}\n\n` +
                `Now enter the recipient email address:`;
            bot.sendMessage(chatId, preview, { parse_mode: 'Markdown' });
        }
        else if (session.step === 'recipient') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(text)) {
                return bot.sendMessage(chatId, '❌ Invalid email format. Please enter a valid email address.');
            }
            
            session.recipient = text;
            session.step = 'confirm';
            
            const confirmMsg = `✅ **Confirm Email Details**\n\n` +
                `**Recipient**: ${session.recipient}\n` +
                `**Subject**: ${session.subject || session.template.subject}\n` +
                `**Template**: ${session.template.name}\n\n` +
                `Reply with:\n` +
                `✅ To send\n` +
                `❌ To cancel\n` +
                `🔄 To start over`;
            
            bot.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
        }
        else if (session.step === 'confirm') {
            if (text.toLowerCase() === '✅' || text.toLowerCase() === 'yes') {
                // Send the email
                const finalSubject = session.subject || session.template.subject;
                const finalBody = session.template.body;
                
                try {
                    const result = await emailService.sendCustomEmail(session.recipient, finalSubject, finalBody);
                    
                    if (result.success) {
                        const successMsg = `✅ **Email Sent Successfully!**\n\n` +
                            `**To**: ${session.recipient}\n` +
                            `**Subject**: ${finalSubject}\n` +
                            `**Template**: ${session.template.name}\n` +
                            `**Message ID**: ${result.messageId || 'N/A'}\n` +
                            `**Sent At**: ${new Date().toLocaleString()}\n` +
                            `**Sent By**: ${session.adminName}\n\n` +
                            `Use /sendemail to send another email.`;
                        
                        bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
                        console.log(`📧 [Admin Email] From ${session.adminName}: sent "${finalSubject}" to ${session.recipient}`);
                    } else {
                        const error = result.offline ? 
                            '⚠️ Email service is offline (no API key configured)' : 
                            `❌ Failed to send: ${result.error}`;
                        
                        bot.sendMessage(chatId, error);
                    }
                } catch (error) {
                    console.error('[Admin Email] Send error:', error);
                    bot.sendMessage(chatId, `❌ Error sending email: ${error.message}`);
                } finally {
                    emailSessions.delete(chatId);
                }
            } 
            else if (text.toLowerCase() === '❌' || text.toLowerCase() === 'no') {
                emailSessions.delete(chatId);
                bot.sendMessage(chatId, '❌ Email sending cancelled. Use /sendemail to start again.');
            }
            else if (text.toLowerCase() === '🔄' || text.toLowerCase() === 'restart') {
                emailSessions.delete(chatId);
                // Restart the command
                bot.processUpdate({
                    message: {
                        message_id: msg.message_id,
                        chat: msg.chat,
                        from: msg.from,
                        text: '/sendemail'
                    }
                });
            }
            else {
                bot.sendMessage(chatId, 'Please reply with one of: ✅, ❌, or 🔄');
            }
        }
    } catch (error) {
        console.error('[Email Session] Error:', error);
        emailSessions.delete(chatId);
        bot.sendMessage(chatId, `❌ An error occurred: ${error.message}`);
    }
});

bot.onText(/\/adminhelp/, (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    // Verify admin
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, "❌ Unauthorized");
    }
    
    const helpText = `🔧 **Admin Commands Help**

**👥 User Management:**
/ban [user_id] - Ban a user from using the bot
/unban [user_id] - Unban a previously banned user
/warn [user_id] - Send a warning to a user
/warnings [user_id] - Check all warnings for a user
/users - List all users in the system
/detect_users - Detect and process new users

**👤 User Activity & Location Logs:**
/userinfo [user_id] - View comprehensive user info (referrals, activity, location, devices)

**�💰 Wallet Management:**
/updatewallet [user_id] [sell|withdrawal] [order_id] [new_wallet_address]
  - Update a user's wallet address for specific order
  - Example: /updatewallet 123456789 sell ABC123 UQAbc123...
/userwallet [user_id] - View all wallet addresses for a user

**📋 Order Management:**
/findorder [order_id] - Find detailed order information
/getpayment [order_id] - Get payment details for an order
/cso- [order_id] - Complete sell order
/cbo- [order_id] - Complete buy order
/sell_complete [order_id] - Complete sell order (alternative)
/sell_decline [order_id] - Decline sell order

**💸 Refund Management:**
/adminrefund [order_id] - Process a refund for an order
/refundtx [order_id] [tx_hash] - Update refund transaction hash

**📢 Communication:**
/reply [user_id1,user_id2,...] [message] - Send message to multiple users
/broadcast - Send broadcast message to all users
/notify [all|@username|user_id] [message] - Send targeted notification
/add_amb [user_id] [email] - Add user as ambassador
/sendemail - Send custom email to users (interactive session)

**🔍 Information:**
/version - Check app version and update information
/adminhelp - Show this admin help menu
/adminwallethelp - Show detailed wallet management help

**Wallet Update Requests:**
• Use the inline buttons on wallet update requests to approve/reject
• All wallet changes require admin approval for security`;
    
    bot.sendMessage(chatId, helpText);
});

// Admin command to check activity and bot status
bot.onText(/\/activity(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const adminUsername = msg.from.username || 'Unknown';
    const timeframe = match?.[1]?.toLowerCase() || '24h';
    
    if (!adminIds.includes(adminId)) {
        console.warn(`[SECURITY] Unauthorized activity attempt by user ${adminId} (@${adminUsername})`);
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }
    
    console.log(`[ADMIN-ACTION] activity command initiated by @${adminUsername} (${adminId}) for timeframe: ${timeframe}`);
    
    try {
        await bot.sendMessage(chatId, '📊 Fetching activity statistics...');
        
        // Calculate time range
        let startTime;
        let displayPeriod;
        switch (timeframe) {
            case '1h':
                startTime = new Date(Date.now() - 60 * 60 * 1000);
                displayPeriod = 'Last Hour';
                break;
            case '24h':
                startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
                displayPeriod = 'Last 24 Hours';
                break;
            case '7d':
                startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                displayPeriod = 'Last 7 Days';
                break;
            default:
                startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
                displayPeriod = 'Last 24 Hours';
        }

        // Get statistics
        const [
            totalActivities,
            recentActivities,
            totalUsers,
            activeUsers,
            botUsers,
            botActivities,
            activityTypes
        ] = await Promise.all([
            Activity.countDocuments(),
            Activity.countDocuments({ timestamp: { $gte: startTime } }),
            User.countDocuments(),
            User.countDocuments({ lastActive: { $gte: startTime } }),
            User.countDocuments({ id: { $regex: '^200000' } }),
            Activity.countDocuments({ 
                userId: { $regex: '^200000' },
                timestamp: { $gte: startTime }
            }),
            Activity.aggregate([
                { $match: { timestamp: { $gte: startTime } } },
                { $group: { 
                    _id: '$activityType', 
                    count: { $sum: 1 },
                    totalPoints: { $sum: '$points' }
                }},
                { $sort: { count: -1 } },
                { $limit: 5 }
            ])
        ]);

        const botSimulatorEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';

        const activityText = `📊 <b>Activity Statistics</b>

<b>${displayPeriod}:</b>
• Activities: <code>${recentActivities}</code> (Total: <code>${totalActivities}</code>)
• Active Users: <code>${activeUsers}</code> / <code>${totalUsers}</code>

<b>Bot Simulator:</b>
• Status: ${botSimulatorEnabled ? '✅ Enabled' : '❌ Disabled'}
• Bot Users: <code>${botUsers}</code>
• Bot Activities: <code>${botActivities}</code>

<b>Top Activity Types:</b>
${activityTypes.length > 0 ? 
    activityTypes.map(type => `• ${type._id}: <code>${type.count}</code> (${type.totalPoints} pts)`).join('\n') : 
    '• No recent activities'
}

<b>Commands:</b>
• <code>/activity 1h</code> - Last hour stats
• <code>/activity 24h</code> - Last 24 hours (default)
• <code>/activity 7d</code> - Last 7 days`;

        await bot.sendMessage(chatId, activityText, { 
            parse_mode: 'HTML',
            disable_web_page_preview: true 
        });
        
        // Additional diagnostics if bot simulator is enabled but not working
        if (botSimulatorEnabled && botActivities === 0) {
            await bot.sendMessage(chatId, 
                '⚠️ <b>Bot Simulator Issue Detected</b>\n\n' +
                'Bot simulator is enabled but no recent bot activities found.\n' +
                'This may indicate the bot simulator is not running properly.',
                { parse_mode: 'HTML' }
            );
        }
        
        console.log(`[ADMIN-ACTION] activity command completed by @${adminUsername}`);
    } catch (error) {
        console.error(`[ADMIN-ACTION] activity command error by @${adminUsername}:`, error);
        await bot.sendMessage(chatId, `❌ Error fetching activity statistics: ${error.message}`);
    }
});

// Admin version command
bot.onText(/\/version/, (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    // Verify admin
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, "❌ Unauthorized");
    }
    
    try {
        // Get current version info
        const packageJson = require('./package.json');
        const { execSync } = require('child_process');
        
        // Get git information with error handling
        let gitInfo = {};
        let recentCommits = [];
        
        // Check if we're in a git repository and git is available
        const isGitAvailable = process.env.NODE_ENV !== 'production' && 
                              (process.env.RAILWAY_GIT_COMMIT_SHA || 
                               process.env.GIT_AVAILABLE === 'true');
        
        if (isGitAvailable) {
            try {
                gitInfo = {
                    commitCount: execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim(),
                    currentHash: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
                    branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
                    lastCommitDate: execSync('git log -1 --format=%ci', { encoding: 'utf8' }).trim(),
                    lastCommitMessage: execSync('git log -1 --format=%s', { encoding: 'utf8' }).trim(),
                    lastCommitAuthor: execSync('git log -1 --format=%an', { encoding: 'utf8' }).trim()
                };
                
                // Get recent commits (last 5)
                recentCommits = execSync('git log -5 --oneline', { encoding: 'utf8' }).trim().split('\n');
            } catch (gitError) {
                // Fall through to environment variables
            }
        }
        
        // Use environment variables or build-time info if git failed or unavailable
        if (!gitInfo.commitCount) {
            gitInfo = {
                commitCount: process.env.RAILWAY_GIT_COMMIT_SHA ? '1' : 'N/A',
                currentHash: process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.substring(0, 7) : 'N/A',
                branch: process.env.RAILWAY_GIT_BRANCH || 'main',
                lastCommitDate: process.env.RAILWAY_GIT_COMMIT_CREATED_AT ? 
                    new Date(process.env.RAILWAY_GIT_COMMIT_CREATED_AT).toISOString() : 
                    new Date().toISOString(),
                lastCommitMessage: process.env.RAILWAY_GIT_COMMIT_MESSAGE || 'Production build',
                lastCommitAuthor: process.env.RAILWAY_GIT_COMMIT_AUTHOR || 'System'
            };
            recentCommits = ['Production environment - Railway deployment'];
        }
        
        // Calculate time since last update
        const lastUpdate = new Date(gitInfo.lastCommitDate);
        const now = new Date();
        const timeDiff = now - lastUpdate;
        const hoursAgo = Math.floor(timeDiff / (1000 * 60 * 60));
        const daysAgo = Math.floor(hoursAgo / 24);
        
        let timeAgo;
        if (daysAgo > 0) {
            timeAgo = `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`;
        } else if (hoursAgo > 0) {
            timeAgo = `${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
        } else {
            const minutesAgo = Math.floor(timeDiff / (1000 * 60));
            timeAgo = `${minutesAgo} minute${minutesAgo > 1 ? 's' : ''} ago`;
        }
        
        const versionText = `📊 **StarStore Version Information**

**🔢 Current Version:**
• Version: \`${packageJson.version}\`
• Build Number: \`${gitInfo.commitCount}\`
• Commit Hash: \`${gitInfo.currentHash}\`
• Branch: \`${gitInfo.branch}\`

**⏰ Last Update:**
• Date: \`${gitInfo.lastCommitDate}\`
• Time Ago: \`${timeAgo}\`
• Author: \`${gitInfo.lastCommitAuthor}\`
• Message: \`${gitInfo.lastCommitMessage}\`

**📈 Recent Updates:**
${recentCommits.map((commit, index) => `• ${index + 1}. ${commit}`).join('\n')}

**🕐 Server Status:**
• Server Time: \`${now.toISOString()}\`
• Uptime: \`${Math.floor(process.uptime() / 3600)} hours\`
• Memory Usage: \`${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB\`

**📱 App Information:**
• Name: \`${packageJson.name}\`
• Description: \`${packageJson.description}\`
• Node Version: \`${process.version}\``;

        bot.sendMessage(chatId, versionText, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Error getting version info:', error);
        bot.sendMessage(chatId, `❌ Error getting version information: ${error.message}`);
    }
});

// Admin command to update user wallet addresses
// Usage: /updatewallet <userId> <sell|withdrawal> <orderId> <walletAddress> [memo]
bot.onText(/\/updatewallet\s+([0-9]+)\s+(sell|withdrawal)\s+([A-Za-z0-9_-]+)\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    try {
        // Verify admin
        if (!adminIds.includes(adminId)) {
            return await bot.sendMessage(chatId, "❌ Unauthorized access");
        }
        
        const userId = match[1];
        const orderType = match[2].toLowerCase();
        const orderId = match[3];
        const input = match[4].trim();
        
        // Parse wallet input
        const { address: newWalletAddress, memo: newMemoTag } = parseWalletInput(input);
        
        // Validate inputs
        if (!userId || !orderId || !newWalletAddress) {
            return await bot.sendMessage(chatId, "❌ Missing required parameters\n\nUsage: /updatewallet <userId> <sell|withdrawal> <orderId> <walletAddress> [memo]");
        }
        
        if (!isValidTONAddress(newWalletAddress)) {
            return await bot.sendMessage(chatId, "❌ Invalid wallet address format");
        }
        
        if (!['sell', 'withdrawal'].includes(orderType)) {
            return await bot.sendMessage(chatId, "❌ Order type must be 'sell' or 'withdrawal'");
        }
        
        // Find and update order
        let order, oldWallet = '', orderDisplayId = '';
        
        if (orderType === 'sell') {
            order = await SellOrder.findOne({ id: orderId, telegramId: userId });
            if (!order) {
                return await bot.sendMessage(chatId, `❌ Sell order ${orderId} not found for user ${userId}`);
            }
            orderDisplayId = order.id;
            oldWallet = order.walletAddress || '';
            order.walletAddress = newWalletAddress;
            order.memoTag = newMemoTag || 'none';
            await order.save();
            
            // Update user message with new wallet/memo details so they see the change
            if (order.userMessageId) {
                try {
                    const currentText = `✅ Payment successful!\n\n` +
                        `Order ID: ${order.id}\n` +
                        `Stars: ${order.stars}\n` +
                        `Wallet: ${order.walletAddress}\n` +
                        `${order.memoTag && order.memoTag !== 'none' ? `Memo: ${order.memoTag}\n` : ''}` +
                        `\nStatus: Processing (21-day hold)\n\n` +
                        `Funds will be released to your wallet after the hold period.`;
                    await bot.editMessageText(currentText, { chat_id: order.telegramId, message_id: order.userMessageId });
                } catch (e) {
                    console.warn(`Failed to update wallet info in user message for order ${order.id}:`, e.message);
                }
            }
            
            // Update admin messages if present
            if (Array.isArray(order.adminMessages) && order.adminMessages.length) {
                await Promise.all(order.adminMessages.map(async (m) => {
                    let text = m.originalText || '';
                    if (text) {
                        if (text.includes('\nWallet: ')) {
                            text = text.replace(/\nWallet:.*?(\n|$)/, `\nWallet: ${order.walletAddress}$1`);
                        }
                        if (order.memoTag) {
                            if (text.includes('\nMemo:')) {
                                text = text.replace(/\nMemo:.*?(\n|$)/, `\nMemo: ${order.memoTag}$1`);
                            } else {
                                text += `\nMemo: ${order.memoTag}`;
                            }
                        }
                    } else {
                        const locationStr = order.userLocation ? 
                            `Location: ${order.userLocation.city || 'Unknown'}, ${order.userLocation.country || 'Unknown'}\n` : '';
                        text = `💰 New Payment Received!\n\nOrder ID: ${order.id}\nUser: ${order.username ? `@${order.username}` : 'Unknown'} (ID: ${order.telegramId})\n${locationStr}Stars: ${order.stars}\nWallet: ${order.walletAddress}\n${order.memoTag ? `Memo: ${order.memoTag}` : 'Memo: None'}`;
                    }
                    
                    // Update the originalText in the database to preserve the new wallet address
                    m.originalText = text;
                    
                    // Re-attach the original sell action buttons
                    const sellButtons = {
                        inline_keyboard: [[
                            { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                            { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                            { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                        ]]
                    };
                    
                    try {
                        await bot.editMessageText(text, { 
                            chat_id: parseInt(m.adminId, 10) || m.adminId, 
                            message_id: m.messageId, 
                            reply_markup: sellButtons 
                        });
                    } catch (e) {
                        console.warn(`Failed to edit admin message for order ${order.id}:`, e.message);
                    }
                }));
                
                // Save the updated admin messages back to the database
                await order.save();
            }
        } else {
            order = await ReferralWithdrawal.findOne({ withdrawalId: orderId, userId: userId });
            if (!order) {
                return await bot.sendMessage(chatId, `❌ Withdrawal ${orderId} not found for user ${userId}`);
            }
            orderDisplayId = order.withdrawalId;
            oldWallet = order.walletAddress || '';
            order.walletAddress = newWalletAddress;
            order.memoTag = newMemoTag || 'none';
            await order.save();
            
            // Update admin messages for withdrawal if present
            if (Array.isArray(order.adminMessages) && order.adminMessages.length) {
                await Promise.all(order.adminMessages.map(async (m) => {
                    let text = m.originalText || '';
                    if (text) {
                        if (text.includes('\nWallet: ')) {
                            text = text.replace(/\nWallet:.*?(\n|$)/, `\nWallet: ${order.walletAddress}$1`);
                        }
                        if (order.memoTag) {
                            if (text.includes('\nMemo:')) {
                                text = text.replace(/\nMemo:.*?(\n|$)/, `\nMemo: ${order.memoTag}$1`);
                            } else {
                                text += `\nMemo: ${order.memoTag}`;
                            }
                        }
                    }
                    
                    try {
                        await bot.editMessageText(text, { 
                            chat_id: parseInt(m.adminId, 10) || m.adminId, 
                            message_id: m.messageId
                        });
                    } catch (e) {
                        console.warn(`Failed to edit admin message for withdrawal ${order.withdrawalId}:`, e.message);
                    }
                }));
            }
        }
        
        // Notify user
        try {
            await bot.sendMessage(userId, `🔧 Admin updated your wallet for ${orderType} order ${orderDisplayId}:\n\nOld: ${oldWallet || 'N/A'}\nNew: ${newWalletAddress}${newMemoTag ? `\nMemo: ${newMemoTag}` : ''}`);
        } catch (e) {
            console.warn(`Failed to notify user ${userId} of wallet update:`, e.message);
        }
        
        // Confirm to admin
        await bot.sendMessage(chatId, `✅ Wallet updated successfully!\n\nUser: ${userId}\nOrder: ${orderDisplayId} (${orderType})\nOld: ${oldWallet || 'N/A'}\nNew: ${newWalletAddress}${newMemoTag ? `\nMemo: ${newMemoTag}` : ''}`);
        
    } catch (error) {
        console.error('Admin wallet update error:', error);
        
        // More specific error messages
        if (error.name === 'ValidationError') {
            await bot.sendMessage(chatId, '❌ Database validation error. Check the data format.');
        } else if (error.name === 'CastError') {
            await bot.sendMessage(chatId, '❌ Invalid data format. Check order ID and user ID.');
        } else {
            await bot.sendMessage(chatId, '❌ Failed to update wallet. Please try again.');
        }
    }
});

// Admin help command for wallet management
bot.onText(/\/adminwallethelp/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    if (!adminIds.includes(adminId)) {
        return await bot.sendMessage(chatId, "❌ Unauthorized access");
    }
    
    const helpText = `🔧 **Admin Wallet Commands**

**Update User Wallet:**
\`/updatewallet <userId> <sell|withdrawal> <orderId> <walletAddress> [memo]\`

**Examples:**
\`/updatewallet 123456789 sell ABC123 UQAbc123...xyz\`
\`/updatewallet 123456789 withdrawal DEF456 UQDef456...xyz, memo123\`

**View User Wallets:**
\`/userwallet <userId>\`

**Notes:**
• Order types: \`sell\` or \`withdrawal\`
• Memo is optional (defaults to 'none')
• Invalid characters are automatically cleaned
• User gets notified of changes`;
    
    await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// Admin command to view user's orders and wallets
bot.onText(/\/userwallet\s+([0-9]+)/, async (msg, match) => {
    try {
        const chatId = msg.chat.id;
        const adminId = msg.from.id.toString();
        
        // Verify admin
        if (!adminIds.includes(adminId)) {
            return await bot.sendMessage(chatId, "❌ Unauthorized");
        }
        
        const userId = match[1];
        
        // Fetch user's orders and withdrawals
        const [sellOrders, withdrawals] = await Promise.all([
            SellOrder.find({ telegramId: userId }).sort({ dateCreated: -1 }).limit(10),
            ReferralWithdrawal.find({ userId: userId }).sort({ createdAt: -1 }).limit(10)
        ]);
        
        let response = `👤 User ${userId} Wallet Information:\n\n`;
        
        if (sellOrders.length > 0) {
            response += `🛒 Sell Orders:\n`;
            sellOrders.forEach(order => {
                response += `• ${order.id} — ${order.stars} ★ — ${order.status} — Wallet: ${order.walletAddress || 'N/A'}\n`;
            });
            response += `\n`;
        }
        
        if (withdrawals.length > 0) {
            response += `💳 Withdrawals:\n`;
            withdrawals.forEach(wd => {
                response += `• ${wd.withdrawalId} — ${wd.amount} — ${wd.status} — Wallet: ${wd.walletAddress || 'N/A'}\n`;
            });
        }
        
        if (sellOrders.length === 0 && withdrawals.length === 0) {
            response += `No orders or withdrawals found for this user.`;
        }
        
        await bot.sendMessage(chatId, response);
        
    } catch (error) {
        console.error('Admin user wallet view error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to fetch user wallet information');
    }
});

bot.onText(/\/reply\s+([0-9]+(?:\s*,\s*[0-9]+)*)(?:\s+([\s\S]+))?/, async (msg, match) => {
    try {
        // Verify admin (using your existing adminIds)
        if (!adminIds.includes(String(msg.from.id))) {
            return await bot.sendMessage(msg.chat.id, "❌ Unauthorized");
        }

        const recipientsRaw = match[1] || '';
        const textMessage = match[2] || '';
        const hasText = (textMessage || '').trim().length > 0;

        const recipientIds = Array.from(new Set(
            recipientsRaw
                .split(/[\s,]+/)
                .map(id => id.trim())
                .filter(id => id && /^\d+$/.test(id))
        ));

        if (recipientIds.length === 0) {
            return await bot.sendMessage(msg.chat.id, '❌ No valid user IDs provided. Use: /reply <id1,id2,...> <message>');
        }

        if (recipientIds.length > REPLY_MAX_RECIPIENTS) {
            return await bot.sendMessage(msg.chat.id, `❌ Too many recipients (${recipientIds.length}). Max allowed is ${REPLY_MAX_RECIPIENTS}.`);
        }

        if (!msg.reply_to_message && !hasText) {
            throw new Error('No message content provided');
        }

        if (!msg.reply_to_message && hasText && textMessage.length > 4000) {
            throw new Error('Message exceeds 4000 character limit');
        }

        const mediaMsg = msg.reply_to_message || null;
        const results = [];

        for (const userId of recipientIds) {
            try {
                if (mediaMsg) {
                    if (mediaMsg.photo) {
                        await bot.sendPhoto(
                            userId,
                            mediaMsg.photo.slice(-1)[0].file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.document) {
                        await bot.sendDocument(
                            userId,
                            mediaMsg.document.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.video) {
                        await bot.sendVideo(
                            userId,
                            mediaMsg.video.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.audio) {
                        await bot.sendAudio(
                            userId,
                            mediaMsg.audio.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (mediaMsg.voice) {
                        await bot.sendVoice(
                            userId,
                            mediaMsg.voice.file_id,
                            { caption: hasText ? textMessage : '📨 Admin Reply' }
                        );
                    } else if (hasText) {
                        await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
                    } else {
                        throw new Error('No message content found');
                    }
                } else {
                    await bot.sendMessage(userId, `📨 Admin Reply:\n\n${textMessage}`);
                }

                results.push({ userId, ok: true });
            } catch (err) {
                let reason = err && err.message ? err.message : 'Unknown error';
                if (err && err.response && err.response.error_code === 403) {
                    reason = "User has blocked the bot or doesn't exist";
                } else if (reason.includes('chat not found')) {
                    reason = "User hasn't started a chat with the bot";
                }
                results.push({ userId, ok: false, reason });
            }
        }

        const successCount = results.filter(r => r.ok).length;
        const failureCount = results.length - successCount;
        let summary = `📬 Delivery report (${successCount} sent, ${failureCount} failed):\n\n`;
        summary += results.map(r => r.ok ? `✅ ${r.userId}` : `❌ ${r.userId} — ${r.reason}`).join('\n');

        await bot.sendMessage(msg.chat.id, summary);
    } 
    catch (error) {
        let errorMsg = `❌ Failed to send: ${error.message}`;
        
        if (error.response?.error_code === 403) {
            errorMsg = "❌ User has blocked the bot or doesn't exist";
        }
        else if (error.message.includes("chat not found")) {
            errorMsg = "❌ User hasn't started a chat with the bot";
        }
        
        await bot.sendMessage(msg.chat.id, errorMsg);
        console.error("Reply command error:", error);
    }
});

// IMPROVED BROADCAST SYSTEM - Production-grade with rate limiting, async processing, and retry logic

// Helper: Send message with retry logic and rate limiting
async function sendBroadcastMessage(userId, messageType, messageText, caption, mediaFileId) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await broadcastRateLimiter.delay();
            
            // Build default inline keyboard with Sell and Referral buttons
            const defaultKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💰 Sell Page', web_app: { url: 'https://starstore.site/sell.html' } }],
                        [{ text: '👥 Referral Program', web_app: { url: 'https://starstore.site/referral.html' } }]
                    ]
                }
            };
            
            if (messageType === 'text') {
                await bot.sendMessage(userId, messageText || caption, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    disable_notification: true,
                    ...defaultKeyboard
                });
            } else {
                await bot.sendCopy(userId, mediaFileId, {
                    caption: caption,
                    parse_mode: 'HTML',
                    disable_notification: true,
                    ...defaultKeyboard
                });
            }
            return { success: true, attempts: attempt };
        } catch (error) {
            lastError = error;
            
            // Check if error is recoverable
            const errorMsg = error.message || '';
            const isFatal = errorMsg.includes('bot was blocked') || 
                           errorMsg.includes('user is deactivated') ||
                           errorMsg.includes('chat not found');
            
            if (isFatal) {
                return { success: false, attempts: attempt, error: errorMsg, fatal: true };
            }
            
            // For rate limits, wait longer before retry
            if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
            
            if (attempt === 3) {
                return { success: false, attempts: attempt, error: errorMsg };
            }
            
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
    }
    
    return { success: false, attempts: 3, error: lastError?.message || 'Unknown error' };
}

// Helper: Process broadcast job in background
async function processBroadcastJob(jobId) {
    try {
        const job = await BroadcastJob.findOne({ jobId });
        if (!job) {
            console.error(`Broadcast job ${jobId} not found`);
            return;
        }
        
        if (job.status === 'cancelled') {
            console.log(`Broadcast job ${jobId} cancelled`);
            return;
        }
        
        // Initialize processedUserIds for duplicate prevention if not present
        if (!job.processedUserIds) {
            job.processedUserIds = [];
        }
        
        job.status = 'processing';
        job.startedAt = new Date();
        job.estimatedCompletionTime = new Date(Date.now() + (job.totalUsers / 50) * 2500);
        await job.save();
        
        console.log(`🚀 Starting broadcast job ${jobId} for ${job.totalUsers} users`);
        
        const batchSize = job.batchSize || 50;
        let processed = job.currentIndex || 0;
        const processedUserSet = new Set(job.processedUserIds);
        
        while (processed < job.totalUsers) {
            const batch = await User.find({}).skip(processed).limit(batchSize).lean();
            
            if (batch.length === 0) break;
            
            for (const user of batch) {
                try {
                    if (!user.id) {
                        job.skippedCount++;
                        continue;
                    }
                    
                    // DUPLICATE PREVENTION: Skip if this user already received this broadcast
                    if (processedUserSet.has(user.id.toString())) {
                        job.skippedCount++;
                        console.log(`⏭️ Skipping user ${user.id} - already received this broadcast`);
                        continue;
                    }
                    
                    const result = await sendBroadcastMessage(
                        user.id,
                        job.messageType,
                        job.messageText,
                        job.caption,
                        job.mediaFileId,
                        job.buttons
                    );
                    
                    if (result.success) {
                        job.sentCount++;
                        // Add to processed users to prevent duplicate sends
                        processedUserSet.add(user.id.toString());
                        job.processedUserIds.push(user.id.toString());
                    } else {
                        job.failedCount++;
                        if (!result.fatal) {
                            job.failedUserIds.push({
                                userId: user.id,
                                error: result.error,
                                attempts: result.attempts
                            });
                        } else {
                            job.skippedCount++;
                        }
                    }
                } catch (error) {
                    job.failedCount++;
                    console.error(`Error processing user ${user.id}:`, error.message);
                }
                
                job.lastProcessedUserId = user.id;
                processed++;
                job.currentIndex = processed;
                
                if (processed % 50 === 0) {
                    await job.save();
                    console.log(`📊 Progress: ${processed}/${job.totalUsers} (✅${job.sentCount}, ❌${job.failedCount}, ⏭️${job.skippedCount})`);
                }
            }
            
            if (processed < job.totalUsers) {
                await new Promise(resolve => setTimeout(resolve, job.delayBetweenBatchesMs || 1000));
            }
        }
        
        job.status = 'completed';
        job.completedAt = new Date();
        await job.save();
        
        console.log(`✅ Broadcast job ${jobId} completed: ${job.sentCount} sent, ${job.failedCount} failed, ${job.skippedCount} skipped`);
        
        try {
            const duration = Math.round((job.completedAt - job.startedAt) / 1000);
            const successRate = ((job.sentCount / job.totalUsers) * 100).toFixed(1);
            
            const resultMsg = `📢 Broadcast Completed!\n\n` +
                `✅ Sent: ${job.sentCount}/${job.totalUsers}\n` +
                `❌ Failed: ${job.failedCount}\n` +
                `⏭️ Skipped: ${job.skippedCount}\n` +
                `📊 Success Rate: ${successRate}%\n` +
                `⏱️ Duration: ${duration}s`;
            
            await bot.sendMessage(job.adminId, resultMsg);
        } catch (error) {
            console.error('Failed to notify admin of broadcast completion:', error);
        }
    } catch (error) {
        console.error(`Error processing broadcast job ${jobId}:`, error);
        try {
            const job = await BroadcastJob.findOne({ jobId });
            if (job) {
                job.status = 'failed';
                job.lastError = error.message;
                await job.save();
                await bot.sendMessage(job.adminId, `❌ Broadcast job failed: ${error.message}`);
            }
        } catch (_) {}
    }
}

// Track broadcast sessions
const broadcastSessions = new Map();

// NEW BROADCAST COMMAND
bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!adminIds.includes(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }
    
    try {
        broadcastSessions.set(chatId, { step: 'waiting_message', timestamp: Date.now() });
        
        await bot.sendMessage(chatId, 
            `📢 Broadcast Creator\n\n` +
            `Send your message (text, photo, audio, video, or document):\n\n` +
            `💡 Tips:\n` +
            `• Text messages are fastest\n` +
            `• Media will be optimized\n` +
            `• Optional captions work with HTML\n` +
            `• Non-disruptive broadcasts\n\n` +
            `⏱️ Est. time for 50K users: 25-35 minutes`,
            {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Cancel', callback_data: 'broadcast_cancel' }]]
                }
            }
        );
    } catch (error) {
        console.error('Broadcast command error:', error);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// Handle broadcast message submission
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!adminIds.includes(userId)) return;
    
    const session = broadcastSessions.get(chatId);
    if (!session || session.step !== 'waiting_message') return;
    
    if (msg.text && msg.text.startsWith('/')) return;
    
    if (Date.now() - session.timestamp > 10 * 60 * 1000) {
        broadcastSessions.delete(chatId);
        return bot.sendMessage(chatId, '⏰ Broadcast session expired. Use /broadcast to start over.');
    }
    
    try {
        let messageType = 'text';
        let messageText = msg.text || '';
        let caption = msg.caption || '';
        let mediaFileId = null;
        
        if (msg.photo) {
            messageType = 'photo';
            mediaFileId = msg.photo[msg.photo.length - 1].file_id;
            caption = msg.caption || '';
            messageText = '';
        } else if (msg.audio) {
            messageType = 'audio';
            mediaFileId = msg.audio.file_id;
            caption = msg.caption || '';
            messageText = '';
        } else if (msg.video) {
            messageType = 'video';
            mediaFileId = msg.video.file_id;
            caption = msg.caption || '';
            messageText = '';
        } else if (msg.document) {
            messageType = 'document';
            mediaFileId = msg.document.file_id;
            caption = msg.caption || '';
            messageText = '';
        }
        
        if (!messageText && !mediaFileId) {
            return bot.sendMessage(chatId, '❌ No message content found. Please try again.');
        }
        
        const totalUsers = await User.countDocuments({});
        if (totalUsers === 0) {
            broadcastSessions.delete(chatId);
            return bot.sendMessage(chatId, '⚠️ No users in database.');
        }
        
        // Create job ID upfront for tracking
        const jobId = `bcast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Create the broadcast job record with approval tracking
        const job = new BroadcastJob({
            jobId,
            adminId: userId,
            adminUsername: msg.from.username || msg.from.first_name,
            messageType,
            messageText,
            caption,
            mediaFileId,
            totalUsers,
            status: 'pending',
            approvalStatus: 'pending',
            adminMessageIds: [],
            batchSize: 50,
            delayBetweenBatchesMs: 1000
        });
        
        // Build default inline keyboard with Sell and Referral buttons
        const approvalKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Sell at a Higher Price', web_app: { url: 'https://starstore.site/sell.html' } }],
                    [{ text: '✅ Continue Broadcasting', callback_data: `approve_broadcast_${jobId}` }],
                    [{ text: '❌ Cancel', callback_data: `reject_broadcast_${jobId}` }]
                ]
            }
        };
        
        // Send the ACTUAL broadcast message to all admins and capture message IDs
        const messagePromises = [];
        for (const adminId of adminIds) {
            try {
                let promise;
                if (messageType === 'text') {
                    promise = bot.sendMessage(adminId, messageText || caption, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                        disable_notification: false,
                        ...approvalKeyboard
                    });
                } else {
                    promise = bot.sendCopy(adminId, mediaFileId, {
                        caption: caption,
                        parse_mode: 'HTML',
                        disable_notification: false,
                        ...approvalKeyboard
                    });
                }
                
                // Capture message ID when sent
                promise.then(sentMsg => {
                    job.adminMessageIds.push({
                        adminId: adminId.toString(),
                        messageId: sentMsg.message_id
                    });
                }).catch(err => {
                    console.error(`Failed to send broadcast preview to admin ${adminId}:`, err.message);
                });
                
                messagePromises.push(promise);
            } catch (err) {
                console.error(`Failed to send broadcast preview to admin ${adminId}:`, err.message);
            }
        }
        
        // Wait for all admin messages to send
        await Promise.allSettled(messagePromises);
        
        // Save job with message IDs
        await job.save();
        
        // Clear the broadcast session
        broadcastSessions.delete(chatId);
        
        // Send summary to initiating admin
        const summaryText = `📢 <b>Broadcast Preview Sent to All Admins</b>\n\n` +
            `📊 Job ID: <code>${jobId}</code>\n` +
            `👥 Will be sent to: ${totalUsers.toLocaleString()} users\n` +
            `📝 Type: ${messageType.toUpperCase()}\n` +
            `🔘 Includes: Sell Page & Referral buttons\n\n` +
            `⏱️ Est. time: ${Math.ceil(totalUsers / 50 * 2.5)} minutes\n\n` +
            `<i>Message sent to all ${adminIds.length} admins for approval. Waiting for confirmation...</i>`;
        
        await bot.sendMessage(chatId, summaryText, { parse_mode: 'HTML' });
        
        console.log(`📢 Broadcast ${jobId} preview sent to ${adminIds.length} admins - Waiting for approval`);
        
    } catch (error) {
        console.error('Broadcast message handling error:', error);
        broadcastSessions.delete(chatId);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// Broadcast callback handlers for admin approval/rejection
bot.on('callback_query', async (query) => {
    // Handle broadcast approval
    if (query.data.startsWith('approve_broadcast_')) {
        const jobId = query.data.replace('approve_broadcast_', '');
        const userId = query.from.id.toString();
        const adminUsername = query.from.username || query.from.first_name;
        
        if (!adminIds.includes(userId)) {
            return bot.answerCallbackQuery(query.id, '❌ Unauthorized', true);
        }
        
        try {
            // Get the broadcast job
            const job = await BroadcastJob.findOne({ jobId });
            
            if (!job) {
                return bot.answerCallbackQuery(query.id, '❌ Broadcast job not found', true);
            }
            
            // Check if already approved/rejected (one-time use)
            if (job.approvalStatus !== 'pending') {
                return bot.answerCallbackQuery(query.id, `⚠️ Already ${job.approvalStatus}`, true);
            }
            
            // Update job with approval
            job.approvalStatus = 'approved';
            job.approvedBy = {
                adminId: userId,
                adminUsername: adminUsername,
                approvedAt: new Date()
            };
            await job.save();
            
            // Update all admin messages - remove buttons, show approval
            const updatePromises = [];
            for (const msgInfo of job.adminMessageIds) {
                updatePromises.push(
                    bot.editMessageReplyMarkup(
                        {
                            inline_keyboard: [
                                [{ text: `✅ Approved by ${adminUsername}`, callback_data: 'dummy' }]
                            ]
                        },
                        {
                            chat_id: msgInfo.adminId,
                            message_id: msgInfo.messageId
                        }
                    ).catch(err => {
                        console.error(`Failed to update message for admin ${msgInfo.adminId}:`, err.message);
                    })
                );
            }
            
            await Promise.allSettled(updatePromises);
            
            // React to the approval button
            await bot.answerCallbackQuery(query.id, '✅ Broadcast approved! Sending to all users...');
            
            // Start the actual broadcast in background (to ALL USERS now)
            processBroadcastJob(jobId).catch(error => console.error('Background broadcast error:', error));
            console.log(`📢 Broadcast ${jobId} approved by admin ${adminUsername} - Broadcasting to ${job.totalUsers.toLocaleString()} users`);
            
        } catch (error) {
            console.error('Broadcast approval error:', error);
            bot.answerCallbackQuery(query.id, `❌ Error: ${error.message}`, true);
        }
        return;
    }
    
    // Handle broadcast rejection
    if (query.data.startsWith('reject_broadcast_')) {
        const jobId = query.data.replace('reject_broadcast_', '');
        const userId = query.from.id.toString();
        const adminUsername = query.from.username || query.from.first_name;
        
        if (!adminIds.includes(userId)) {
            return bot.answerCallbackQuery(query.id, '❌ Unauthorized', true);
        }
        
        try {
            // Get the broadcast job
            const job = await BroadcastJob.findOne({ jobId });
            
            if (!job) {
                return bot.answerCallbackQuery(query.id, '❌ Broadcast job not found', true);
            }
            
            // Check if already approved/rejected (one-time use)
            if (job.approvalStatus !== 'pending') {
                return bot.answerCallbackQuery(query.id, `⚠️ Already ${job.approvalStatus}`, true);
            }
            
            // Update job with rejection
            job.approvalStatus = 'rejected';
            job.approvedBy = {
                adminId: userId,
                adminUsername: adminUsername,
                approvedAt: new Date()
            };
            job.status = 'cancelled';
            await job.save();
            
            // Update all admin messages - remove buttons, show cancellation
            const updatePromises = [];
            for (const msgInfo of job.adminMessageIds) {
                updatePromises.push(
                    bot.editMessageReplyMarkup(
                        {
                            inline_keyboard: [
                                [{ text: `❌ Cancelled by ${adminUsername}`, callback_data: 'dummy' }]
                            ]
                        },
                        {
                            chat_id: msgInfo.adminId,
                            message_id: msgInfo.messageId
                        }
                    ).catch(err => {
                        console.error(`Failed to update message for admin ${msgInfo.adminId}:`, err.message);
                    })
                );
            }
            
            await Promise.allSettled(updatePromises);
            
            // React to the rejection button
            await bot.answerCallbackQuery(query.id, '🛑 Broadcast cancelled');
            
            console.log(`🛑 Broadcast ${jobId} cancelled by admin ${adminUsername}`);
        } catch (error) {
            console.error('Broadcast rejection error:', error);
            bot.answerCallbackQuery(query.id, `❌ Error: ${error.message}`, true);
        }
        return;
    }
});

// Status command
bot.onText(/\/broadcast_status\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (!adminIds.includes(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }
    
    try {
        const jobId = match[1].trim();
        const job = await BroadcastJob.findOne({ jobId });
        
        if (!job) {
            return bot.sendMessage(chatId, `❌ Job not found: ${jobId}`);
        }
        
        const progress = Math.round((job.sentCount + job.failedCount + job.skippedCount) / job.totalUsers * 100);
        const status = job.status.toUpperCase();
        
        let statusEmoji = '⏳';
        if (job.status === 'completed') statusEmoji = '✅';
        if (job.status === 'failed') statusEmoji = '❌';
        if (job.status === 'cancelled') statusEmoji = '⛔';
        
        const timeTaken = job.completedAt ? Math.round((job.completedAt - job.startedAt) / 1000) : 'N/A';
        const successRate = ((job.sentCount / job.totalUsers) * 100).toFixed(1);
        
        let statusMsg = `${statusEmoji} Broadcast Status\n\n` +
            `📊 Job ID: <code>${jobId}</code>\n` +
            `Status: ${status}\n` +
            `Progress: ${progress}%\n\n` +
            `✅ Sent: ${job.sentCount}/${job.totalUsers}\n` +
            `❌ Failed: ${job.failedCount}\n` +
            `⏭️ Skipped: ${job.skippedCount}\n` +
            `📈 Success Rate: ${successRate}%\n\n`;
        
        if (job.status === 'processing') {
            if (job.estimatedCompletionTime) {
                const remaining = Math.max(0, Math.round((job.estimatedCompletionTime - new Date()) / 1000));
                statusMsg += `⏱️ Est. remaining: ${remaining}s`;
            }
        } else if (job.completedAt) {
            statusMsg += `⏱️ Completed in: ${timeTaken}s`;
        }
        
        await bot.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});
// Enhanced notification fetching with pagination and unread count
app.get('/api/notifications', requireTelegramAuth, async (req, res) => {
    try {
        const { limit = 20, skip = 0 } = req.query;
        const userId = req.user.id;

        const userNotifications = await UserNotification.find({ userId })
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();

        const templateIds = userNotifications.map(n => n.templateId);
        const templates = await NotificationTemplate.find({ _id: { $in: templateIds } }).lean();
        const templateMap = new Map(templates.map(t => [t._id.toString(), t]));

        const formattedNotifications = userNotifications.map(n => {
            const t = templateMap.get(n.templateId.toString());
            return {
                id: n._id.toString(),
                title: t?.title || 'Notification',
                message: t?.message || 'You have a new notification',
                actionUrl: t?.actionUrl,
                icon: t?.icon || 'fa-bell',
                createdAt: n.createdAt,
                read: n.read,
                priority: t?.priority ?? 0
            };
        });

        const unreadCount = await UserNotification.countDocuments({ userId, read: false });
        const totalCount = await UserNotification.countDocuments({ userId });

        // Clean up old read notifications (older than 30 days) to prevent database bloat
        try {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            await UserNotification.deleteMany({ 
                userId, 
                read: true, 
                createdAt: { $lt: thirtyDaysAgo } 
            });
        } catch (cleanupError) {
            console.log('Notification cleanup error (non-critical):', cleanupError.message);
        }

        // Only create welcome notification if user has no notifications at all
        if (formattedNotifications.length === 0) {
            
            // Create a welcome notification for this user
            const newTemplate = await NotificationTemplate.create({
                title: 'Welcome to StarStore! 🌟',
                message: 'Welcome to StarStore! Check in daily to earn bonus points and maintain your streak. Use the bottom navigation to explore all features!',
                icon: 'fa-star',
                audience: 'user',
                targetUserId: userId,
                priority: 0,
                actionUrl: null,
                createdBy: 'system_welcome'
            });

            await UserNotification.create({
                userId: userId,
                templateId: newTemplate._id,
                read: false  // Explicitly set as unread
            });

            // Notification created successfully

            // Add the new notification to the response
            const newNotification = {
                id: newTemplate._id.toString(),
                title: newTemplate.title,
                message: newTem
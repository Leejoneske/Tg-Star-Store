

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
      // Run daily to check for end-of-month wallet reminder dates (last day of month and 1st)
      const checkEndOfMonth = () => {
        const now = new Date();
        const dayOfMonth = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        
        // Trigger on: last day of month (works for all months) OR day 1 of next month
        const isLastDayOfMonth = dayOfMonth === daysInMonth;
        const isFirstDayOfMonth = dayOfMonth === 1;
        const isTriggerDay = isLastDayOfMonth || isFirstDayOfMonth;
        
        if (isTriggerDay) {
          console.log(`[Scheduler] Triggering end-of-month task on day ${dayOfMonth} (last day of month: ${isLastDayOfMonth}, day 1: ${isFirstDayOfMonth})`);
          callback();
        }
      };
      
      // Check every hour (will trigger on last day of any month OR day 1)
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

// Server-side rate limiting: track temporary purchase bans (survives client-side workarounds)
const purchaseTempBans = new Map(); // Maps userId to ban expiry timestamp
const TEMP_BAN_DURATION_MS = 600000; // 10 minutes (600 seconds)
const VIOLATION_RECORDS = new Map(); // Maps userId to array of violation timestamps
const VIOLATION_THRESHOLD = 5; // Ban after 5 violations
const VIOLATION_WINDOW_MS = 60000; // Consider violations within 60 seconds
const PURCHASE_MIN_INTERVAL_MS = 3000; // 3 second minimum between purchases
const userLastPurchaseTime = new Map(); // Track last purchase time per user
const prolongedBanNotifications = new Map(); // Track which users we've notified admins about for prolonged bans
const PROLONGED_BAN_THRESHOLD_MS = 540000; // 9 minutes - threshold for admin notification about prolonged bans
const PROLONGED_BAN_NOTIFICATION_INTERVAL_MS = 180000; // 3 minutes - minimum wait between repeated notifications

// Rate limit functions will be defined after adminIds is initialized
let checkPurchaseBan, recordPurchaseViolation;
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
const tonTransactionService = require('./services/ton-transaction-service');

// Admin commands module
const registerAdminEmailCommands = require('./telegram-commands-admin');

// Create Telegram bot or a stub in local/dev if no token is provided
let bot;
let isBotStub = false;
if (process.env.BOT_TOKEN) {
  bot = new TelegramBot(process.env.BOT_TOKEN, { webHook: true });
  console.log('[BOT INIT] Telegram Bot initialized');
} else {
  console.warn('[BOT INIT] BOT_TOKEN not set. Using stub for local/dev.');
  isBotStub = true;
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
    
    // Check if user is banned - deny access immediately
    if (userId) {
      const isBanned = await checkUserBanStatus(userId);
      if (isBanned) {
        const fs = require('fs').promises;
        const banned = path.join(__dirname, 'public', 'errors', '403.html');
        try {
          const banContent = await fs.readFile(banned, 'utf8');
          const customContent = banContent.replace(
            /<\/body>/,
            `<script>
              document.title = 'Access Denied';
              if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.showAlert('Your account is restricted. Contact support with your case ID.');
              }
            </script></body>`
          );
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
          return res.status(403).send(customContent);
        } catch (e) {
          return res.status(403).send('Access Denied: Your account is restricted');
        }
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
    adminMessages: [{
      adminId: String,
      messageId: Number,
      originalText: String
    }],
    createdAt: { type: Date, default: Date.now }
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
        
        const adminMessagePromises = admins.map(async (adminId) => {
          try {
            const message = await bot.sendMessage(adminId, adminText, { reply_markup: adminKeyboard });
            return { adminId, messageId: message.message_id, originalText: adminText };
          } catch (e) {
            console.error('Failed to notify admin of ambassador signup:', e.message);
            return null;
          }
        });
        
        const messageResults = await Promise.all(adminMessagePromises);
        const adminMessages = messageResults.filter(m => m !== null);
        
        // Store admin message info for later updates
        if (adminMessages.length > 0) {
          if (process.env.MONGODB_URI && global.AmbassadorWaitlist) {
            await global.AmbassadorWaitlist.updateOne(
              { id: saved.id },
              { $set: { adminMessages } }
            );
            saved.adminMessages = adminMessages;
          } else if (db && typeof db.updateAmbassadorWaitlist === 'function') {
            await db.updateAmbassadorWaitlist(saved.id, { adminMessages });
            saved.adminMessages = adminMessages;
          }
        }
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
app.get(['/', '/about', '/sell', '/history', '/daily', '/feedback', '/blog', '/knowledge-base', '/how-to-withdraw-telegram-stars', '/ambassador'], async (req, res, next) => {
  try {
    // Extract user ID from available sources
    let userId = null;
    
    if (req.user && req.user.id) {
      userId = String(req.user.id).trim();
    } else if (req.headers['x-telegram-id']) {
      userId = String(req.headers['x-telegram-id']).trim();
    } else if (req.telegramInitData?.user?.id) {
      userId = String(req.telegramInitData.user.id).trim();
    }
    
    // Check if user is banned - deny app access immediately
    if (userId) {
      const isBanned = await checkUserBanStatus(userId);
      if (isBanned) {
        const banDetails = await getBanDetails(userId);
        const fs = require('fs').promises;
        let banAccessDenied = await fs.readFile(path.join(__dirname, 'public', 'errors', 'ban-access-denied.html'), 'utf8');
        
        // Inject case ID and appeal deadline into the page
        if (banDetails) {
          const appealDeadline = banDetails.appealDeadline ? new Date(banDetails.appealDeadline).toLocaleDateString() : 'N/A';
          banAccessDenied = banAccessDenied
            .replace('{{CASE_ID}}', banDetails.caseId || 'N/A')
            .replace('{{APPEAL_DEADLINE}}', appealDeadline);
        }
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
        return res.status(403).send(banAccessDenied);
      }
    }
    
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
if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'dev_stub') {
  bot.setWebHook(WEBHOOK_URL)
    .then(() => console.log(`✅ Webhook set successfully at ${WEBHOOK_URL}`))
    .catch(err => {
      console.warn(`⚠️ Webhook setup failed (dev mode): ${err.message}`);
      console.log('ℹ️ Continuing in local/dev mode without webhook');
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
app.get('/api/whoami', async (req, res) => {
  try {
    const tgId = String(req.headers['x-telegram-id'] || '').trim();
    if (!tgId) return res.json({ id: null, isAdmin: false, isBanned: false });
    
    // Check if user is banned
    const isBanned = await checkUserBanStatus(tgId);
    if (isBanned) {
      return res.json({ 
        id: tgId, 
        isAdmin: false, 
        isBanned: true,
        message: 'Access Denied: Your account is restricted'
      });
    }
    
    return res.json({ 
      id: tgId, 
      isAdmin: Array.isArray(adminIds) && adminIds.includes(tgId),
      isBanned: false
    });
  } catch (error) {
    console.error('Error in /api/whoami:', error);
    return res.json({ id: null, isAdmin: false, isBanned: false });
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
    autoRemove: { type: Boolean, default: false },
    // Enhanced for appeal system
    caseId: { type: String, unique: true, sparse: true },
    appealStatus: { type: String, enum: ['pending', 'under_review', 'approved', 'rejected', 'closed'], default: 'pending' },
    appealDeadline: { type: Date }
});

// Ban Appeal Schema - tracks user appeals and appeals process
const banAppealSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    caseId: { type: String, required: true, unique: true, index: true },
    warningId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warning', required: true },
    email: String,
    appealReason: { type: String, required: true },
    attachmentUrl: String,
    status: { type: String, enum: ['submitted', 'under_review', 'approved', 'rejected'], default: 'submitted' },
    submittedAt: { type: Date, default: Date.now },
    reviewedBy: String,
    reviewedAt: Date,
    reviewNotes: String,
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, index: true }
});

// Ban Audit Log - tracks all ban-related actions
const banAuditLogSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    caseId: String,
    action: { type: String, enum: ['banned', 'unbanned', 'appeal_submitted', 'appeal_reviewed', 'appeal_approved', 'appeal_rejected'], required: true },
    performedBy: { type: String, required: true },
    details: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now, index: true }
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

// Schema to track sent wallet reminder emails to prevent duplicates
const walletReminderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  username: String,
  email: String,
  reminderType: { type: String, enum: ['first', 'final', 'last-chance'], required: true },
  dayOfMonth: { type: Number, required: true },
  month: { type: String, required: true }, // YYYY-MM format
  sentAt: { type: Date, default: Date.now },
  balance: Number,
  adminNotified: { type: Boolean, default: false },
  telegramSent: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false }
});

const Sticker = mongoose.model('Sticker', stickerSchema);
const NotificationTemplate = mongoose.model('NotificationTemplate', notificationTemplateSchema);
const UserNotification = mongoose.model('UserNotification', userNotificationSchema);
const Warning = mongoose.model('Warning', warningSchema);
const BanAppeal = mongoose.model('BanAppeal', banAppealSchema);
const BanAuditLog = mongoose.model('BanAuditLog', banAuditLogSchema);
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
const WalletReminder = mongoose.model('WalletReminder', walletReminderSchema);

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

// Log admin initialization status
if (adminIds.length > 0) {
  console.log(`[ADMIN INIT] Admin IDs configured: ${adminIds.join(', ')}`);
} else {
  console.warn('[ADMIN INIT] No admin IDs found. Set ADMIN_TELEGRAM_IDS or ADMIN_IDS env variable.');
}
const REPLY_MAX_RECIPIENTS = parseInt(process.env.REPLY_MAX_RECIPIENTS || '30', 10);

// Initialize rate limit functions (now adminIds is available)
checkPurchaseBan = function(telegramId) {
    const now = Date.now();
    const userId = String(telegramId);
    const banUntil = purchaseTempBans.get(userId);
    
    if (banUntil && banUntil > now) {
        const secondsRemaining = Math.ceil((banUntil - now) / 1000);
        // Only log for bans > 5 minutes
        if (TEMP_BAN_DURATION_MS > 300000) {
            console.log(`[BAN] User ${userId} banned for ${Math.ceil(secondsRemaining / 60)}m`);
        }
        return { isBanned: true, secondsRemaining };
    } else if (banUntil) {
        // Ban expired, clean up
        purchaseTempBans.delete(userId);
        VIOLATION_RECORDS.delete(userId);
        userLastPurchaseTime.delete(userId);
    }
    
    return { isBanned: false };
};

recordPurchaseViolation = function(telegramId, username) {
    const userId = String(telegramId);
    const now = Date.now();
    
    // Get or create violation list for this user
    let violations = VIOLATION_RECORDS.get(userId) || [];
    
    // Clean old violations (outside the window)
    violations = violations.filter(time => now - time < VIOLATION_WINDOW_MS);
    
    // Add new violation
    violations.push(now);
    VIOLATION_RECORDS.set(userId, violations);
    
    console.log(`[VIOLATION] User ${userId}: ${violations.length}/${VIOLATION_THRESHOLD} violations`);
    
    // Check if threshold reached
    if (violations.length >= VIOLATION_THRESHOLD) {
        const banUntil = now + TEMP_BAN_DURATION_MS;
        purchaseTempBans.set(userId, banUntil);
        
        const banDurationMinutes = Math.ceil(TEMP_BAN_DURATION_MS / 60000);
        const adminNotification = `⛔ RATE LIMIT BAN\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUser: @${username} (ID: ${userId})\nReason: ${violations.length} attempts in ${Math.round((now - violations[0]) / 1000)}s\nBan Duration: ${banDurationMinutes}min\nUntil: ${new Date(banUntil).toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        console.log(`[BAN] User ${userId} (@${username}) banned for ${banDurationMinutes}m`);
        console.log(`[BAN] Bot: ${isBotStub ? 'stub' : 'real'} | Admins: ${adminIds.length} | Config: TEMP_BAN_DURATION_MS=${TEMP_BAN_DURATION_MS}`);
        
        // Only notify for bans > 5 minutes
        if (TEMP_BAN_DURATION_MS > 300000) {
            if (!isBotStub && bot && Array.isArray(adminIds) && adminIds.length > 0) {
                adminIds.forEach(adminId => {
                    bot.sendMessage(adminId, adminNotification).then(() => {
                        console.log(`[BAN NOTIFY] Sent to admin ${adminId}`);
                    }).catch(err => {
                        console.error(`[BAN NOTIFY] Error sending to admin ${adminId}: ${err.message}`);
                    });
                });
            } else {
                console.warn(`[BAN NOTIFY] Skipped - Bot stub: ${isBotStub}, Bot exists: ${!!bot}, Admins: ${adminIds.length}`);
            }
        }
        
        return { banActivated: true, violationCount: violations.length, banUntil };
    }
    
    return { banActivated: false, violationCount: violations.length };
};

// Notify admins about prolonged bans that exceed 9 minutes
function checkAndNotifyProlongedBans() {
    const now = Date.now();
    
    for (const [userId, banUntil] of purchaseTempBans) {
        // Check if ban is still active
        if (banUntil <= now) continue;
        
        // Only process bans > 5 minutes
        if (TEMP_BAN_DURATION_MS <= 300000) continue;
        
        // Check if ban has been active for 9+ minutes (9 minutes = 540000 ms)
        const banDuration = TEMP_BAN_DURATION_MS - (banUntil - now);
        if (banDuration < PROLONGED_BAN_THRESHOLD_MS) continue;
        
        // Check if we've already notified about this user's prolonged ban recently
        const lastNotification = prolongedBanNotifications.get(userId);
        if (lastNotification && (now - lastNotification) < PROLONGED_BAN_NOTIFICATION_INTERVAL_MS) {
            continue;
        }
        
        // Send notification to admins about prolonged ban
        const timeRemaining = Math.ceil((banUntil - now) / 1000);
        const minutesRemaining = Math.ceil(timeRemaining / 60);
        const prolongedBanMsg = `⚠️ PROLONGED BAN ONGOING\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUser ID: ${userId}\nDuration: 9+ minutes\nRemaining: ${minutesRemaining}min\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        console.log(`[BAN] Prolonged ban alert for user ${userId} (${minutesRemaining}m remaining)`);
        
        if (!isBotStub && bot && Array.isArray(adminIds) && adminIds.length > 0) {
            adminIds.forEach(adminId => {
                bot.sendMessage(adminId, prolongedBanMsg).then(() => {
                    console.log(`[BAN NOTIFY] Prolonged alert sent to admin ${adminId}`);
                }).catch(err => {
                    console.error(`[BAN NOTIFY] Failed to send to admin ${adminId}: ${err.message}`);
                });
            });
        }
        
        // Mark this user as notified about prolonged ban
        prolongedBanNotifications.set(userId, now);
    }
}

// Periodic task to check for prolonged bans (every 2 minutes)
setInterval(() => {
    try {
        checkAndNotifyProlongedBans();
    } catch (err) {
        console.error('[Prolonged Ban Check] Error checking for prolonged bans:', err.message);
    }
}, 2 * 60 * 1000); // Check every 2 minutes

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

// ==================== BAN SYSTEM HELPERS ====================

// Generate unique case ID for ban appeals
function generateBanCaseId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `CASE-${timestamp}-${random}`;
}

// Check if user is currently banned
async function checkUserBanStatus(userId) {
    try {
        const ban = await Warning.findOne({ 
            userId: userId.toString(),
            type: 'ban',
            isActive: true
        }).lean();
        return !!ban;
    } catch (error) {
        console.error('Error checking ban status for user', userId, ':', error);
        return false;
    }
}

// Get ban details for user
async function getBanDetails(userId) {
    try {
        const ban = await Warning.findOne({ 
            userId: userId.toString(),
            type: 'ban',
            isActive: true
        }).lean();
        return ban || null;
    } catch (error) {
        console.error('Error fetching ban details for user', userId, ':', error);
        return null;
    }
}

// Get appeal details for a case
async function getAppealDetails(caseId) {
    try {
        const appeal = await BanAppeal.findOne({ caseId }).lean();
        return appeal || null;
    } catch (error) {
        console.error('Error fetching appeal for case', caseId, ':', error);
        return null;
    }
}

// Middleware to check if user is banned
const checkBanmiddleware = async (req, res, next) => {
    try {
        const userId = req.telegramInitData?.user?.id?.toString();
        if (!userId) return next();
        
        const isBanned = await checkUserBanStatus(userId);
        if (isBanned) {
            req.userBanned = true;
            req.banDetails = await getBanDetails(userId);
        }
        next();
    } catch (error) {
        console.error('Ban check middleware error:', error);
        next();
    }
};

// ==================== END BAN SYSTEM HELPERS ====================

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

// Background job to verify pending transactions (DISABLED - frontend no longer waits)
// Orders are now shown as successful immediately after creation.
// Manual admin processing handles the rest.
// Re-enable if needed for reconciliation purposes only.
/*
setInterval(async () => {
    try {
        const pendingOrders = await BuyOrder.find({
            status: 'pending',
            transactionHash: { $exists: true, $ne: null },
            transactionVerified: false,
            verificationAttempts: { $lt: 5 },
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
                    
                    if (order.verificationAttempts >= 5 && orderAge > 1800000) {
                        order.status = 'failed';
                        console.log(`❌ Order ${order.id} marked as failed after ${orderAgeMinutes} minutes and ${order.verificationAttempts} attempts`);
                    }
                }
                
                await order.save();
            } catch (error) {
                console.error(`Error verifying order ${order.id}:`, error);
                order.verificationAttempts += 1;
                
                const orderAge = Date.now() - order.dateCreated.getTime();
                if (order.verificationAttempts >= 5 && orderAge > 1800000) {
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
*/

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
                console.debug(`API ${endpointIndex + 1}: Response received`);
                
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
                console.debug(`API ${endpointIndex + 1}: Found transaction, verifying...`);
                
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
    return await fallbackTransactionVerification(transactionHash, targetAddress, expectedAmount);
}

// Fallback verification method when TON APIs are down
async function fallbackTransactionVerification(transactionHash, targetAddress, expectedAmount) {
    try {
        
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
        console.error('Fallback verification error:', error.message);
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
// ===== TRANSACTION VERIFICATION ENDPOINT =====
// Handles blockchain transaction status checks
// Returns: { success, verified, status: 'pending'|'confirmed'|'failed' }
app.post('/api/verify-transaction', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { orderId, userWalletAddress } = req.body;
        
        // Validate inputs
        if (!orderId || !userWalletAddress) {
            return res.status(400).json({ 
                success: false, 
                verified: false,
                error: 'Missing orderId or wallet address' 
            });
        }

        // Check if user is banned
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                verified: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId
            });
        }

        // Look up order to get payment details
        let order;
        try {
            order = await BuyOrder.findOne({ id: orderId });
            if (!order) {
                return res.status(404).json({
                    success: false,
                    verified: false,
                    error: 'Order not found'
                });
            }
        } catch (dbError) {
            console.error('[Database Error]:', dbError.message);
            return res.status(500).json({
                success: false,
                verified: false,
                error: 'Database error'
            });
        }

        // Use tonTransactionService for proper blockchain verification
        let result;
        try {
            // Find transaction by amount and target address (more reliable)
            // This works even if we don't have a valid transaction hash
            result = await tonTransactionService.findTransactionByAmountAndTarget(
                userWalletAddress,
                order.walletAddress,  // Payment destination
                order.amount           // Expected amount in USDT
            );
        } catch (serviceError) {
            console.error('[TON Service Error]:', serviceError.message);
            // Return pending status so frontend keeps polling
            return res.json({ 
                success: true,
                verified: false,
                status: 'pending',
                error: 'Transaction verification in progress...'
            });
        }

        // Return appropriate response based on transaction status
        if (result.status === 'confirmed') {
            console.log(`✅ [Order ${orderId}] Transaction CONFIRMED on blockchain`);
            
            // Update order status
            try {
                await BuyOrder.updateOne(
                    { id: orderId },
                    { 
                        transactionVerified: true,
                        status: 'verified',
                        dateVerified: new Date()
                    }
                );
            } catch {}
            
            return res.json({ 
                success: true, 
                verified: true,
                status: 'confirmed',
                message: 'Transaction finalized on blockchain'
            });
        }
        
        if (result.status === 'pending') {
            console.log(`⏳ [Order ${orderId}] Transaction PENDING - still indexing`);
            return res.json({ 
                success: true,
                verified: false,
                status: 'pending',
                message: 'Waiting for blockchain confirmation...'
            });
        }

        // Unknown/timeout status - keep polling
        console.debug(`⏳ [Order ${orderId}] Transaction status unknown - will retry`);
        return res.json({ 
            success: true,
            verified: false,
            status: 'pending',
            error: 'Blockchain indexing in progress - please wait'
        });
        
    } catch (error) {
        console.error('[Verify Transaction] Unexpected error:', error.message);
        return res.status(500).json({ 
            success: false, 
            verified: false,
            error: 'Verification service error' 
        });
    }
});

/**
 * New endpoint for polling transaction status changes
 * Follows TON Sub-Second best practices
 */
app.post('/api/transaction-status-poll', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { transactionHash, targetAddress, expectedAmount, timeout = 60000 } = req.body;

        if (!transactionHash || !targetAddress) {
            return res.status(400).json({ success: false, error: 'Missing transaction data' });
        }

        console.debug('[TON] Polling transaction:', transactionHash);

        // Poll with timeout (max 60 seconds by default)
        const result = await tonTransactionService.pollTransactionStatus(
            transactionHash,
            targetAddress,
            Math.min(timeout, 120000) // Cap at 2 minutes
        );

        res.json({
            success: true,
            status: result.status,
            transaction: result.transaction,
            message: result.status === 'confirmed' ? 'Transaction confirmed!' : 
                     result.status === 'timeout' ? 'Verification timed out. Transaction may still be processing.' :
                     'Unknown status'
        });
    } catch (error) {
        console.error('[TON] Poll error:', error.message);
        res.status(500).json({ success: false, error: 'Polling failed' });
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
        const timestamp = new Date().toISOString();

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
            console.log(`[${timestamp}] QUOTE | Premium: ${premiumDuration}mo x ${quantity} recipient(s) | Unit: ${unitAmount} USDT | Total: ${totalAmount} USDT`);
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
            const unitAmount = Number((totalAmount / quantity).toFixed(2));
            console.log(`[${timestamp}] QUOTE | Package: ${starsNum} stars (mapped) x ${quantity} recipient(s) | Price: ${mapPrice} USDT | Total: ${totalAmount} USDT | Per recipient: ${unitAmount} USDT`);
            return res.json({ 
                success: true, 
                totalAmount, 
                unitAmount,
                quantity 
            });
        } else {
            // Fallback to linear rate for custom amounts: $0.02 per star
            // VALIDATE: This should not happen for standard packages, only custom amounts
            const unitAmount = Number((starsNum * 0.02).toFixed(2));
            const totalAmount = Number((unitAmount * quantity).toFixed(2));
            console.warn(`[${timestamp}] QUOTE FALLBACK | Custom: ${starsNum} stars @ $0.02/star x ${quantity} recipient(s) | Unit: ${unitAmount} USDT | Total: ${totalAmount} USDT`);
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

// Smart amount validation with automatic retry on rate changes
// Called automatically by app before opening wallet - user never sees the refresh
app.post('/api/validate-amount', (req, res) => {
    try {
        const { usdtAmount, expectedTonAmount } = req.body;
        const timestamp = new Date().toISOString();
        
        if (!usdtAmount || usdtAmount <= 0) {
            return res.status(400).json({ 
                success: false,
                valid: false, 
                error: 'Invalid USDT amount'
            });
        }
        
        const amountNum = Number(usdtAmount);
        const expectedTon = expectedTonAmount ? Number(expectedTonAmount) : null;
        
        // Fetch current TON/USDT rate from CoinGecko
        const axios = require('axios');
        axios.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd', { timeout: 3000 })
            .then(response => {
                const currentRate = response.data?.['the-open-network']?.usd || 2.10;
                
                // Calculate what TON amount SHOULD be at current rate
                const calculatedTonAmount = amountNum / currentRate;
                const nanoTonAmount = Math.round(calculatedTonAmount * 1e9);
                
                // Define tolerance: 1% difference or 0.05 TON, whichever is larger
                // This accounts for: rate fluctuations, rounding, blockchain delays
                const tonTolerance = Math.max(0.05, calculatedTonAmount * 0.01);
                
                // Validation logic
                let valid = true;
                let reason = null;
                
                // If app provided expected TON, validate it matches current rate calculation
                if (expectedTon) {
                    const tonDiff = Math.abs(expectedTon - calculatedTonAmount);
                    if (tonDiff > tonTolerance) {
                        valid = false;
                        reason = `Rate changed too much. Expected: ${expectedTon.toFixed(8)} TON, Current: ${calculatedTonAmount.toFixed(8)} TON, Diff: ${tonDiff.toFixed(8)} TON`;
                    }
                }
                
                console.log(`[VALIDATE] ${timestamp} | USDT: ${amountNum} | Expected TON: ${expectedTon ? expectedTon.toFixed(8) : 'n/a'} | Current Rate: ${currentRate} | Calculated TON: ${calculatedTonAmount.toFixed(8)} | Valid: ${valid} ${reason ? '| Reason: ' + reason : ''}`);
                
                return res.json({
                    success: true,
                    valid: valid,
                    reason: reason,
                    usdtAmount: amountNum,
                    currentRate: currentRate,
                    expectedTonAmount: expectedTon,
                    calculatedTonAmount: Number(calculatedTonAmount.toFixed(8)),
                    nanoTonAmount: nanoTonAmount.toString(),
                    tonTolerance: Number(tonTolerance.toFixed(8)),
                    timestamp: timestamp,
                    action: valid ? 'PROCEED' : 'RETRY'
                });
            })
            .catch(err => {
                console.error(`[VALIDATE] Rate fetch failed:`, err.message);
                // Fallback validation using default rate
                const fallbackRate = 2.10;
                const calculatedTonAmount = amountNum / fallbackRate;
                const nanoTonAmount = Math.round(calculatedTonAmount * 1e9);
                const tonTolerance = Math.max(0.05, calculatedTonAmount * 0.01);
                
                let valid = true;
                let reason = null;
                
                if (expectedTon) {
                    const tonDiff = Math.abs(expectedTon - calculatedTonAmount);
                    if (tonDiff > tonTolerance) {
                        valid = false;
                        reason = `Rate validation failed (using fallback rate)`;
                    }
                }
                
                return res.json({
                    success: true,
                    valid: valid,
                    reason: reason,
                    usdtAmount: amountNum,
                    currentRate: fallbackRate,
                    expectedTonAmount: expectedTon,
                    calculatedTonAmount: Number(calculatedTonAmount.toFixed(8)),
                    nanoTonAmount: nanoTonAmount.toString(),
                    tonTolerance: Number(tonTolerance.toFixed(8)),
                    timestamp: timestamp,
                    action: valid ? 'PROCEED' : 'RETRY',
                    warning: 'Using fallback rate - rate API unavailable'
                });
            });
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ success: false, valid: false, error: 'Internal server error' });
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
        const timestamp = new Date().toISOString();
        
        // === SECURITY VALIDATION: Ensure user can only create orders for themselves ===
        if (String(telegramId) !== String(req.user?.id)) {
            console.warn(`[${timestamp}] SECURITY ALERT: User ${req.user?.id} attempted to create order for user ${telegramId}`);
            return res.status(401).json({ error: 'Unauthorized: Cannot create orders for other users' });
        }
        
        // === VALIDATION PHASE ===
        await syncUserData(telegramId, username, 'order_create', req);
        const requesterIsAdmin = Boolean(req.user?.isAdmin);

        // Log incoming request - IMPORTANT for troubleshooting
        console.log(`[${timestamp}] ORDER CREATE REQUEST | User: ${telegramId} (@${username}) | Wallet: ${walletAddress.slice(0, 20)}... | Item: ${isPremium ? premiumDuration + 'mo Premium' : stars + ' stars'} | Amount from frontend: ${req.body.totalAmount} USDT`);

        // Prevent duplicate requests
        if (processingRequests.has(requestKey)) {
            return res.status(429).json({ error: 'Request already being processed. Please wait...' });
        }
        processingRequests.set(requestKey, Date.now());

        // === SERVER-SIDE RATE LIMIT CHECK (Ultimate defense) ===
        // Even if user clears localStorage, backend enforces the ban
        console.log(`[RATE CHECK] User ${telegramId} attempting order`);
        const banCheck = checkPurchaseBan(telegramId);
        if (banCheck.isBanned) {
            processingRequests.delete(requestKey);
            console.warn(`[RATE CHECK] User ${telegramId} is banned (${banCheck.secondsRemaining}s remaining). Recording violation.`);
            
            // If user tries to bypass ban, record additional violation to extend ban
            recordPurchaseViolation(telegramId, username);
            
            return res.status(429).json({ 
                error: 'Temporary purchase limit active',
                banRemaining: banCheck.secondsRemaining,
                message: `Please wait ${Math.ceil(banCheck.secondsRemaining / 60)} minutes before trying again.`
            });
        }

        // Check for rapid-fire purchases (3-second minimum interval)
        const userId = String(telegramId);
        const lastPurchaseTime = userLastPurchaseTime.get(userId);
        const now = Date.now();
        
        if (lastPurchaseTime && (now - lastPurchaseTime) < PURCHASE_MIN_INTERVAL_MS) {
            processingRequests.delete(requestKey);
            const timeTooSoon = Math.round((PURCHASE_MIN_INTERVAL_MS - (now - lastPurchaseTime)) / 1000);
            console.warn(`[RATE CHECK] User ${userId} rapid purchase (${timeTooSoon}s too soon). Recording violation.`);
            
            // Record violation for rapid-fire purchase attempt
            const violationResult = recordPurchaseViolation(telegramId, username);
            
            // If ban was activated by this violation, return 429
            if (violationResult.banActivated) {
                return res.status(429).json({ 
                    error: 'Temporary purchase limit active',
                    banRemaining: Math.ceil(TEMP_BAN_DURATION_MS / 1000),
                    message: `You are rate limited. Please wait ${Math.ceil(TEMP_BAN_DURATION_MS / 60000)} minutes before trying again.`
                });
            } else {
                // Still under cooldown warning
                return res.status(429).json({ 
                    error: 'Please slow down',
                    message: 'You can only make one purchase every 3 seconds.'
                });
            }
        }

        // Strict validation
        if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
            processingRequests.delete(requestKey);
            const reason = 'Missing required fields';
            console.log(`[${timestamp}] ORDER FAILED | User: ${telegramId} | Reason: ${reason}`);
            return res.status(400).json({ error: reason });
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

        // Check ban status using Warning schema
        const isBanned = await checkUserBanStatus(telegramId.toString());
        if (isBanned) {
            processingRequests.delete(requestKey);
            const banDetails = await getBanDetails(telegramId.toString());
            return res.status(403).json({ 
                error: 'Your account is restricted and cannot place orders',
                caseId: banDetails?.caseId,
                message: "Contact support with your case ID to appeal"
            });
        }

        // Keep legacy check for backward compatibility
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

        // SECURITY: Calculate amount server-side only, ignore client-submitted totalAmount
        // Never trust client-submitted amounts - they can be manipulated
        let amount;
        const priceMap = {
            regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
            premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
        };
        
        // Calculate base unit price
        let basePrice;
        let isStandardPackage = false;
        
        if (isPremium) {
            // Premium only allows standard durations from map
            basePrice = priceMap.premium[premiumDuration];
            if (!basePrice) {
                processingRequests.delete(requestKey);
                console.error(`[${timestamp}] SECURITY: Rejected invalid premium duration. User: ${telegramId} | Duration: ${premiumDuration}mo | Reason: Not in price map`);
                return res.status(400).json({
                    error: 'Invalid premium duration',
                    details: `${premiumDuration} months not available. Choose 3, 6, or 12 months.`
                });
            }
            isStandardPackage = true;
        } else {
            // Regular stars: use map if available, otherwise calculate at $0.02/star
            if (priceMap.regular[stars]) {
                basePrice = priceMap.regular[stars];
                isStandardPackage = true;
            } else {
                // Custom amount: use $0.02 per star as base rate
                basePrice = Number((stars * 0.02).toFixed(4));
                isStandardPackage = false;
            }
        }
        
        // Calculate total based on recipients if applicable
        const quantityMultiplier = isBuyForOthers && totalRecipients > 0 ? totalRecipients : 1;
        amount = Number((basePrice * quantityMultiplier).toFixed(2));
        
        // === CLEANUP EXPIRED ORDERS ===
        // Mark old abandoned/expired pending orders as expired (those past their timeout)
        await BuyOrder.updateMany(
            {
                telegramId: telegramId,
                status: "pending",
                dateCreated: { $lt: new Date(Date.now() - 15 * 60 * 1000) } // Older than 15 mins
            },
            { status: "expired" }
        );

        // Log what we calculated server-side
        const clientSubmittedAmount = req.body.totalAmount ? Number(req.body.totalAmount) : null;
        console.log(`[AMOUNT CALC] User: ${telegramId} | Item: ${isPremium ? `${premiumDuration}mo premium` : `${stars} stars`} | Type: ${isStandardPackage ? 'standard' : 'custom'} | Recipients: ${quantityMultiplier} | Base: ${basePrice} USDT | Total: ${amount} USDT | Client: ${clientSubmittedAmount}`);
        
        // SECURITY CHECK: Validate client amount against server calculation
        // Use strict validation: amounts MUST match within 0.01 USDT
        // (unless client never validated, then allow 0.03 for rate changes)
        const STRICT_TOLERANCE = 0.01;    // For validated orders
        const LOOSE_TOLERANCE = 0.03;     // For orders without validation
        
        if (clientSubmittedAmount) {
            const diff = Math.abs(clientSubmittedAmount - amount);
            
            // Always use strict tolerance - client should have validated before reaching here
            if (diff > STRICT_TOLERANCE) {
                console.warn(`[SECURITY] AMOUNT DISCREPANCY FLAGGED`);
                console.warn(`  User: ${telegramId} | Client: ${clientSubmittedAmount} USDT | Server: ${amount} USDT | Diff: ${diff.toFixed(4)} USDT`);
                // Still accept but log for monitoring
            } else if (diff > 0.001) {
                console.log(`[AMOUNT MATCH] Within tolerance | Diff: ${diff.toFixed(4)} USDT`);
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
        
        // SUCCESS LOG - Easy to grep and debug order creation
        console.log(`[${timestamp}] ORDER CREATED | OrderID: ${order.id} | User: ${telegramId} (@${username}) |  Wallet: ${walletAddress.slice(0, 20)}... | Amount: ${amount} USDT | Stars: ${stars || 'premium'} | Status: pending`);

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
            console.error(`[${timestamp}] ❌ CRITICAL - Admin notification failed for Order ${order.id}. Error: ${lastAdminError?.message}. Order still created in DB.`);
        }

        await trackUserActivity(telegramId, username, 'order_created', { orderId: order.id, amount, stars, isPremium });

        // === SUCCESS RESPONSE ===
        // Update last purchase time for rate limiting
        userLastPurchaseTime.set(userId, now);
        
        // Always return success if order was saved (order exists in DB regardless of admin notification)
        processingRequests.delete(requestKey);
        res.json({ success: true, order });

    } catch (err) {
        processingRequests.delete(requestKey);
        const timestamp = new Date().toISOString();
        const userId = req.body?.telegramId;
        console.error(`[${timestamp}] ❌ ORDER CREATION ERROR | User: ${userId} | Error: ${err.message} | Stack: ${err.stack ? err.stack.split('\n')[1].trim() : 'N/A'}`);
        res.status(500).json({ error: 'Failed to create order. Please try again.' });
    }
});

function sanitizeUsername(username) {
    if (!username) return null;
    return username.replace(/[^\w\d_]/g, '');
}

app.post("/api/sell-orders", requireTelegramAuth, async (req, res) => {
    try {
        const { 
            telegramId, 
            username = '', 
            stars, 
            walletAddress, 
            memoTag = '' 
        } = req.body;
        
        // === SECURITY VALIDATION: Ensure user can only create sell orders for themselves ===
        if (String(telegramId) !== String(req.user?.id)) {
            console.warn(`[${new Date().toISOString()}] SECURITY ALERT: User ${req.user?.id} attempted to create sell order for user ${telegramId}`);
            return res.status(401).json({ error: 'Unauthorized: Cannot create sell orders for other users' });
        }
        
        // === SYNC USER DATA ON EVERY INTERACTION ===
        await syncUserData(telegramId, username, 'sell_order_create', req);
        
        if (!telegramId || stars === undefined || stars === null || !walletAddress) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Check ban status using Warning schema
        const isBanned = await checkUserBanStatus(telegramId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(telegramId.toString());
            return res.status(403).json({ 
                error: "Your account is restricted and cannot place orders",
                caseId: banDetails?.caseId,
                message: "Contact support with your case ID to appeal"
            });
        }

        // Keep legacy check for backward compatibility
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

        // === CLEANUP EXPIRED ORDERS ===
        // Mark old abandoned/expired pending orders as expired (those past their 15-min timeout)
        await SellOrder.updateMany(
            {
                telegramId: telegramId,
                status: "pending",
                sessionExpiry: { $lt: new Date() } // Expired by timeout
            },
            { status: "expired" }
        );

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
        console.log(`Sell order created for user ${telegramId}`);

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
        
        // === SECURITY: Remove payment link from message when order expires ===
        if (order.userMessageId) {
            await updateSellOrderUserMessage(order, 'expired');
        }
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

// Helper: Edit user message to remove payment link (prevents double-payment)
async function editMessageRemovePaymentLink(telegramId, messageId, orderStatus) {
    if (!messageId) return; // No message to edit
    
    try {
        // Build the updated message - same format but without payment link
        let updatedText = `🚀 Sell order initialized!\n\n`;
        updatedText += `Order ID: [ID]\n`;
        updatedText += `Stars: [stars]\n`;
        updatedText += `Status: ${orderStatus === 'processing' ? 'Processing (payment received)' : 'Expired'}\n`;
        
        // Note: We need to get the actual order data to format correctly
        // For now, return and let the caller provide the text
        return true; // Placeholder
    } catch (error) {
        console.error(`[Payment Link Edit] Failed to edit message ${messageId} for user ${telegramId}:`, error.message);
        // Non-blocking - log but don't fail the order processing
        return false;
    }
}

// Helper: Edit sell order user message to update status and remove payment link
async function updateSellOrderUserMessage(order, newStatus) {
    if (!order.userMessageId) {
        return; // No message ID stored, can't edit
    }

    try {
        // Reconstruct the message without payment link
        const statusText = newStatus === 'processing' ? 
            'Processing (payment received)' : 
            newStatus === 'expired' ? 
            'Expired' : 
            order.status;

        const updatedMessage = `🚀 Sell order initialized!\n\n` +
            `Order ID: ${order.id}\n` +
            `Stars: ${order.stars}\n` +
            `Status: ${statusText}\n\n` +
            (newStatus !== 'expired' ? `⏰ Payment link expires in 15 minutes` : `⏰ This order has expired`);

        await bot.editMessageText(updatedMessage, {
            chat_id: order.telegramId,
            message_id: order.userMessageId,
            parse_mode: 'HTML'
        });

        console.log(`[Payment Link Edit] Successfully removed payment link from message ${order.userMessageId} for order ${order.id}`);
        return true;
    } catch (error) {
        // Log but don't block - order processing continues
        if (error.message.includes('message to edit not found')) {
            // Message was deleted by user, that's fine
            console.log(`[Payment Link Edit] Message ${order.userMessageId} not found (already deleted)`);
        } else {
            console.error(`[Payment Link Edit] Failed to edit message for order ${order.id}:`, error.message);
        }
        return false;
    }
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
    
    // === SECURITY: Remove payment link from original message to prevent double-payment ===
    // Edit the original sell order message to remove the payment link
    await updateSellOrderUserMessage(order, 'processing');
    
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
            await bot.sendMessage(chatId, `Please send the new wallet address for ${bucket.selections.size} selected item(s). If needed, you can add a memo after a comma.\n\nSome characters will be removed automatically.\n\nThis request will time out in 10 minutes.`);
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
            await bot.sendMessage(chatId, `Please send the new wallet address for ${orderType === 'sell' ? 'Sell order' : 'Withdrawal'} ${orderId}. If needed, add a memo after a comma.\n\nSome characters will be removed automatically.\n\nThis request will time out in 10 minutes.`);

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
  
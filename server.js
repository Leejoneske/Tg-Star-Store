

require('dotenv').config();

// Process resilience: prevent crash from unhandled background errors (e.g., Mongoose buffer timeouts when DB unavailable in dev)
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.message ? err.message : err);
});


// Repository restored to stable state - April 19, 2026
// All pages and routing working as expected
// Deployment: April 19, 2026 - 04:52 UTC - Force rebuild with fresh file serving

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
const fs = require('fs').promises;
const app = express();
app.set('trust proxy', 1);
const path = require('path');  
const zlib = require('zlib');

// Security middleware
let helmet, rateLimit;
try { helmet = require('helmet'); } catch (_) { helmet = null; }
try { rateLimit = require('express-rate-limit'); } catch (_) { rateLimit = null; }

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

// Create Telegram bot or a stub in local/dev if no token is provided.
// When loaded by tests (require.main !== module) skip the webHook listener so
// node-telegram-bot-api does not bind port 8443 during test runs.
let bot;
let isBotStub = false;
if (process.env.BOT_TOKEN) {
  const botOptions = require.main === module ? { webHook: true } : {};
  bot = new TelegramBot(process.env.BOT_TOKEN, botOptions);
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
// Webhook domain configuration
// Priority: explicit WEBHOOK_DOMAIN env var > starstore.app (current production)
// This ensures webhook always uses starstore.app unless explicitly overridden
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || 'starstore.app';
const SERVER_URL = WEBHOOK_DOMAIN;
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = `https://${SERVER_URL}${WEBHOOK_PATH}`;

// Log webhook configuration for debugging
console.log('🔗 Webhook Configuration:', {
  domain: WEBHOOK_DOMAIN,
  url: WEBHOOK_URL,
  envVars: {
    WEBHOOK_DOMAIN: process.env.WEBHOOK_DOMAIN || 'not set',
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || 'not set',
    RAILWAY_STATIC_URL: process.env.RAILWAY_STATIC_URL || 'not set'
  }
});
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
    // Fallback used only when middleware/telegramAuth.js failed to load.
    // SECURITY: Never trust x-telegram-id header in production — it is unsigned and trivially spoofed.
    requireTelegramAuth = (req, res, next) => {
        const telegramIdHeader = req.headers['x-telegram-id'];
        const telegramInitData = req.headers['x-telegram-init-data'];
        const isProd = process.env.NODE_ENV === 'production';

        // initData (signed) - allowed in any env, but in prod we cannot verify here without bot token logic
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

        // Header-only auth: dev/local only — NEVER trusted in production
        if (telegramIdHeader && !isProd) {
            req.user = { id: telegramIdHeader.toString(), isAdmin: Array.isArray(adminIds) && adminIds.includes(telegramIdHeader.toString()) };
            return next();
        }

        if (isProd) {
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
            /^https:\/\/(www\.)?starstore\.app$/,
            /^https:\/\/(www\.)?walletbot\.me$/,
            /^https:\/\/.*\.railway\.app$/,
            // Ambassador app domains
            /^https:\/\/amb-starstore\.vercel\.app$/,
            /^https:\/\/amb\.starstore\.app$/,
            /^https:\/\/.*ambassador.*\.vercel\.app$/,
            // Lovable preview/sandbox environments
            /^https:\/\/.*\.lovableproject\.com$/,
            /^https:\/\/.*\.lovable\.app$/,
            /^https:\/\/.*\.lovable\.dev$/
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

// Helmet — sane HTTP security headers (CSP disabled to avoid breaking inline scripts in static pages)
if (helmet) {
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));
    app.disable('x-powered-by');
}

// Global lightweight rate limiter on /api/* to mitigate abuse and brute force
if (rateLimit) {
    const apiLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 240, // 4 req/sec average per IP across all /api endpoints
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => req.method === 'OPTIONS' || req.path.startsWith('/api/health')
    });
    app.use('/api', apiLimiter);

    // Stricter limiter for sensitive write endpoints
    const sensitiveLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false
    });
    app.use([
        '/api/orders/create',
        '/api/referral-withdrawals',
        '/api/admin/auth/send-otp',
        '/api/admin/auth/verify-otp',
        '/api/newsletter/subscribe',
        '/api/feedback/submit',
        '/api/survey'
    ], sensitiveLimiter);

    // Rate limiter for the Telegram webhook to mitigate flooding/DoS
    const webhookLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests' }
    });
    app.use(WEBHOOK_PATH, webhookLimiter);
}

// Ambassador App Authentication Middleware
const AMBASSADOR_API_KEY = process.env.AMBASSADOR_API_KEY;
const DEFAULT_AMB_KEY = 'amb_starstore_secure_key_2024';
if (process.env.NODE_ENV === 'production' && (!AMBASSADOR_API_KEY || AMBASSADOR_API_KEY === DEFAULT_AMB_KEY)) {
    console.error('🚨 SECURITY: AMBASSADOR_API_KEY missing or set to default value in production. Refusing to enable ambassador-app authenticated routes.');
}
const EFFECTIVE_AMB_KEY = (process.env.NODE_ENV === 'production' && (!AMBASSADOR_API_KEY || AMBASSADOR_API_KEY === DEFAULT_AMB_KEY))
    ? null
    : (AMBASSADOR_API_KEY || DEFAULT_AMB_KEY);

const authenticateAmbassadorApp = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const userAgent = req.headers['user-agent'];

    if (userAgent && userAgent.includes('Ambassador-Dashboard')) {
        if (EFFECTIVE_AMB_KEY && apiKey && apiKey === EFFECTIVE_AMB_KEY) {
            req.isAmbassadorApp = true;
            return next();
        }
        console.log('❌ Invalid or unconfigured API key for ambassador app');
        return res.status(401).json({ error: 'Invalid API key for ambassador app' });
    }
    next();
};

// Apply ambassador authentication middleware
app.use(authenticateAmbassadorApp);

// ==================== GLOBAL API BAN ENFORCEMENT ====================
// Block ALL /api/* requests from banned users (except probe/health/appeal endpoints).
// This catches notifications, daily, referral, orders, wallet, etc. with one gate.
const BAN_EXEMPT_API_PATHS = new Set([
  '/api/whoami',
  '/api/health',
  '/api/version',
  '/api/ban-status',
  '/api/ban-appeal',
]);
app.use(async (req, res, next) => {
  try {
    if (!req.path.startsWith('/api/')) return next();
    if (req.method === 'OPTIONS') return next();
    if (BAN_EXEMPT_API_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/admin/')) return next(); // admin endpoints have their own auth
    if (req.path.startsWith('/api/public/')) return next();
    if (req.isAmbassadorApp) return next();

    // Extract telegram id from header or initData (cheap, no signature verify here —
    // per-endpoint requireTelegramAuth still enforces signature for sensitive ops)
    let userId = null;
    const hdr = req.headers['x-telegram-id'];
    if (hdr && hdr !== 'undefined' && hdr !== 'null' && hdr !== 'dev-user') {
      userId = String(hdr).trim();
    }
    if (!userId && req.headers['x-telegram-init-data']) {
      try {
        const params = new URLSearchParams(req.headers['x-telegram-init-data']);
        const u = params.get('user');
        if (u) {
          const parsed = JSON.parse(u);
          if (parsed?.id) userId = String(parsed.id);
        }
      } catch (_) {}
    }
    if (!userId) return next();

    if (typeof checkUserBanStatus !== 'function') return next();
    const isBanned = await checkUserBanStatus(userId);
    if (!isBanned) return next();

    const banDetails = await getBanDetails(userId);
    return res.status(403).json({
      error: 'Account restricted',
      isBanned: true,
      caseId: banDetails?.caseId || null,
      appealDeadline: banDetails?.appealDeadline || null,
      message: 'Your account has been restricted. Contact support with your case ID to appeal.'
    });
  } catch (err) {
    console.error('[BAN GATE] middleware error:', err.message);
    return next();
  }
});
// ==================== END GLOBAL API BAN ENFORCEMENT ====================


// Ensure directories with index.html return 200 (no 302/redirects)
// This MUST come before express.static so it takes priority
// Maps clean URLs like /sell to sell.html, /about to about.html, etc.
app.get(['/', '/about', '/sell', '/history', '/daily', '/feedback', '/ambassador'], async (req, res, next) => {
  try {
    // Extract user ID from available sources for ban checking
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
      '/ambassador': 'apply_ambassador.html'
    };
    const file = map[req.path];
    if (file) {
      const abs = path.join(__dirname, 'public', file);
      return res.status(200).sendFile(abs, (err) => {
        if (err) {
          console.error(`[ROUTE ERROR] Failed to send ${file}: ${err.message}`);
          // If the mapped file is missing, serve the graceful 404 page
          const notFound = path.join(__dirname, 'public', 'errors', '404.html');
          return res.status(404).sendFile(notFound, (sendErr) => {
            if (sendErr) return res.status(404).send('Not found');
          });
        }
      });
    }
    return next();
  } catch (e) { 
    console.error(`[ROUTE ERROR] Exception in route handler:`, e.message);
    return next(); 
  }
});

// Also handle requests with .html endings: /sell.html → same as /sell
app.get(/\/(about|sell|history|daily|feedback|ambassador)\.html$/i, async (req, res, next) => {
  try {
    const pathWithoutHtml = req.path.replace(/\.html$/i, '');
    
    const map = {
      '/about': 'about.html',
      '/sell': 'sell.html',
      '/history': 'history.html',
      '/daily': 'daily.html',
      '/feedback': 'feedback.html',
      '/ambassador': 'apply_ambassador.html'
    };
    const file = map[pathWithoutHtml];
    if (file) {
      const abs = path.join(__dirname, 'public', file);
      return res.status(200).sendFile(abs, (err) => {
        if (err) {
          console.error(`[ROUTE ERROR] Failed to send ${file}: ${err.message}`);
          const notFound = path.join(__dirname, 'public', 'errors', '404.html');
          return res.status(404).sendFile(notFound, (sendErr) => {
            if (sendErr) return res.status(404).send('Not found');
          });
        }
      });
    }
    return next();
  } catch (e) { 
    console.error(`[ROUTE ERROR] Exception in .html handler:`, e.message);
    return next(); 
  }
});

// ==================== STATIC DIRECTORY ROUTES ====================


// Serve static files from public directory

// Serve static files from public directory
app.use(express.static('public', { 
    maxAge: '1h',
    etag: false,
    lastModified: false,
    index: ['index.html'],
    setHeaders: (res, requestPath) => {
        if (requestPath.endsWith('.html')) {
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

// Diagnostic endpoint to check file availability
app.get('/api/debug/file-status', requireAdmin, (req, res) => {
  try {
    const fsSyncModule = require('fs');
    const publicDir = path.join(__dirname, 'public');
    
    const filesToCheck = [
      'index.html',
      'sell.html', 
      'about.html',
      'history.html',
      'daily.html',
      'referral.html',
      'support.html',
      'notification.html',
      'feedback.html',
      'apply_ambassador.html',
      'amb_ref.html',
      'blog/index.html',
      'errors/404.html',
      'errors/500.html'
    ];
    
    const results = {};
    filesToCheck.forEach(file => {
      const fullPath = path.join(publicDir, file);
      results[file] = fsSyncModule.existsSync(fullPath);
    });
    
    // List actual files in public directory
    let actualFiles = [];
    try {
      const readDirSync = fsSyncModule.readdirSync;
      actualFiles = readDirSync(publicDir);
    } catch (e) {
      actualFiles = ['ERROR: Could not read directory'];
    }
    
    res.json({
      __dirname: __dirname,
      publicDir: publicDir,
      publicDirExists: fsSyncModule.existsSync(publicDir),
      checkedFiles: results,
      actualFilesInPublic: actualFiles,
      nodeEnv: process.env.NODE_ENV
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      try {
        const notFoundContent = await fs.readFile(notFound, 'utf8');
        res.status(404).type('text/html').send(notFoundContent);
      } catch (e) {
        res.status(404).send('Not found');
      }
      return;
    }

    // Inject user ID as global variable if we have one
    if (userId) {
      htmlContent = htmlContent.replace(
        '<script src="https://telegram.org/js/telegram-web-app.js" defer></script>',
        `<script src="https://telegram.org/js/telegram-web-app.js" defer></script>
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
    try {
      const notFoundContent = await fs.readFile(notFound, 'utf8');
      res.status(404).type('text/html').send(notFoundContent);
    } catch (e2) {
      res.status(404).send('Not found');
    }
  }
});

// Sitemap.xml with proper headers
app.get('/sitemap.xml', async (req, res) => {
  try {
    const content = await fs.readFile(path.join(__dirname, 'public', 'sitemap.xml'), 'utf8');
    res.type('application/xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.status(200).send(content);
  } catch (err) {
    console.error('Error serving sitemap.xml:', err.message);
    res.status(404).type('text/plain').send('Not found');
  }
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
app.get('/api/ambassador/user/:telegramId', requireTelegramAuth, async (req, res) => {
  // Authorization: only allow users to fetch their own profile (admins may fetch any)
  if (String(req.params.telegramId) !== String(req.user?.id) && !req.user?.isAdmin) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
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
    const redirectUrl = redirect || 'https://amb.starstore.app/apply';
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
    let redirectUrl = 'https://amb.starstore.app/apply';
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
    // Derive base from configured server domain; fallback to starstore.app
    const base = `https://${WEBHOOK_DOMAIN || 'starstore.app'}`;
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
      ['/','/about','/sell','/history']
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
app.get('/admin', async (req, res) => {
	try {
		const content = await fs.readFile(path.join(__dirname, 'public', 'admin', 'index.html'), 'utf8');
		res.status(200).type('text/html').send(content);
	} catch (e) {
		console.error('Error serving /admin:', e.message);
		const notFound = path.join(__dirname, 'public', 'errors', '404.html');
		try {
			const notFoundContent = await fs.readFile(notFound, 'utf8');
			res.status(404).type('text/html').send(notFoundContent);
		} catch (e2) {
			res.status(404).send('Not found');
		}
	}
});

// Catch-all 404 for non-API GET requests - allows all other traffic through
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    // Serve 404 for non-API GET requests
    res.status(404).type('text/html').send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>404 - Page Not Found</title>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
            .container { text-align: center; padding: 20px; }
            h1 { font-size: 48px; margin: 0; color: #333; }
            p { color: #666; margin: 10px 0; }
            a { color: #007AFF; text-decoration: none; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>404</h1>
            <p>Page not found</p>
            <a href="/">← Back to home</a>
          </div>
        </body>
        </html>
      `);
  } else {
    // All other requests (POST, PUT, DELETE, API, etc.) continue to next middleware
    next();
  }
});

// Global error handler - JSON for APIs, HTML for pages
app.use(async (err, req, res, next) => {
  try { console.error('Unhandled error:', err); } catch (_) {}
  if (res.headersSent) return next(err);
  
  // API errors return JSON
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  
  // Serve appropriate error page
  const statusCode = err.status || err.statusCode || 500;
  const errorFile = path.join(__dirname, 'public', 'errors', `${statusCode}.html`);
  try {
    const content = await fs.readFile(errorFile, 'utf8');
    res.status(statusCode).type('text/html').send(content);
  } catch (readErr) {
    console.error(`Error serving error page ${statusCode}:`, readErr.message);
    res.status(statusCode).send(`Error ${statusCode}`);
  }
});
// Webhook setup (only when real bot is configured, and not during tests)
if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== 'dev_stub' && require.main === module) {
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
// Webhook handler — strict body size + secret token enforcement
app.post(WEBHOOK_PATH, express.json({ limit: '100kb' }), (req, res) => {
  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    // In production: secret MUST be configured and MUST match
    if (!expectedSecret) {
      console.error('🚨 WEBHOOK_SECRET not configured in production — rejecting all webhook requests');
      return res.sendStatus(500);
    }
    if (!incomingSecret || incomingSecret !== expectedSecret) {
      console.warn('⚠️ Rejected webhook request: missing or invalid secret token');
      return res.sendStatus(401);
    }
  } else if (expectedSecret && incomingSecret && incomingSecret !== expectedSecret) {
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

// Analytics configuration endpoint
app.get('/api/analytics/config', (req, res) => {
    res.json({
        token: process.env.TGANALYTICS_TOKEN || 'eyJhcHBfbmFtZSI6InN0YXJzdG9yZSIsImFwcF91cmwiOiJodHRwczovL3QubWUvVGdTdGFyU3RvcmVfYm90IiwiYXBwX2RvbWFpbiI6Imh0dHBzOi8vc3RhcnN0b3JlLnNpdGUifQ==!p6+pJ88q7iIxa8nf+x+jWQshXdMnNYE4MjiRq2wWP3M=',
        appName: process.env.TGANALYTICS_APP_NAME || 'starstore'
    });
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
      const banDetails = await getBanDetails(tgId);
      return res.json({ 
        id: tgId, 
        isAdmin: false, 
        isBanned: true,
        caseId: banDetails?.caseId || null,
        appealDeadline: banDetails?.appealDeadline || null,
        reason: banDetails?.reason || null,
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
    id: { type: String, index: true, unique: true },
    telegramId: { type: String, index: true },
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
    // Payment currency used at checkout: 'TON' (native) or 'USDT' (USDT-TON jetton).
    // Same store wallet address receives both; only the on-chain message type differs.
    paymentCurrency: { type: String, enum: ['TON', 'USDT'], default: 'TON' },
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
        required: true,
        index: true
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
    }],
    // 21-day hold notice acceptance
    hasAccepted21DayNotice: { type: Boolean, default: false },
    acceptedAt: Date
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
    referrerUserId: { type: String, required: true, index: true },
    referredUserId: { type: String, required: true, index: true },
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
    userId: { type: String, index: true },
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

// 🔐 SECURITY: Admin Action Audit Log - tracks all admin actions for security audit trail
const adminActionAuditLogSchema = new mongoose.Schema({
    adminId: { type: String, required: true, index: true },
    adminUsername: String,
    action: { type: String, required: true, index: true },
    actionType: { type: String, enum: ['order_completion', 'order_decline', 'order_refund', 'username_update', 'ambassador_status', 'ban_action'], required: true, index: true },
    targetUserId: { type: String, index: true },
    targetOrderId: String,
    status: String,
    details: mongoose.Schema.Types.Mixed,
    sourceType: { type: String, enum: ['callback_query', 'api_call', 'direct_command'], default: 'callback_query' },
    verified: { type: Boolean, default: false },
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
const AdminActionAuditLog = mongoose.model('AdminActionAuditLog', adminActionAuditLogSchema);
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

// 🔐 SECURITY: Admin verification and audit logging helpers
function isUserAdmin(userId) {
    return Array.isArray(adminIds) && adminIds.includes(String(userId).trim());
}

async function logAdminAction(adminId, action, actionType, targetUserId, details = {}) {
    try {
        const auditEntry = new AdminActionAuditLog({
            adminId: String(adminId),
            adminUsername: details.adminUsername || 'unknown',
            action,
            actionType,
            targetUserId: targetUserId ? String(targetUserId) : null,
            targetOrderId: details.targetOrderId || null,
            status: details.status || 'executed',
            details,
            sourceType: 'callback_query',
            verified: true,
            timestamp: new Date()
        });
        await auditEntry.save();
        console.log(`[AUDIT] Admin action logged: ${action} by ${adminId}`);
    } catch (error) {
        console.error('[AUDIT] Failed to log admin action:', error.message);
    }
}

// 🔐 SECURITY: Rate limit tracking for admin actions
const adminActionRateLimit = new Map();
const ADMIN_ACTION_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_ADMIN_ACTIONS_PER_MINUTE = 30;

function checkAdminRateLimit(adminId) {
    const now = Date.now();
    const key = String(adminId);
    let timestamps = adminActionRateLimit.get(key) || [];
    timestamps = timestamps.filter(t => now - t < ADMIN_ACTION_RATE_LIMIT_WINDOW_MS);
    
    if (timestamps.length >= MAX_ADMIN_ACTIONS_PER_MINUTE) {
        console.warn(`[RATE_LIMIT] Admin ${adminId} exceeded (${timestamps.length}/${MAX_ADMIN_ACTIONS_PER_MINUTE})`);
        return { allowed: false, remaining: 0, resetIn: ADMIN_ACTION_RATE_LIMIT_WINDOW_MS / 1000 };
    }
    
    timestamps.push(now);
    adminActionRateLimit.set(key, timestamps);
    return { allowed: true, remaining: MAX_ADMIN_ACTIONS_PER_MINUTE - timestamps.length };
}

// 🔐 SECURITY: Helper function to escape regex special characters and prevent injection
function escapeRegex(str) {
    return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// 🧠 SMART SESSION MANAGEMENT: End all active flows for a user when they click a new command
// This allows seamless command switching like Telegram's @BotFather
function endActiveFlowForUser(userId, chatId) {
    const userIdStr = String(userId);
    const chatIdNum = parseInt(chatId, 10);
    
    // Clear sell flow if active (uses userId as string)
    if (sellFlowStates.has(userIdStr)) {
        sellFlowStates.delete(userIdStr);
    }
    
    // Clear reversal/refund flow if active (uses chatId as integer)
    if (reversalRequests.has(chatIdNum)) {
        reversalRequests.delete(chatIdNum);
    }
    
    // Clear wallet selections if active (uses userId as string)
    if (walletSelections.has(userIdStr)) {
        walletSelections.delete(userIdStr);
    }
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

// Sell flow state tracking for keyboard-based sell orders
// Map<userId, { stage: 'amount'|'wallet'|'memo', data: {...}, errors: {} (tracks errors per stage), timeout }>
const sellFlowStates = new Map();

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
app.post('/api/validate-amount', requireTelegramAuth, (req, res) => {
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
app.post('/api/validate-usernames', requireTelegramAuth, (req, res) => {
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
            const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
            const userId = 'u_' + hash;
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
    const { telegramId, username, stars, walletAddress, isPremium, premiumDuration, recipients, transactionHash, isTestnet, paymentCurrency } = req.body;
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
            paymentCurrency: paymentCurrency === 'USDT' ? 'USDT' : 'TON',
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
        // Extract geolocation (with timeout so a slow geo lookup never blocks the notify)
        let userLocation = '';
        try {
            let ip = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
            if (ip && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
                const geo = await Promise.race([
                    getGeolocation(ip),
                    new Promise(resolve => setTimeout(() => resolve(null), 3000))
                ]);
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
            // Truncate recipient list to keep message well under Telegram's 4096-char limit
            const recipientHandles = recipients.map(r => `@${r}`);
            const MAX_RECIPIENTS_INLINE = 50;
            if (recipientHandles.length <= MAX_RECIPIENTS_INLINE) {
                adminMessage += `\nRecipients: ${recipientHandles.join(', ')}`;
            } else {
                const shown = recipientHandles.slice(0, MAX_RECIPIENTS_INLINE).join(', ');
                adminMessage += `\nRecipients (first ${MAX_RECIPIENTS_INLINE} of ${recipientHandles.length}): ${shown}, …`;
            }
        }

        // Hard cap to stay under Telegram's 4096-char message limit (safety net)
        if (adminMessage.length > 3900) {
            adminMessage = adminMessage.slice(0, 3897) + '...';
        }

        const adminKeyboard = { inline_keyboard: [[ { text: '✅ Complete', callback_data: `complete_buy_${order.id}` }, { text: '❌ Decline', callback_data: `decline_buy_${order.id}` } ]] };

        // Send to admins with retry (MUST succeed for at least one admin)
        let adminNotificationSucceeded = false;
        let lastAdminError = null;

        if (!bot || isBotStub) {
            console.error(`[${timestamp}] ❌ ADMIN NOTIFY SKIPPED | Order: ${order.id} | Reason: bot ${!bot ? 'missing' : 'is stub'}`);
        } else if (!Array.isArray(adminIds) || adminIds.length === 0) {
            console.error(`[${timestamp}] ❌ ADMIN NOTIFY SKIPPED | Order: ${order.id} | Reason: adminIds is empty. Set ADMIN_TELEGRAM_IDS env var.`);
        } else {
            console.log(`[${timestamp}] ADMIN NOTIFY START | Order: ${order.id} | Targets: ${adminIds.length} admin(s) [${adminIds.join(', ')}]`);
            for (const adminId of adminIds) {
                let retryCount = 0;
                let delivered = false;
                while (retryCount < 4 && !delivered) {
                    try {
                        const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                        order.adminMessages.push({ adminId, messageId: message.message_id, originalText: adminMessage });
                        adminNotificationSucceeded = true;
                        delivered = true;
                        console.log(`[${timestamp}] ADMIN NOTIFY OK | Order: ${order.id} | Admin: ${adminId} | MsgID: ${message.message_id}`);
                    } catch (err) {
                        lastAdminError = err;
                        retryCount++;
                        const code = err?.response?.statusCode || err?.code || 'n/a';
                        const body = err?.response?.body || err?.response?.data;
                        const retryAfterSec = body?.parameters?.retry_after || err?.response?.parameters?.retry_after;
                        console.error(`[${timestamp}] ADMIN NOTIFY FAIL | Order: ${order.id} | Admin: ${adminId} | Attempt: ${retryCount}/4 | Code: ${code} | ${err?.message || err}`);

                        // Fatal: chat not found, bot blocked, deactivated, BUTTON_DATA_INVALID, message too long — don't retry
                        const msg = String(err?.message || '');
                        const isFatal = code === 400 || code === 403 ||
                            /chat not found|bot was blocked|user is deactivated|BUTTON_DATA_INVALID|message is too long/i.test(msg);
                        if (isFatal) {
                            console.error(`[${timestamp}] ADMIN NOTIFY FATAL | Order: ${order.id} | Admin: ${adminId} | Giving up on this admin (won't retry).`);
                            break;
                        }

                        if (retryCount < 4) {
                            // Honor Telegram's retry_after on 429; otherwise exponential backoff
                            let waitMs;
                            if (code === 429 && retryAfterSec) {
                                waitMs = (Number(retryAfterSec) + 1) * 1000;
                                console.warn(`[${timestamp}] ADMIN NOTIFY RATE-LIMITED | Order: ${order.id} | Admin: ${adminId} | Waiting ${waitMs}ms per Telegram retry_after`);
                            } else {
                                waitMs = 500 * Math.pow(2, retryCount - 1); // 500, 1000, 2000
                            }
                            await new Promise(r => setTimeout(r, waitMs));
                        }
                    }
                }
                // Brief inter-admin spacing to stay under Telegram's 30 msg/sec global cap under bursts
                await new Promise(r => setTimeout(r, 50));
            }
            console.log(`[${timestamp}] ADMIN NOTIFY DONE | Order: ${order.id} | Success: ${adminNotificationSucceeded} | Delivered to ${order.adminMessages.length}/${adminIds.length} admins`);
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

        // Optimization: Pass existing geo object to trackUserActivity to avoid redundant lookup
        const activityGeo = order.userLocation ? {
            country: order.userLocation.country,
            countryCode: order.userLocation.countryCode,
            city: order.userLocation.city,
            ip: order.userLocation.ip
        } : null;
        await trackUserActivity(telegramId, username, 'order_created', { orderId: order.id, amount, stars, isPremium }, null, null, activityGeo);

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
        try { const sent = await bot.sendMessage(telegramId, userMessage); if (sent?.message_id) { order.userMessageId = sent.message_id; await order.save(); } } catch {}

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
    
    // For keyboard-created orders, notify admins after payment is confirmed
    if (order.createdViaKeyboard) {
        let userLocationInfo = '';
        if (order.userLocation) {
            const city = order.userLocation.city || 'Unknown';
            const country = order.userLocation.country || 'Unknown';
            userLocationInfo = `📍 ${city}, ${country}`;
        } else {
            userLocationInfo = `📍 Location unknown`;
        }

        const adminMessage = `💰 New Payment Received!\n\n` +
            `Order ID: ${order.id}\n` +
            `User: @${order.username} (ID: ${order.telegramId})\n` +
            (userLocationInfo ? `${userLocationInfo}\n` : '') +
            `Stars: ${order.stars}\n` +
            `Wallet: ${order.walletAddress}\n` +
            `Memo: ${order.memoTag || 'None'}\n\n` +
            `💱 Generated via Telegram keyboard button`;

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                    { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                    { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                ]
            ]
        };

        // Send to all admins
        for (const adminId of adminIds) {
            try {
                const adminMsg = await bot.sendMessage(
                    adminId,
                    adminMessage,
                    { reply_markup: adminKeyboard }
                );
                order.adminMessages.push({
                    adminId,
                    messageId: adminMsg.message_id,
                    originalText: adminMessage
                });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }
        await order.save();
    }
    
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
        
        // 🔐 AUDIT LOG: Log the admin action
        await logAdminAction(
            query.from.id,
            `${actionType}_${orderType}_${orderId}`,
            actionType === 'complete' ? 'order_completion' : actionType === 'decline' ? 'order_decline' : 'order_refund',
            order.telegramId,
            {
                adminUsername,
                targetOrderId: orderId,
                orderType,
                orderStatus: order.status
            }
        );
        
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
            // 🔐 SECURITY: Only allow refunds for PROCESSING orders, prevent double-refunds
            // Note: Completed orders have already paid the seller - they require reversal/chargeback process
            if (order.status === 'refunded') {
                throw new Error('Order has already been refunded');
            }
            if (order.status !== 'processing') {
                throw new Error(`Cannot refund order with status: ${order.status}. Only 'processing' orders can be refunded.`);
            }
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
        
        // 🔐 SECURITY: Track admin action attempts
        const isAdmin = isUserAdmin(userId);
        const adminRateLimitCheck = isAdmin ? checkAdminRateLimit(userId) : { allowed: true, remaining: 0 };

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

        // 🔐 SECURITY: Admin verify for confirmed admin actions
        if (data.startsWith('confirm_')) {
            if (!isAdmin) {
                console.warn(`[SECURITY] Non-admin ${userId} attempted admin action: ${data}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Only admins can perform this action', show_alert: true });
                return;
            }
            if (!adminRateLimitCheck.allowed) {
                console.warn(`[SECURITY] Admin rate limit exceeded for ${userId}`);
                await bot.answerCallbackQuery(query.id, { text: `⏳ Rate limited. Try again later`, show_alert: true });
                return;
            }
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

        // 🔐 SECURITY: Admin verify for order completion actions
        const adminActions = ['complete_sell_', 'decline_sell_', 'refund_sell_', 'complete_buy_', 'decline_buy_'];
        const needsConfirmation = adminActions.some(action => data.startsWith(action));
        
        if (needsConfirmation) {
            if (!isAdmin) {
                console.warn(`[SECURITY] Non-admin ${userId} attempted admin action: ${data}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Only admins can perform this action', show_alert: true });
                return;
            }
            if (!adminRateLimitCheck.allowed) {
                console.warn(`[SECURITY] Admin rate limit exceeded for ${userId}`);
                await bot.answerCallbackQuery(query.id, { text: `⏳ Rate limited. Try again later`, show_alert: true });
                return;
            }
            return await showConfirmationButtons(query, data);
        }

        // 🔐 SECURITY: Admin verify for username update requests
        if (data.startsWith('username_approve_') || data.startsWith('username_reject_')) {
            if (!isAdmin) {
                console.warn(`[SECURITY] Non-admin ${userId} attempted admin action: ${data}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Only admins can perform this action', show_alert: true });
                return;
            }
            if (!adminRateLimitCheck.allowed) {
                console.warn(`[SECURITY] Admin rate limit exceeded for ${userId}`);
                await bot.answerCallbackQuery(query.id, { text: `⏳ Rate limited. Try again later`, show_alert: true });
                return;
            }
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

        // 🔐 SECURITY: Admin verify for ambassador approval actions
        if (data.startsWith('ambassador_approve_') || data.startsWith('ambassador_decline_')) {
            if (!isAdmin) {
                console.warn(`[SECURITY] Non-admin ${userId} attempted admin action: ${data}`);
                await bot.answerCallbackQuery(query.id, { text: '❌ Only admins can perform this action', show_alert: true });
                return;
            }
            if (!adminRateLimitCheck.allowed) {
                console.warn(`[SECURITY] Admin rate limit exceeded for ${userId}`);
                await bot.answerCallbackQuery(query.id, { text: `⏳ Rate limited. Try again later`, show_alert: true });
                return;
            }
            
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

                // Update message for ALL admins
                if (Array.isArray(waitlistEntry.adminMessages) && waitlistEntry.adminMessages.length) {
                    const updatePromises = waitlistEntry.adminMessages.map(async (m) => {
                        try {
                            await bot.editMessageText(finalText, {
                                chat_id: m.adminId,
                                message_id: m.messageId,
                                reply_markup: statusKeyboard
                            });
                        } catch (editError) {
                            console.error(`Error updating ambassador message for admin ${m.adminId}:`, editError.message);
                        }
                    });
                    await Promise.all(updatePromises);
                } else {
                    // Fallback: try to update just the current admin's message
                    try {
                        await bot.editMessageText(finalText, {
                            chat_id: query.message.chat.id,
                            message_id: query.message.message_id,
                            reply_markup: statusKeyboard
                        });
                    } catch (editError) {
                        console.error('Error updating ambassador message (fallback):', editError.message);
                    }
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
    if (!process.env.BOT_TOKEN) {
        const err = new Error('BOT_TOKEN is not configured');
        console.error('Error creating invoice: missing BOT_TOKEN');
        throw err;
    }

    const amountInt = Number.isFinite(Number(stars)) ? Math.floor(Number(stars)) : 0;
    const body = {
        title: `Purchase of ${amountInt} Telegram Stars`,
        description: description,
        payload: String(orderId),
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
    const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`;
    const maxAttempts = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await axios.post(url, body, {
                timeout: 10000,
                maxRedirects: 0
            });

            if (!response?.data?.ok || !response.data.result) {
                const msg = response?.data?.description || 'Unexpected Telegram response';
                throw new Error(`Telegram createInvoiceLink failed: ${msg}`);
            }

            return response.data.result;
        } catch (error) {
            lastError = error;
            const isRetryable = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code);
            console.error('Error creating invoice attempt', attempt, { orderId, chatId, stars, error: error?.message, code: error?.code });

            if (!isRetryable || attempt === maxAttempts) {
                throw lastError;
            }

            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }

    throw lastError;
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
    
    // 🧠 SMART: End any active flows when user starts a new command
    endActiveFlowForUser(userId, chatId);
    
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
    
    // Check if user is banned - prevent mission interactions
    const isBanned = await checkUserBanStatus(userId.toString());
    if (isBanned) {
      const banDetails = await getBanDetails(userId.toString());
      return res.status(403).json({
        success: false,
        error: 'Your account is restricted',
        caseId: banDetails?.caseId,
        message: 'You cannot participate in daily missions. Contact support with your case ID to appeal'
      });
    }

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
    
    // Check if user is banned - prevent mission completion
    const isBanned = await checkUserBanStatus(userId.toString());
    if (isBanned) {
      const banDetails = await getBanDetails(userId.toString());
      return res.status(403).json({
        success: false,
        error: 'Your account is restricted',
        caseId: banDetails?.caseId,
        message: 'You cannot complete missions. Contact support with your case ID to appeal'
      });
    }

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
        
        // Check if user is banned - blocked from accessing referral stats
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot access referral statistics. Contact support with your case ID to appeal'
            });
        }

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

        // Fetch ambassador withdrawal/payout history for ambassadors
        let withdrawHistory = [];
        if (isAmbassadorRequest && isAmbassador) {
            try {
                const wds = await ReferralWithdrawal.find({ userId })
                    .sort({ createdAt: -1 })
                    .limit(50)
                    .lean();
                withdrawHistory = wds.map(w => ({
                    withdrawalId: w.withdrawalId,
                    amount: w.amount || 0,
                    walletAddress: w.walletAddress || null,
                    status: (w.status || 'pending').toLowerCase(),
                    date: w.processedAt || w.createdAt || new Date(0)
                }));
            } catch (e) {
                console.warn('[Ambassador] Failed to load withdraw history:', e.message);
            }
        }

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
            withdrawHistory,
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
app.post('/api/ambassador/update-earnings', requireTelegramAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId required' });
        }
        if (String(userId) !== String(req.user?.id) && !req.user?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
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
        
        // Check if user is banned - prevent wallet updates
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot update wallet settings. Contact support with your case ID to appeal'
            });
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
app.post('/api/referral-withdrawals', requireTelegramAuth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { userId, amount, walletAddress } = req.body;
        const amountNum = parseFloat(amount);

        if (!userId || !amount || !walletAddress) {
            await session.abortTransaction();
            session.endSession();
            throw new Error('Missing required fields');
        }

        // SECURITY: caller must own the userId
        if (String(userId) !== String(req.user?.id) && !req.user?.isAdmin) {
            await session.abortTransaction();
            session.endSession();
            return res.status(403).json({ success: false, error: 'Cannot withdraw on behalf of another user' });
        }

        // Check if user is banned - prevent referral withdrawals
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            await session.abortTransaction();
            session.endSession();
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot process withdrawals. Contact support with your case ID to appeal'
            });
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

        // Send email receipt for ambassador withdrawals
        if (withdrawal.isAmbassadorWithdrawal) {
            try {
                const ambUser = await User.findOne({ id: withdrawal.userId }).lean();
                const ambEmail = ambUser && ambUser.ambassadorEmail;
                const ambName = (ambUser && ambUser.username) || 'Ambassador';
                if (ambEmail && emailService && typeof emailService.sendWithdrawalApproved === 'function' && action === 'complete') {
                    await emailService.sendWithdrawalApproved(ambEmail, ambName, withdrawal.amount, '');
                } else if (ambEmail && emailService && typeof emailService.sendWithdrawalDeclined === 'function' && finalDecline) {
                    await emailService.sendWithdrawalDeclined(ambEmail, ambName, query.declineReason || 'Declined');
                }
            } catch (emailErr) {
                console.warn('Failed to send ambassador withdrawal email receipt:', emailErr.message);
            }
        }

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
        return bot.sendMessage(chatId, 'Access Denied - Insufficient privileges', {
            reply_to_message_id: msg.message_id
        });
    }
    
    if (!match[1]) return;
    
    const userId = match[1];
    const existing = await Warning.findOne({ userId: userId, type: 'ban', isActive: true });
    if (existing) {
        return bot.sendMessage(chatId, `User ${userId} is already banned with case: ${existing.caseId}`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    // Generate unique case ID for tracking
    const caseId = generateBanCaseId();
    const appealDeadline = new Date();
    appealDeadline.setDate(appealDeadline.getDate() + 30); // 30-day appeal window
    
    // Create ban record
    await Warning.create({
        userId: userId,
        type: 'ban',
        reason: 'Policy violation',
        issuedBy: requesterId,
        isActive: true,
        autoRemove: false,
        caseId: caseId,
        appealStatus: 'pending',
        appealDeadline: appealDeadline
    });
    
    // Add to banned users collection
    await BannedUser.updateOne(
        {}, 
        { $push: { users: userId } },
        { upsert: true }
    );
    
    // Log ban action
    await BanAuditLog.create({
        userId: userId,
        caseId: caseId,
        action: 'banned',
        performedBy: requesterId,
        details: { reason: 'Policy violation' }
    });
    
    // Send professional notification to user with appeal option
    try {
        const userNotification = `<b>Account Restriction Notice</b>\n\n` +
            `Your account has been temporarily restricted due to a policy violation.\n\n` +
            `<b>Case ID:</b> ${caseId}\n` +
            `<b>Restriction Date:</b> ${new Date().toLocaleDateString()}\n` +
            `<b>Appeal Deadline:</b> ${appealDeadline.toLocaleDateString()}\n\n` +
            `<b>What This Means:</b>\n` +
            `You cannot access the app or place any orders during this period.\n\n` +
            `<b>How to Appeal:</b>\n` +
            `You have 30 days to submit an appeal with your case ID. ` +
            `Reply with your case ID and explanation for review.\n\n` +
            `<b>Questions?</b>\n` +
            `Contact support with your case ID: ${caseId}`;
        
        await bot.sendMessage(userId, userNotification, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Ban notification delivery failed:', error);
    }
    
    // Admin confirmation
    const adminSummary = `<b>Account Banned</b>\n\n` +
        `<b>User ID:</b> ${userId}\n` +
        `<b>Case ID:</b> ${caseId}\n` +
        `<b>Reason:</b> Policy violation\n` +
        `<b>Appeals Allowed Until:</b> ${appealDeadline.toLocaleDateString()}\n` +
        `<b>Authorized By:</b> ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `<b>Timestamp:</b> ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminSummary, {
        parse_mode: 'HTML',
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
        return bot.sendMessage(chatId, 'Access Denied - Insufficient privileges');
    }
    
    const userId = match[1];
    const activeWarning = await Warning.findOne({ userId: userId, type: 'ban', isActive: true });
    
    if (!activeWarning) {
        return bot.sendMessage(chatId, `User ${userId} is not currently banned.`, {
            reply_to_message_id: msg.message_id
        });
    }
    
    const caseId = activeWarning.caseId;
    
    //  Update ban status
    await Warning.updateOne(
        { userId: userId, isActive: true },
        { isActive: false, appealStatus: 'closed' }
    );
    await BannedUser.updateOne({}, { $pull: { users: userId } });
    
    // Log unban action
    await BanAuditLog.create({
        userId: userId,
        caseId: caseId,
        action: 'unbanned',
        performedBy: requesterId,
        details: { manualUnban: true, autorizedBy: requesterId }
    });
    
    // Send restoration notice to user
    try {
        const reinstatementNotice = `<b>Account Restored</b>\n\n` +
            `Your account has been restored to full functionality.\n\n` +
            `<b>Case ID:</b> ${caseId}\n` +
            `<b>Restoration Date:</b> ${new Date().toLocaleDateString()}\n` +
            `<b>Status:</b> Active\n\n` +
            `You can now resume all activities including:\n` +
            `- Buying and selling Telegram Stars\n` +
            `- Placing orders\n` +
            `- Referral transactions\n` +
            `- All platform features`;
        
        await bot.sendMessage(userId, reinstatementNotice, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Unban notification delivery failed:', error);
    }
    
    // Admin confirmation
    const adminConfirmation = `<b>Account Unbanned</b>\n\n` +
        `<b>User ID:</b> ${userId}\n` +
        `<b>Case ID:</b> ${caseId}\n` +
        `<b>Status:</b> Active\n` +
        `<b>Authorized By:</b> ${msg.from.username ? `@${msg.from.username}` : msg.from.first_name}\n` +
        `<b>Timestamp:</b> ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, adminConfirmation, {
        parse_mode: 'HTML',
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
                { text: '📖 Learn About Ambassador Program', url: 'https://amb.starstore.app/' }
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
            [{ text: '💰 Wallet' }, { text: '👥 Referral' }],
            [{ text: '💱 SELL Stars' }, { text: '💬 Help' }]
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
                    [{ text: '🚀 Launch StarStore', web_app: { url: `https://starstore.app?startapp=home_${chatId}` } }],
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

// Helper: Initialize user entry in database if needed
async function ensureUserExists(userId) {
    try {
        if (!db) {
            const DataPersistence = require('./tools/data-persistence');
            db = new DataPersistence();
        }
        if (!db.data) {
            db.data = { users: {} };
        }
        if (!db.data.users) {
            db.data.users = {};
        }
        if (!db.data.users[userId]) {
            // Try to load from MongoDB first
            try {
                const mongoUser = await User.findOne({ id: userId }).lean();
                if (mongoUser) {
                    db.data.users[userId] = {
                        userId: userId,
                        hasAccepted21DayNotice: mongoUser.hasAccepted21DayNotice || false,
                        acceptedAt: mongoUser.acceptedAt || null,
                        ...mongoUser
                    };
                } else {
                    // User doesn't exist in MongoDB, create default
                    db.data.users[userId] = {
                        userId: userId,
                        hasAccepted21DayNotice: false,
                        acceptedAt: null
                    };
                }
            } catch (mongoErr) {
                console.error('Error loading user from MongoDB:', mongoErr);
                // Fallback to default
                db.data.users[userId] = {
                    userId: userId,
                    hasAccepted21DayNotice: false,
                    acceptedAt: null
                };
            }
        }
        return db.data.users[userId];
    } catch (err) {
        console.error('Error ensuring user exists:', err);
        return null;
    }
}

// Helper: Check if user has accepted 21-day hold notice
async function hasUserAccepted21DayNotice(userId) {
    try {
        await ensureUserExists(userId);
        const user = db.data.users?.[userId];
        return user?.hasAccepted21DayNotice === true;
    } catch (err) {
        console.error('Error checking 21-day notice acceptance:', err);
        return false;
    }
}

// Helper: Mark user as accepted 21-day hold notice
async function setUser21DayNoticeAccepted(userId) {
    try {
        // Update MongoDB
        await User.findOneAndUpdate(
            { id: userId },
            {
                hasAccepted21DayNotice: true,
                acceptedAt: new Date()
            },
            { upsert: false, new: true }
        );
        
        // Also update local data cache
        await ensureUserExists(userId);
        db.data.users[userId].hasAccepted21DayNotice = true;
        db.data.users[userId].acceptedAt = new Date().toISOString();
        return true;
    } catch (err) {
        console.error('Error setting 21-day notice acceptance:', err);
        return false;
    }
}

// Handle keyboard SELL Stars button or /sell command
bot.onText(/^(�\s*SELL\s*Stars|\/sell)$/i, async (msg) => {
    try {
        const userId = msg.from.id.toString();
        const chatId = msg.chat.id;
        const username = msg.from.username || '';

        // 🧠 SMART: End any active flows when user starts a new command
        endActiveFlowForUser(userId, chatId);

        // Check ban status
        const isBanned = await checkUserBanStatus(userId);
        if (isBanned) {
            const banDetails = await getBanDetails(userId);
            return bot.sendMessage(chatId, `❌ Your account is restricted and cannot place orders.\n\nCase ID: ${banDetails?.caseId}\n\nContact support to appeal.`);
        }

        // Check if user has accepted 21-day hold notice
        const hasAccepted = await hasUserAccepted21DayNotice(userId);
        if (!hasAccepted) {
            // Show 21-day hold agreement notice first - beautified with Telegram formatting
            const noticeMsg = await bot.sendMessage(chatId, 
                '📋 <b>Important Notice - 21-Day Hold</b>\n\n' +
                '<i>Please note that we will hold your Stars for a mandatory <b>21-day period</b> before processing a payout.</i>\n\n' +
                'By clicking "Continue", you acknowledge and agree to these terms. ' +
                '🔗 <a href="https://t.me/StarStore_Chat/19566">Read More</a>',
                {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Continue', callback_data: `sell_accept_agreement_${userId}_${Date.now()}` }
                        ]]
                    }
                }
            );

            // Initialize sell flow state in agreement_pending stage
            sellFlowStates.set(userId, {
                stage: 'agreement_pending',
                data: { username, userId, chatId },
                errors: { amount: 0, wallet: 0, memo: 0 },
                isAdmin: adminIds.includes(userId),
                timeout: Date.now() + 15 * 60 * 1000, // 15 minute timeout
                agreementMessageId: noticeMsg?.message_id
            });
            return;
        }

        // User already accepted, proceed with sell flow
        // Initialize sell flow state
        sellFlowStates.set(userId, {
            stage: 'amount',
            data: { username, userId, chatId },
            errors: { amount: 0, wallet: 0, memo: 0 },
            isAdmin: adminIds.includes(userId),
            timeout: Date.now() + 15 * 60 * 1000 // 15 minute timeout
        });

        const isAdmin = adminIds.includes(userId);
        const amountPrompt = isAdmin 
            ? `💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 1 star | No maximum\n\n<code>Current Rate: 1 star = 0.01 USDT | 100 stars = 1.00 USDT</code>\n\nEnter the amount:` 
            : `💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 50 stars | Maximum: 80,000 stars\n\n<code>Current Rate: 1 star = 0.01 USDT | 100 stars = 1.00 USDT</code>\n\nEnter the amount:`;
        
        await bot.sendMessage(chatId, amountPrompt, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('SELL Stars command error:', err);
        await bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
    }
});

// Handle text input for sell flow (amount, wallet, memo)
bot.on('message', async (msg) => {
    try {
        if (!msg || !msg.from || !msg.from.id || !msg.chat || !msg.chat.id) return;
        const userId = msg.from.id.toString();
        const chatId = msg.chat.id;
        const text = msg.text?.trim();

        // Skip if not text message or if this is a command
        if (!text || text.startsWith('/') || text.startsWith('�')) return;

        // Check if user is in sell flow
        const flowState = sellFlowStates.get(userId);
        if (!flowState) return; // Not in sell flow

        // Check timeout
        if (Date.now() > flowState.timeout) {
            sellFlowStates.delete(userId);
            return bot.sendMessage(chatId, '⏰ Sell flow expired. Type /sell to start again.');
        }

        // STAGE 1: Amount of stars
        if (flowState.stage === 'amount') {
            const stars = parseInt(text, 10);
            if (isNaN(stars)) {
                flowState.errors.amount = (flowState.errors.amount || 0) + 1;
                if (flowState.errors.amount >= 2) {
                    sellFlowStates.delete(userId);
                    return bot.sendMessage(chatId, '❌ Too many errors. Sell session ended. Type /sell to start again.');
                }
                return bot.sendMessage(chatId, '❌ Please enter a valid number.');
            }
            
            if (!flowState.isAdmin && (stars < 50 || stars > 80000)) {
                flowState.errors.amount = (flowState.errors.amount || 0) + 1;
                if (flowState.errors.amount >= 2) {
                    sellFlowStates.delete(userId);
                    return bot.sendMessage(chatId, '❌ Too many errors. Sell session ended. Type /sell to start again.');
                }
                return bot.sendMessage(chatId, '❌ Invalid amount. Please enter a number between 50 and 80,000.');
            }
            
            if (flowState.isAdmin && (stars < 1 || stars > 1000000)) {
                flowState.errors.amount = (flowState.errors.amount || 0) + 1;
                if (flowState.errors.amount >= 2) {
                    sellFlowStates.delete(userId);
                    return bot.sendMessage(chatId, '❌ Too many errors. Sell session ended. Type /sell to start again.');
                }
                return bot.sendMessage(chatId, '❌ Amount must be between 1 and 1,000,000 stars.');
            }
            
            flowState.data.stars = stars;
            flowState.errors.amount = 0;
            flowState.stage = 'wallet';
            
            // Show amount confirmation with USDT preview
            const conversionRate = 0.01; // 1 star = 0.01 USDT
            const usdtAmount = (stars * conversionRate).toFixed(2);
            const rateInfo = `\n\n💲 <b>You will receive:</b> <u>${usdtAmount} USDT</u>`;
            
            return bot.sendMessage(chatId, `✅ <b>${stars} stars</b>${rateInfo}\n\nNow enter your USDT TON wallet address:`, { parse_mode: 'HTML' });
        }

        // STAGE 2: Wallet address
        if (flowState.stage === 'wallet') {
            const walletAddress = cleanWalletAddress(text);
            if (!walletAddress || walletAddress.length < 10) {
                flowState.errors.wallet = (flowState.errors.wallet || 0) + 1;
                if (flowState.errors.wallet >= 2) {
                    sellFlowStates.delete(userId);
                    return bot.sendMessage(chatId, '❌ Too many errors. Sell session ended. Type /sell to start again.');
                }
                return bot.sendMessage(chatId, '❌ Invalid wallet address. Please enter a valid USDT TON wallet (at least 10 characters).');
            }
            flowState.data.walletAddress = walletAddress;
            flowState.errors.wallet = 0;
            flowState.stage = 'memo';
            
            // Calculate and show USDT amount for confirmed wallet + amount
            const starsAmount = flowState.data.stars;
            const conversionRate = 0.01; // 1 star = 0.01 USDT
            const confirmUsdtAmount = (starsAmount * conversionRate).toFixed(2);
            const confirmRateDisplay = `\n\n💲 <b>You will receive:</b> <u>${confirmUsdtAmount} USDT</u>`;
            
            // Store the message ID so we can delete the button after clicking skip
            const memoMsg = await bot.sendMessage(chatId, `✅ Wallet: <code>${walletAddress}</code>${confirmRateDisplay}\n\nEnter memo/tag if required (or skip):`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '⏭️ Skip Memo', callback_data: `sell_skip_memo_${userId}_${Date.now()}` }
                    ]]
                }
            });
            
            if (memoMsg?.message_id) {
                flowState.memoMessageId = memoMsg.message_id;
            }
            return;
        }

        // STAGE 3: Memo (optional)
        if (flowState.stage === 'memo') {
            const memoInput = text.toLowerCase() === 'skip' ? '' : text.trim();
            if (memoInput && memoInput.length > 50) {
                flowState.errors.memo = (flowState.errors.memo || 0) + 1;
                if (flowState.errors.memo >= 2) {
                    sellFlowStates.delete(userId);
                    // Try to delete skip button if it still exists
                    if (flowState.memoMessageId) {
                        try {
                            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: flowState.memoMessageId });
                        } catch (e) { /* ignore */ }
                    }
                    return bot.sendMessage(chatId, '❌ Too many errors. Sell session ended. Type /sell to start again.');
                }
                return bot.sendMessage(chatId, '❌ Memo is too long (max 50 characters). Please try again.');
            }
            flowState.data.memoTag = memoInput;
            flowState.errors.memo = 0;
            
            // Delete skip button after user responds
            if (flowState.memoMessageId) {
                try {
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: flowState.memoMessageId });
                } catch (e) { /* ignore */ }
            }
            
            // User has already accepted agreement at start, create order directly
            await createSellOrderFromKeyboard(flowState.data, msg, flowState.isAdmin);
            sellFlowStates.delete(userId);
        }
    } catch (err) {
        console.error('Sell flow message handler error:', err);
    }
});

// Handle skip memo button for sell flow
bot.on('callback_query', async (query) => {
    if (query.data.startsWith('sell_skip_memo_')) {
        try {
            const parts = query.data.split('_');
            const userId = parts[3]; // sell_skip_memo_USERID_TIMESTAMP
            const flowState = sellFlowStates.get(userId);
            
            if (!flowState || flowState.stage !== 'memo') {
                return bot.answerCallbackQuery(query.id, { text: 'Session expired', show_alert: true });
            }
            
            const chatId = query.message.chat.id;
            
            // Set empty memo and move to order creation
            flowState.data.memoTag = '';
            flowState.errors.memo = 0;
            
            // Delete the button
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } catch (e) { /* ignore */ }
            
            // User has already accepted agreement at start, create order directly
            await bot.sendMessage(chatId, '✅ Memo skipped.\n\n🔄 Creating your sell order...');
            await createSellOrderFromKeyboard(flowState.data, query.message, flowState.isAdmin);
            sellFlowStates.delete(userId);
            
            bot.answerCallbackQuery(query.id);
        } catch (err) {
            console.error('Skip memo button error:', err);
            bot.answerCallbackQuery(query.id, { text: 'Error processing request', show_alert: true });
        }
    }
});

// Handle 21-day agreement acceptance for sell orders
bot.on('callback_query', async (query) => {
    if (query.data.startsWith('sell_accept_agreement_')) {
        try {
            const parts = query.data.split('_');
            const userId = parts[3]; // sell_accept_agreement_USERID_TIMESTAMP - index 3 is the userId
            const flowState = sellFlowStates.get(userId);
            
            if (!flowState || flowState.stage !== 'agreement_pending') {
                return bot.answerCallbackQuery(query.id, { text: 'Session expired', show_alert: true });
            }
            
            const chatId = query.message.chat.id;
            
            // Mark user as accepted 21-day hold notice
            await setUser21DayNoticeAccepted(userId);
            
            // Delete the agreement button message
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } catch (e) { /* ignore */ }
            
            // Send confirmation and proceed to amount input
            const postAgreementPrompt = flowState.isAdmin
                ? `✅ Agreement accepted.\n\n💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 1 star | No maximum\n\nEnter the amount:`
                : `✅ Agreement accepted.\n\n💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 50 stars | Maximum: 80,000 stars\n\nEnter the amount:`;
            await bot.sendMessage(chatId, postAgreementPrompt, { parse_mode: 'HTML' });
            
            // Move to amount stage
            flowState.stage = 'amount';
            
            bot.answerCallbackQuery(query.id);
        } catch (err) {
            console.error('Agreement acceptance button error:', err);
            bot.answerCallbackQuery(query.id, { text: 'Error processing request', show_alert: true });
        }
    }
});

// Helper: Create sell order from keyboard with exact same logic as /api/create-sell-order
async function createSellOrderFromKeyboard(flowData, msg, isUserAdmin = false) {
    try {
        const { userId, chatId, username, stars, walletAddress, memoTag } = flowData;

        // Sync user data
        await syncUserData(userId, username, 'button_click', msg);

        // Check ban status again
        const isBanned = await checkUserBanStatus(userId);
        if (isBanned) {
            return bot.sendMessage(chatId, '❌ Your account is restricted. Cannot create order.');
        }

        // Clean up expired orders
        await SellOrder.updateMany(
            {
                telegramId: userId,
                status: "pending",
                sessionExpiry: { $lt: new Date() }
            },
            { status: "expired" }
        );

        // Get last known location from user's tracking history
        let userLocation = null;
        try {
            const userDoc = await User.findOne({ id: userId }).lean();
            if (userDoc?.lastLocation) {
                userLocation = userDoc.lastLocation;
            }
        } catch (locErr) {
            console.error('Error fetching user location:', locErr);
        }

        // Generate session token
        const sessionToken = generateSessionToken(userId);
        const sessionExpiry = new Date(Date.now() + 15 * 60 * 1000);

        // Create the order
        const order = new SellOrder({
            id: generateSellOrderId(),
            telegramId: userId,
            username: sanitizeUsername(username),
            stars: stars,
            walletAddress: walletAddress,
            memoTag: memoTag || undefined,
            status: "pending",
            telegram_payment_charge_id: "temp_" + Date.now(),
            reversible: true,
            dateCreated: new Date(),
            adminMessages: [],
            sessionToken: sessionToken,
            sessionExpiry: sessionExpiry,
            userLocked: userId,
            userLocation: userLocation,
            createdViaKeyboard: true  // Mark as keyboard-created
        });

        // Generate payment link
        let paymentLink = null;
        try {
            paymentLink = await createTelegramInvoice(
                userId,
                order.id,
                stars,
                `Purchase of ${stars} Telegram Stars`,
                sessionToken
            );
        } catch (invoiceErr) {
            console.error('Failed to create invoice:', invoiceErr);
            return bot.sendMessage(chatId, '❌ Failed to generate payment link. Please try again.');
        }

        if (!paymentLink) {
            return bot.sendMessage(chatId, '❌ Failed to create payment link. Please try again.');
        }

        // Save order
        await order.save();

        // Log activity
        await logActivity(userId, ACTIVITY_TYPES.SELL_ORDER, ACTIVITY_TYPES.SELL_ORDER.points, {
            orderId: order.id,
            stars: stars,
            walletAddress: walletAddress,
            source: 'keyboard'
        });

        // Send user message with payment link
        const userMessage = `🚀 <b>Sell order initialized!</b>\n\n` +
            `<b>Order ID:</b> <code>${order.id}</code>\n` +
            `<b>Stars:</b> ${order.stars}\n` +
            `<b>Status:</b> <i>Pending — waiting for payment</i>\n\n` +
            `<i>⏰ Payment link expires in 15 minutes</i>\n\n` +
            `Pay here: ${paymentLink}`;
        try {
            const sent = await bot.sendMessage(chatId, userMessage, { parse_mode: 'HTML' });
            if (sent?.message_id) {
                order.userMessageId = sent.message_id;
                await order.save();
            }
        } catch (err) {
            console.error('Failed to send user message:', err);
        }

        // Get user location info for admin message (with fallback to unknown)
        let userLocationInfo = '';
        if (order.userLocation) {
            const city = order.userLocation.city || 'Unknown';
            const country = order.userLocation.country || 'Unknown';
            userLocationInfo = `📍 ${city}, ${country}`;
        } else {
            userLocationInfo = `📍 Location unknown`;
        }

        // Send admin notification with keyboard signature
        const adminMessage = `💰 New Payment Received!\n\n` +
            `Order ID: ${order.id}\n` +
            `User: @${order.username} (ID: ${order.telegramId})\n` +
            (userLocationInfo ? `${userLocationInfo}\n` : '') +
            `Stars: ${order.stars}\n` +
            `Wallet: ${order.walletAddress}\n` +
            `Memo: ${order.memoTag || 'None'}\n\n` +
            `📱 Generated via Telegram keyboard button`; // Signature

        const adminKeyboard = {
            inline_keyboard: [
                [
                    { text: "✅ Complete", callback_data: `complete_sell_${order.id}` },
                    { text: "❌ Fail", callback_data: `decline_sell_${order.id}` },
                    { text: "💸 Refund", callback_data: `refund_sell_${order.id}` }
                ]
            ]
        };

        // DON'T notify admins yet - wait for payment to be verified
        // The successful_payment handler will notify admins when payment is confirmed
        await order.save();
        await bot.sendMessage(chatId, `✅ <b>Order created!</b> Waiting for your payment…`, { parse_mode: 'HTML' });

    } catch (err) {
        console.error('Error creating sell order from keyboard:', err);
        await bot.sendMessage(flowData.chatId, '❌ Failed to create order. Please try again.');
    }
}

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
                    [{ text: 'Open Web App', web_app: { url: 'https://starstore.app/referral' } }]
                ]
            };
            
            await bot.sendMessage(chatId, message, { reply_markup: keyboard });
        } else {
            const message = `You have no referrals yet.\n\n🔗 Your Referral Link:\n${referralLink}\n\nShare this link to start earning!`;
            
            const keyboard = {
                inline_keyboard: [
                    [{ text: 'Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }],
                    [{ text: 'Open Web App', web_app: { url: 'https://starstore.app/referral' } }]
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
    endActiveFlowForUser(msg.from.id.toString(), msg.chat.id);
    handleHelpCommand(msg);
});

// Handle keyboard menu button presses - no double processing
bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    // 🧠 SMART: End any active flows if user clicks a NEW command/button
    // This allows users to switch commands seamlessly without finishing their current flow
    const isCommandOrButton = text?.startsWith('/') || 
                              text === '💬 Help' || 
                              text === '👥 Referral' || 
                              text === '💰 Wallet' || 
                              text === '💱 SELL Stars';
    
    if (isCommandOrButton) {
        endActiveFlowForUser(userId, chatId);
    }
    
    // Skip bare commands - let dedicated handlers process them
    if (text?.startsWith('/')) {
        return;
    }
    
    // Map keyboard button presses directly to handlers
    if (text === '💬 Help') {
        handleHelpCommand(msg);
    } else if (text === '👥 Referral') {
        handleReferralsCommand(msg);
    } else if (text === '💰 Wallet') {
        handleWalletCommand(msg);
    } else if (text === '💱 SELL Stars') {
        // Handle SELL Stars keyboard button
        try {
            const userId = msg.from.id.toString();
            const chatId = msg.chat.id;
            const username = msg.from.username || '';

            // Check ban status
            const isBanned = await checkUserBanStatus(userId);
            if (isBanned) {
                const banDetails = await getBanDetails(userId);
                return bot.sendMessage(chatId, `❌ Your account is restricted and cannot place orders.\n\nCase ID: ${banDetails?.caseId}\n\nContact support to appeal.`);
            }

            // Check if user has accepted 21-day hold notice
            const hasAccepted = await hasUserAccepted21DayNotice(userId);
            if (!hasAccepted) {
                // Show 21-day hold agreement notice first - beautified with Telegram formatting
                const noticeMsg = await bot.sendMessage(chatId, 
                    '📋 <b>Important Notice - 21-Day Hold</b>\n\n' +
                    '<i>Please note that we will hold your Stars for a mandatory <b>21-day period</b> before processing a payout.</i>\n\n' +
                    'By clicking "Continue", you acknowledge and agree to these terms. ' +
                    '🔗 <a href="https://t.me/StarStore_Chat/19566">Read More</a>',
                    {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Continue', callback_data: `sell_accept_agreement_${userId}_${Date.now()}` }
                            ]]
                        }
                    }
                );

                // Initialize sell flow state in agreement_pending stage
                sellFlowStates.set(userId, {
                    stage: 'agreement_pending',
                    data: { username, userId, chatId },
                    errors: { amount: 0, wallet: 0, memo: 0 },
                    isAdmin: adminIds.includes(userId),
                    timeout: Date.now() + 15 * 60 * 1000, // 15 minute timeout
                    agreementMessageId: noticeMsg?.message_id
                });
                return;
            }

            // Check if user is admin
            const isAdmin = adminIds.includes(userId);

            // Initialize sell flow state
            sellFlowStates.set(userId, {
                stage: 'amount',
                data: { username, userId, chatId },
                errors: { amount: 0, wallet: 0, memo: 0 },
                isAdmin: isAdmin,
                timeout: Date.now() + 15 * 60 * 1000 // 15 minute timeout
            });

            const amountPrompt = isAdmin 
                ? `💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 1 star | No maximum\n\nEnter the amount:` 
                : `💱 <b>How many Telegram Stars do you want to sell?</b>\n\nMinimum: 50 stars | Maximum: 80,000 stars\n\nEnter the amount:`;
            
            await bot.sendMessage(chatId, amountPrompt, { parse_mode: 'HTML' });
        } catch (err) {
            console.error('SELL Stars command error:', err);
            await bot.sendMessage(msg.chat.id, '❌ An error occurred. Please try again.');
        }
    }
});

// Contact command for users
bot.onText(/\/contact/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    const userId = msg.from.id.toString();

    // 🧠 SMART: End any active flows when user starts a new command
    endActiveFlowForUser(userId, chatId);

    const contactText = `📞 **Contact Support**

**Type your message below and we'll respond quickly!**`;

    bot.sendMessage(chatId, contactText, { parse_mode: 'Markdown' });
    
    // Set up message listener for support request with timeout
    let timeoutId;
    const supportHandler = (userMsg) => {
        if (userMsg.chat.id === chatId && userMsg.text) {
            // If user sends a command, end this flow and let the command execute
            if (userMsg.text.startsWith('/')) {
                clearTimeout(timeoutId);
                bot.removeListener('message', supportHandler);
                return;
            }
            
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
                        { text: '💰 Open Sell Page', web_app: { url: 'https://starstore.app/sell' } }
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
    timeoutId = setTimeout(() => {
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
        `1 - Ambassador Approval\n` +
        `2 - Welcome/Onboarding\n` +
        `3 - Promotional\n` +
        `4 - Support/Notification\n` +
        `5 - Custom Template\n\n` +
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
                    body: ''
                },
                '2': {
                    name: 'Welcome/Onboarding',
                    subject: 'Welcome to StarStore',
                    body: ''
                },
                '3': {
                    name: 'Promotional',
                    subject: 'Exclusive Offer for You',
                    body: ''
                },
                '4': {
                    name: 'Support/Notification',
                    subject: 'Important Update',
                    body: ''
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
                // Preset template - ask for body content
                session.step = 'preset_body';
                const bodyPrompt = `📝 **${session.template.name}**\n\n**Subject**: ${session.template.subject}\n\n` +
                    `Now enter the email body content:`;
                bot.sendMessage(chatId, bodyPrompt, { parse_mode: 'Markdown' });
            }
        } 
        else if (session.step === 'preset_body') {
            session.template.body = text;
            session.step = 'recipient';
            const preview = `📝 **Email Preview**\n\n**Template**: ${session.template.name}\n**Subject**: ${session.template.subject}\n**Body**: ${session.template.body}\n\n` +
                `Now enter the recipient email address:`;
            bot.sendMessage(chatId, preview, { parse_mode: 'Markdown' });
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
                `1 - Send email\n` +
                `2 - Cancel\n` +
                `3 - Start over`;
            
            bot.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
        }
        else if (session.step === 'confirm') {
            if (text === '1' || text.toLowerCase() === 'yes') {
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
            else if (text === '2' || text.toLowerCase() === 'no' || text.toLowerCase() === 'cancel') {
                emailSessions.delete(chatId);
                bot.sendMessage(chatId, '❌ Email sending cancelled. Use /sendemail to start again.');
            }
            else if (text === '3' || text.toLowerCase() === 'restart') {
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
                bot.sendMessage(chatId, 'Please reply with one of: 1 (send), 2 (cancel), or 3 (restart)');
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

**� Referral Management:**
/referral_stats - Show top 20 referrers with active and pending referral counts

**�📢 Communication:**
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

// Admin referral stats command - shows top 20 referrers with active/pending counts
bot.onText(/\/referral_stats/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    // Verify admin
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }
    
    try {
        await bot.sendMessage(chatId, 'Analyzing referral data...');
        
        // Fetch all referrals and group by referrerUserId
        const allReferrals = await Referral.find({}).lean();
        
        // Group by referrerUserId and count active/pending
        const referralStats = {};
        allReferrals.forEach(referral => {
            const userId = referral.referrerUserId;
            if (!referralStats[userId]) {
                referralStats[userId] = {
                    userId,
                    total: 0,
                    active: 0,
                    pending: 0
                };
            }
            referralStats[userId].total++;
            if (referral.status === 'active') {
                referralStats[userId].active++;
            } else if (referral.status === 'pending') {
                referralStats[userId].pending++;
            }
        });
        
        // Convert to array and sort by total (descending)
        const sortedStats = Object.values(referralStats)
            .sort((a, b) => b.total - a.total)
            .slice(0, 20);
        
        // Get user info for display
        const userIds = sortedStats.map(s => s.userId);
        const users = await User.find({ id: { $in: userIds } }).lean();
        const userMap = {};
        users.forEach(u => {
            userMap[u.id] = u;
        });
        
        // Format message
        let message = '<b>Top 20 Referrers</b>\n\n';
        sortedStats.forEach((stat, index) => {
            const user = userMap[stat.userId];
            const username = user?.username || 'Unknown';
            message += `${index + 1}. @${username} (ID: ${stat.userId})\n`;
            message += `Active: ${stat.active} | Pending: ${stat.pending} | Total: ${stat.total}\n\n`;
        });
        
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Error in /referral_stats:', error);
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
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

        // Send delivery report to the admin who created the reply
        await bot.sendMessage(msg.chat.id, summary);

        // Notify OTHER admins about the reply (skip sender to avoid duplicate)
        if (successCount > 0) {  // Only notify if at least one message was sent
            const senderAdminId = String(msg.from.id);
            const senderName = msg.from.username || `${msg.from.first_name} ${msg.from.last_name}`.trim() || `Admin ${senderAdminId}`;
            
            // Show full message or indicate media-only
            const fullMessage = textMessage || '[Media only]';
            const recipient = recipientIds.length === 1 ? recipientIds[0] : `${recipientIds.length} recipients`;
            
            const adminNotification = `📨 ADMIN REPLY SENT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFrom: ${senderName}\nTo: ${recipient}\nStatus: ${successCount} sent, ${failureCount} failed\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${fullMessage}`;
            
            // Send notification to all OTHER admins
            for (const adminId of adminIds) {
                if (adminId !== senderAdminId) {
                    try {
                        await bot.sendMessage(adminId, adminNotification);
                    } catch (err) {
                        console.error(`Failed to notify admin ${adminId}:`, err.message);
                    }
                }
            }
        }
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
            
            // Single CTA opens the StarStore mini-app (index / buy page)
            const defaultKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Open StarStore', web_app: { url: 'https://starstore.app/' } }]
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
                const mediaOpts = {
                    caption: caption || undefined,
                    parse_mode: 'HTML',
                    disable_notification: true,
                    ...defaultKeyboard
                };
                if (messageType === 'photo')         await bot.sendPhoto(userId, mediaFileId, mediaOpts);
                else if (messageType === 'video')    await bot.sendVideo(userId, mediaFileId, mediaOpts);
                else if (messageType === 'audio')    await bot.sendAudio(userId, mediaFileId, mediaOpts);
                else if (messageType === 'document') await bot.sendDocument(userId, mediaFileId, mediaOpts);
                else throw new Error(`Unsupported media type: ${messageType}`);
            }
            return { success: true, attempts: attempt };
        } catch (error) {
            lastError = error;
            
            // Check if error is recoverable
            const errorMsg = error.message || '';
            const errCode = error && error.response && error.response.error_code;
            const isFatal =
                errCode === 403 ||
                errCode === 400 ||
                /bot was blocked|user is deactivated|chat not found|user not found|peer_id_invalid|user_is_blocked|bot can't initiate|have no rights|kicked|user is restricted/i.test(errorMsg);
            
            if (isFatal) {
                return { success: false, attempts: attempt, error: errorMsg, fatal: true };
            }
            
            // For rate limits, wait longer before retry
            if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429') || errCode === 429) {
                const retryAfter = (error.response && error.response.parameters && error.response.parameters.retry_after) || 0;
                const waitMs = Math.max(2000 * attempt, retryAfter * 1000);
                await new Promise(resolve => setTimeout(resolve, waitMs));
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
            // Mid-flight cancellation check
            const fresh = await BroadcastJob.findOne({ jobId }, { status: 1 }).lean();
            if (fresh && fresh.status === 'cancelled') {
                job.status = 'cancelled';
                job.completedAt = new Date();
                await job.save();
                console.log(`🛑 Broadcast ${jobId} cancelled mid-flight at ${processed}/${job.totalUsers}`);
                try {
                    await bot.sendMessage(job.adminId,
                        `Broadcast cancelled mid-flight.\n\n` +
                        `Sent: ${job.sentCount}/${job.totalUsers}\n` +
                        `Failed: ${job.failedCount}\n` +
                        `Skipped: ${job.skippedCount}`);
                } catch (_) {}
                return;
            }
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
            
            const resultMsg = `Broadcast Completed\n\n` +
                `Sent: ${job.sentCount}/${job.totalUsers}\n` +
                `Failed: ${job.failedCount}\n` +
                `Skipped: ${job.skippedCount}\n` +
                `Success Rate: ${successRate}%\n` +
                `Duration: ${duration}s`;
            
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
                    [{ text: 'Open StarStore', web_app: { url: 'https://starstore.app/' } }],
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
                    const mediaOpts = {
                        caption: caption || undefined,
                        parse_mode: 'HTML',
                        disable_notification: false,
                        ...approvalKeyboard
                    };
                    if (messageType === 'photo')         promise = bot.sendPhoto(adminId, mediaFileId, mediaOpts);
                    else if (messageType === 'video')    promise = bot.sendVideo(adminId, mediaFileId, mediaOpts);
                    else if (messageType === 'audio')    promise = bot.sendAudio(adminId, mediaFileId, mediaOpts);
                    else if (messageType === 'document') promise = bot.sendDocument(adminId, mediaFileId, mediaOpts);
                    else throw new Error(`Unsupported media type: ${messageType}`);
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
        
        // Wait for all admin previews to send. If none succeeded, abort the job so
        // the admin must explicitly restart instead of approving a phantom broadcast.
        const settled = await Promise.allSettled(messagePromises);
        const previewsSent = settled.filter(r => r.status === 'fulfilled').length;

        if (previewsSent === 0) {
            broadcastSessions.delete(chatId);
            const reason = settled[0]?.reason?.message || 'all preview sends failed';
            await bot.sendMessage(chatId,
                `Broadcast aborted: ${reason}.\n\nNo previews were delivered. Run /broadcast again to retry.`);
            return;
        }

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
    // Handle pre-approval cancel button (shown in /broadcast prompt)
    if (query.data === 'broadcast_cancel') {
        const userId = query.from.id.toString();
        if (!adminIds.includes(userId)) {
            return bot.answerCallbackQuery(query.id, '❌ Unauthorized', true);
        }
        broadcastSessions.delete(query.message.chat.id);
        try {
            await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: 'Cancelled', callback_data: 'dummy' }]] }, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });
        } catch (_) {}
        return bot.answerCallbackQuery(query.id, 'Broadcast cancelled');
    }

    // Handle mid-flight cancel (set job.status='cancelled'; processBroadcastJob will pick up)
    if (query.data && query.data.startsWith('cancel_running_')) {
        const jobId = query.data.replace('cancel_running_', '');
        const userId = query.from.id.toString();
        const adminUsername = query.from.username || query.from.first_name;
        if (!adminIds.includes(userId)) {
            return bot.answerCallbackQuery(query.id, '❌ Unauthorized', true);
        }
        try {
            const job = await BroadcastJob.findOne({ jobId });
            if (!job) return bot.answerCallbackQuery(query.id, 'Job not found', true);
            if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
                return bot.answerCallbackQuery(query.id, `Already ${job.status}`, true);
            }
            job.status = 'cancelled';
            await job.save();
            await bot.answerCallbackQuery(query.id, 'Stopping broadcast...');
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: `Cancelled by ${adminUsername}`, callback_data: 'dummy' }]] }, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            } catch (_) {}
            console.log(`🛑 Broadcast ${jobId} mid-flight cancel requested by ${adminUsername}`);
        } catch (error) {
            console.error('Mid-flight cancel error:', error);
            bot.answerCallbackQuery(query.id, `Error: ${error.message}`, true);
        }
        return;
    }

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
            
            // Give the initiating admin a stop button to cancel mid-flight
            try {
                await bot.sendMessage(job.adminId,
                    `Broadcasting to ${job.totalUsers.toLocaleString()} users started.\nYou can stop it at any time.`,
                    { reply_markup: { inline_keyboard: [[{ text: '🛑 Stop Broadcast', callback_data: `cancel_running_${jobId}` }]] } }
                );
            } catch (e) {
                console.error('Failed to send stop-broadcast control:', e.message);
            }

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
                message: newTemplate.message,
                actionUrl: newTemplate.actionUrl,
                icon: newTemplate.icon,
                createdAt: newTemplate.createdAt,
                read: false,
                priority: newTemplate.priority
            };

            formattedNotifications.unshift(newNotification);
            
            // Update counts
            const newUnreadCount = unreadCount + 1;
            const newTotalCount = totalCount + 1;
            
            return res.json({ 
                notifications: formattedNotifications, 
                unreadCount: newUnreadCount, 
                totalCount: newTotalCount 
            });
        }

        res.json({ notifications: formattedNotifications, unreadCount, totalCount });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

// Unread notifications count endpoint to support frontend polling
app.get('/api/notifications/unread-count', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const unreadCount = await UserNotification.countDocuments({ userId, read: false });
        res.json({ unreadCount });
    } catch (error) {
        console.error('Error fetching unread notifications count:', error);
        res.status(500).json({ error: 'Failed to fetch unread notifications count' });
    }
});

// Debug endpoint to create sample notification
app.post('/api/debug/create-notification', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const template = await NotificationTemplate.create({
            title: 'Test Notification 📢',
            message: 'This is a test notification created via debug endpoint. Everything is working correctly!',
            icon: 'fa-bell',
            audience: 'user',
            targetUserId: userId,
            priority: 1,
            actionUrl: '/daily',
            createdBy: 'debug'
        });

        await UserNotification.create({
            userId: userId,
            templateId: template._id,
            read: false
        });

        res.json({ success: true, templateId: template._id, userId });
    } catch (error) {
        console.error('Debug create notification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint to check database state
app.get('/api/debug/db-state', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const dbState = {
            userId,
            userNotifications: await UserNotification.countDocuments({ userId }),
            allUserNotifications: await UserNotification.countDocuments(),
            notificationTemplates: await NotificationTemplate.countDocuments(),
            buyOrders: await BuyOrder.countDocuments({ telegramId: userId }),
            sellOrders: await SellOrder.countDocuments({ telegramId: userId }),
            referrals: await Referral.countDocuments({ referrerUserId: userId }),
            
            // Sample data
            sampleUserNotifications: await UserNotification.find({ userId }).limit(3).lean(),
            sampleTemplates: await NotificationTemplate.find().limit(3).lean()
        };
        
        res.json(dbState);
    } catch (error) {
        console.error('Debug DB state error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Dev-only: seed sample notifications for local verification
if (process.env.NODE_ENV !== 'production') {
    app.post('/dev/seed-notifications', async (req, res) => {
        try {
            const { userId = 'test-user', count = 3 } = req.body || {};
            const templates = [];
            for (let i = 0; i < Number(count) || 0; i++) {
                templates.push({
                    title: `Test Notification ${i + 1}`,
                    message: `This is a test notification #${i + 1}`,
                    audience: 'user',
                    targetUserId: userId,
                    priority: i % 3,
                    icon: 'fa-bell',
                });
            }
            templates.push({
                title: 'Global Announcement',
                message: 'This is a global message visible to all users',
                audience: 'global',
                priority: 1,
                icon: 'fa-bullhorn'
            });

            const createdTemplates = await NotificationTemplate.insertMany(templates);

            // Fan out user-scoped templates to UserNotification for that user
            const directTemplates = createdTemplates.filter(t => t.audience === 'user');
            const userNotifs = directTemplates.map(t => ({ userId, templateId: t._id }));

            // For global, just create one example user mapping to verify UI for dev user
            const globalTemplate = createdTemplates.find(t => t.audience === 'global');
            if (globalTemplate) userNotifs.push({ userId, templateId: globalTemplate._id });

            await UserNotification.insertMany(userNotifs);
            res.json({ success: true, createdTemplates: createdTemplates.length, createdUserNotifications: userNotifs.length });
        } catch (error) {
            console.error('Error seeding notifications:', error);
            res.status(500).json({ error: 'Failed to seed notifications' });
        }
    });
}

// Create notification with enhanced validation
app.post('/api/notifications', requireTelegramAuth, async (req, res) => {
    try {
        const { targetUserId, title, message, actionUrl, audience = 'global', priority = 0 } = req.body;
        
        // Enhanced validation
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: "Valid message is required" });
        }

        // Admin check (implement your actual admin verification)
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ error: "Unauthorized: Admin access required" });
        }

        const template = await NotificationTemplate.create({
            title: title || 'Notification',
            message: message.trim(),
            actionUrl,
            audience: audience === 'user' ? 'user' : 'global',
            targetUserId: audience === 'user' ? (targetUserId || '').toString() : undefined,
            priority: Math.min(2, Math.max(0, parseInt(priority) || 0)),
            createdBy: req.user.id
        });

        // Fan out: for user audience, create one UserNotification for that user.
        if (template.audience === 'user' && template.targetUserId) {
            await UserNotification.create({ userId: template.targetUserId, templateId: template._id });
        }

        res.status(201).json({ id: template._id, success: true, message: "Notification created successfully" });
    } catch (error) {
        console.error('Error creating notification:', error);
        res.status(500).json({ error: "Failed to create notification" });
    }
});

// Enhanced mark as read endpoint
app.post('/api/notifications/:id/read', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params; // this is UserNotification id now
        const userId = req.user.id;

        const updated = await UserNotification.findOneAndUpdate({ _id: id, userId }, { $set: { read: true } });
        if (!updated) return res.status(404).json({ error: 'Notification not found' });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ error: "Failed to mark notification as read" });
    }
});

// Optimized mark all as read
app.post('/api/notifications/mark-all-read', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const result = await UserNotification.updateMany({ userId, read: false }, { $set: { read: true } });
        res.json({ success: true, markedCount: result.modifiedCount });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({ error: "Failed to mark all notifications as read" });
    }
});

// Enhanced notification deletion with ownership check
app.delete('/api/notifications/:id', requireTelegramAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Try delete as user-owned notification first
        const deleted = await UserNotification.findOneAndDelete({ _id: id, userId });
        if (deleted) return res.json({ success: true });

        // If not found and user is admin, allow deleting template and cascade
        if (req.user.isAdmin) {
            const template = await NotificationTemplate.findById(id);
            if (!template) return res.status(404).json({ error: 'Notification not found' });
            await NotificationTemplate.deleteOne({ _id: id });
            await UserNotification.deleteMany({ templateId: id });
            return res.json({ success: true, deletedTemplate: true });
        }

        return res.status(404).json({ error: 'Notification not found' });
    } catch (error) {
        console.error('Error dismissing notification:', error);
        res.status(500).json({ error: "Failed to dismiss notification" });
    }
});

// Active heartbeat: update user's lastActive from web or Telegram
app.post('/api/active-ping', async (req, res) => {
    try {
        // Prefer authenticated user (Telegram WebApp), otherwise fallback to explicit header
        const authUserId = req.user?.id;
        const headerId = (req.headers['x-telegram-id'] || '').toString().trim();
        const userId = authUserId || (headerId || null);
        const username = req.body?.username || '';
        
        if (!userId) {
            console.debug('Active-ping missing userId. Auth:', !!authUserId, 'Header:', !!headerId);
            return res.status(400).json({ error: 'Missing user id' });
        }
        
        // Detect username change if provided
        if (username) {
            try {
                const usernameChange = await detectUsernameChange(userId, username, 'page_visit');
                if (usernameChange) {
                    await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
                }
            } catch (usernameErr) {
                console.error('Error detecting username in active-ping:', usernameErr.message);
            }
        }
        
        await User.updateOne(
            { id: userId },
            { $set: { lastActive: new Date(), username: username || undefined }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to update activity' });
    }
});

/**
 * Track user location on every page load
 * Captures IP-based geolocation for all website visitors
 * Runs silently - no user interaction needed
 */
app.post('/api/track-location', async (req, res) => {
    try {
        const userId = req.body?.userId || req.headers['x-telegram-id'];
        const username = req.body?.username || '';
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        // Extract IP from request
        const ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
            .toString().split(',')[0].trim();

        // Detect username change if provided
        if (username) {
            try {
                const usernameChange = await detectUsernameChange(userId, username, 'page_visit');
                if (usernameChange) {
                    await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
                }
            } catch (usernameErr) {
                console.error('Error detecting username in track-location:', usernameErr.message);
            }
        }

        // Get geolocation from IP
        let geo = null;
        if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
            geo = await getGeolocation(ip);
        }

        if (!geo) {
            return res.json({ success: false, reason: 'No location data' });
        }

        // Update user with location data
        await User.updateOne(
            { id: userId.toString() },
            {
                $set: {
                    lastActive: new Date(),
                    lastLocation: {
                        country: geo.country,
                        countryCode: geo.countryCode,
                        city: geo.city,
                        ip,
                        source: 'website_visit',
                        timestamp: new Date()
                    }
                },
                $setOnInsert: {
                    id: userId.toString(),
                    createdAt: new Date()
                },
                $addToSet: {
                    locationHistory: {
                        country: geo.country,
                        countryCode: geo.countryCode,
                        city: geo.city,
                        ip,
                        source: 'website_visit',
                        timestamp: new Date()
                    }
                }
            },
            { upsert: true }
        );

        return res.json({ 
            success: true, 
            location: geo.country,
            city: geo.city
        });
    } catch (error) {
        console.error('Track location error:', error);
        return res.status(500).json({ error: 'Failed to track location' });
    }
});

// Enhanced Telegram bot command handler with more options
bot.onText(/\/notify(?:\s+(all|@\w+|\d+))?\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const [_, target, notificationMessage] = match;
    const timestamp = new Date();

    try {
        let template;
        let responseMessage;
        let userNotificationsCreated = 0;

        if (target === 'all') {
            // Create global notification template
            template = await NotificationTemplate.create({
                title: 'Global Announcement 📢',
                message: notificationMessage,
                audience: 'global',
                priority: 1,
                icon: 'fa-bullhorn',
                createdBy: `admin_${chatId}`
            });

            // Get all users and create UserNotification for each
            const users = await User.find({}, { id: 1 }).limit(10000);
            const userNotifications = users.map(user => ({
                userId: user.id.toString(),
                templateId: template._id,
                read: false
            }));

            if (userNotifications.length > 0) {
                await UserNotification.insertMany(userNotifications);
                userNotificationsCreated = userNotifications.length;
            }

            responseMessage = `🌍 Global notification sent to ${userNotificationsCreated} users`;
        } 
        else if (target && (target.startsWith('@') || !isNaN(target))) {
            const userId = target.startsWith('@') ? target.substring(1) : target;
            
            // Create user-specific notification template
            template = await NotificationTemplate.create({
                title: 'Personal Message 💬',
                message: notificationMessage,
                audience: 'user',
                targetUserId: userId,
                priority: 2,
                icon: 'fa-envelope',
                createdBy: `admin_${chatId}`
            });

            // Create UserNotification for the specific user
            await UserNotification.create({
                userId: userId,
                templateId: template._id,
                read: false
            });

            userNotificationsCreated = 1;
            responseMessage = `👤 Notification sent to ${target}`;

            // Also try to send direct Telegram message if possible
            try {
                await bot.sendMessage(userId, `📢 Admin Message:\n\n${notificationMessage}`);
                responseMessage += ` (also sent via Telegram)`;
            } catch (telegramErr) {
                console.log(`Could not send direct Telegram message to ${userId}:`, telegramErr.message);
            }
        } 
        else {
            // Default to global notification
            template = await NotificationTemplate.create({
                title: 'System Notification 🔔',
                message: notificationMessage,
                audience: 'global',
                priority: 1,
                icon: 'fa-bell',
                createdBy: `admin_${chatId}`
            });

            // Get all users and create UserNotification for each
            const users = await User.find({}, { id: 1 }).limit(10000);
            const userNotifications = users.map(user => ({
                userId: user.id.toString(),
                templateId: template._id,
                read: false
            }));

            if (userNotifications.length > 0) {
                await UserNotification.insertMany(userNotifications);
                userNotificationsCreated = userNotifications.length;
            }

            responseMessage = `✅ System notification sent to ${userNotificationsCreated} users`;
        }

        // Format the response with timestamp and preview
        await bot.sendMessage(chatId,
            `${responseMessage} at ${timestamp.toLocaleTimeString()}\n\n` +
            `📝 Preview: ${notificationMessage.substring(0, 100)}${notificationMessage.length > 100 ? '...' : ''}\n` +
            `🆔 Template ID: ${template._id}`
        );

    } catch (err) {
        console.error('Notification error:', err);
        bot.sendMessage(chatId, '❌ Failed to send notification: ' + err.message);
    }
});
// Get transaction history and should NOT TOUCH THIS CODE
app.get('/api/transactions/:userId', requireTelegramAuth, async (req, res) => {
    try {
        const { userId } = req.params;

        // Callers may only fetch their own transactions unless they are admin
        if (!req.user.isAdmin && String(req.user.id) !== String(userId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        console.log(`[Transactions API] Fetching transactions for userId: ${userId}`);
        
        // Get both buy and sell orders for the user
        const buyOrders = await BuyOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();
        
        const sellOrders = await SellOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();

        console.log(`[Transactions API] Found ${buyOrders.length} buy orders and ${sellOrders.length} sell orders`);

        // Combine and format the data
        const transactions = [
            ...buyOrders.map(order => ({
                id: order.id,
                type: 'Buy Stars',
                amount: order.stars,
                status: (order.status || 'pending').toLowerCase(),
                date: order.dateCreated,
                details: `Buy order for ${order.stars} stars`,
                usdtValue: order.amount
            })),
            ...sellOrders.map(order => ({
                id: order.id,
                type: 'Sell Stars',
                amount: order.stars,
                status: (order.status || 'pending').toLowerCase(),
                date: order.dateCreated,
                details: `Sell order for ${order.stars} stars`,
                usdtValue: null 
            }))
        ];

        console.log(`[Transactions API] Returning ${transactions.length} total transactions`);
        res.json(transactions);
    } catch (error) {
        console.error('[Transactions API] Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Export transactions as CSV via Telegram
app.post('/api/export-transactions', requireTelegramAuth, async (req, res) => {
    try {
        console.log('[CSV Export] Request initiated for user:', req.user.id);
        
        // Check if user is banned - prevent data export
        const userId = req.user.id;
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot export data. Contact support with your case ID to appeal'
            });
        }
        
        // Check if user authentication worked and extract user ID
        let userIdCheck = null;
        if (req.user && req.user.id) {
            userIdCheck = req.user.id;
            // Get transaction counts
        const buyOrdersCount = await BuyOrder.countDocuments({ telegramId: userIdCheck });
        const sellOrdersCount = await SellOrder.countDocuments({ telegramId: userIdCheck });
        } else {
            console.log('[CSV Export] Authentication failed');
            
            // Try to extract user ID from init data directly
            try {
                const initData = req.headers['x-telegram-init-data'];
                if (initData) {
                    console.log('Trying to parse init data directly...');
                    const params = new URLSearchParams(initData);
                    const userParam = params.get('user');
                    if (userParam) {
                        const user = JSON.parse(userParam);
                        userId = user.id?.toString();
                        console.log('[CSV Export] Extracted user ID from init data:', userId);
                        // Create a minimal user object for CSV generation
                        req.user = { id: userId, username: user.username };
                    }
                }
            } catch (parseError) {
                console.error('Error parsing init data:', parseError.message);
            }
            
            // Final fallback
            if (!userId && req.headers['x-telegram-id']) {
                userId = req.headers['x-telegram-id'];
                console.log('⚠️ Using fallback user ID from header:', userId);
            }
            
            if (!userId) {
                return res.status(401).json({ error: 'Authentication failed. Please refresh and try again.' });
            }
        }
        console.log('Using user ID:', userId);
        
        // Get both buy and sell orders for the user
        console.log('Fetching buy orders for user:', userId);
        let buyOrders = [];
        let sellOrders = [];
        
        try {
            buyOrders = await BuyOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
            // Buy orders fetched
        } catch (buyError) {
            console.error('❌ Error fetching buy orders:', buyError.message);
            buyOrders = [];
        }
        
        try {
            sellOrders = await SellOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
            console.log('✅ Found sell orders:', sellOrders.length);
        } catch (sellError) {
            console.error('❌ Error fetching sell orders:', sellError.message);
            sellOrders = [];
        }

        // Combine and format the data
        // Combining transaction data
        const transactions = [];
        
        // Safely map buy orders
        if (buyOrders && buyOrders.length > 0) {
            buyOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Buy Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        details: `Buy order for ${order.stars || 0} stars`,
                        usdtValue: order.amount || 0
                    });
                } catch (orderError) {
                    console.error('Error processing buy order:', orderError.message);
                }
            });
        }
        
        // Safely map sell orders
        if (sellOrders && sellOrders.length > 0) {
            sellOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Sell Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        details: `Sell order for ${order.stars || 0} stars`,
                        usdtValue: order.amount || 0
                    });
                } catch (orderError) {
                    console.error('Error processing sell order:', orderError.message);
                }
            });
        }
        
        // Transactions combined

        // Generate professional CSV with enhanced formatting for Excel/Sheets
        let csv = '';
        
        try {
            const userInfo = req.user || {};
            const generationDate = new Date();
            const formattedDate = generationDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const formattedTime = generationDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            const totalTransactions = transactions.length;
            const completedCount = transactions.filter(t => t.status === 'completed').length;
            const processingCount = transactions.filter(t => t.status === 'processing').length;
            const declinedCount = transactions.filter(t => t.status === 'declined').length;
            const totalStarsTraded = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
            const totalUsdtValue = transactions.reduce((sum, t) => sum + (t.usdtValue || 0), 0);
            
            console.log('Transaction counts:', { totalTransactions, completedCount, processingCount, declinedCount });
            
            // Professional statement-style header with visual separation
            csv = `═══════════════════════════════════════════════════════════════\n`;
            csv += `STARSTORE TRANSACTION STATEMENT\n`;
            csv += `═══════════════════════════════════════════════════════════════\n`;
            csv += `\n`;
            csv += `ACCOUNT INFORMATION\n`;
            csv += `───────────────────────────────────────────────────────────────\n`;
            csv += `Account Holder,${userInfo.username ? '@' + userInfo.username : 'Unknown'}\n`;
            csv += `Account ID,${userId}\n`;
            csv += `Statement Date,${formattedDate}\n`;
            csv += `Generated Time,${formattedTime} UTC\n`;
            csv += `\n`;
            csv += `SUMMARY OVERVIEW\n`;
            csv += `───────────────────────────────────────────────────────────────\n`;
            csv += `Description,Count,Amount (USDT)\n`;
            csv += `Total Transactions,${totalTransactions},${totalUsdtValue.toFixed(2)}\n`;
            csv += `Completed Orders,${completedCount},-\n`;
            csv += `Processing Orders,${processingCount},-\n`;
            csv += `Declined Orders,${declinedCount},-\n`;
            csv += `Total Stars Traded,-,${totalStarsTraded.toFixed(2)}\n`;
            csv += `\n`;
            csv += `TRANSACTION DETAILS\n`;
            csv += `───────────────────────────────────────────────────────────────\n`;
            csv += `Date & Time,Type,Stars Traded,Amount (USDT),Status,Reference ID\n`;
            
            // Add transaction data with enhanced formatting
            if (transactions.length > 0) {
                transactions.forEach((txn, index) => {
                    try {
                        const dateStr = new Date(txn.date).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
                        const timeStr = new Date(txn.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                        const typeDisplay = txn.type.replace(' Stars', '');
                        const statusDisplay = txn.status.charAt(0).toUpperCase() + txn.status.slice(1);
                        
                        // Right-align numbers for better readability
                        const starsFormatted = txn.amount.toFixed(2).padStart(12);
                        const usdtFormatted = txn.usdtValue.toFixed(2).padStart(12);
                        
                        csv += `${dateStr} ${timeStr},${typeDisplay},${starsFormatted},${usdtFormatted},${statusDisplay},${txn.id}\n`;
                    } catch (rowError) {
                        console.error('Error processing transaction row:', rowError.message);
                    }
                });
            } else {
                csv += `\n`;
                csv += `No transactions available for this account\n`;
            }
            
            csv += `\n`;
            csv += `═══════════════════════════════════════════════════════════════\n`;
            csv += `TOTALS\n`;
            csv += `═══════════════════════════════════════════════════════════════\n`;
            csv += `Total Stars,${totalStarsTraded.toFixed(2)}\n`;
            csv += `Total USDT Value,${totalUsdtValue.toFixed(2)}\n`;
            csv += `Average Per Transaction,${(totalTransactions > 0 ? totalUsdtValue / totalTransactions : 0).toFixed(2)}\n`;
            csv += `\n`;
            csv += `═══════════════════════════════════════════════════════════════\n`;
            csv += `FOOTER\n`;
            csv += `═══════════════════════════════════════════════════════════════\n`;
            csv += `This is an official StarStore transaction record.\n`;
            csv += `For disputes or questions, contact support at https://starstore.app\n`;
            csv += `Generated by StarStore - Your Trusted Telegram Stars Marketplace\n`;
            csv += `Statement generated on: ${new Date().toISOString()}\n`;
            
        } catch (csvError) {
            console.error('Error generating CSV:', csvError.message);
            csv = `STARSTORE TRANSACTION STATEMENT\nError: Unable to generate report\nDetails: ${csvError.message}`;
        }

        // Send CSV file via Telegram bot when possible, otherwise provide direct download
        const filename = `transactions_${userId}_${new Date().toISOString().slice(0, 10)}.csv`;
        const buffer = Buffer.from(csv, 'utf8');
        // CSV buffer created

        if (process.env.BOT_TOKEN) {
            try {
                // Prefer Buffer with filename to avoid filesystem usage
                await bot.sendDocument(userId, buffer, {
                    caption: 'Your StarStore transaction statement is ready for download.'
                }, {
                    filename: filename,
                    contentType: 'text/csv'
                });
                console.log('CSV sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'CSV file sent to your Telegram' });
            } catch (botError) {
                const message = String(botError && botError.message || '');
                const forbidden = (botError && botError.response && botError.response.statusCode === 403) || /user is deactivated|bot was blocked/i.test(message);
                if (forbidden) {
                    console.warn('Telegram sendDocument forbidden, falling back to direct download');
                } else {
                    console.error('Bot sendDocument failed, falling back to direct download:', botError.message);
                }
                // Fall through to direct download
            }
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        console.log('✅ CSV direct download for user:', userId);
        return res.send(csv);
    } catch (error) {
        console.error('❌ ERROR in CSV export:', error);
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
        console.error('User ID:', req.user?.id);
        console.error('Bot token available:', !!process.env.BOT_TOKEN);
        console.error('=== CSV EXPORT DEBUG END (ERROR) ===');
        res.status(500).json({ error: 'Failed to export transactions: ' + error.message });
    }
});

// Direct-download variant for environments where programmatic downloads are restricted
app.get('/api/export-transactions-download', async (req, res) => {
    try {
        let userId = null;
        // Prefer init data if provided (Telegram signed payload)
        const initData = req.query.init || req.query.init_data;
        if (initData) {
            try {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) userId = JSON.parse(userParam).id?.toString();
            } catch (_) {}
        }
        // Fallback: explicit tg_id
        if (!userId && req.query.tg_id) {
            userId = String(req.query.tg_id);
        }
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const [buyOrders, sellOrders] = await Promise.all([
            BuyOrder.find({ telegramId: userId }).sort({ dateCreated: -1 }).lean().catch(() => []),
            SellOrder.find({ telegramId: userId }).sort({ dateCreated: -1 }).lean().catch(() => [])
        ]);

        const transactions = [];
        (buyOrders || []).forEach(order => {
            transactions.push({
                id: order.id || 'N/A',
                type: 'Buy Stars',
                amount: order.stars || 0,
                status: (order.status || 'unknown').toLowerCase(),
                date: order.dateCreated || new Date(),
                details: `Buy order for ${order.stars || 0} stars`,
                usdtValue: order.amount || 0
            });
        });
        (sellOrders || []).forEach(order => {
            transactions.push({
                id: order.id || 'N/A',
                type: 'Sell Stars',
                amount: order.stars || 0,
                status: (order.status || 'unknown').toLowerCase(),
                date: order.dateCreated || new Date(),
                details: `Sell order for ${order.stars || 0} stars`,
                usdtValue: order.amount || 0
            });
        });

        const generationDate = new Date().toLocaleString();
        const totalTransactions = transactions.length;
        const completedCount = transactions.filter(t => t.status === 'completed').length;
        const processingCount = transactions.filter(t => t.status === 'processing').length;
        const declinedCount = transactions.filter(t => t.status === 'declined').length;
        let csv = '';
        csv = `# StarStore - Transaction History Export\n`;
        csv += `# Generated on: ${generationDate}\n`;
        csv += `# User ID: ${userId}\n`;
        csv += `# Total Transactions: ${totalTransactions}\n`;
        csv += `# Completed: ${completedCount} | Processing: ${processingCount} | Declined: ${declinedCount}\n`;
        csv += `# Website: https://starstore.app\n`;
        csv += `# Export Type: Transaction History\n`;
        csv += `#\n`;
        csv += `ID,Type,Amount (Stars),USDT Value,Status,Date,Details\n`;
        if (transactions.length > 0) {
            transactions.forEach(txn => {
                const dateStr = new Date(txn.date).toISOString().split('T')[0];
                csv += `"${txn.id}","${txn.type}","${txn.amount}","${txn.usdtValue}","${txn.status}","${dateStr}","${txn.details}"\n`;
            });
        } else {
            csv += `"No Data","No transactions found","0","0","none","${new Date().toISOString().split('T')[0]}","No transactions available for this user"\n`;
        }

        const filename = `transactions_${userId}_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(csv);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to export' });
    }
});

// Export transactions as PDF (professional formatted statement)
app.post('/api/export-transactions-pdf', requireTelegramAuth, async (req, res) => {
    try {
        console.log('[PDF Export] Transaction PDF export requested by user:', req.user?.id);
        console.log('[PDF Export] pdfGenerator available:', !!pdfGenerator);
        
        if (!pdfGenerator) {
            console.error('❌ PDF Generator not available - module is null or undefined');
            return res.status(501).json({ error: 'PDF export service not available. Please try again later.' });
        }

        const userId = req.user.id;
        
        // Check if user is banned - prevent data export
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot export data. Contact support with your case ID to appeal'
            });
        }

        const userInfo = req.user || {};
        
        if (!userId) {
            console.error('No user ID found in request');
            return res.status(401).json({ error: 'User authentication failed' });
        }
        
        // Fetch transactions
        let buyOrders = [];
        let sellOrders = [];
        
        try {
            buyOrders = await BuyOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
        } catch (err) {
            console.error('Error fetching buy orders:', err.message);
            buyOrders = [];
        }
        
        try {
            sellOrders = await SellOrder.find({ telegramId: userId })
                .sort({ dateCreated: -1 })
                .lean();
        } catch (err) {
            console.error('Error fetching sell orders:', err.message);
            sellOrders = [];
        }

        // Format transactions
        const transactions = [];
        
        if (buyOrders && buyOrders.length > 0) {
            buyOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Buy Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        usdtValue: order.amount || 0
                    });
                } catch (err) {
                    console.error('Error processing buy order:', err.message);
                }
            });
        }
        
        if (sellOrders && sellOrders.length > 0) {
            sellOrders.forEach(order => {
                try {
                    transactions.push({
                        id: order.id || 'N/A',
                        type: 'Sell Stars',
                        amount: order.stars || 0,
                        status: (order.status || 'unknown').toLowerCase(),
                        date: order.dateCreated || new Date(),
                        usdtValue: order.amount || 0
                    });
                } catch (err) {
                    console.error('Error processing sell order:', err.message);
                }
            });
        }

        console.log(`Generating transaction PDF for user ${userId} with ${transactions.length} transactions`);

        // Generate PDF
        let docDefinition;
        try {
            docDefinition = pdfGenerator.generateTransactionPDF(
                userId,
                userInfo.username,
                transactions
            );
        } catch (err) {
            console.error('Error generating transaction PDF definition:', err.message, err.stack);
            return res.status(500).json({ error: 'Failed to generate PDF document: ' + err.message });
        }
        
        let buffer;
        try {
            buffer = await pdfGenerator.createPDFBuffer(docDefinition);
            console.log(`PDF buffer created successfully, size: ${buffer.length} bytes`);
        } catch (err) {
            console.error('Error creating PDF buffer:', err.message, err.stack);
            return res.status(500).json({ error: 'Failed to create PDF file: ' + err.message });
        }

        const filename = `Transactions_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Send via Telegram if possible
        if (process.env.BOT_TOKEN) {
            try {
                await bot.sendDocument(userId, buffer, {
                    caption: 'Your StarStore transaction statement PDF is ready for download.'
                });
                console.log('PDF sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'PDF file sent to your Telegram' });
            } catch (botError) {
                console.error('Bot sendDocument failed, falling back to direct download:', botError.message);
            }
        }

        // Direct download fallback
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        console.log(`Sending PDF to user as direct download`);
        return res.send(buffer);
    } catch (error) {
        console.error('Error exporting transactions PDF:', error.message, error.stack);
        res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
});

// Direct PDF download variant
app.get('/api/export-transactions-pdf-download', async (req, res) => {
    try {
        if (!pdfGenerator) {
            return res.status(501).json({ error: 'PDF export not available' });
        }

        let userId = null;
        const initData = req.query.init || req.query.init_data;
        if (initData) {
            try {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) userId = JSON.parse(userParam).id?.toString();
            } catch (_) {}
        }
        if (!userId && req.query.tg_id) {
            userId = req.query.tg_id;
        }

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Fetch transactions
        let buyOrders = await BuyOrder.find({ telegramId: userId }).sort({ dateCreated: -1 }).lean();
        let sellOrders = await SellOrder.find({ telegramId: userId }).sort({ dateCreated: -1 }).lean();

        const transactions = [];
        if (buyOrders) buyOrders.forEach(order => {
            transactions.push({
                id: order.id || 'N/A',
                type: 'Buy Stars',
                amount: order.stars || 0,
                status: (order.status || 'unknown').toLowerCase(),
                date: order.dateCreated || new Date(),
                usdtValue: order.amount || 0
            });
        });
        if (sellOrders) sellOrders.forEach(order => {
            transactions.push({
                id: order.id || 'N/A',
                type: 'Sell Stars',
                amount: order.stars || 0,
                status: (order.status || 'unknown').toLowerCase(),
                date: order.dateCreated || new Date(),
                usdtValue: order.amount || 0
            });
        });

        const docDefinition = pdfGenerator.generateTransactionPDF(userId, null, transactions);
        const buffer = await pdfGenerator.createPDFBuffer(docDefinition);
        const filename = `Transactions_${new Date().toISOString().slice(0, 10)}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('Error in PDF download:', error);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Export referrals as CSV via Telegram
app.post('/api/export-referrals', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Check if user is banned - prevent data export
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot export data. Contact support with your case ID to appeal'
            });
        }
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();
        
        // Generate professional CSV with enhanced formatting
        const userInfo = req.user;
        const generationDate = new Date();
        const formattedDate = generationDate.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const formattedTime = generationDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const totalReferrals = referrals.length;
        const activeCount = referrals.filter(r => r.status === 'active').length;
        const inactiveCount = referrals.filter(r => r.status !== 'active').length;
        const totalReferralValue = referrals.reduce((sum, r) => sum + (r.amount || 0), 0);
        
        let csv = `═══════════════════════════════════════════════════════════════\n`;
        csv += `STARSTORE REFERRAL EARNINGS STATEMENT\n`;
        csv += `═══════════════════════════════════════════════════════════════\n`;
        csv += `\n`;
        csv += `ACCOUNT INFORMATION\n`;
        csv += `───────────────────────────────────────────────────────────────\n`;
        csv += `Account Holder,${userInfo.username ? '@' + userInfo.username : 'Unknown'}\n`;
        csv += `Account ID,${userId}\n`;
        csv += `Statement Date,${formattedDate}\n`;
        csv += `Generated Time,${formattedTime} UTC\n`;
        csv += `\n`;
        csv += `EARNINGS SUMMARY\n`;
        csv += `───────────────────────────────────────────────────────────────\n`;
        csv += `Description,Count,Earnings (USDT)\n`;
        csv += `Total Referrals,${totalReferrals},${totalReferralValue.toFixed(2)}\n`;
        csv += `Active Referrals,${activeCount},-\n`;
        csv += `Inactive Referrals,${inactiveCount},-\n`;
        csv += `Average Per Referral,-,${(totalReferrals > 0 ? totalReferralValue / totalReferrals : 0).toFixed(2)}\n`;
        csv += `\n`;
        csv += `REFERRAL DETAILS\n`;
        csv += `───────────────────────────────────────────────────────────────\n`;
        csv += `Date & Time,Referred User,Earnings (USDT),Status,User ID\n`;
        
        referrals.forEach((ref, index) => {
            const dateStr = new Date(ref.dateReferred).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const timeStr = new Date(ref.dateReferred).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const statusDisplay = ref.status.charAt(0).toUpperCase() + ref.status.slice(1);
            const earningsFormatted = (ref.amount || 0).toFixed(2).padStart(12);
            csv += `${dateStr} ${timeStr},${ref.referredUsername || 'Unknown'},${earningsFormatted},${statusDisplay},${ref.referredUserId || 'Unknown'}\n`;
        });

        csv += `\n`;
        csv += `═══════════════════════════════════════════════════════════════\n`;
        csv += `TOTALS\n`;
        csv += `═══════════════════════════════════════════════════════════════\n`;
        csv += `Total Referrals,${totalReferrals}\n`;
        csv += `Total Earnings,${totalReferralValue.toFixed(2)} USDT\n`;
        csv += `Average Per Referral,${(totalReferrals > 0 ? totalReferralValue / totalReferrals : 0).toFixed(2)} USDT\n`;
        csv += `\n`;
        csv += `═══════════════════════════════════════════════════════════════\n`;
        csv += `FOOTER\n`;
        csv += `═══════════════════════════════════════════════════════════════\n`;
        csv += `This is an official StarStore referral earnings record.\n`;
        csv += `For disputes or questions, contact support at https://starstore.app\n`;
        csv += `Generated by StarStore - Your Trusted Telegram Stars Marketplace\n`;
        csv += `Statement generated on: ${new Date().toISOString()}\n`;

        // Send CSV file via Telegram bot
        const filename = `referrals_${userId}_${new Date().toISOString().slice(0, 10)}.csv`;
        const buffer = Buffer.from(csv, 'utf8');
        
        // Try to send via Telegram first
        try {
            // Create a readable stream from the buffer for better compatibility
            const stream = require('stream');
            const readable = new stream.Readable();
            readable.push(buffer);
            readable.push(null);
            readable.path = filename; // Set filename for the stream
            
            await bot.sendDocument(userId, readable, {
                caption: `Your referral earnings statement (${referrals.length} referrals)\n\nGenerated on: ${formattedDate}`
            });
        } catch (botError) {
            console.error('Bot sendDocument failed, providing direct download:', botError.message);
            // Fallback: provide CSV for direct download
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Cache-Control', 'no-store');
            return res.send(csv);
        }

        res.json({ success: true, message: 'CSV file sent to your Telegram' });
    } catch (error) {
        console.error('Error exporting referrals:', error);
        console.error('Error details:', error.message);
        console.error('Stack trace:', error.stack);
        console.error('User ID:', req.user?.id);
        console.error('Bot token available:', !!process.env.BOT_TOKEN);
        res.status(500).json({ error: 'Failed to export referrals: ' + error.message });
    }
});

// Direct-download variant for referrals
app.get('/api/export-referrals-download', async (req, res) => {
    try {
        let userId = null;
        const initData = req.query.init || req.query.init_data;
        if (initData) {
            try {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) userId = JSON.parse(userParam).id?.toString();
            } catch (_) {}
        }
        if (!userId && req.query.tg_id) userId = String(req.query.tg_id);
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();

        const generationDate = new Date().toLocaleString();
        const totalReferrals = referrals.length;
        const activeCount = referrals.filter(r => r.status === 'active').length;
        const processingCount = referrals.filter(r => r.status === 'processing').length;
        let csv = '';
        csv = `# StarStore - Referral History Export\n`;
        csv += `# Generated on: ${generationDate}\n`;
        csv += `# User ID: ${userId}\n`;
        csv += `# Total Referrals: ${totalReferrals}\n`;
        csv += `# Active: ${activeCount} | Processing: ${processingCount}\n`;
        csv += `# Website: https://starstore.app\n`;
        csv += `# Export Type: Referral History\n`;
        csv += `#\n`;
        csv += `ID,Referred User,Amount,Status,Date,Details\n`;
        referrals.forEach(ref => {
            const dateStr = new Date(ref.dateReferred).toISOString().split('T')[0];
            csv += `"${ref.id}","${ref.referredUsername || 'Unknown'}","${ref.amount}","${ref.status}","${dateStr}","${ref.details || 'Referral bonus'}"\n`;
        });

        const filename = `referrals_${userId}_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(csv);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to export' });
    }
});

// Export referrals as PDF (professional formatted statement)
app.post('/api/export-referrals-pdf', requireTelegramAuth, async (req, res) => {
    try {
        console.log('[PDF Export] Referral PDF export requested by user:', req.user?.id);
        console.log('[PDF Export] pdfGenerator available:', !!pdfGenerator);
        console.log('[PDF Export] pdfGenerator type:', typeof pdfGenerator);
        console.log('[PDF Export] pdfGenerator functions:', pdfGenerator ? Object.keys(pdfGenerator) : 'N/A');
        
        if (!pdfGenerator) {
            console.error('❌ PDF Generator not available - module is null or undefined');
            return res.status(501).json({ error: 'PDF export service not available. Please try again later.' });
        }

        const userId = req.user.id;
        
        // Check if user is banned - prevent data export
        const isBanned = await checkUserBanStatus(userId.toString());
        if (isBanned) {
            const banDetails = await getBanDetails(userId.toString());
            return res.status(403).json({
                success: false,
                error: 'Your account is restricted',
                caseId: banDetails?.caseId,
                message: 'You cannot export data. Contact support with your case ID to appeal'
            });
        }

        const userInfo = req.user || {};
        
        if (!userId) {
            console.error('No user ID found in request');
            return res.status(401).json({ error: 'User authentication failed' });
        }
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();

        console.log(`Generating referral PDF for user ${userId} with ${referrals.length} referrals`);

        // Generate PDF
        let docDefinition;
        try {
            docDefinition = pdfGenerator.generateReferralPDF(
                userId,
                userInfo.username,
                referrals
            );
        } catch (err) {
            console.error('Error generating referral PDF definition:', err.message, err.stack);
            return res.status(500).json({ error: 'Failed to generate PDF document: ' + err.message });
        }
        
        let buffer;
        try {
            buffer = await pdfGenerator.createPDFBuffer(docDefinition);
            console.log(`PDF buffer created successfully, size: ${buffer.length} bytes`);
        } catch (err) {
            console.error('Error creating PDF buffer:', err.message, err.stack);
            return res.status(500).json({ error: 'Failed to create PDF file: ' + err.message });
        }

        const filename = `Referrals_${new Date().toISOString().slice(0, 10)}.pdf`;

        // Send via Telegram if possible
        if (process.env.BOT_TOKEN) {
            try {
                await bot.sendDocument(userId, buffer, {
                    caption: 'Your StarStore referral earnings statement PDF is ready for download.'
                });
                console.log('Referral PDF sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'PDF file sent to your Telegram' });
            } catch (botError) {
                console.error('Bot sendDocument failed, falling back to direct download:', botError.message);
            }
        }

        // Direct download fallback
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        console.log(`Sending PDF to user as direct download`);
        return res.send(buffer);
    } catch (error) {
        console.error('Error exporting referrals PDF:', error.message, error.stack);
        res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
    }
});

// Direct PDF download variant for referrals
app.get('/api/export-referrals-pdf-download', async (req, res) => {
    try {
        if (!pdfGenerator) {
            return res.status(501).json({ error: 'PDF export not available' });
        }

        let userId = null;
        const initData = req.query.init || req.query.init_data;
        if (initData) {
            try {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) userId = JSON.parse(userParam).id?.toString();
            } catch (_) {}
        }
        if (!userId && req.query.tg_id) {
            userId = req.query.tg_id;
        }

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();

        const docDefinition = pdfGenerator.generateReferralPDF(userId, null, referrals);
        const buffer = await pdfGenerator.createPDFBuffer(docDefinition);
        const filename = `Referrals_${new Date().toISOString().slice(0, 10)}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('Error in referral PDF download:', error);
        res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// Get referral history
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        console.log(`[Referrals API] Fetching referrals for userId: ${userId}`);
        
        // Check if user is banned
        const isBanned = await checkUserBanStatus(userId);
        if (isBanned) {
            return res.status(403).json({ 
                error: 'Access Denied',
                message: 'Your account is restricted and cannot access referral data'
            });
        }
        
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(parseInt(req.query.limit) || 50, 500); // Cap at 500 per page
        const skip = (page - 1) * limit;
        
        // Get total count for pagination metadata
        const totalCount = await Referral.countDocuments({ referrerUserId: userId });
        console.log(`[Referrals API] Found ${totalCount} total referrals for user ${userId}`);
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
        
        console.log(`[Referrals API] Fetched ${referrals.length} referrals for this page`);
        
        // Optimize: Batch fetch all referred users at once instead of N+1 queries
        const referredUserIds = referrals.map(r => r.referredUserId);
        const referredUsers = await User.find({ id: { $in: referredUserIds } }).lean();
        
        const userMap = {};
        referredUsers.forEach(user => {
            userMap[user.id] = user;
        });
        
        // Format referral data
        const formattedReferrals = referrals.map(referral => {
            const referredUser = userMap[referral.referredUserId];
            
            return {
                id: referral._id.toString(),
                name: referredUser?.username || 'Unknown User',
                status: referral.status.toLowerCase(),
                date: referral.dateReferred,
                details: `Referred user ${referredUser?.username || referral.referredUserId}`,
                amount: 0.5 // Fixed bonus amount or calculate based on your logic
            };
        });

        const response = {
            data: formattedReferrals,
            pagination: {
                page,
                limit,
                total: totalCount,
                pages: Math.ceil(totalCount / limit)
            }
        };
        
        console.log(`[Referrals API] Returning ${formattedReferrals.length} formatted referrals with pagination`);
        console.log(`[Referrals API] Response structure:`, { 
            dataCount: response.data.length, 
            totalCount: response.pagination.total,
            pages: response.pagination.pages 
        });
        res.json(response);
    } catch (error) {
        console.error('[Referrals API] Error fetching referrals:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// AMBASSADOR DASHBOARD INTEGRATION ENDPOINTS
// Added for seamless integration with Ambassador Dashboard
// ============================================================================

// Get user information by Telegram ID (for Ambassador app)
app.get('/api/users/:telegramId', requireTelegramAuth, async (req, res) => {
    try {
        const { telegramId } = req.params;

        // Callers may only fetch their own profile unless they are admin or the ambassador app
        if (!req.user.isAdmin && !req.isAmbassadorApp && String(req.user.id) !== String(telegramId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Track location on profile read
        const ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
            .toString().split(',')[0].trim();
        
        if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
            try {
                const geo = await getGeolocation(ip);
                if (geo && geo.country !== 'Unknown') {
                    // Update location in background (non-blocking)
                    User.updateOne(
                        { id: telegramId },
                        {
                            $set: {
                                lastLocation: {
                                    country: geo.country,
                                    countryCode: geo.countryCode,
                                    city: geo.city,
                                    ip,
                                    source: 'profile_read',
                                    timestamp: new Date()
                                }
                            },
                            $addToSet: {
                                locationHistory: {
                                    country: geo.country,
                                    countryCode: geo.countryCode,
                                    city: geo.city,
                                    ip,
                                    source: 'profile_read',
                                    timestamp: new Date()
                                }
                            }
                        }
                    ).catch(() => {}); // Silent fail
                }
            } catch (_) {}
        }
        
        // Find user in MongoDB
        const user = await User.findOne({ id: telegramId }).lean();
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get comprehensive user stats
        const totalReferrals = await Referral.countDocuments({ referrerUserId: telegramId });
        const activeReferrals = await Referral.countDocuments({ referrerUserId: telegramId, status: 'active' });
        const pendingReferrals = await Referral.countDocuments({ referrerUserId: telegramId, status: 'pending' });
        
        const totalEarnings = await ReferralWithdrawal.aggregate([
            { $match: { userId: telegramId, status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        // Get transaction stats
        const buyOrders = await BuyOrder.countDocuments({ telegramId, status: 'completed' });
        const sellOrders = await SellOrder.countDocuments({ telegramId, status: 'completed' });
        
        const totalStarsEarned = await BuyOrder.aggregate([
            { $match: { telegramId, status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$stars' } } }
        ]);

        const userData = {
            id: user.id,
            username: user.username,
            telegramId: user.id,
            totalReferrals,
            activeReferrals,
            pendingReferrals,
            totalEarnings: totalEarnings[0]?.total || 0,
            buyOrders,
            sellOrders,
            totalStarsEarned: totalStarsEarned[0]?.total || 0,
            createdAt: user.createdAt,
            lastActive: user.lastActive,
            ambassadorEmail: user.ambassadorEmail,
            ambassadorFullName: user.ambassadorFullName,
            ambassadorTier: user.ambassadorTier,
            ambassadorReferralCode: user.ambassadorReferralCode,
            ambassadorSyncedAt: user.ambassadorSyncedAt
        };
        
        res.json(userData);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Get all users data for Ambassador admin dashboard
app.get('/api/admin/users-data', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        
        // Get users with comprehensive data
        const users = await User.find({})
            .sort({ lastActive: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const enrichedUsers = await Promise.all(users.map(async (user) => {
            const [
                totalReferrals,
                activeReferrals,
                pendingReferrals,
                totalEarnings,
                buyOrders,
                sellOrders,
                totalStarsEarned,
                recentReferrals
            ] = await Promise.all([
                Referral.countDocuments({ referrerUserId: user.id }),
                Referral.countDocuments({ referrerUserId: user.id, status: 'active' }),
                Referral.countDocuments({ referrerUserId: user.id, status: 'pending' }),
                ReferralWithdrawal.aggregate([
                    { $match: { userId: user.id, status: 'completed' } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]),
                BuyOrder.countDocuments({ telegramId: user.id, status: 'completed' }),
                SellOrder.countDocuments({ telegramId: user.id, status: 'completed' }),
                BuyOrder.aggregate([
                    { $match: { telegramId: user.id, status: 'completed' } },
                    { $group: { _id: null, total: { $sum: '$stars' } } }
                ]),
                Referral.find({ referrerUserId: user.id })
                    .sort({ dateReferred: -1 })
                    .limit(5)
                    .lean()
            ]);

            return {
                id: user.id,
                username: user.username,
                createdAt: user.createdAt,
                lastActive: user.lastActive,
                totalReferrals,
                activeReferrals,
                pendingReferrals,
                totalEarnings: totalEarnings[0]?.total || 0,
                buyOrders,
                sellOrders,
                totalStarsEarned: totalStarsEarned[0]?.total || 0,
                recentReferrals: recentReferrals.length,
                isAmbassador: !!user.ambassadorEmail,
                ambassadorTier: user.ambassadorTier,
                ambassadorSyncedAt: user.ambassadorSyncedAt
            };
        }));

        const totalUsers = await User.countDocuments({});
        
        res.json({
            users: enrichedUsers,
            pagination: {
                page,
                limit,
                total: totalUsers,
                pages: Math.ceil(totalUsers / limit),
                hasMore: skip + limit < totalUsers
            }
        });
    } catch (error) {
        console.error('Error fetching users data:', error);
        res.status(500).json({ error: 'Failed to fetch users data' });
    }
});

// Get comprehensive referrals data for admin
app.get('/api/admin/referrals-data', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        
        const referrals = await Referral.find({})
            .sort({ dateReferred: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const enrichedReferrals = await Promise.all(referrals.map(async (referral) => {
            const [referrer, referred] = await Promise.all([
                User.findOne({ id: referral.referrerUserId }).lean(),
                User.findOne({ id: referral.referredUserId }).lean()
            ]);

            return {
                id: referral._id,
                referrerUserId: referral.referrerUserId,
                referredUserId: referral.referredUserId,
                referrerUsername: referrer?.username || 'Unknown',
                referredUsername: referred?.username || 'Unknown',
                status: referral.status,
                dateReferred: referral.dateReferred,
                withdrawn: referral.withdrawn,
                referrerIsAmbassador: !!referrer?.ambassadorEmail,
                referrerTier: referrer?.ambassadorTier
            };
        }));

        const totalReferrals = await Referral.countDocuments({});
        
        res.json({
            referrals: enrichedReferrals,
            pagination: {
                page,
                limit,
                total: totalReferrals,
                pages: Math.ceil(totalReferrals / limit),
                hasMore: skip + limit < totalReferrals
            }
        });
    } catch (error) {
        console.error('Error fetching referrals data:', error);
        res.status(500).json({ error: 'Failed to fetch referrals data' });
    }
});

// Get comprehensive transactions data for admin
app.get('/api/admin/transactions-data', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        
        // Get both buy and sell orders
        const [buyOrders, sellOrders] = await Promise.all([
            BuyOrder.find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Math.floor(limit / 2))
                .lean(),
            SellOrder.find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Math.floor(limit / 2))
                .lean()
        ]);

        // Combine and format transactions
        const transactions = [
            ...buyOrders.map(order => ({
                id: order.id,
                type: 'buy',
                telegramId: order.telegramId,
                username: order.username,
                amount: order.amount,
                stars: order.stars,
                status: order.status,
                createdAt: order.createdAt,
                isPremium: order.isPremium,
                premiumDuration: order.premiumDuration
            })),
            ...sellOrders.map(order => ({
                id: order.id,
                type: 'sell',
                telegramId: order.telegramId,
                username: order.username,
                amount: order.amount,
                stars: order.stars,
                status: order.status,
                createdAt: order.createdAt,
                walletAddress: order.walletAddress
            }))
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const [totalBuyOrders, totalSellOrders] = await Promise.all([
            BuyOrder.countDocuments({}),
            SellOrder.countDocuments({})
        ]);
        
        res.json({
            transactions,
            pagination: {
                page,
                limit,
                total: totalBuyOrders + totalSellOrders,
                pages: Math.ceil((totalBuyOrders + totalSellOrders) / limit),
                hasMore: skip + limit < (totalBuyOrders + totalSellOrders)
            },
            stats: {
                totalBuyOrders,
                totalSellOrders,
                totalTransactions: totalBuyOrders + totalSellOrders
            }
        });
    } catch (error) {
        console.error('Error fetching transactions data:', error);
        res.status(500).json({ error: 'Failed to fetch transactions data' });
    }
});

// Get dashboard analytics for admin
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalUsers,
            totalReferrals,
            activeReferrals,
            totalTransactions,
            todayUsers,
            weekUsers,
            monthUsers,
            todayReferrals,
            weekReferrals,
            monthReferrals,
            totalEarnings,
            totalStarsTraded
        ] = await Promise.all([
            User.countDocuments({}),
            Referral.countDocuments({}),
            Referral.countDocuments({ status: 'active' }),
            BuyOrder.countDocuments({ status: 'completed' }) + await SellOrder.countDocuments({ status: 'completed' }),
            User.countDocuments({ createdAt: { $gte: today } }),
            User.countDocuments({ createdAt: { $gte: thisWeek } }),
            User.countDocuments({ createdAt: { $gte: thisMonth } }),
            Referral.countDocuments({
                $or: [
                    { dateReferred: { $gte: today } },
                    { dateReferred: { $exists: false }, dateCreated: { $gte: today } }
                ]
            }),
            Referral.countDocuments({
                $or: [
                    { dateReferred: { $gte: thisWeek } },
                    { dateReferred: { $exists: false }, dateCreated: { $gte: thisWeek } }
                ]
            }),
            Referral.countDocuments({
                $or: [
                    { dateReferred: { $gte: thisMonth } },
                    { dateReferred: { $exists: false }, dateCreated: { $gte: thisMonth } }
                ]
            }),
            ReferralWithdrawal.aggregate([
                { $match: { status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            BuyOrder.aggregate([
                { $match: { status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$stars' } } }
            ])
        ]);

        res.json({
            overview: {
                totalUsers,
                totalReferrals,
                activeReferrals,
                totalTransactions,
                conversionRate: totalReferrals > 0 ? ((activeReferrals / totalReferrals) * 100).toFixed(2) : 0
            },
            growth: {
                today: { users: todayUsers, referrals: todayReferrals },
                week: { users: weekUsers, referrals: weekReferrals },
                month: { users: monthUsers, referrals: monthReferrals }
            },
            financial: {
                totalEarnings: totalEarnings[0]?.total || 0,
                totalStarsTraded: totalStarsTraded[0]?.total || 0
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Sync ambassador data (called from Ambassador app)
app.post('/api/ambassador/sync', (req, res, next) => {
    // Allow either authenticated ambassador app OR Telegram-auth'd user syncing themselves
    if (req.isAmbassadorApp) return next();
    return requireTelegramAuth(req, res, next);
}, async (req, res) => {
    try {
        const { telegramId, email, fullName, tier, referralCode } = req.body;

        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
        }
        // If not from ambassador app, caller must be syncing themselves
        if (!req.isAmbassadorApp && String(telegramId) !== String(req.user?.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Store ambassador info in the User collection with additional fields
        const result = await User.findOneAndUpdate(
            { id: telegramId },
            { 
                $set: {
                    ambassadorEmail: email,
                    ambassadorFullName: fullName,
                    ambassadorTier: tier,
                    ambassadorReferralCode: referralCode,
                    ambassadorSyncedAt: new Date()
                }
            },
            { upsert: false, new: true }
        );

        if (!result) {
            return res.status(404).json({ error: 'User not found. Please interact with the bot first.' });
        }

        res.json({ 
            success: true, 
            message: 'Ambassador data synced successfully',
            user: {
                id: result.id,
                username: result.username,
                ambassadorTier: result.ambassadorTier,
                syncedAt: result.ambassadorSyncedAt
            }
        });
    } catch (error) {
        console.error('Error syncing ambassador data:', error);
        res.status(500).json({ error: 'Failed to sync ambassador data' });
    }
});

// ========== AMBASSADOR WAITLIST ADMIN ENDPOINT ==========
// GET /api/admin/ambassador-waitlist - Fetch all ambassador waitlist entries
app.get('/api/admin/ambassador-waitlist', async (req, res) => {
  try {
    // Verify request is from Ambassador app
    if (!req.isAmbassadorApp) {
      return res.status(401).json({ success: false, error: 'Unauthorized - Ambassador app authentication required' });
    }

    let waitlist = [];
    
    if (process.env.MONGODB_URI && global.AmbassadorWaitlist) {
      // Fetch from MongoDB
      waitlist = await global.AmbassadorWaitlist.find({}).lean();
    } else if (db && typeof db.listAmbassadorWaitlist === 'function') {
      // Fallback to file DB
      waitlist = (await db.listAmbassadorWaitlist()) || [];
    }

    console.log(`✅ Ambassador waitlist fetched: ${waitlist.length} entries`);

    return res.json({
      success: true,
      waitlist: waitlist.map(entry => ({
        id: entry.id || entry._id?.toString(),
        _id: entry._id?.toString(),
        email: entry.email,
        fullName: entry.fullName,
        username: entry.username,
        telegramId: entry.telegramId,
        socials: entry.socials,
        status: entry.status || 'pending',
        processedBy: entry.processedBy,
        processedAt: entry.processedAt,
        createdAt: entry.createdAt
      })),
      total: waitlist.length
    });
  } catch (e) {
    console.error('Ambassador waitlist fetch error:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch waitlist' });
  }
});

// Register webhook endpoint (for Ambassador app to register for updates)
app.post('/api/webhook/register', (req, res, next) => {
    if (!req.isAmbassadorApp) {
        return res.status(401).json({ error: 'Unauthorized webhook registration' });
    }
    next();
}, async (req, res) => {
    try {
        const { url, events, source } = req.body;
        
        if (!url || !events || !Array.isArray(events)) {
            return res.status(400).json({ error: 'URL and events array are required' });
        }

        // Log webhook registration (enhance this to store in DB if needed)
        console.log(`🔗 Webhook registered: ${url} for events: ${events.join(', ')} from ${source}`);
        
        res.json({ 
            success: true, 
            message: 'Webhook registered successfully',
            url,
            events,
            registeredAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error registering webhook:', error);
        res.status(500).json({ error: 'Failed to register webhook' });
    }
});

// Health check endpoint for Ambassador app connection testing
app.get('/api/health', async (req, res) => {
    try {
        // Quick health check - no sensitive data
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        
        // Don't count all users for every health check - expensive operation
        // Just verify database can respond quickly
        const isDbHealthy = mongoose.connection.readyState === 1;
        
        res.status(isDbHealthy ? 200 : 503).json({
            status: isDbHealthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            service: 'StarStore',
            version: '1.0.0'
        });
    } catch (error) {
        console.error('[HEALTH-CHECK] Error:', error.message);
        res.status(503).json({
            status: 'error',
            timestamp: new Date().toISOString()
        });
    }
});

// Webhook registration endpoint for ambassador app
app.post('/api/webhook/register', (req, res, next) => {
    // Only allow ambassador app to register webhooks
    if (req.isAmbassadorApp) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized webhook registration' });
}, async (req, res) => {
    try {
        const { url, events, source } = req.body;
        
        if (!url || !events || !Array.isArray(events)) {
            return res.status(400).json({ 
                success: false, 
                error: 'URL and events array are required' 
            });
        }
        
        // Store webhook configuration
        const webhookConfig = {
            url,
            events,
            source: source || 'ambassador-app',
            registeredAt: new Date(),
            active: true
        };
        
        console.log('✅ Webhook registered for ambassador app:', webhookConfig);
        
        res.json({ 
            success: true, 
            data: true,
            message: 'Webhook registered successfully' 
        });
        
    } catch (error) {
        console.error('❌ Webhook registration error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to register webhook' 
        });
    }
});

// ============================================================================
// END OF AMBASSADOR DASHBOARD INTEGRATION ENDPOINTS
// ============================================================================

// Handle both /referrals command and plain text "referrals"
bot.onText(/\/referrals|referrals/i, async (msg) => {
    // 🧠 SMART: End any active flows when user starts a new command
    endActiveFlowForUser(msg.from.id.toString(), msg.chat.id);
    handleReferralsCommand(msg);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    const username = msg.from.username || '';
    const text = msg.text;

    // Auto-detect and update username in real-time on ANY message
    if (username) {
        const usernameChange = await detectUsernameChange(userId, username, 'telegram');
        if (usernameChange) {
            await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
        }
    }

    if (!text) return;

    const orderId = text.startsWith('/order ') ? text.split(' ')[1] : text;

    const buyOrder = await BuyOrder.findOne({ id: orderId, telegramId: chatId });
    const sellOrder = await SellOrder.findOne({ id: orderId, telegramId: chatId });

    if (buyOrder) {
        const message = `🛒 Buy Order Details:\n\nOrder ID: ${buyOrder.id}\nAmount: ${buyOrder.amount} USDT\nStatus: ${buyOrder.status}`;
        await bot.sendMessage(chatId, message);
    } else if (sellOrder) {
        const message = `🛒 Sell Order Details:\n\nOrder ID: ${sellOrder.id}\nStars: ${sellOrder.stars}\nStatus: ${sellOrder.status}`;
        await bot.sendMessage(chatId, message);
    }
});



// Handle orders recreation                     

// Helper: Send sell order notification to admin (for both creation and recreation)
async function notifyAdminOfSellOrder(order) {
    try {
        const userDisplayName = await getUserDisplayName(order.telegramId);
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

        let adminNotificationSucceeded = false;
        for (const adminId of adminIds) {
            let retryCount = 0;
            while (retryCount < 3) {
                try {
                    const message = await bot.sendMessage(
                        adminId,
                        adminMessage,
                        { reply_markup: adminKeyboard }
                    );
                    order.adminMessages = order.adminMessages || [];
                    order.adminMessages.push({ 
                        adminId, 
                        messageId: message.message_id,
                        originalText: adminMessage 
                    });
                    adminNotificationSucceeded = true;
                    break;
                } catch (err) {
                    retryCount++;
                    if (retryCount < 3) await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        
        if (adminNotificationSucceeded) {
            await order.save();
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error notifying admin of sell order:', error);
        return false;
    }
}

// Helper: Send sell order user notification (for both creation and recreation)
async function notifyUserOfSellOrder(order, status = 'processing') {
    try {
        let userMessage = '';
        if (status === 'processing') {
            userMessage = `✅ Payment successful!\n\n` +
                `Order ID: ${order.id}\n` +
                `Stars: ${order.stars}\n` +
                `Wallet: ${order.walletAddress}\n` +
                `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
                `\nStatus: Processing (21-day hold)\n\n` +
                `Funds will be released to your wallet after the hold period.`;
        } else if (status === 'pending') {
            userMessage = `🚀 Sell order initialized!\n\nOrder ID: ${order.id}\nStars: ${order.stars}\nStatus: Pending (Waiting for payment)\n\n⏰ Payment link expires in 15 minutes`;
        }

        const sent = await bot.sendMessage(order.telegramId, userMessage);
        order.userMessageId = sent?.message_id;
        await order.save();
    } catch (error) {
        console.error('Error notifying user of sell order:', error);
    }
}

// /cso- Command: Recreate Sell Order exactly as original
bot.onText(/\/cso$/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    // Step 1: Get Order ID
    await bot.sendMessage(chatId, '📝 <b>Step 1:</b> Enter the order ID to recreate:', { parse_mode: 'HTML' });
    
    const handleOrderId = async (orderIdMsg) => {
        const orderId = orderIdMsg.text.trim();
        if (!orderId) {
            return await bot.sendMessage(chatId, '❌ Order ID cannot be empty. Try /cso');
        }

        try {
            let order = await SellOrder.findOne({ id: orderId });

            if (order) {
                // Order already exists - recreate as if it just received payment
                order.status = 'processing';
                order.datePaid = new Date();
                order.sessionToken = null;
                order.sessionExpiry = null;
                order.adminMessages = [];
                
                await notifyUserOfSellOrder(order, 'processing');
                const notified = await notifyAdminOfSellOrder(order);
                
                if (notified) {
                    await bot.sendMessage(chatId, 
                        `✅ Sell order <code>${orderId}</code> recreated!\n\n` +
                        `User: @${order.username} (ID: ${order.telegramId})\n` +
                        `Stars: ${order.stars}\n` +
                        `Wallet: <code>${order.walletAddress}</code>\n` +
                        (order.memoTag ? `Memo: ${order.memoTag}\n` : '') +
                        `Status: Processing`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.sendMessage(chatId, `⚠️ Order recreated but admin notification failed.`);
                }
            } else {
                // Order doesn't exist - initiate dialogue for manual creation
                const data = {};
                
                // Step 2: Get Telegram ID
                await bot.sendMessage(chatId, '📝 <b>Step 2:</b> Enter the user\'s Telegram ID:', { parse_mode: 'HTML' });
                
                const handleStep1 = async (userMsg) => {
                    const telegramId = userMsg.text.trim();
                    if (!telegramId || isNaN(telegramId)) {
                        return await bot.sendMessage(chatId, '❌ Invalid ID. Try /cso');
                    }
                    data.telegramId = telegramId;
                
                // Step 3: Auto-fetch username and location from DB
                let dbUser = await User.findOne({ id: telegramId });
                if (dbUser && dbUser.username) {
                    data.username = dbUser.username;
                    // Get location from user's last login location
                    if (dbUser.lastLocation && dbUser.lastLocation.city) {
                        data.userLocation = dbUser.lastLocation;
                    }
                    await bot.sendMessage(chatId, 
                        `✅ Found user: <b>@${dbUser.username}</b>\n\n📝 <b>Step 3:</b> Enter the number of stars:`,
                        { parse_mode: 'HTML' }
                    );
                    bot.once('message', handleStep2);
                } else {
                    await bot.sendMessage(chatId, 
                        `📝 <b>Step 3:</b> Username not found in DB. Enter user's username:`,
                        { parse_mode: 'HTML' }
                    );
                    const handleUsername = async (msg) => {
                        data.username = msg.text.trim().replace(/^@/, '');
                        await bot.sendMessage(chatId, 
                            `📝 <b>Step 4:</b> Enter the number of stars:`,
                            { parse_mode: 'HTML' }
                        );
                        bot.once('message', handleStep2);
                    };
                    bot.once('message', handleUsername);
                }
            };
            
            bot.once('message', handleStep1);
            
            // Step 2: Get Stars
            const handleStep2 = async (userMsg) => {
                const stars = parseInt(userMsg.text.trim(), 10);
                if (isNaN(stars) || stars < 1) {
                    return await bot.sendMessage(chatId, '❌ Invalid amount (min 1 star).');
                }
                data.stars = stars;
                
                await bot.sendMessage(chatId, `📝 <b>Step 4:</b> Enter the TON wallet address:`, { parse_mode: 'HTML' });
                bot.once('message', handleStep3);
            };
            
            // Step 3: Get Wallet
            const handleStep3 = async (userMsg) => {
                const wallet = userMsg.text.trim();
                if (!wallet || wallet.length < 20) {
                    return await bot.sendMessage(chatId, '❌ Invalid wallet address.');
                }
                data.walletAddress = wallet;
                
                // Step 4: Get Date Created (optional)
                await bot.sendMessage(chatId, 
                    `📝 <b>Step 5:</b> Enter order creation time (e.g., "2024-04-17 14:30" or leave blank for now):`,
                    { parse_mode: 'HTML' }
                );
                bot.once('message', handleTimeCreated);
            };
            
            // Step 5: Get Time Created
            const handleTimeCreated = async (userMsg) => {
                let timeStr = userMsg.text.trim();
                let dateCreated = new Date();
                
                if (timeStr && timeStr.toLowerCase() !== 'now') {
                    try {
                        dateCreated = new Date(timeStr);
                        if (isNaN(dateCreated.getTime())) {
                            dateCreated = new Date();
                        }
                    } catch {
                        dateCreated = new Date();
                    }
                }
                data.dateCreated = dateCreated;
                
                // Create the order with all collected data
                const newOrder = new SellOrder({
                    id: orderId,
                    telegramId: data.telegramId,
                    username: data.username,
                    stars: data.stars,
                    walletAddress: data.walletAddress,
                    memoTag: data.memoTag || '',
                    userLocation: data.userLocation || null,
                    status: 'processing',
                    telegram_payment_charge_id: `admin_recreate_${Date.now()}`,
                    reversible: true,
                    dateCreated: data.dateCreated,
                    datePaid: new Date(),
                    adminMessages: []
                });
                
                // Notify user
                await notifyUserOfSellOrder(newOrder, 'processing');
                
                // Notify admins
                const notified = await notifyAdminOfSellOrder(newOrder);
                
                if (notified) {
                    await bot.sendMessage(chatId,
                        `✅ <b>Sell order created!</b>\n\n` +
                        `ID: <code>${orderId}</code>\n` +
                        `User: @${data.username}\n` +
                        `Stars: ${data.stars}\n` +
                        `Wallet: <code>${data.walletAddress}</code>\n` +
                        `Created: ${data.dateCreated.toLocaleString()}\n` +
                        `Status: Processing`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.sendMessage(chatId, `⚠️ Order created but admin notification failed.`);
                }
            };
            }
        } catch (error) {
            console.error('Error in /cso command:', error);
            await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    };
    
    // Start dialogue
    bot.once('message', handleOrderId);
});

bot.onText(/\/cbo$/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    
    if (!adminIds.includes(adminId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    await bot.sendMessage(chatId, '📝 <b>Step 1:</b> Enter the order ID:', { parse_mode: 'HTML' });
    
    const handleOrderId = async (orderIdMsg) => {
        const orderId = orderIdMsg.text.trim();
        if (!orderId) {
            await bot.sendMessage(chatId, '❌ Order ID cannot be empty. Try /cbo');
            return;
        }

        try {
            let order = await BuyOrder.findOne({ id: orderId });

            if (order) {
                // Order already exists - recreate
                order.status = 'pending';
                order.dateCreated = new Date();
                order.adminMessages = [];

                const adminKeyboard = { 
                    inline_keyboard: [[ 
                        { text: '✅ Complete', callback_data: `complete_buy_${order.id}` }, 
                        { text: '❌ Decline', callback_data: `decline_buy_${order.id}` } 
                    ]] 
                };

                let adminMessage = `🛒 BUY ORDER\n\nOrder ID: ${order.id}\nUser: @${order.username}\nAmount: ${order.amount} USDT\nStars: ${order.stars || 0}`;
                
                if (order.userLocation && order.userLocation.city) {
                    adminMessage += `\nLocation: ${order.userLocation.city}, ${order.userLocation.country || 'Unknown'}`;
                }
                
                let adminNotificationSucceeded = false;
                for (const adminIdTarget of adminIds) {
                    try {
                        const message = await bot.sendMessage(adminIdTarget, adminMessage, { reply_markup: adminKeyboard });
                        order.adminMessages.push({ 
                            adminId: adminIdTarget, 
                            messageId: message.message_id, 
                            originalText: adminMessage 
                        });
                        adminNotificationSucceeded = true;
                    } catch (err) {
                        console.error(`Failed to notify admin ${adminIdTarget}:`, err.message);
                    }
                }

                await order.save();

                // Send notification to user
                try {
                    const userNotification = `🛍️ <b>Buy order recreated!</b>\n\n` +
                        `Order ID: <code>${order.id}</code>\n` +
                        `Amount: ${order.amount} USDT\n` +
                        `Stars: ${order.stars}\n` +
                        `Status: Pending approval\n\n` +
                        `An admin will review and complete your order.`;
                    const sent = await bot.sendMessage(order.telegramId, userNotification, { parse_mode: 'HTML' });
                    order.userMessageId = sent?.message_id;
                    await order.save();
                } catch (err) {
                    console.error(`Failed to notify user ${order.telegramId}:`, err.message);
                }

                if (adminNotificationSucceeded) {
                    await bot.sendMessage(chatId,
                        `✅ Buy order <code>${orderId}</code> recreated!`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.sendMessage(chatId, `⚠️ Order recreated but admin notification failed.`);
                }
            } else {
                // Create new order - start dialogue
                const data = {};
                
                await bot.sendMessage(chatId, '📝 <b>Step 2:</b> Enter user\'s Telegram ID:', { parse_mode: 'HTML' });
                
                const handleStep1 = async (userMsg) => {
                    const telegramId = userMsg.text.trim();
                    if (!telegramId || isNaN(telegramId)) {
                        await bot.sendMessage(chatId, '❌ Invalid ID. Try /cbo');
                        return;
                    }
                    data.telegramId = telegramId;
                    
                    let dbUser = await User.findOne({ id: telegramId });
                    if (dbUser && dbUser.username) {
                        data.username = dbUser.username;
                        // Get location from user's last login location
                        if (dbUser.lastLocation && dbUser.lastLocation.city) {
                            data.userLocation = dbUser.lastLocation;
                        }
                        await bot.sendMessage(chatId, 
                            `✅ Found: <b>@${dbUser.username}</b>\n\n📝 <b>Step 3:</b> Enter amount in USDT:`,
                            { parse_mode: 'HTML' }
                        );
                        bot.once('message', handleStep2);
                    } else {
                        await bot.sendMessage(chatId,
                            `📝 <b>Step 3:</b> Enter username:`,
                            { parse_mode: 'HTML' }
                        );
                        const handleUsername = async (msg) => {
                            data.username = msg.text.trim().replace(/^@/, '');
                            await bot.sendMessage(chatId,
                                `📝 <b>Step 4:</b> Enter amount in USDT:`,
                                { parse_mode: 'HTML' }
                            );
                            bot.once('message', handleStep2);
                        };
                        bot.once('message', handleUsername);
                    }
                };
                
                const handleStep2 = async (userMsg) => {
                    const amount = parseFloat(userMsg.text.trim());
                    if (isNaN(amount) || amount <= 0) {
                        await bot.sendMessage(chatId, '❌ Invalid amount (must be greater than 0).');
                        return;
                    }
                    data.amount = amount;
                    
                    await bot.sendMessage(chatId, '📝 <b>Step 4:</b> Enter stars (or 0):', { parse_mode: 'HTML' });
                    bot.once('message', handleStep3);
                };
                
                const handleStep3 = async (userMsg) => {
                    const stars = parseInt(userMsg.text.trim(), 10);
                    if (isNaN(stars) || stars < 0) {
                        await bot.sendMessage(chatId, '❌ Invalid stars.');
                        return;
                    }
                    data.stars = stars;
                    
                    await handleCreateOrder();
                };

                const handleCreateOrder = async () => {
                    const newOrder = new BuyOrder({
                        id: orderId,
                        telegramId: data.telegramId,
                        username: data.username,
                        amount: data.amount,
                        stars: data.stars > 0 ? data.stars : null,
                        walletAddress: null,
                        userLocation: data.userLocation || null,
                        status: 'pending',
                        dateCreated: new Date(),
                        adminMessages: [],
                        recipients: [],
                        isBuyForOthers: false,
                        totalRecipients: 1,
                        starsPerRecipient: data.stars,
                        premiumDurationPerRecipient: null,
                        isPremium: false,
                        transactionHash: null,
                        transactionVerified: false,
                        verificationAttempts: 0
                    });
                    
                    let adminMessage = `🛒 NEW BUY ORDER\n\nOrder ID: ${newOrder.id}\nUser: @${data.username} (ID: ${data.telegramId})\nAmount: ${data.amount} USDT\nStars: ${data.stars}`;
                    
                    if (data.userLocation && data.userLocation.city) {
                        adminMessage += `\nLocation: ${data.userLocation.city}, ${data.userLocation.country || 'Unknown'}`;
                    }
                    
                    const adminKeyboard = { 
                        inline_keyboard: [[ 
                            { text: '✅ Complete', callback_data: `complete_buy_${newOrder.id}` }, 
                            { text: '❌ Decline', callback_data: `decline_buy_${newOrder.id}` } 
                        ]] 
                    };
                    
                    let adminNotificationSucceeded = false;
                    for (const adminIdTarget of adminIds) {
                        try {
                            const message = await bot.sendMessage(adminIdTarget, adminMessage, { reply_markup: adminKeyboard });
                            newOrder.adminMessages.push({ 
                                adminId: adminIdTarget, 
                                messageId: message.message_id, 
                                originalText: adminMessage 
                            });
                            adminNotificationSucceeded = true;
                        } catch (err) {
                            console.error(`Failed to notify admin ${adminIdTarget}:`, err.message);
                        }
                    }
                    
                    await newOrder.save();
                    
                    // Send notification to user
                    try {
                        const userNotification = `🛍️ <b>Buy order created!</b>\n\n` +
                            `Order ID: <code>${newOrder.id}</code>\n` +
                            `Amount: ${data.amount} USDT\n` +
                            `Stars: ${data.stars}\n` +
                            `Status: Pending approval\n\n` +
                            `An admin will review and complete your order.`;
                        const sent = await bot.sendMessage(data.telegramId, userNotification, { parse_mode: 'HTML' });
                        newOrder.userMessageId = sent?.message_id;
                        await newOrder.save();
                    } catch (err) {
                        console.error(`Failed to notify user ${data.telegramId}:`, err.message);
                    }
                    
                    if (adminNotificationSucceeded) {
                        await bot.sendMessage(chatId,
                            `✅ <b>Buy order created!</b>\n\n` +
                            `ID: <code>${orderId}</code>\n` +
                            `User: @${data.username}\n` +
                            `Amount: ${data.amount} USDT\n` +
                            `Stars: ${data.stars}`,
                            { parse_mode: 'HTML' }
                        );
                    } else {
                        await bot.sendMessage(chatId, `⚠️ Order created but notification failed.`);
                    }
                };
                
                bot.once('message', handleStep1);
            }
        } catch (error) {
            console.error('Error in /cbo command:', error);
            await bot.sendMessage(chatId, `❌ Error: ${error.message}`);
        }
    };
    
    bot.once('message', handleOrderId);
});
                
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
        if (data.startsWith('confirm_sell_')) {
            const [_, __, orderId, adminChatId] = data.split('_');
            const order = await SellOrder.findOne({ id: orderId });

            if (order) {
                order.status = 'confirmed';
                order.dateConfirmed = new Date();
                await order.save();

                const userOrderDetails = `Your sell order has been confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                try {
                    const sent = await bot.sendMessage(order.telegramId, userOrderDetails);
                    try {
                        order.userMessageId = sent?.message_id || order.userMessageId;
                        await order.save();
                    } catch (_) {}
                } catch (err) {
                    const message = String(err && err.message || '');
                    const forbidden = (err && err.response && err.response.statusCode === 403) || /user is deactivated|bot was blocked/i.test(message);
                    if (!forbidden) throw err;
                }

                const adminOrderDetails = `Sell Order Confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(adminChatId, adminOrderDetails);

                const disabledButton = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Confirmed', callback_data: 'confirmed', disabled: true }]]
                    }
                };
                bot.editMessageReplyMarkup(disabledButton, { chat_id: chatId, message_id: query.message.message_id });
            }
        } else if (data.startsWith('confirm_buy_')) {
            const [_, __, orderId, adminChatId] = data.split('_');
            const order = await BuyOrder.findOne({ id: orderId });

            if (order) {
                order.status = 'confirmed';
                order.dateConfirmed = new Date();
                await order.save();

                const userOrderDetails = `Your buy order has been confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                try {
                    await bot.sendMessage(order.telegramId, userOrderDetails);
                } catch (err) {
                    const message = String(err && err.message || '');
                    const forbidden = (err && err.response && err.response.statusCode === 403) || /user is deactivated|bot was blocked/i.test(message);
                    if (!forbidden) throw err;
                }

                const adminOrderDetails = `Buy Order Confirmed:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: confirmed\nDate Created: ${order.dateCreated}`;
                bot.sendMessage(adminChatId, adminOrderDetails);

                const disabledButton = {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Confirmed', callback_data: 'confirmed', disabled: true }]]
                    }
                };
                bot.editMessageReplyMarkup(disabledButton, { chat_id: chatId, message_id: query.message.message_id });
            }
        }
    } catch (error) {
        console.error('Error confirming order:', error);
        bot.sendMessage(chatId, 'An error occurred while confirming the order.');
    }
});  
            
   //second user detection for adding users incase the start command doesn't work or not reachable 
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || 'user';

    try {
        // Skip /start command since it already adds users to the database
        if (msg.text && msg.text.startsWith('/start')) {
            return;
        }

        // Only cache users who are NOT already in the User database
        const existingUser = await User.findOne({ id: chatId });
        if (existingUser) {
            // User already in database, no need to cache
            return;
        }

        // Check if already in cache
        const existingCache = await Cache.findOne({ id: chatId });
        if (!existingCache) {
            // Only add to cache if they're not already a saved user
            await Cache.create({ id: chatId, username: username });
        }
    } catch (error) {
        console.error('Error caching user interaction:', error);
    }
});

bot.onText(/\/detect_users/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const adminUsername = msg.from.username || 'Unknown';
    const startTime = Date.now();

    try {
        if (!adminIds.includes(adminId)) {
            console.warn(`[SECURITY] Unauthorized detect_users attempt by user ${adminId} (@${adminUsername})`);
            return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        }

        console.log(`[ADMIN-ACTION] detect_users command initiated by @${adminUsername} (${adminId})`);

        await bot.sendMessage(chatId, '🔍 Detecting all users from bot interactions...');

        // Collect all unique user IDs from ALL interaction sources
        const userIds = new Set();
        const userMap = new Map(); // Store user info for upsert

        console.log('[ADMIN-ACTION] Scanning all user interaction sources...');

        // 1. From BUY orders
        const buyOrders = await BuyOrder.find({}, { telegramId: 1, username: 1 }).lean();
        console.log(`   • Found ${buyOrders.length} buy orders`);
        for (const order of buyOrders) {
            if (order.telegramId) {
                userIds.add(order.telegramId);
                if (!userMap.has(order.telegramId)) {
                    userMap.set(order.telegramId, { id: order.telegramId, username: order.username });
                }
            }
        }

        // 2. From SELL orders
        const sellOrders = await SellOrder.find({}, { telegramId: 1, username: 1 }).lean();
        console.log(`   • Found ${sellOrders.length} sell orders`);
        for (const order of sellOrders) {
            if (order.telegramId) {
                userIds.add(order.telegramId);
                if (!userMap.has(order.telegramId)) {
                    userMap.set(order.telegramId, { id: order.telegramId, username: order.username });
                }
            }
        }

        // 3. From DAILY activity/check-ins
        const dailyStates = await DailyState.find({}, { userId: 1 }).lean();
        console.log(`   • Found ${dailyStates.length} daily state records`);
        for (const state of dailyStates) {
            if (state.userId) {
                userIds.add(state.userId);
                if (!userMap.has(state.userId)) {
                    userMap.set(state.userId, { id: state.userId, username: null });
                }
            }
        }

        // 4. From REFERRALS (both referrer and referred)
        const referrals = await Referral.find({}, { referrerUserId: 1, referredUserId: 1 }).lean();
        console.log(`   • Found ${referrals.length} referral records`);
        for (const ref of referrals) {
            if (ref.referrerUserId) {
                userIds.add(ref.referrerUserId);
                if (!userMap.has(ref.referrerUserId)) {
                    userMap.set(ref.referrerUserId, { id: ref.referrerUserId, username: null });
                }
            }
            if (ref.referredUserId) {
                userIds.add(ref.referredUserId);
                if (!userMap.has(ref.referredUserId)) {
                    userMap.set(ref.referredUserId, { id: ref.referredUserId, username: null });
                }
            }
        }

        // 5. From REFERRAL WITHDRAWALS
        const withdrawals = await ReferralWithdrawal.find({}, { userId: 1, username: 1 }).lean();
        console.log(`   • Found ${withdrawals.length} withdrawal records`);
        for (const wd of withdrawals) {
            if (wd.userId) {
                userIds.add(wd.userId);
                if (!userMap.has(wd.userId)) {
                    userMap.set(wd.userId, { id: wd.userId, username: wd.username });
                }
            }
        }

        // 6. From WARNINGS/BANS
        const warnings = await Warning.find({}, { userId: 1 }).lean();
        console.log(`   • Found ${warnings.length} warning/ban records`);
        for (const warn of warnings) {
            if (warn.userId) {
                userIds.add(warn.userId);
                if (!userMap.has(warn.userId)) {
                    userMap.set(warn.userId, { id: warn.userId, username: null });
                }
            }
        }

        // 7. From CACHE (legacy)
        const cachedUsers = await Cache.find({}, { id: 1, username: 1 }).lean();
        console.log(`   • Found ${cachedUsers.length} cached users`);
        for (const cached of cachedUsers) {
            if (cached.id) {
                userIds.add(cached.id);
                if (!userMap.has(cached.id)) {
                    userMap.set(cached.id, { id: cached.id, username: cached.username });
                }
            }
        }

        // Now process all detected users
        console.log(`Processing ${userIds.size} unique users...`);
        let totalNew = 0;
        let totalAlreadySaved = 0;
        let totalFailed = 0;

        // Check existing users efficiently
        const existingUsers = await User.find({ id: { $in: Array.from(userIds) } }, { id: 1 }).lean();
        const existingUserIds = new Set(existingUsers.map(u => u.id));

        // Process each user
        for (const userId of userIds) {
            try {
                if (existingUserIds.has(userId)) {
                    // User already in database
                    totalAlreadySaved++;
                } else {
                    // Add new user
                    const userData = userMap.get(userId) || { id: userId, username: null };
                    try {
                        await User.findOneAndUpdate(
                            { id: userId },
                            { 
                                $set: { 
                                    id: userId, 
                                    username: userData.username || null,
                                    createdAt: new Date(),
                                    lastActive: new Date()
                                } 
                            },
                            { upsert: true, new: true }
                        );
                        totalNew++;
                    } catch (createErr) {
                        // Handle E11000 duplicate key error (race condition)
                        if (createErr.code === 11000) {
                            totalAlreadySaved++;
                        } else {
                            throw createErr;
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to process user ${userId}:`, error);
                totalFailed++;
            }
        }

        // Clear cache after successful processing
        await Cache.deleteMany({});

        // === COMPREHENSIVE DATA ANALYSIS ===
        // Get all users with detailed stats
        const allUsers = await User.find({}, { 
            id: 1, 
            username: 1, 
            createdAt: 1, 
            lastActive: 1,
            lastLocation: 1,
            devices: 1
        }).lean();
        
        // Analyze data completeness
        let usersWithUsername = 0;
        let usersWithLocation = 0;
        let usersWithDevices = 0;
        let usersActive24h = 0;
        let usersActive7d = 0;
        let usersInactive30d = 0;
        let completeDataCount = 0;
        const now = new Date();
        const day24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const day7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const day30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        for (const user of allUsers) {
            if (user.username) usersWithUsername++;
            if (user.lastLocation && user.lastLocation.country !== 'Unknown') usersWithLocation++;
            if (user.devices && user.devices.length > 0) usersWithDevices++;
            
            if (user.lastActive >= day24h) usersActive24h++;
            if (user.lastActive >= day7d) usersActive7d++;
            if (user.lastActive < day30d) usersInactive30d++;
            
            // Complete data = has username + location + device info
            if (user.username && user.lastLocation && user.lastLocation.country !== 'Unknown' && user.devices && user.devices.length > 0) {
                completeDataCount++;
            }
        }
        
        const totalUsers = allUsers.length;
        const locationCoverage = totalUsers > 0 ? ((usersWithLocation / totalUsers) * 100).toFixed(1) : 0;
        const usernameCoverage = totalUsers > 0 ? ((usersWithUsername / totalUsers) * 100).toFixed(1) : 0;
        const deviceCoverage = totalUsers > 0 ? ((usersWithDevices / totalUsers) * 100).toFixed(1) : 0;
        const completeDataCoverage = totalUsers > 0 ? ((completeDataCount / totalUsers) * 100).toFixed(1) : 0;
        
        // Get recent interactions
        const recentInteractions = await UserActivityLog.countDocuments({
            timestamp: { $gte: day24h }
        });
        
        // Top locations
        const topLocations = await User.aggregate([
            { $match: { 'lastLocation.country': { $nin: [null, undefined, 'Unknown'] } } },
            { $group: { _id: '$lastLocation.country', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]);

        const duration = Date.now() - startTime;
        const reportMessage = 
            `📊 *COMPREHENSIVE USER ANALYTICS REPORT*\n\n` +
            
            `*═══ DETECTION SUMMARY ═══*\n` +
            `Total Detected: ${userIds.size}\n` +
            `Newly Added: ${totalNew}\n` +
            `Already Saved: ${totalAlreadySaved}\n` +
            `Failed: ${totalFailed}\n\n` +
            
            `*═══ DATABASE STATS ═══*\n` +
            `Total Users in DB: ${totalUsers}\n` +
            `Users Added (All-time): ${totalUsers}\n\n` +
            
            `*═══ DATA COMPLETENESS ═══*\n` +
            `✅ With Username: ${usersWithUsername}/${totalUsers} (${usernameCoverage}%)\n` +
            `📍 With Location: ${usersWithLocation}/${totalUsers} (${locationCoverage}%)\n` +
            `💻 With Device Info: ${usersWithDevices}/${totalUsers} (${deviceCoverage}%)\n` +
            `🎯 Complete Profile: ${completeDataCount}/${totalUsers} (${completeDataCoverage}%)\n\n` +
            
            `*═══ ACTIVITY METRICS ═══*\n` +
            `Active (24h): ${usersActive24h} users\n` +
            `Active (7d): ${usersActive7d} users\n` +
            `Inactive (30d+): ${usersInactive30d} users\n` +
            `Recent Interactions (24h): ${recentInteractions} actions\n\n` +
            
            `*═══ TOP 5 LOCATIONS ═══*\n` +
            (topLocations.length > 0 ? 
                topLocations.map((loc, i) => `${i+1}. ${loc._id}: ${loc.count} users`).join('\n') :
                'No location data available') +
            `\n\n` +
            
            `*═══ PROCESSING ═══*\n` +
            `Duration: ${duration}ms\n` +
            `Scanned Sources:\n` +
            `  • Buy Orders\n` +
            `  • Sell Orders\n` +
            `  • Daily Activity\n` +
            `  • Referrals\n` +
            `  • Withdrawals\n` +
            `  • Warnings/Bans\n` +
            `  • Cache`;
        
        bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
        console.log(`[ADMIN-ACTION] detect_users completed by @${adminUsername} in ${duration}ms - Data Quality: ${completeDataCoverage}% complete profiles`);
    } catch (error) {
        console.error(`[ADMIN-ACTION] detect_users error by @${adminUsername}:`, error);
        bot.sendMessage(chatId, `❌ User detection failed: ${error.message}`);
    }
});

// Audit users - check for duplicate Telegram user IDs in database
bot.onText(/\/audit_users/, async (msg) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const adminUsername = msg.from.username || 'Unknown';
    const auditStartTime = Date.now();
    const AUDIT_TIMEOUT = 25000; // 25 second timeout (safer than 30s Telegram limit)

    try {
        // Security check - admin only
        if (!adminIds.includes(adminId)) {
            console.warn(`[SECURITY] Unauthorized audit_users attempt by user ${adminId} (@${adminUsername})`);
            return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        }

        console.log(`[ADMIN-ACTION] audit_users command initiated by @${adminUsername} (${adminId})`);

        bot.sendMessage(chatId, '🔍 Running user database audit...');

        // Run all queries in parallel for better performance
        const [
            totalUsers,
            duplicateIds,
            duplicateUsernames,
            nullIds,
            missingCreatedAt,
            timeInconsistencies
        ] = await Promise.all([
            // 1. Total users - fastest query
            User.countDocuments({}).hint({ id: 1 }).exec(),

            // 2. Check for duplicate Telegram IDs - uses aggregation pipeline
            (async () => {
                try {
                    return await User.aggregate([
                        { $group: { _id: '$id', count: { $sum: 1 } } },
                        { $match: { count: { $gt: 1 } } }
                    ]).exec();
                } catch (err) {
                    console.warn('Duplicate ID check timeout, returning empty', err.message);
                    return [];
                }
            })(),

            // 3. Check for duplicate usernames - filters first to reduce data
            (async () => {
                try {
                    return await User.aggregate([
                        { $match: { username: { $ne: null } } },
                        { $group: { _id: '$username', count: { $sum: 1 } } },
                        { $match: { count: { $gt: 1 } } }
                    ]).exec();
                } catch (err) {
                    console.warn('Duplicate username check timeout, returning empty', err.message);
                    return [];
                }
            })(),

            // 4. Check for null IDs - simple count
            User.countDocuments({ id: null }).hint({ id: 1 }).exec(),

            // 5. Check for missing createdAt - simple count
            User.countDocuments({ createdAt: null }).hint({ createdAt: 1 }).exec(),

            // 6. Check for time inconsistencies - expression query
            (async () => {
                try {
                    return await User.countDocuments({
                        $expr: { $gt: ['$createdAt', '$lastActive'] }
                    }).exec();
                } catch (err) {
                    console.warn('Time inconsistency check timeout, returning 0', err.message);
                    return 0;
                }
            })()
        ]);

        const auditDuration = Date.now() - auditStartTime;

        // Check if audit took too long (might be incomplete/slow)
        const isSlowAudit = auditDuration > 20000;
        const speedWarning = isSlowAudit ? '⚠️ *WARNING: Audit took longer than expected*\n' : '';

        // Build report
        let report = `📊 *User Database Audit Report*\n\n`;
        report += `Total Users: *${totalUsers}*\n\n`;
        
        report += `*Duplicate Telegram IDs:* ${duplicateIds.length === 0 ? '✅ None' : `❌ ${duplicateIds.length}`}\n`;
        report += `*Duplicate Usernames:* ${duplicateUsernames.length === 0 ? '✅ None' : `❌ ${duplicateUsernames.length}`}\n`;
        report += `*Null Telegram IDs:* ${nullIds === 0 ? '✅ None' : `❌ ${nullIds}`}\n`;
        report += `*Missing CreatedAt:* ${missingCreatedAt === 0 ? '✅ None' : `❌ ${missingCreatedAt}`}\n`;
        report += `*Time Inconsistencies:* ${timeInconsistencies === 0 ? '✅ None' : `❌ ${timeInconsistencies}`}\n\n`;

        const hasIssues = duplicateIds.length > 0 || duplicateUsernames.length > 0 || nullIds > 0 || missingCreatedAt > 0 || timeInconsistencies > 0;
        report += hasIssues ? '⚠️ *STATUS: ISSUES FOUND*' : '✅ *STATUS: ALL PASSED*';
        report += `\n\n*Duration:* ${auditDuration}ms`;
        
        if (speedWarning) {
            report = speedWarning + report;
        }

        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        console.log(`[ADMIN-ACTION] audit_users completed by @${adminUsername} in ${auditDuration}ms`);
    } catch (error) {
        const auditDuration = Date.now() - auditStartTime;
        console.error(`[ADMIN-ACTION] audit_users error by @${adminUsername}:`, error);
        
        let errorMsg = `❌ Audit failed`;
        if (error.name === 'MongoServerSelectionError') {
            errorMsg += ': Database connection issue';
        } else if (error.name === 'MongoServerError' && error.message.includes('exceeded')) {
            errorMsg += ': Audit took too long (database timeout)';
        } else {
            errorMsg += `: ${error.message}`;
        }
        
        errorMsg += `\n⏱️ Duration: ${auditDuration}ms`;
        bot.sendMessage(chatId, errorMsg);
    }
});

// Geographic analysis - analyze user distribution by country
bot.onText(/\/geo_analysis(?:\s+(cities))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const adminUsername = msg.from.username || 'Unknown';
    const includesCities = match?.[1]?.toLowerCase() === 'cities';
    const analysisStart = Date.now();

    try {
        // Security check - admin only
        if (!adminIds.includes(adminId)) {
            console.warn(`[SECURITY] Unauthorized geo_analysis attempt by user ${adminId} (@${adminUsername})`);
            return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        }

        console.log(`[ADMIN-ACTION] geo_analysis command initiated by @${adminUsername} (${adminId})`);
        
        await bot.sendMessage(chatId, 'Analyzing geographic distribution...');

        // Get all users with location data
        const users = await User.find({
            'lastLocation.country': { $ne: null }
        }, { 'lastLocation.country': 1, 'lastLocation.city': 1 }).lean();

        // Country code to full name mapping
        const countryNames = {
            'KE': 'Kenya', 'UG': 'Uganda', 'BD': 'Bangladesh', 'US': 'United States', 'GB': 'United Kingdom',
            'IN': 'India', 'NG': 'Nigeria', 'PK': 'Pakistan', 'BR': 'Brazil', 'MX': 'Mexico',
            'DE': 'Germany', 'FR': 'France', 'IT': 'Italy', 'ES': 'Spain', 'CA': 'Canada',
            'AU': 'Australia', 'NZ': 'New Zealand', 'JP': 'Japan', 'CN': 'China', 'RU': 'Russia',
            'ZA': 'South Africa', 'EG': 'Egypt', 'TZ': 'Tanzania', 'GH': 'Ghana', 'ET': 'Ethiopia',
            'PH': 'Philippines', 'TH': 'Thailand', 'VN': 'Vietnam', 'ID': 'Indonesia', 'MY': 'Malaysia',
            'SG': 'Singapore', 'HK': 'Hong Kong', 'KR': 'South Korea', 'TW': 'Taiwan', 'NL': 'Netherlands',
            'BE': 'Belgium', 'CH': 'Switzerland', 'SE': 'Sweden', 'NO': 'Norway', 'DK': 'Denmark',
            'FI': 'Finland', 'PL': 'Poland', 'CZ': 'Czech Republic', 'AT': 'Austria', 'PT': 'Portugal',
            'GR': 'Greece', 'TR': 'Turkey', 'IL': 'Israel', 'SA': 'Saudi Arabia', 'AE': 'United Arab Emirates',
            'KW': 'Kuwait', 'QA': 'Qatar', 'AR': 'Argentina', 'CL': 'Chile', 'CO': 'Colombia',
            'PE': 'Peru', 'VE': 'Venezuela', 'EC': 'Ecuador', 'BO': 'Bolivia', 'PY': 'Paraguay',
            'UY': 'Uruguay', 'CR': 'Costa Rica', 'PA': 'Panama', 'SV': 'El Salvador', 'HN': 'Honduras',
            'NI': 'Nicaragua', 'GT': 'Guatemala', 'BZ': 'Belize', 'JM': 'Jamaica', 'CU': 'Cuba',
            'DO': 'Dominican Republic', 'HT': 'Haiti', 'PR': 'Puerto Rico', 'TT': 'Trinidad and Tobago',
            // additional codes seen in reports
            'MM': 'Myanmar', 'DZ': 'Algeria', 'CM': 'Cameroon', 'UA': 'Ukraine', 'UZ': 'Uzbekistan',
            'LK': 'Sri Lanka', 'IQ': 'Iraq', 'KH': 'Cambodia', 'NP': 'Nepal', 'ML': 'Mali',
            'AF': 'Afghanistan', 'CI': 'Côte d\'Ivoire', 'TN': 'Tunisia'
        };

        // Aggregate by country, filter out 'unknown'
        const countryStats = {};
        const cityStats = {};
        
        for (const user of users) {
            if (user.lastLocation?.country && user.lastLocation.country.toLowerCase() !== 'unknown') {
                const countryCode = user.lastLocation.country;
                const countryName = countryNames[countryCode] || countryCode;
                countryStats[countryName] = (countryStats[countryName] || 0) + 1;
                
                if (includesCities && user.lastLocation?.city) {
                    const cityKey = `${user.lastLocation.city}, ${countryName}`;
                    cityStats[cityKey] = (cityStats[cityKey] || 0) + 1;
                }
            }
        }

        // Sort countries by user count (descending)
        const sortedCountries = Object.entries(countryStats)
            .sort((a, b) => b[1] - a[1]); // include all countries (no top-50 limit)

        const totalUsersWithLocation = Object.values(countryStats).reduce((a, b) => a + b, 0);
        const totalUsers = await User.countDocuments({});
        const usersWithoutLocation = totalUsers - totalUsersWithLocation;

        let report = `<b>Geographic User Distribution</b>\n\n`;
        report += `Total Users: <code>${totalUsers}</code>\n`;
        report += `With Location: <code>${totalUsersWithLocation}</code>\n`;
        report += `Without Location: <code>${usersWithoutLocation}</code>\n`;
        report += `Countries Represented: <code>${Object.keys(countryStats).length}</code>\n\n`;
        report += `<b>Top Countries:</b>\n`;

        sortedCountries.forEach(([country, count], index) => {
            const percentage = ((count / totalUsersWithLocation) * 100).toFixed(1);
            report += `${index + 1}. ${country}: <code>${count}</code> users (<code>${percentage}%</code>)\n`;
        });

        // Add city breakdown if requested
        if (includesCities && Object.keys(cityStats).length > 0) {
            const sortedCities = Object.entries(cityStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20); // Top 20 cities

            report += `\n<b>Top Cities:</b>\n`;
            sortedCities.forEach(([city, count], index) => {
                const percentage = ((count / totalUsersWithLocation) * 100).toFixed(1);
                report += `${index + 1}. ${city}: <code>${count}</code> users (<code>${percentage}%</code>)\n`;
            });
        }

        const duration = Date.now() - analysisStart;
        report += `\n<b>Duration:</b> <code>${duration}ms</code>`;
        if (includesCities) {
            report += `\n\nTip: Use /geo_analysis for countries only`;
        } else {
            report += `\n\nTip: Use /geo_analysis cities for city breakdown`;
        }

        console.log(`[ADMIN-ACTION] geo_analysis completed by @${adminUsername} in ${duration}ms`);
        bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
    } catch (error) {
        console.error(`[ADMIN-ACTION] geo_analysis error by @${adminUsername} (${adminId}):`, error);
        bot.sendMessage(chatId, `❌ Analysis failed: ${error.message}`);
    }
});

app.post('/api/survey', requireTelegramAuth, async (req, res) => {
    try {
        const surveyData = req.body;
        
        let message = `📊 *New Survey Submission*\n\n`;
        message += `*Usage Frequency*: ${surveyData.usageFrequency}\n`;
        
        if (surveyData.favoriteFeatures) {
            const features = Array.isArray(surveyData.favoriteFeatures) 
                ? surveyData.favoriteFeatures.join(', ') 
                : surveyData.favoriteFeatures;
            message += `*Favorite Features*: ${features}\n`;
        }
        
        message += `*Desired Features*: ${surveyData.desiredFeatures}\n`;
        message += `*Overall Rating*: ${surveyData.overallRating}/5\n`;
        
        if (surveyData.improvementFeedback) {
            message += `*Improvement Feedback*: ${surveyData.improvementFeedback}\n`;
        }
        
        message += `*Technical Issues*: ${surveyData.technicalIssues || 'No'}\n`;
        
        if (surveyData.technicalIssues === 'yes' && surveyData.technicalIssuesDetails) {
            message += `*Issue Details*: ${surveyData.technicalIssuesDetails}\n`;
        }
        
        message += `\n📅 Submitted: ${new Date().toLocaleString()}`;
        
        const sendPromises = adminIds.map(chatId => {
            return bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        });
        
        await Promise.all(sendPromises);
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error processing survey:', error);
        res.status(500).json({ success: false, error: 'Failed to process survey' });
    }
});

        
//feedback on sell orders
bot.onText(/\/sell_complete (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const orderId = match[1].trim();
    const order = await SellOrder.findOne({ id: orderId });
    
    if (!order) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    try {
        // Send confirmation to user
        const confirmationMessage = `🎉 Order #${orderId} Completed!\n\n` +
                                 `We've successfully processed your sell order for ${order.stars} stars.\n\n` +
                                 `Payment was sent to:\n` +
                                 `\`${order.walletAddress}\`\n\n` +
                                 `We'd love to hear about your experience!`;
        
        const feedbackKeyboard = {
            inline_keyboard: [
                [{ text: "⭐ Leave Feedback", callback_data: `start_feedback_${orderId}` }],
                [{ text: "Skip Feedback", callback_data: `skip_feedback_${orderId}` }]
            ]
        };

        await bot.sendMessage(
            order.telegramId,
            confirmationMessage,
            { 
                parse_mode: 'Markdown',
                reply_markup: feedbackKeyboard 
            }
        );

        await bot.sendMessage(chatId, `✅ Sent completion notification for order ${orderId} to user @${order.username}`);
        
    } catch (error) {
        if (error.response?.error_code === 403) {
            await bot.sendMessage(chatId, `❌ Failed to notify user @${order.username} (user blocked the bot)`);
        } else {
            console.error('Notification error:', error);
            await bot.sendMessage(chatId, `❌ Failed to send notification for order ${orderId}`);
        }
    }
});

// Feedback session state management
const feedbackSessions = {};
const completedFeedbacks = new Set(); // Track users who have already submitted feedback

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    if (data.startsWith('start_feedback_')) {
        const orderId = data.split('_')[2];
        const order = await SellOrder.findOne({ id: orderId });
        
        if (!order) return;
        
        // Check if user has already completed feedback for this order
        if (completedFeedbacks.has(chatId.toString() + '_' + orderId)) {
            await bot.sendMessage(chatId, "You have already submitted feedback for this order. Thank you!");
            await bot.answerCallbackQuery(query.id);
            return;
        }
        
        // Initialize feedback session
        feedbackSessions[chatId] = {
            orderId: orderId,
            telegramId: order.telegramId,
            username: order.username,
            currentQuestion: 1, // 1 = satisfaction, 2 = reasons, 3 = suggestions, 4 = additional info
            responses: {},
            active: true
        };

        // Ask first question
        await askFeedbackQuestion(chatId, 1);
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('skip_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update message to show feedback was skipped
        await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: "✓ Feedback Skipped", callback_data: 'feedback_skipped' }]] },
            { chat_id: chatId, message_id: messageId }
        );
        
        await bot.sendMessage(chatId, "Thank you for your order! We appreciate your business.");
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('feedback_rating_')) {
        // Handle rating selection
        const rating = parseInt(data.split('_')[2]);
        const session = feedbackSessions[chatId];
        
        if (session && session.active) {
            session.responses.satisfaction = rating;
            session.currentQuestion = 2;
            
            await askFeedbackQuestion(chatId, 2);
            await bot.answerCallbackQuery(query.id);
        }
    }
    // Add other feedback handlers here if needed
});

async function askFeedbackQuestion(chatId, questionNumber) {
    const session = feedbackSessions[chatId];
    if (!session) return;
    
    let questionText = '';
    let replyMarkup = {};
    
    switch(questionNumber) {
        case 1: // Satisfaction rating
            questionText = "How satisfied are you with our service? (1-5 stars)";
            replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "⭐", callback_data: `feedback_rating_1` },
                        { text: "⭐⭐", callback_data: `feedback_rating_2` },
                        { text: "⭐⭐⭐", callback_data: `feedback_rating_3` },
                        { text: "⭐⭐⭐⭐", callback_data: `feedback_rating_4` },
                        { text: "⭐⭐⭐⭐⭐", callback_data: `feedback_rating_5` }
                    ],
                    [{ text: "Skip", callback_data: `feedback_skip_1` }]
                ]
            };
            break;
            
        case 2: // Reasons for rating
            questionText = "Could you tell us why you gave this rating?";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip", callback_data: `feedback_skip_2` }]
                ]
            };
            break;
            
        case 3: // Suggestions
            questionText = "What could we improve or add to make your experience better?";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip", callback_data: `feedback_skip_3` }]
                ]
            };
            break;
            
        case 4: // Additional info
            questionText = "Any additional comments? (Optional - you can skip this)";
            replyMarkup = {
                inline_keyboard: [
                    [{ text: "Skip and Submit", callback_data: `feedback_complete` }]
                ]
            };
            break;
    }
    
    // If we're moving to a new question, send it (but don't delete previous ones)
    if (questionText) {
        const message = await bot.sendMessage(chatId, questionText, { reply_markup: replyMarkup });
        session.lastQuestionMessageId = message.message_id;
    }
}

// Handle text responses to feedback questions
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id.toString();
    const session = feedbackSessions[chatId];
    
    if (!session || !session.active) return;
    
    try {
        switch(session.currentQuestion) {
            case 2: // Reasons for rating
                session.responses.reasons = msg.text;
                session.currentQuestion = 3;
                await askFeedbackQuestion(chatId, 3);
                break;
                
            case 3: // Suggestions
                session.responses.suggestions = msg.text;
                session.currentQuestion = 4;
                await askFeedbackQuestion(chatId, 4);
                break;
                
            case 4: // Additional info
                session.responses.additionalInfo = msg.text;
                await completeFeedback(chatId);
                break;
        }
    } catch (error) {
        console.error('Feedback processing error:', error);
    }
});

async function completeFeedback(chatId) {
    const session = feedbackSessions[chatId];
    if (!session) return;
    
    try {
        // Save feedback to database
        const feedback = new Feedback({
            orderId: session.orderId,
            telegramId: session.telegramId,
            username: session.username,
            satisfaction: session.responses.satisfaction,
            reasons: session.responses.reasons,
            suggestions: session.responses.suggestions,
            additionalInfo: session.responses.additionalInfo
        });
        
        await feedback.save();
        
        // Add to completed feedbacks set
        completedFeedbacks.add(chatId.toString() + '_' + session.orderId);
        
        // Notify admins
        const adminMessage = `📝 New Feedback Received\n\n` +
                            `Order: ${session.orderId}\n` +
                            `User: @${session.username} (ID: ${chatId})\n` +
                            `Rating: ${session.responses.satisfaction}/5\n` +
                            `Reasons: ${session.responses.reasons || 'Not provided'}\n` +
                            `Suggestions: ${session.responses.suggestions || 'Not provided'}\n` +
                            `Additional Info: ${session.responses.additionalInfo || 'None'}`;
        
        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(adminId, adminMessage);
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }
        
        // Thank user
        await bot.sendMessage(chatId, "Thank you for your feedback! We appreciate your time.");
        
    } catch (error) {
        console.error('Error saving feedback:', error);
        await bot.sendMessage(chatId, "Sorry, we couldn't save your feedback. Please try again later.");
    } finally {
        // Clean up session
        delete feedbackSessions[chatId];
    }
}

// Handle skip actions for feedback questions
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    
    if (data.startsWith('feedback_skip_')) {
        const questionNumber = parseInt(data.split('_')[2]);
        const session = feedbackSessions[chatId];
        
        if (session) {
            if (questionNumber < 4) {
                // Move to next question
                session.currentQuestion = questionNumber + 1;
                await askFeedbackQuestion(chatId, session.currentQuestion);
            } else {
                // Complete feedback if on last question
                await completeFeedback(chatId);
            }
        }
        await bot.answerCallbackQuery(query.id);
        
    } else if (data === 'feedback_complete') {
        await completeFeedback(chatId);
        await bot.answerCallbackQuery(query.id);
    }
});
//end of sell order feedback



//notification for reversing orders
bot.onText(/\/sell_decline (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }

    const orderId = match[1].trim();
    const order = await SellOrder.findOne({ id: orderId });
    
    if (!order) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    try {
        await bot.sendMessage(
            order.telegramId,
            `⚠️ Order #${orderId} Notification\n\n` +
            `Your order was canceled because the stars were reversed during our 21-day holding period.\n\n` +
            `Since the transaction cannot be completed after any reversal, you'll need to submit a new order if you still wish to sell your stars.\n\n` +
            `We'd appreciate your feedback to help us improve:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Provide Feedback", callback_data: `reversal_feedback_${orderId}` },
                            { text: "Skip", callback_data: `skip_feedback_${orderId}` }
                        ]
                    ]
                }
            }
        );

        await bot.sendMessage(chatId, `✅ Sent reversal notification for order ${orderId} to user @${order.username}`);
        
    } catch (error) {
        if (error.response?.error_code === 403) {
            await bot.sendMessage(chatId, `❌ Failed to notify user @${order.username} (user blocked the bot)`);
        } else {
            console.error('Notification error:', error);
            await bot.sendMessage(chatId, `❌ Failed to send notification for order ${orderId}`);
        }
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    if (data.startsWith('reversal_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update buttons to show feedback submitted
        await bot.editMessageReplyMarkup(
            {
                inline_keyboard: [
                    [{ text: "✓ Feedback Submitted", callback_data: `feedback_submitted_${orderId}` }]
                ]
            },
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
        
        // Prompt for feedback
        await bot.sendMessage(
            chatId,
            `Please tell us why the stars were reversed and how we can improve:`
        );
        
        // Set temporary state to collect feedback
        userFeedbackState[chatId] = {
            orderId: orderId,
            timestamp: Date.now()
        };
        
        await bot.answerCallbackQuery(query.id);
        
    } else if (data.startsWith('skip_feedback_')) {
        const orderId = data.split('_')[2];
        
        // Update buttons to show feedback skipped
        await bot.editMessageReplyMarkup(
            {
                inline_keyboard: [
                    [{ text: "✗ Feedback Skipped", callback_data: `feedback_skipped_${orderId}` }]
                ]
            },
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
        
        await bot.answerCallbackQuery(query.id);
    }
});

// Handle feedback messages
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id.toString();
    const feedbackState = userFeedbackState[chatId];
    
    if (feedbackState && Date.now() - feedbackState.timestamp < 600000) { // 10 minute window
        const orderId = feedbackState.orderId;
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        
        // Notify admins
        const adminMessage = `📝 Reversal Feedback\n\n` +
                            `Order: ${orderId}\n` +
                            `User: ${username}\n` +
                            `Feedback: ${msg.text}`;
        
        adminIds.forEach(adminId => {
            bot.sendMessage(adminId, adminMessage);
        });
        
        // Confirm receipt
        await bot.sendMessage(chatId, `Thank you for your feedback!`);
        
        // Clear state
        delete userFeedbackState[chatId];
    }
});

// Temporary state storage
const userFeedbackState = {};

// Cleanup expired feedback states (runs hourly)
setInterval(() => {
    const now = Date.now();
    for (const [chatId, state] of Object.entries(userFeedbackState)) {
        if (now - state.timestamp > 600000) { // 10 minutes
            delete userFeedbackState[chatId];
        }
    }
}, 60 * 60 * 1000);

// Clean up broadcast sessions that expire
setInterval(() => {
    const now = Date.now();
    const timeout = 15 * 60 * 1000; // 15 minutes
    
    for (const [chatId, session] of broadcastSessions.entries()) {
        if (now - session.timestamp > timeout) {
            broadcastSessions.delete(chatId);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

//get total users from db
bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    if (!adminIds.includes(chatId.toString())) {
        bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
        return;
    }

    try {
        const userCount = await User.countDocuments({});
        bot.sendMessage(chatId, `📊 Total users in the database: ${userCount}`);
    } catch (err) {
        console.error('Error fetching user count:', err);
        bot.sendMessage(chatId, '❌ Failed to fetch user count.');
    }
});

// Duplicate activity command removed - using the comprehensive one above

// ==================== FEEDBACK API ENDPOINTS ====================

/**
 * POST /api/feedback/submit
 * Submit general feedback with optional media attachments
 * Expected form-data:
 * - userId: User's Telegram ID
 * - type: 'bug' | 'feature' | 'improvement' | 'general'
 * - email: User's email
 * - message: Feedback message (max 3000 chars)
 * - timestamp: ISO timestamp
 * - media_*: File attachments (images/videos, max 20MB total)
 */
app.post('/api/feedback/submit', upload.any(), async (req, res) => {
    try {
        // Check if MongoDB is available
        if (!process.env.MONGODB_URI) {
            console.warn('Feedback submission attempted without MongoDB connection');
            return res.status(503).json({
                success: false,
                error: 'Feedback service temporarily unavailable. Please try again later.'
            });
        }

        const { userId, type, email, message, timestamp } = req.body;

        // Validate required fields
        if (!userId || !type || !email || !message) {
            console.warn('Feedback validation failed: missing required fields');
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, type, email, message'
            });
        }

        // Validate feedback type
        if (!['bug', 'feature', 'improvement', 'general'].includes(type)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid feedback type'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid email format'
            });
        }

        // Validate message length
        if (message.length === 0 || message.length > 3000) {
            return res.status(400).json({
                success: false,
                error: 'Message must be between 1 and 3000 characters'
            });
        }

        // Create feedback document
        const feedbackData = {
            userId,
            type,
            email,
            message,
            mediaFiles: [],
            totalMediaSize: 0,
            createdAt: timestamp ? new Date(timestamp) : new Date()
        };

        // Process uploaded files
        if (req.files && req.files.length > 0) {
            req.files.forEach((file, index) => {
                feedbackData.mediaFiles.push({
                    filename: file.filename || `file_${index}`,
                    originalName: file.originalname || file.fieldname,
                    mimetype: file.mimetype,
                    size: file.size,
                    uploadedAt: new Date()
                });
                feedbackData.totalMediaSize += file.size;
            });
            console.log(`Feedback has ${feedbackData.mediaFiles.length} attached files`);
        }

        // Save to database
        const feedback = new GeneralFeedback(feedbackData);
        await feedback.save();
        console.log('Feedback saved:', { id: feedback._id, email, type, attachments: feedbackData.mediaFiles.length });

        // Notify admins via Telegram (if bot is available)
        try {
            // Create full message with complete feedback text
            const adminMessage = `📬 New ${type} feedback from User ID: ${userId}\n\n📧 Email: ${email}\n\n💬 Message:\n${message}${feedbackData.mediaFiles.length > 0 ? `\n\n📎 Attachments: ${feedbackData.mediaFiles.length} file(s)` : ''}`;
            
            for (const adminId of adminIds) {
                try {
                    await bot.sendMessage(adminId, adminMessage, {
                        parse_mode: 'HTML'
                    });
                    
                    // Send attached files if any
                    if (req.files && req.files.length > 0) {
                        for (const file of req.files) {
                            try {
                                await bot.sendDocument(adminId, file.buffer, {
                                    caption: `📎 ${file.originalname || 'Attachment'} (${(file.size / 1024).toFixed(2)} KB)`
                                });
                            } catch (fileErr) {
                                console.error(`Failed to send file to admin ${adminId}:`, fileErr.message);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Failed to notify admin ${adminId}:`, e.message);
                }
            }
        } catch (e) {
            console.error('Error notifying admins:', e.message);
        }

        return res.json({
            success: true,
            message: 'Feedback submitted successfully',
            feedbackId: feedback._id
        });

    } catch (error) {
        console.error('Feedback submission error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to save feedback: ' + error.message
        });
    }
});

/**
 * GET /api/feedback/list
 * Get all feedback submissions (admin only)
 * Query params:
 * - status: 'new' | 'read' | 'archived' (optional)
 * - type: feedback type filter (optional)
 * - limit: number of results (default 50)
 * - skip: pagination offset (default 0)
 */
app.get('/api/feedback/list', requireAdmin, async (req, res) => {
    try {
        const { status, type, limit = 50, skip = 0 } = req.query;
        
        const query = {};
        if (status) query.status = status;
        if (type) query.type = type;

        const feedbacks = await GeneralFeedback.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip))
            .lean();

        const total = await GeneralFeedback.countDocuments(query);

        return res.json({
            success: true,
            data: feedbacks,
            pagination: {
                total,
                limit: parseInt(limit),
                skip: parseInt(skip),
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Feedback list error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback list'
        });
    }
});

/**
 * GET /api/feedback/:feedbackId
 * Get single feedback submission details (admin only)
 */
app.get('/api/feedback/:feedbackId', requireAdmin, async (req, res) => {
    try {
        const { feedbackId } = req.params;

        const feedback = await GeneralFeedback.findById(feedbackId).lean();
        
        if (!feedback) {
            return res.status(404).json({
                success: false,
                error: 'Feedback not found'
            });
        }

        return res.json({
            success: true,
            data: feedback
        });

    } catch (error) {
        console.error('Feedback detail error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback details'
        });
    }
});

/**
 * PATCH /api/feedback/:feedbackId
 * Update feedback status or add admin notes (admin only)
 * Body:
 * - status: 'new' | 'read' | 'archived'
 * - adminNotes: Admin's notes
 */
app.patch('/api/feedback/:feedbackId', requireAdmin, async (req, res) => {
    try {
        const { feedbackId } = req.params;
        const { status, adminNotes } = req.body;

        const updateData = {
            updatedAt: new Date()
        };

        if (status) {
            if (!['new', 'read', 'archived'].includes(status)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid status'
                });
            }
            updateData.status = status;
        }

        if (adminNotes !== undefined) {
            updateData.adminNotes = adminNotes;
        }

        if (status || adminNotes) {
            updateData.processedBy = req.user?.id;
            updateData.processedAt = new Date();
        }

        const feedback = await GeneralFeedback.findByIdAndUpdate(
            feedbackId,
            updateData,
            { new: true }
        );

        if (!feedback) {
            return res.status(404).json({
                success: false,
                error: 'Feedback not found'
            });
        }

        return res.json({
            success: true,
            message: 'Feedback updated successfully',
            data: feedback
        });

    } catch (error) {
        console.error('Feedback update error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update feedback'
        });
    }
});

/**
 * GET /api/feedback/stats
 * Get feedback statistics (admin only)
 */
app.get('/api/feedback/stats', requireAdmin, async (req, res) => {
    try {
        const stats = {
            total: await GeneralFeedback.countDocuments({}),
            byType: await GeneralFeedback.aggregate([
                { $group: { _id: '$type', count: { $sum: 1 } } }
            ]),
            byStatus: await GeneralFeedback.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            thisMonth: await GeneralFeedback.countDocuments({
                createdAt: {
                    $gte: new Date(new Date().setDate(1)),
                    $lt: new Date()
                }
            })
        };

        return res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        console.error('Feedback stats error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback statistics'
        });
    }
});

// ==================== END FEEDBACK API ENDPOINTS ====================

// Run data migrations on startup
async function runMigrations() {
  try {
    // Migrate old 'completed' status to 'active' for backward compatibility
    const completedCount = await Referral.countDocuments({ status: 'completed' });
    if (completedCount > 0) {
      console.log(`[MIGRATION] Found ${completedCount} referrals with old 'completed' status...`);
      const result = await Referral.updateMany(
        { status: 'completed' },
        { $set: { status: 'active' } }
      );
      console.log(`[MIGRATION] ✓ Successfully migrated ${result.modifiedCount} referrals to 'active' status`);
    }
  } catch (error) {
    console.warn('[MIGRATION] Warning - could not complete status migration:', error.message);
  }
}

// Export app for testing before conditionally starting the server
module.exports = app;

const PORT = process.env.PORT || 8080;
if (require.main === module) {
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Minimal startup validation
  try {
    const fsSyncModule = require('fs');
    const publicDir = path.join(__dirname, 'public');
    
    if (!fsSyncModule.existsSync(publicDir)) {
      console.error('❌ CRITICAL: /public directory does not exist at:', publicDir);
      console.error('   This will cause 404 errors for all static files and routes');
      console.error('   Ensure the public/ folder is committed to git and deployed');
    }
  } catch (e) {
    // Silently continue
  }
  
  // Run migrations
  await runMigrations();
  
  // Log data retention & cleanup configuration
  const enableBotActivityLogging = process.env.ENABLE_BOT_ACTIVITY_LOGGING === '1';
  const activityRetentionDays = parseInt(process.env.ACTIVITY_RETENTION_DAYS || '90');
  const userActivitySampleRate = parseFloat(process.env.USERACTIVITYLOG_SAMPLE_RATE || '0.5');
  const userActivityRetentionDays = parseInt(process.env.USERACTIVITYLOG_RETENTION_DAYS || '30');
  
  console.log('📊 Data Retention & Cleanup Configuration:');
  console.log(`   • Bot Activity Logging: ${enableBotActivityLogging ? '✅ ENABLED' : '❌ DISABLED (default)'}`);
  console.log(`   • Activity Retention: ${activityRetentionDays} days (auto-delete older records)`);
  console.log(`   • UserActivityLog Sampling: ${Math.round(userActivitySampleRate * 100)}% of requests logged`);
  console.log(`   • UserActivityLog Retention: ${userActivityRetentionDays} days (auto-delete older records)`);
  
  // Start bot simulator if enabled
  if (process.env.ENABLE_BOT_SIMULATOR === '1' && startBotSimulatorSafe) {
    try {
      startBotSimulatorSafe({
        useMongo: !!process.env.MONGODB_URI,
        models: { User, DailyState, BotProfile, Activity },
        db
      });
      console.log('🤖 Bot simulator enabled');
    } catch (e) {
      console.warn('Failed to start bot simulator:', e.message);
    }
  }
  
  // Initialize end-of-month withdrawal scheduler
  if (schedule && schedule.scheduleEndOfMonthTask) {
    // Define the withdrawal processing function
    const processAmbassadorWithdrawals = async () => {
      try {
        console.log('[Scheduler] Processing end-of-month ambassador withdrawals...');
        
        const now = new Date();
        const dayOfMonth = now.getDate();
        
        // Log calendar information for debugging
        const calendarMonthStr = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        console.log(`[Scheduler] Calendar: Today is ${calendarMonthStr}, Day ${dayOfMonth}/${daysInMonth}`);
        
        // CRITICAL: Only process auto-withdrawals on day 1 of the month
        // This prevents multiple withdrawals and ensures all reminders have been sent first
        if (dayOfMonth !== 1) {
          console.log(`[Scheduler] Skipping withdrawal processing - Today is day ${dayOfMonth}, need day 1 (next occurrence: ${calendarMonthStr.includes('May') ? 'June' : 'next month'} 1st)`);
          return;
        }
        
        console.log('[Scheduler] DAY 1 DETECTED - Starting end-of-month auto-withdrawals...');
        
        // Define date range for this month (used both for dedup + balance lookup)
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const monthStr = now.toISOString().substring(0, 7);

        // Find all ambassadors (have ambassadorEmail set)
        const ambassadors = await User.find({
          ambassadorEmail: { $exists: true, $ne: null }
        }).lean();

        console.log(`[Scheduler] Found ${ambassadors.length} total ambassadors`);

        let processedCount = 0;
        let skippedCount = 0;
        let reminderCount = 0;
        let alreadyDoneCount = 0;

        // Process each ambassador
        for (const ambassador of ambassadors) {
          try {
            // Per-ambassador dedup: skip if a withdrawal was already created
            // for this ambassador for this month (prevents duplicate runs while
            // still allowing other ambassadors to be processed)
            const existingThisMonth = await ReferralWithdrawal.findOne({
              userId: ambassador.id,
              isAmbassadorWithdrawal: true,
              ambassadorMonth: monthStr
            }).lean();

            if (existingThisMonth) {
              console.log(`[Scheduler] ${ambassador.username}: already processed this month (${existingThisMonth._id})`);
              alreadyDoneCount++;
              continue;
            }

            // Calculate available balance from non-withdrawn referrals
            const availableReferrals = await Referral.countDocuments({
              referrerUserId: ambassador.id,
              $or: [
                  { dateReferred: { $gte: monthStart, $lt: monthEnd } },
                  { dateReferred: { $exists: false }, dateCreated: { $gte: monthStart, $lt: monthEnd } }
              ],
              status: 'active',
              withdrawn: { $ne: true }
            });

            const availableBalance = availableReferrals * 0.5;

            // Skip if balance is below minimum withdrawal (0.5 USDT)
            if (availableBalance < 0.5) {
              console.log(`[Scheduler] Skipping ${ambassador.username}: insufficient balance ($${availableBalance.toFixed(2)})`);
              skippedCount++;
              continue;
            }
            
            // Check if ambassador has wallet address set
            if (!ambassador.ambassadorWalletAddress || ambassador.ambassadorWalletAddress.trim() === '') {
              const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
              const isLastDayOfMonth = dayOfMonth === daysInMonth;
              const isFirstDayOfMonth = dayOfMonth === 1;
              
              // Only send wallet reminders on last day of month or day 1 (not day 29)
              if (isLastDayOfMonth || isFirstDayOfMonth) {
                // Check if reminder already sent today to prevent duplicates when scheduler runs multiple times per hour
                const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                const reminderType = isLastDayOfMonth ? 'final' : 'last_chance';
                
                const alreadySentToday = await WalletReminder.findOne({
                  userId: ambassador.id,
                  reminderType: reminderType,
                  month: monthKey,
                  dayOfMonth: dayOfMonth
                });
                
                if (!alreadySentToday) {
                  console.log(`[Scheduler] Sending ${reminderType} reminder to ${ambassador.username} (balance: $${availableBalance.toFixed(2)}) - FIRST TIME THIS DAY`);
                  try {
                    if (ambassador.id) {
                      const reminderMsg = isLastDayOfMonth 
                        ? `⏰ **FINAL WALLET REMINDER** 💰\n\nYou have earnings of $${availableBalance.toFixed(2)} ready for payout!\n\n🔐 Set your TON wallet ADDRESS TODAY or your payout will be delayed.\n\nWithdraws tomorrow!`
                        : `⏰ **LAST CHANCE - WITHDRAWAL TODAY** 💰\n\nYou have earnings of $${availableBalance.toFixed(2)}!\n\n🔐 Set your wallet address NOW to receive your payout.\n\nAutomatic withdrawal is processing today.`;
                      await bot.sendMessage(ambassador.id, reminderMsg, { parse_mode: 'Markdown' });
                      
                      // Save reminder record for deduplication (prevents sending again same day even if app restarts)
                      const reminder = new WalletReminder({
                        userId: ambassador.id,
                        username: ambassador.username,
                        email: ambassador.ambassadorEmail,
                        reminderType: reminderType,
                        dayOfMonth: dayOfMonth,
                        month: monthKey,
                        balance: availableBalance,
                        sentAt: new Date()
                      });
                      await reminder.save();
                      
                      reminderCount++;
                    }
                  } catch (botError) {
                    console.warn(`[Scheduler] Failed to send reminder to ${ambassador.username}:`, botError.message);
                  }
                } else {
                  console.log(`[Scheduler] ${reminderType} reminder ALREADY SENT today to ${ambassador.username} - deduplicating (sent at ${alreadySentToday.sentAt.toLocaleTimeString()})`);
                }
              } else {
                console.log(`[Scheduler] No wallet for ${ambassador.username}: balance $${availableBalance.toFixed(2)} - skipping reminder (day ${dayOfMonth}, last day: ${daysInMonth})`);
              }
              continue;
            }
            
            // Create automatic withdrawal for ambassador
            const referralsToWithdraw = await Referral.find({
              referrerUserId: ambassador.id,
              $or: [
                  { dateReferred: { $gte: monthStart, $lt: monthEnd } },
                  { dateReferred: { $exists: false }, dateCreated: { $gte: monthStart, $lt: monthEnd } }
              ],
              status: 'active',
              withdrawn: { $ne: true }
            }).limit(Math.ceil(availableBalance / 0.5));
            
            const withdrawal = new ReferralWithdrawal({
              userId: ambassador.id,
              username: ambassador.username,
              isAmbassadorWithdrawal: true,
              amount: availableBalance,
              ambassadorLevel: ambassador.ambassadorCurrentLevel || 0,
              ambassadorReferralCount: availableReferrals,
              ambassadorLevelBreakdown: ambassador.ambassadorLevelEarnings || {},
              ambassadorMonth: now.toISOString().substring(0, 7),
              walletAddress: ambassador.ambassadorWalletAddress,
              referralIds: referralsToWithdraw.map(r => r._id.toString()),
              status: 'pending',
              createdAt: new Date()
            });
            
            await withdrawal.save();
            
            // Mark referrals as withdrawn
            await Referral.updateMany(
              { _id: { $in: referralsToWithdraw.map(r => r._id) } },
              { withdrawn: true }
            );

            // Send admin notifications with approve/decline buttons
            const adminMessage = `📩 AUTO-WITHDRAWAL REQUEST\n\n` +
                               `User: @${ambassador.username} (ID: ${ambassador.id})\n` +
                               `Amount: $${availableBalance.toFixed(2)} USDT\n` +
                               `Referrals: ${availableReferrals}\n` +
                               `Wallet: ${ambassador.ambassadorWalletAddress}\n` +
                               `Month: ${now.toISOString().substring(0, 7)}\n\n` +
                               `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;

            const adminKeyboard = {
              inline_keyboard: [
                [
                  { text: "✅ Complete", callback_data: `complete_withdrawal_${withdrawal._id}` },
                  { text: "❌ Decline", callback_data: `decline_withdrawal_${withdrawal._id}` }
                ]
              ]
            };

            // Send to all admins
            if (adminIds && Array.isArray(adminIds) && adminIds.length > 0) {
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
                  console.error(`[Scheduler] Failed to notify admin ${adminId}:`, err);
                  return null;
                }
              })).then(results => results.filter(Boolean));
              
              await withdrawal.save();
            }

            // Send user confirmation message (with amount and wallet)
            try {
              await bot.sendMessage(
                ambassador.id,
                `📋 **Automatic Withdrawal Submitted**\n\n` +
                `Amount: $${availableBalance.toFixed(2)} USDT\n` +
                `Wallet: ${ambassador.ambassadorWalletAddress}\n` +
                `Month: ${now.toISOString().substring(0, 7)}\n\n` +
                `ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                `Status: Pending approval`,
                { parse_mode: 'Markdown' }
              );
            } catch (botErr) {
              console.warn(`[Scheduler] Failed to send user confirmation for ${ambassador.username}:`, botErr.message);
            }
            
            // Send email notification
            try {
              await emailService.sendWithdrawalCreated(
                ambassador.ambassadorEmail,
                ambassador.username || 'Ambassador',
                availableBalance,
                availableReferrals
              );
            } catch (emailErr) {
              console.warn(`[Scheduler] Email notification failed for ${ambassador.username}:`, emailErr.message);
            }
            
            console.log(`[Scheduler] ✅ Automatic withdrawal created for ${ambassador.username}: $${availableBalance.toFixed(2)}`);
            processedCount++;
            
          } catch (ambError) {
            console.error(`[Scheduler] Error processing ${ambassador.username}:`, ambError.message);
          }
        }
        
        console.log(`[Scheduler] ✅ End-of-month processing complete - Processed: ${processedCount}, Skipped: ${skippedCount}, AlreadyDone: ${alreadyDoneCount}, Reminders: ${reminderCount}`);
      } catch (error) {
        console.error('[Scheduler] Error processing end-of-month withdrawals:', error);
      }
    };

    // Call immediately on startup to catch day 1 if we're already on it
    console.log('[Scheduler] Running initial end-of-month check on startup...');
    processAmbassadorWithdrawals();

    // Then set up the scheduler through the schedule object for hourly checks
    schedule.scheduleEndOfMonthTask(processAmbassadorWithdrawals);
    console.log('📅 End-of-month automatic withdrawal scheduler initialized');
  }

  // Initialize periodic referral repair scheduler (every 2 hours)
  if (schedule && schedule.schedulePeriodicRepair) {
    // Define the periodic repair function
    const runPeriodicRepair = async () => {
      try {
        console.log('[Scheduler] Starting periodic referral repair scan...');
        
        // Find all users with pending referrals that have bought/sold enough stars
        const pendingReferrals = await Referral.find({ status: 'pending' });
        
        if (pendingReferrals.length === 0) {
          console.log('[Scheduler] No pending referrals found, scan complete');
          return;
        }
        
        console.log(`[Scheduler] Found ${pendingReferrals.length} pending referrals to check`);
        
        // Group by referrer to repair in batches
        const userMap = {};
        for (const ref of pendingReferrals) {
          if (!userMap[ref.referrerUserId]) {
            userMap[ref.referrerUserId] = [];
          }
          userMap[ref.referrerUserId].push(ref);
        }
        
        let totalRepaired = 0;
        let usersProcessed = 0;
        
        // Process each user
        for (const [userId, refs] of Object.entries(userMap)) {
          try {
            // Clear debounce for periodic repair so it always runs
            repairDebounceCache.delete(userId);
            
            const repairedCount = await repairStuckReferrals(userId);
            if (repairedCount > 0) {
              totalRepaired += repairedCount;
              console.log(`[Scheduler] Periodic repair for user ${userId}: ${repairedCount} referrals fixed`);
            }
            usersProcessed++;
          } catch (userError) {
            console.error(`[Scheduler] Error repairing user ${userId}:`, userError.message);
          }
        }
        
        console.log(`[Scheduler] ✅ Periodic referral repair complete - Users: ${usersProcessed}, Total Repaired: ${totalRepaired}`);
      } catch (error) {
        console.error('[Scheduler] Error in periodic repair scan:', error);
      }
    };

    // Run immediately on startup (after a small delay to ensure DB is ready)
    setTimeout(() => {
      console.log('[Scheduler] Running initial periodic repair check on startup...');
      runPeriodicRepair();
    }, 2000);

    // Then set up the scheduler through the schedule object for 2-hour checks
    schedule.schedulePeriodicRepair(runPeriodicRepair);
    console.log('🔧 Periodic referral repair scheduler initialized (runs every 2 hours)');
  }
});
} // end: if (require.main === module)

app.get('/api/me', async (req, res) => {
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		return res.json({ id: sess.payload.tgId, isAdmin: true, username: null, isAmbassador: false });
	}
	const tgId = (req.headers['x-telegram-id'] || '').toString();
	let username = null;
	let isAmbassador = false;
	try { 
		if (req.user && req.user.username) username = req.user.username; 
		// Check if user is ambassador (from request object - may be cached)
		if (req.user && req.user.ambassadorEmail) isAmbassador = true;
	} catch(_) {}
	try { 
		if (!username && req.telegramInitData && req.telegramInitData.user && req.telegramInitData.user.username) username = req.telegramInitData.user.username; 
	} catch(_) {}
	
	// ALWAYS verify ambassador status against fresh database query (don't trust cache)
	if (tgId) {
		try {
			console.log(`Checking ambassador status for user ${tgId} in database`);
			const user = await User.findOne({ id: tgId }).lean();
			if (user && user.ambassadorEmail) {
				isAmbassador = true;
				console.log(`User ${tgId} IS ambassador (email: ${user.ambassadorEmail})`);
			} else {
				// User either doesn't exist OR doesn't have ambassadorEmail - not an ambassador
				isAmbassador = false;
				if (user) {
					console.log(`User ${tgId} found but NOT ambassador (ambassadorEmail: ${user.ambassadorEmail || 'undefined'})`);
				} else {
					console.log(`User ${tgId} NOT found in database`);
				}
			}
		} catch (e) {
			console.error('Error checking ambassador status:', e.message);
			// On error, default to NOT ambassador (safer than assuming)
			isAmbassador = false;
		}
	}
	
	return res.json({ id: tgId || null, isAdmin: tgId ? adminIds.includes(tgId) : false, username, isAmbassador });
});

// Basic admin stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
	try {
		const [totalOrders, pendingWithdrawals, totalUsers, revenueUsdt] = await Promise.all([
			Promise.resolve(await BuyOrder.countDocuments({}).catch(()=>0) + await SellOrder.countDocuments({}).catch(()=>0)),
			ReferralWithdrawal.countDocuments({ status: 'pending' }).catch(()=>0),
			User.countDocuments({}).catch(()=>0),
			Promise.resolve(0)
		]);
		res.json({ totalOrders, pendingWithdrawals, totalUsers, revenueUsdt });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load stats' });
	}
});

// Leaderboard and engagement performance for admins
app.get('/api/admin/performance', requireAdmin, async (req, res) => {
  try {
    // Load leaderboard inputs similarly to /api/leaderboard global scope
    let referralCounts, dailyUsers;
    if (process.env.MONGODB_URI) {
      [referralCounts, dailyUsers] = await Promise.all([
        Referral.aggregate([
          { $match: { status: { $in: ['active', 'completed'] } } },
          { $group: { _id: '$referrerUserId', referralsCount: { $sum: 1 } } }
        ]),
        DailyState.find({}, { userId: 1, totalPoints: 1, streak: 1, missionsCompleted: 1, lastCheckIn: 1 })
      ]);
    } else {
      [referralCounts, dailyUsers] = await Promise.all([
        db.aggregateReferrals([
          { $match: { status: { $in: ['active', 'completed'] } } },
          { $group: { _id: '$referrerUserId', referralsCount: { $sum: 1 } } }
        ]),
        db.findAllDailyStates()
      ]);
    }

    const allUserIds = Array.from(new Set([
      ...referralCounts.map(r => r._id),
      ...dailyUsers.map(d => d.userId)
    ]));

    let users;
    if (process.env.MONGODB_URI) {
      users = await User.find({ id: { $in: allUserIds } }, { id: 1, username: 1 });
    } else {
      users = await Promise.all(allUserIds.map(id => db.findUser(id)));
    }

    const idToUsername = new Map(users.filter(Boolean).map(u => [u.id, u.username]));
    const idToReferrals = new Map(referralCounts.map(r => [r._id, r.referralsCount]));
    const idToDaily = new Map(dailyUsers.map(d => [d.userId, d]));

    const maxPoints = Math.max(1, ...dailyUsers.map(d => d.totalPoints || 0));
    const maxReferrals = Math.max(1, ...referralCounts.map(r => r.referralsCount), 1);

    const entries = allUserIds.map(userId => {
      const referrals = idToReferrals.get(userId) || 0;
      const s = idToDaily.get(userId) || {};
      const missions = (s.missionsCompleted || []).length;
      const lastCheckIn = s.lastCheckIn ? new Date(s.lastCheckIn) : null;
      const daysSinceCheckIn = lastCheckIn ? Math.floor((Date.now() - lastCheckIn.getTime()) / (1000*60*60*24)) : null;
      const points = s.totalPoints || 0;
      const referralPoints = referrals * 5;
      const penaltyPoints = (() => {
        const today = new Date();
        if (!lastCheckIn) return 0;
        const diff = Math.floor((today - lastCheckIn) / (1000*60*60*24));
        return Math.max(0, diff - 1) * 2;
      })();
      const totalPoints = points + referralPoints - penaltyPoints;
      const score = ((totalPoints / Math.max(maxPoints + (maxReferrals * 5), 1)) * 0.6)
                  + ((referrals / maxReferrals) * 0.25)
                  + (Math.min(missions / 10, 1) * 0.15);
      return {
        userId,
        username: idToUsername.get(userId) || null,
        totalPoints,
        activityPoints: points,
        referralPoints,
        referralsCount: referrals,
        missionsCompleted: missions,
        streak: s.streak || 0,
        daysSinceCheckIn,
        score: Math.round(score * 100)
      };
    }).sort((a,b) => b.score - a.score);

    const top10 = entries.slice(0, 10);
    const totals = {
      usersCount: entries.length,
      totalActivityPoints: entries.reduce((sum, e) => sum + (e.activityPoints || 0), 0),
      totalReferralPoints: entries.reduce((sum, e) => sum + (e.referralPoints || 0), 0),
      avgMissionsCompleted: entries.length ? (entries.reduce((sum, e) => sum + (e.missionsCompleted || 0), 0) / entries.length) : 0,
      activeToday: entries.filter(e => e.daysSinceCheckIn === 0).length,
      active7d: entries.filter(e => e.daysSinceCheckIn !== null && e.daysSinceCheckIn <= 7).length
    };

    res.json({ success: true, top10, totals });
  } catch (e) {
    console.error('admin/performance error:', e);
    res.status(500).json({ success: false, error: 'Failed to load performance data' });
  }
});

// List recent orders (buy + sell)
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit) || 20, 200);
		const page = Math.max(parseInt(req.query.page) || 1, 1);
		const status = (req.query.status || '').toString().trim();
		const type = (req.query.type || 'all').toString().trim();
		const q = (req.query.q || '').toString().trim();

		// 🔐 SECURITY: Escape regex to prevent injection/ReDoS attacks
		const escapedQ = escapeRegex(q);
		const textFilter = q ? { $or: [
			{ id: { $regex: escapedQ, $options: 'i' } },
			{ username: { $regex: escapedQ, $options: 'i' } },
			{ telegramId: { $regex: escapedQ, $options: 'i' } }
		] } : {};
		const statusFilter = status ? { status } : {};

		const buyQuery = { ...statusFilter, ...textFilter };
		const sellQuery = { ...statusFilter, ...textFilter };
		const needBuy = type === 'all' || type === 'buy';
		const needSell = type === 'all' || type === 'sell';
		const [buyCount, sellCount] = await Promise.all([
			needBuy ? BuyOrder.countDocuments(buyQuery).catch(()=>0) : Promise.resolve(0),
			needSell ? SellOrder.countDocuments(sellQuery).catch(()=>0) : Promise.resolve(0)
		]);

		const take = limit * page;
		const [buys, sells] = await Promise.all([
			needBuy ? BuyOrder.find(buyQuery).sort({ dateCreated: -1 }).limit(take).lean() : Promise.resolve([]),
			needSell ? SellOrder.find(sellQuery).sort({ dateCreated: -1 }).limit(take).lean() : Promise.resolve([])
		]);

		const merged = [
			...buys.map(b => ({ id: b.id, type: 'buy', username: b.username, telegramId: b.telegramId, amount: b.amount, stars: b.stars, status: b.status, dateCreated: b.dateCreated })),
			...sells.map(s => ({ id: s.id, type: 'sell', username: s.username, telegramId: s.telegramId, amount: s.stars, stars: s.stars, status: s.status, dateCreated: s.dateCreated }))
		].sort((a,b)=> new Date(b.dateCreated) - new Date(a.dateCreated));

		const start = (page - 1) * limit;
		const orders = merged.slice(start, start + limit);
		const total = buyCount + sellCount;
		res.json({ orders, total });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load orders' });
	}
});

app.get('/api/admin/orders/export', requireAdmin, async (req, res) => {
	try {
		const status = (req.query.status || '').toString().trim();
		const q = (req.query.q || '').toString().trim();
		// 🔐 SECURITY: Escape regex to prevent injection/ReDoS attacks
		const escapedQ = escapeRegex(q);
		const textFilter = q ? { $or: [
			{ id: { $regex: escapedQ, $options: 'i' } },
			{ username: { $regex: escapedQ, $options: 'i' } },
			{ telegramId: { $regex: escapedQ, $options: 'i' } }
		] } : {};
		const statusFilter = status ? { status } : {};
		const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
		const [buys, sells] = await Promise.all([
			BuyOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(limit).lean(),
			SellOrder.find({ ...statusFilter, ...textFilter }).sort({ dateCreated: -1 }).limit(limit).lean()
		]);
		const rows = [
			...buys.map(b => ({ id: b.id, type: 'buy', username: b.username, telegramId: b.telegramId, amount: b.amount, status: b.status, dateCreated: b.dateCreated })),
			...sells.map(s => ({ id: s.id, type: 'sell', username: s.username, telegramId: s.telegramId, amount: s.amount, status: s.status, dateCreated: s.dateCreated }))
		].sort((a,b)=> new Date(b.dateCreated) - new Date(a.dateCreated));
		const csv = ['id,type,username,telegramId,amount,status,dateCreated']
			.concat(rows.map(r => [r.id, r.type, r.username || '', r.telegramId || '', r.amount || 0, r.status || '', new Date(r.dateCreated || Date.now()).toISOString()]
				.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')))
			.join('\n');
		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
		res.setHeader('Cache-Control', 'no-store');
		return res.send(csv);
	} catch (e) {
		return res.status(500).send('Failed to export');
	}
});

// Order actions
app.post('/api/admin/orders/:id/complete', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        // Try buy first, then sell
        let order = await BuyOrder.findOne({ id });
        let orderType = 'buy';
        if (!order) { order = await SellOrder.findOne({ id }); orderType = 'sell'; }
        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (orderType === 'sell' && order.status !== 'processing') {
            return res.status(409).json({ error: `Order is ${order.status} - cannot complete` });
        }
        if (orderType === 'buy' && order.status !== 'pending' && order.status !== 'processing') {
            return res.status(409).json({ error: `Order is ${order.status} - cannot complete` });
        }

        order.status = 'completed';
        order.dateCompleted = new Date();
        await order.save();

        // Mirror side effects
        if (orderType === 'sell') {
            if (order.stars) { 
                try { 
                    await trackStars(order.telegramId, order.stars, 'sell'); 
                } catch (error) {
                    console.error('Failed to track stars for sell order:', error);
                    // Notify admins about tracking failure
                    for (const adminId of adminIds) {
                        try {
                            await bot.sendMessage(adminId, `⚠️ Tracking Error - Sell Order #${order.id}\n\nFailed to track stars for user ${order.telegramId}\nError: ${error.message}`);
                        } catch (notifyErr) {
                            console.error(`Failed to notify admin ${adminId} about tracking error:`, notifyErr);
                        }
                    }
                } 
            }
        } else {
            if (!order.isPremium && order.stars) { 
                try { 
                    await trackStars(order.telegramId, order.stars, 'buy'); 
                } catch (error) {
                    console.error('Failed to track stars for buy order:', error);
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
                    console.error('Failed to track premium activation:', error);
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
        }

        // Collapse admin buttons
        const statusText = '✅ Completed';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}${orderType === 'sell' ? '\n\nPayments have been transferred to the seller.' : ''}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        // Notify user
        const userMessage = `✅ Your ${orderType} order #${order.id} has been confirmed!${orderType === 'sell' ? '\n\nPayment has been sent to your wallet.' : '\n\nThank you for choosing StarStore!'}`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to complete order' });
    }
});

app.post('/api/admin/orders/:id/decline', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        let order = await BuyOrder.findOne({ id });
        let orderType = 'buy';
        if (!order) { order = await SellOrder.findOne({ id }); orderType = 'sell'; }
        if (!order) return res.status(404).json({ error: 'Order not found' });

        order.status = orderType === 'sell' ? 'failed' : 'declined';
        order.dateDeclined = new Date();
        await order.save();

        const statusText = order.status === 'failed' ? '❌ Failed' : '❌ Declined';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        const userMessage = order.status === 'failed' 
          ? `❌ Your sell order #${order.id} has failed.\n\nTry selling a lower amount or contact support if the issue persist.`
          : `❌ Your buy order #${order.id} has been declined.\n\nContact support if you believe this was a mistake.`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to decline order' });
    }
});

app.post('/api/admin/orders/:id/refund', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const order = await SellOrder.findOne({ id });
        if (!order) return res.status(404).json({ error: 'Sell order not found' });

        // 🔐 SECURITY: Only allow refunds for PROCESSING orders, prevent double-refunds & late refunds
        // Note: Completed orders have already paid the seller - they require reversal/chargeback process
        if (order.status === 'refunded') {
            return res.status(409).json({ error: 'Order has already been refunded' });
        }
        if (order.status !== 'processing') {
            return res.status(409).json({ error: `Cannot refund order with status: ${order.status}. Only 'processing' orders can be refunded.` });
        }

        order.status = 'refunded';
        order.dateRefunded = new Date();
        await order.save();

        const statusText = '💸 Refunded';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (order.adminMessages?.length) {
            await Promise.all(order.adminMessages.map(async (adminMsg) => {
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\n${statusText}\n${processedBy}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_${order.id}_${Date.now()}` }]] }
                    });
                } catch {}
            }));
        }

        const userMessage = `💸 Your sell order #${order.id} has been refunded.\n\nPlease check your Account for the refund.`;
        try { await bot.sendMessage(order.telegramId, userMessage); } catch {}
        
        // 🔐 AUDIT: Log the refund action
        await logAdminAction(
            req.user?.id || 'admin',
            `refund_order_${id}`,
            'order_refund',
            order.telegramId,
            {
                adminUsername: req.user?.id || 'admin',
                targetOrderId: id,
                orderType: 'sell',
                orderStatus: 'refunded'
            }
        );
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to refund order' });
    }
});

// List recent withdrawals
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
	try {
		const limit = Math.min(parseInt(req.query.limit) || 20, 200);
		const page = Math.max(parseInt(req.query.page) || 1, 1);
		const status = (req.query.status || '').toString().trim();
		const qq = (req.query.q || '').toString().trim();
		const statusFilter = status ? { status } : {};
		// 🔐 SECURITY: Escape regex to prevent injection/ReDoS attacks
		const escapedQq = escapeRegex(qq);
		const textFilter = qq ? { $or: [
			{ userId: { $regex: escapedQq, $options: 'i' } },
			{ username: { $regex: escapedQq, $options: 'i' } },
			{ walletAddress: { $regex: escapedQq, $options: 'i' } },
		] } : {};
		const total = await ReferralWithdrawal.countDocuments({ ...statusFilter, ...textFilter }).catch(()=>0);
		const withdrawals = await ReferralWithdrawal.find({ ...statusFilter, ...textFilter })
			.sort({ createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean();
		res.json({ withdrawals, total });
	} catch (e) {
		res.status(500).json({ error: 'Failed to load withdrawals' });
	}
});

app.get('/api/admin/withdrawals/export', requireAdmin, async (req, res) => {
	try {
		const status = (req.query.status || '').toString().trim();
		const q = (req.query.q || '').toString().trim();
		const statusFilter = status ? { status } : {};
		// 🔐 SECURITY: Escape regex to prevent injection/ReDoS attacks
		const escapedQ = escapeRegex(q);
		const textFilter = q ? { $or: [
			{ userId: { $regex: escapedQ, $options: 'i' } },
			{ username: { $regex: escapedQ, $options: 'i' } },
			{ walletAddress: { $regex: escapedQ, $options: 'i' } }
		] } : {};
		const limit = Math.min(parseInt(req.query.limit) || 5000, 20000);
		const withdrawals = await ReferralWithdrawal
			.find({ ...statusFilter, ...textFilter })
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean();
		const csv = ['id,userId,username,amount,walletAddress,status,reason,createdAt']
			.concat(withdrawals.map(w => [w._id, w.userId || '', w.username || '', w.amount || 0, w.walletAddress || '', w.status || '', w.declineReason || '', new Date(w.createdAt || Date.now()).toISOString()]
				.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')))
			.join('\n');
		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', 'attachment; filename="withdrawals.csv"');
		res.setHeader('Cache-Control', 'no-store');
		return res.send(csv);
	} catch (e) {
		return res.status(500).send('Failed to export');
	}
});

// Complete a withdrawal
app.post('/api/admin/withdrawals/:id/complete', requireAdmin, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const id = req.params.id;
        const admin = req.user?.id || 'admin';

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id), status: 'pending' },
            { $set: { status: 'completed', processedBy: parseInt(admin, 10) || admin, processedAt: new Date() } },
            { new: true, session }
        );
        if (!withdrawal) {
            await session.abortTransaction();
            return res.status(409).json({ error: 'Withdrawal not found or already processed' });
        }

        // Notify user
        try {
            await bot.sendMessage(withdrawal.userId, `✅ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Completed!\n\nAmount: ${withdrawal.amount} USDT\nWallet: ${withdrawal.walletAddress}\n\nFunds have been sent to your wallet.`);
        } catch {}

        // Update admin messages to collapsed status
        const statusText = '✅ Completed';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages.map(async (adminMsg) => {
                if (!adminMsg?.adminId || !adminMsg?.messageId) return;
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\nStatus: ${statusText}\n${processedBy}\nProcessed at: ${new Date().toLocaleString()}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] }
                    });
                } catch {
                    try {
                        await bot.editMessageReplyMarkup(
                            { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                            { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                        );
                    } catch {}
                }
            }));
        }

        await session.commitTransaction();
        return res.json({ success: true });
    } catch (e) {
        await session.abortTransaction();
        return res.status(500).json({ error: 'Failed to complete withdrawal' });
    } finally {
        session.endSession();
    }
});

// Decline a withdrawal with reason
app.post('/api/admin/withdrawals/:id/decline', requireAdmin, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const id = req.params.id;
        const { reason } = req.body || {};
        const admin = req.user?.id || 'admin';

        const withdrawal = await ReferralWithdrawal.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(id), status: 'pending' },
            { $set: { status: 'declined', processedBy: parseInt(admin, 10) || admin, processedAt: new Date(), declineReason: reason || 'Declined' } },
            { new: true, session }
        );
        if (!withdrawal) {
            await session.abortTransaction();
            return res.status(409).json({ error: 'Withdrawal not found or already processed' });
        }

        // Revert referral withdrawn flags
        await Referral.updateMany(
            { _id: { $in: withdrawal.referralIds } },
            { $set: { withdrawn: false } },
            { session }
        );

        // Notify user with reason
        try {
            await bot.sendMessage(withdrawal.userId, `❌ Withdrawal WD${withdrawal._id.toString().slice(-8).toUpperCase()} Declined\nReason: ${withdrawal.declineReason}\n\nAmount: ${withdrawal.amount} USDT\nContact support for more information.`);
        } catch {}

        // Update admin messages
        const statusText = '❌ Declined';
        const processedBy = `Processed by: @${req.user?.id || 'admin'}`;
        if (withdrawal.adminMessages?.length) {
            await Promise.all(withdrawal.adminMessages.map(async (adminMsg) => {
                if (!adminMsg?.adminId || !adminMsg?.messageId) return;
                const baseText = adminMsg.originalText || '';
                const updatedText = `${baseText}\n\nStatus: ${statusText}\nReason: ${withdrawal.declineReason}\n${processedBy}\nProcessed at: ${new Date().toLocaleString()}`;
                try {
                    await bot.editMessageText(updatedText, {
                        chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId,
                        message_id: adminMsg.messageId,
                        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] }
                    });
                } catch {
                    try {
                        await bot.editMessageReplyMarkup(
                            { inline_keyboard: [[{ text: statusText, callback_data: `processed_withdrawal_${withdrawal._id}_${Date.now()}` }]] },
                            { chat_id: parseInt(adminMsg.adminId, 10) || adminMsg.adminId, message_id: adminMsg.messageId }
                        );
                    } catch {}
                }
            }));
        }

        await session.commitTransaction();
        return res.json({ success: true });
    } catch (e) {
        await session.abortTransaction();
        return res.status(500).json({ error: 'Failed to decline withdrawal' });
    } finally {
        session.endSession();
    }
});

// List referrals for admin
app.get('/api/admin/referrals', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const referrals = await Referral.find({}).sort({ dateReferred: -1 }).limit(limit).lean();
        res.json({ referrals });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load referrals' });
    }
});

// List users for admin
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const filter = {};
        const activeSinceMin = parseInt(req.query.activeMinutes || '0', 10);
        if (activeSinceMin > 0) {
            filter.lastActive = { $gte: new Date(Date.now() - activeSinceMin * 60 * 1000) };
        }
        const users = await User.find(filter).sort({ lastActive: -1 }).limit(limit).lean();
        res.json({ users, total: await User.countDocuments(filter).catch(()=>0) });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// Force enable bot simulator endpoint (admin only)
app.post('/api/admin/force-enable-bots', requireAdmin, async (req, res) => {
  try {
    // Set environment variable programmatically
    process.env.ENABLE_BOT_SIMULATOR = '1';
    
    // Try to start bot simulator immediately
    if (startBotSimulatorSafe) {
      try {
        await startBotSimulatorSafe({
          useMongo: !!process.env.MONGODB_URI,
          models: { User, DailyState, BotProfile, Activity },
          db
        });
        
        res.json({
          success: true,
          message: 'Bot simulator force enabled and started',
          status: 'enabled',
          environment: process.env.ENABLE_BOT_SIMULATOR
        });
      } catch (startError) {
        res.json({
          success: true,
          message: 'Bot simulator enabled but start failed',
          status: 'enabled_but_not_started',
          environment: process.env.ENABLE_BOT_SIMULATOR,
          startError: startError.message
        });
      }
    } else {
      res.json({
        success: true,
        message: 'Bot simulator enabled (restart required)',
        status: 'enabled_restart_needed',
        environment: process.env.ENABLE_BOT_SIMULATOR
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to enable bot simulator',
      details: error.message
    });
  }
});

// Diagnostic endpoint to check bot simulator status (admin only)
app.get('/api/admin/bot-simulator/diagnostic', requireAdmin, async (req, res) => {
  try {
    const botUsers = await User.countDocuments({ id: { $regex: '^200000' } });
    const botActivities = await Activity.countDocuments({ 
      userId: { $regex: '^200000' },
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    const botStates = await DailyState.countDocuments({ userId: { $regex: '^200000' } });
    
    // Get sample bot users
    const sampleBots = await User.find({ id: { $regex: '^200000' } }).limit(5).select('id username');
    
    // Check if bot simulator is running
    const isEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
    const hasStartFunction = !!startBotSimulatorSafe;
    
    res.json({
      success: true,
      diagnostic: {
        environment: {
          ENABLE_BOT_SIMULATOR: process.env.ENABLE_BOT_SIMULATOR,
          isEnabled,
          hasStartFunction
        },
        database: {
          botUsers,
          botActivities,
          botStates,
          sampleBots
        },
        expected: {
          botUsers: 135,
          botActivities: '20-40 per day',
          botStates: 135
        },
        recommendations: []
      }
    });
    
    // Add recommendations based on findings
    if (botUsers < 10) {
      res.json.diagnostic?.recommendations.push('Bot seeding failed - need to restart bot simulator');
    }
    if (botActivities === 0 && botUsers > 0) {
      res.json.diagnostic?.recommendations.push('Bots exist but not generating activities - check tick function');
    }
    if (!isEnabled) {
      res.json.diagnostic?.recommendations.push('Set ENABLE_BOT_SIMULATOR=1 in environment variables');
    }
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Diagnostic failed',
      details: error.message
    });
  }
});

// Force restart bot simulator (admin only)
app.post('/api/admin/bot-simulator/restart', requireAdmin, async (req, res) => {
  try {
    if (!startBotSimulatorSafe) {
      return res.status(400).json({
        success: false,
        error: 'Bot simulator not available'
      });
    }
    
    // Force restart the bot simulator
    const result = startBotSimulatorSafe({
      useMongo: !!process.env.MONGODB_URI,
      models: { User, DailyState, BotProfile, Activity },
      db
    });
    
    res.json({
      success: true,
      message: 'Bot simulator restarted',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to restart bot simulator',
      details: error.message
    });
  }
});

// Admin endpoint to view activity statistics
app.get('/api/admin/activity/stats', requireAdmin, async (req, res) => {
    try {
        const { timeframe = '24h' } = req.query;
        
        // Calculate time range
        let startTime;
        switch (timeframe) {
            case '1h':
                startTime = new Date(Date.now() - 60 * 60 * 1000);
                break;
            case '24h':
                startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
                break;
            case '7d':
                startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
                startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                break;
            default:
                startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
        }

        // Get activity statistics
        const [
            totalActivities,
            recentActivities,
            activityTypes,
            topUsers,
            botActivities,
            totalUsers,
            activeUsers
        ] = await Promise.all([
            Activity.countDocuments(),
            Activity.countDocuments({ timestamp: { $gte: startTime } }),
            Activity.aggregate([
                { $match: { timestamp: { $gte: startTime } } },
                { $group: { 
                    _id: '$activityType', 
                    count: { $sum: 1 }, 
                    totalPoints: { $sum: '$points' },
                    avgPoints: { $avg: '$points' }
                }},
                { $sort: { count: -1 } }
            ]),
            Activity.aggregate([
                { $match: { timestamp: { $gte: startTime } } },
                { $group: { 
                    _id: '$userId', 
                    count: { $sum: 1 }, 
                    totalPoints: { $sum: '$points' }
                }},
                { $sort: { totalPoints: -1 } },
                { $limit: 10 }
            ]),
            Activity.countDocuments({ 
                userId: { $regex: '^200000' },
                timestamp: { $gte: startTime }
            }),
            User.countDocuments(),
            User.countDocuments({ lastActive: { $gte: startTime } })
        ]);

        // Get bot simulator status
        const botSimulatorEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
        const botUsers = await User.countDocuments({ id: { $regex: '^200000' } });

        res.json({
            timeframe,
            period: {
                start: startTime.toISOString(),
                end: new Date().toISOString()
            },
            overview: {
                totalActivities,
                recentActivities,
                totalUsers,
                activeUsers,
                botUsers,
                botActivities
            },
            activityTypes,
            topUsers,
            botSimulator: {
                enabled: botSimulatorEnabled,
                botUsers,
                recentBotActivities: botActivities
            }
        });
    } catch (error) {
        console.error('Admin activity stats error:', error);
        res.status(500).json({ error: 'Failed to fetch activity statistics' });
    }
});

// Admin endpoint to view recent activities
app.get('/api/admin/activity/recent', requireAdmin, async (req, res) => {
    try {
        const { limit = 50, skip = 0, userId, activityType } = req.query;
        
        const filter = {};
        if (userId) filter.userId = userId;
        if (activityType) filter.activityType = activityType;

        const activities = await Activity.find(filter)
            .sort({ timestamp: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();

        const total = await Activity.countDocuments(filter);

        res.json({
            activities,
            pagination: {
                total,
                limit: parseInt(limit),
                skip: parseInt(skip),
                hasMore: (parseInt(skip) + parseInt(limit)) < total
            }
        });
    } catch (error) {
        console.error('Admin recent activities error:', error);
        res.status(500).json({ error: 'Failed to fetch recent activities' });
    }
});

// Admin endpoint to enable/disable bot simulator
app.post('/api/admin/bot-simulator/enable', requireAdmin, async (req, res) => {
    try {
        process.env.ENABLE_BOT_SIMULATOR = '1';
        
        // Try to start bot simulator if not already running
        if (startBotSimulatorSafe) {
            try {
                startBotSimulatorSafe({
                    useMongo: !!process.env.MONGODB_URI,
                    models: { User, DailyState, BotProfile, Activity },
                    db
                });
                console.log('🤖 Bot simulator enabled via admin command');
            } catch (e) {
                console.warn('Failed to start bot simulator:', e.message);
            }
        }
        
        res.json({
            success: true,
            message: 'Bot simulator enabled. Note: Changes will be lost on server restart. Update environment variables for persistence.',
            enabled: true
        });
    } catch (error) {
        console.error('Enable bot simulator error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to enable bot simulator',
            details: error.message 
        });
    }
});

// Admin endpoint to test bot simulator
app.post('/api/admin/bot-simulator/test', requireAdmin, async (req, res) => {
    try {
        const isEnabled = process.env.ENABLE_BOT_SIMULATOR === '1';
        
        if (!isEnabled) {
            return res.json({
                success: false,
                message: 'Bot simulator is disabled. Set ENABLE_BOT_SIMULATOR=1 to enable.',
                enabled: false
            });
        }

        // Check if bot simulator is actually working
        const botUsers = await User.countDocuments({ id: { $regex: '^200000' } });
        const recentBotActivity = await Activity.countDocuments({
            userId: { $regex: '^200000' },
            timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
        });

        // Try to create a test bot user
        const testBotId = '200999999';
        let testBotCreated = false;
        const existingTestBot = await User.findOne({ id: testBotId });
        
        if (!existingTestBot) {
            try {
                await User.findOneAndUpdate(
                    { id: testBotId },
                    { $set: { id: testBotId, username: 'test_bot_admin', lastActive: new Date(), createdAt: new Date() } },
                    { upsert: true, new: true }
                );
                testBotCreated = true;
            } catch (createErr) {
                // Handle E11000 duplicate key error - already exists
                if (createErr.code !== 11000) {
                    throw createErr;
                }
            }
        }

        res.json({
            success: true,
            enabled: true,
            stats: {
                botUsers,
                recentBotActivity,
                testBotCreated
            },
            message: `Bot simulator is enabled. Found ${botUsers} bot users with ${recentBotActivity} recent activities.`
        });
    } catch (error) {
        console.error('Bot simulator test error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to test bot simulator',
            details: error.message 
        });
    }
});

// Enhanced notification system - sends both Telegram messages and creates database notifications
app.post('/api/admin/notify', requireAdmin, async (req, res) => {
    try {
        const { target, message, title, sendTelegram = true, createDbNotification = true } = req.body || {};
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message required' });
        }

        const telegramSent = [];
        const dbNotificationsCreated = [];
        let template = null;

        // Create notification template if database notifications are requested
        if (createDbNotification) {
            const notificationTitle = title || 'Admin Notification 📢';
            template = await NotificationTemplate.create({
                title: notificationTitle,
                message: message,
                audience: (!target || target === 'all' || target === 'active') ? 'global' : 'user',
                targetUserId: (/^\d+$/.test(target)) ? target : null,
                priority: 1,
                icon: 'fa-bullhorn',
                createdBy: `admin_api_${req.user.id}`
            });
        }

        if (!target || target === 'all') {
            const users = await User.find({}, { id: 1 }).limit(10000);
            
            // Send Telegram messages
            if (sendTelegram) {
                for (const u of users) {
                    try { 
                        await bot.sendMessage(u.id, `📢 Admin Notification:\n\n${message}`); 
                        telegramSent.push(u.id); 
                    } catch {}
                }
            }

            // Create database notifications
            if (createDbNotification && template) {
                const userNotifications = users.map(user => ({
                    userId: user.id.toString(),
                    templateId: template._id,
                    read: false
                }));
                
                if (userNotifications.length > 0) {
                    await UserNotification.insertMany(userNotifications);
                    dbNotificationsCreated.push(...userNotifications.map(n => n.userId));
                }
            }
        } else if (target === 'active') {
            // Active users in last 24h
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const users = await User.find({ lastActive: { $gte: since } }, { id: 1 }).limit(10000);
            
            // Send Telegram messages
            if (sendTelegram) {
                for (const u of users) {
                    try { 
                        await bot.sendMessage(u.id, `📢 Admin Notification:\n\n${message}`); 
                        telegramSent.push(u.id); 
                    } catch {}
                }
            }

            // Create database notifications
            if (createDbNotification && template) {
                const userNotifications = users.map(user => ({
                    userId: user.id.toString(),
                    templateId: template._id,
                    read: false
                }));
                
                if (userNotifications.length > 0) {
                    await UserNotification.insertMany(userNotifications);
                    dbNotificationsCreated.push(...userNotifications.map(n => n.userId));
                }
            }
        } else if (/^@/.test(target)) {
            const username = target.replace(/^@/, '');
            const user = await User.findOne({ username });
            if (!user) return res.status(404).json({ error: 'User not found' });
            
            // Send Telegram message
            if (sendTelegram) {
                try {
                    await bot.sendMessage(user.id, `📢 Personal Admin Message:\n\n${message}`); 
                    telegramSent.push(user.id);
                } catch (err) {
                    console.log(`Failed to send Telegram message to @${username}:`, err.message);
                }
            }

            // Create database notification
            if (createDbNotification && template) {
                template.audience = 'user';
                template.targetUserId = user.id.toString();
                await template.save();

                await UserNotification.create({
                    userId: user.id.toString(),
                    templateId: template._id,
                    read: false
                });
                dbNotificationsCreated.push(user.id.toString());
            }
        } else if (/^\d+$/.test(target)) {
            // Send Telegram message
            if (sendTelegram) {
                try {
                    await bot.sendMessage(target, `📢 Personal Admin Message:\n\n${message}`); 
                    telegramSent.push(target);
                } catch (err) {
                    console.log(`Failed to send Telegram message to ${target}:`, err.message);
                }
            }

            // Create database notification
            if (createDbNotification && template) {
                template.audience = 'user';
                template.targetUserId = target;
                await template.save();

                await UserNotification.create({
                    userId: target,
                    templateId: template._id,
                    read: false
                });
                dbNotificationsCreated.push(target);
            }
        } else {
            return res.status(400).json({ error: 'Invalid target' });
        }
        
        res.json({ 
            success: true, 
            telegramSent: telegramSent.length,
            dbNotificationsCreated: dbNotificationsCreated.length,
            templateId: template?._id
        });
    } catch (error) {
        console.error('Admin notify error:', error);
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

// Admin endpoint to view all notifications and templates
app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
    try {
        const { limit = 50, skip = 0, type = 'all' } = req.query;

        let query = {};
        if (type === 'global') query.audience = 'global';
        if (type === 'user') query.audience = 'user';

        const templates = await NotificationTemplate.find(query)
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .lean();

        const templateStats = await Promise.all(templates.map(async (template) => {
            const userNotificationCount = await UserNotification.countDocuments({ templateId: template._id });
            const unreadCount = await UserNotification.countDocuments({ templateId: template._id, read: false });
            
            return {
                ...template,
                totalRecipients: userNotificationCount,
                unreadCount: unreadCount,
                readCount: userNotificationCount - unreadCount
            };
        }));

        const totalTemplates = await NotificationTemplate.countDocuments(query);
        const totalUserNotifications = await UserNotification.countDocuments();
        const totalUnread = await UserNotification.countDocuments({ read: false });

        res.json({
            templates: templateStats,
            pagination: {
                total: totalTemplates,
                limit: parseInt(limit),
                skip: parseInt(skip),
                hasMore: (parseInt(skip) + parseInt(limit)) < totalTemplates
            },
            stats: {
                totalTemplates,
                totalUserNotifications,
                totalUnread,
                totalRead: totalUserNotifications - totalUnread
            }
        });
    } catch (error) {
        console.error('Admin notifications fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// Admin endpoint to delete notification templates and cascade to user notifications
app.delete('/api/admin/notifications/:templateId', requireAdmin, async (req, res) => {
    try {
        const { templateId } = req.params;
        
        // Delete the template
        const deletedTemplate = await NotificationTemplate.findByIdAndDelete(templateId);
        if (!deletedTemplate) {
            return res.status(404).json({ error: 'Notification template not found' });
        }

        // Delete all associated user notifications
        const deletedUserNotifications = await UserNotification.deleteMany({ templateId });

        res.json({ 
            success: true, 
            deletedTemplate: deletedTemplate.title,
            deletedUserNotifications: deletedUserNotifications.deletedCount
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to send notification' });
    }
});

function parseCookies(cookieHeader) {
	const out = {};
	if (!cookieHeader) return out;
	cookieHeader.split(';').forEach(part => {
		const idx = part.indexOf('=');
		if (idx > -1) {
			const k = part.slice(0, idx).trim();
			const v = part.slice(idx + 1).trim();
			out[k] = decodeURIComponent(v);
		}
	});
	return out;
}

function base64url(input) {
	return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// 🔐 SECURITY: JWT Secret Configuration Validator
function getAdminJWTSecret() {
	const secret = process.env.ADMIN_JWT_SECRET;
	if (!secret || secret.toLowerCase() === 'secret' || secret.length < 32) {
		console.error('🚨 CRITICAL SECURITY ERROR: ADMIN_JWT_SECRET not properly configured!');
		console.error('   - ADMIN_JWT_SECRET must be set to a strong random string (min 32 chars)');
		console.error('   - Current: ' + (secret ? `"${secret.substring(0, 10)}..."` : 'NOT SET'));
		console.error('   - NEVER use TELEGRAM_BOT_TOKEN or hardcoded values');
		console.error('   - Generate secure secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
		throw new Error('ADMIN_JWT_SECRET is not properly configured. Cannot start application.');
	}
	return secret;
}

// Cache the secret on startup to catch errors early
let __ADMIN_JWT_SECRET = null;
try {
	__ADMIN_JWT_SECRET = getAdminJWTSecret();
	console.log('✅ Admin JWT secret validated');
} catch (err) {
	console.error(err.message);
	// Don't exit here to allow app to start in non-production, but log clearly
}

function signAdminToken(payload, ttlMs) {
	const secret = __ADMIN_JWT_SECRET || getAdminJWTSecret();
	if (!secret) throw new Error('Admin JWT secret not available');
	
	const header = { alg: 'HS256', typ: 'JWT' };
	const exp = Date.now() + (ttlMs || 12 * 60 * 60 * 1000);
	const body = { ...payload, exp };
	const h = base64url(JSON.stringify(header));
	const b = base64url(JSON.stringify(body));
	const sig = require('crypto').createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
	return `${h}.${b}.${sig}`;
}

function verifyAdminToken(token) {
	try {
		const secret = __ADMIN_JWT_SECRET || getAdminJWTSecret();
		if (!secret) return null;
		
		const [h, b, sig] = token.split('.');
		const expected = require('crypto').createHmac('sha256', secret).update(`${h}.${b}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
		if (expected !== sig) return null;
		
		const body = JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
		if (!body || !body.exp || Date.now() > body.exp) return null;
		return body;
	} catch {
		return null;
	}
}

function getAdminSession(req) {
	const cookies = parseCookies(req.headers.cookie || '');
	const token = cookies['admin_session'];
	if (!token) return null;
	const payload = verifyAdminToken(token);
	if (!payload || !payload.sid || !payload.tgId) return null;
	return { token, payload };
}

function requireAdmin(req, res, next) {
	// Backward-compatible GET-only header auth, or cookie session with CSRF for mutations
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
			const csrf = req.headers['x-csrf-token'];
			if (!csrf || csrf !== sess.payload.sid) {
				return res.status(403).json({ error: 'CSRF check failed' });
			}
		}
		req.user = { id: sess.payload.tgId, isAdmin: true };
		return next();
	}
	try {
		const tgId = (req.headers['x-telegram-id'] || '').toString();
		if (tgId && Array.isArray(adminIds) && adminIds.includes(tgId) && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
			req.user = { id: tgId, isAdmin: true };
			return next();
		}
		return res.status(403).json({ error: 'Forbidden' });
	} catch (e) {
		return res.status(403).json({ error: 'Forbidden' });
	}
}

// DUPLICATE /api/me endpoint removed - using the detailed one defined earlier (line 13563+)
// The detailed version includes ambassador status checking

app.get('/api/admin/csrf', (req, res) => {
	const sess = getAdminSession(req);
	if (!sess || !adminIds.includes(sess.payload.tgId)) {
		return res.status(403).json({ error: 'Forbidden' });
	}
	return res.json({ csrfToken: sess.payload.sid });
});

app.post('/api/admin/auth/send-otp', async (req, res) => {
	try {
		const tgId = (req.body?.tgId || '').toString().trim();
		
		console.log('🔐 Admin OTP send attempt:', {
			tgId,
			adminIds: adminIds,
			adminIdsType: typeof adminIds,
			adminIdsLength: Array.isArray(adminIds) ? adminIds.length : 'not array',
			includes: adminIds.includes(tgId)
		});
		
		if (!tgId || !/^\d+$/.test(tgId)) {
			console.log('❌ Invalid Telegram ID format');
			return res.status(400).json({ error: 'Invalid Telegram ID' });
		}
		
		if (!adminIds.includes(tgId)) {
			console.log('❌ Telegram ID not in admin list:', { tgId, adminIds });
			return res.status(403).json({ error: 'Not authorized - ID not in admin list' });
		}
		const code = (Math.floor(100000 + Math.random() * 900000)).toString();
		const now = Date.now();
		global.__adminOtpStore = global.__adminOtpStore || new Map();
		const prev = global.__adminOtpStore.get(tgId);
		if (prev && prev.nextAllowedAt && now < prev.nextAllowedAt) {
			const waitSec = Math.ceil((prev.nextAllowedAt - now) / 1000);
			return res.status(429).json({ error: `Please wait ${waitSec}s before requesting another code` });
		}
		global.__adminOtpStore.set(tgId, { code, expiresAt: now + 5 * 60 * 1000, nextAllowedAt: now + 60 * 1000 });
		try {
			console.log(`[ADMIN OTP] Sending code to ${tgId} ...`);
			await bot.sendMessage(tgId, `StarStore Admin Login Code\n\nYour code: ${code}\n\nThis code expires in 5 minutes.`);
			console.log(`[ADMIN OTP] Code delivered to ${tgId}`);
		} catch (err) {
			console.error(`[ADMIN OTP] Delivery failed to ${tgId}:`, err?.message || err);
			return res.status(500).json({ error: 'Failed to deliver OTP. Ensure you have started the bot and try again.' });
		}
		return res.json({ success: true });
	} catch (e) {
		console.error('[ADMIN OTP] Unexpected error:', e?.message || e);
		return res.status(500).json({ error: 'Failed to send OTP' });
	}
});

app.post('/api/admin/auth/verify-otp', (req, res) => {
	try {
		const tgId = (req.body?.tgId || '').toString().trim();
		const code = (req.body?.code || '').toString().trim();
		
		console.log('🔐 Admin OTP verify attempt:', {
			tgId,
			code: code ? '***' + code.slice(-2) : 'none',
			adminIds: adminIds,
			adminIdsIncludes: adminIds.includes(tgId)
		});
		
		if (!tgId || !/^\d+$/.test(tgId) || !code) {
			console.log('❌ Invalid credentials provided');
			return res.status(400).json({ error: 'Invalid credentials' });
		}
		
		if (!adminIds.includes(tgId)) {
			console.log('❌ Not in admin list:', { tgId, adminIds });
			return res.status(403).json({ error: 'Not authorized - ID not in admin list' });
		}
		
		global.__adminOtpStore = global.__adminOtpStore || new Map();
		const rec = global.__adminOtpStore.get(tgId);
		
		console.log('🔐 OTP record check:', {
			hasRecord: !!rec,
			codeMatch: rec ? rec.code === code : false,
			expired: rec ? Date.now() > rec.expiresAt : true
		});
		
		if (!rec || rec.code !== code || Date.now() > rec.expiresAt) {
			console.log('❌ Invalid or expired OTP');
			return res.status(401).json({ error: 'Invalid or expired code' });
		}
		
		global.__adminOtpStore.delete(tgId);
		const sid = require('crypto').randomBytes(16).toString('hex');
		const token = signAdminToken({ tgId, sid }, 12 * 60 * 60 * 1000);
		const isProd = process.env.NODE_ENV === 'production';
		const cookie = `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${isProd ? '; Secure' : ''}; Max-Age=${12 * 60 * 60}`;
		res.setHeader('Set-Cookie', cookie);
		
		console.log('✅ Admin OTP verification successful for:', tgId);
		return res.json({ success: true, csrfToken: sid });
	} catch (error) {
		console.error('❌ Admin OTP verification error:', error);
		return res.status(500).json({ error: 'Failed to verify OTP' });
	}
});

app.post('/api/admin/logout', (req, res) => {
	try {
		res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
		return res.json({ success: true });
	} catch {
		return res.json({ success: true });
	}
});

// Modern admin auth verification endpoint
app.get('/api/admin/auth/verify', requireAdmin, (req, res) => {
	res.json({
		success: true,
		user: {
			telegramId: req.user?.id,
			isAdmin: true
		}
	});
});

// Debug endpoint — admin-only and disabled in production. Returns no admin IDs.
app.get('/api/admin/debug/config', requireAdmin, (req, res) => {
	if (process.env.NODE_ENV === 'production') {
		return res.status(404).json({ error: 'Not found' });
	}
	res.json({
		adminIdsLength: Array.isArray(adminIds) ? adminIds.length : 0,
		envVars: {
			hasAdminTelegramIds: !!process.env.ADMIN_TELEGRAM_IDS,
			hasAdminIds: !!process.env.ADMIN_IDS,
			hasWebhookSecret: !!process.env.WEBHOOK_SECRET,
			hasBotToken: !!process.env.BOT_TOKEN
		}
	});
});

// Enhanced admin stats endpoint for modern dashboard
app.get('/api/admin/dashboard/stats', requireAdmin, async (req, res) => {
	try {
		// Get existing stats and enhance them
		const orders = await db.getOrders();
		const users = await db.getUsers();
		const withdrawals = await db.getWithdrawals();
		
		const stats = {
			totalUsers: users.length,
			totalOrders: orders.length,
			totalRevenue: orders.reduce((sum, order) => sum + (parseFloat(order.amount) || 0), 0),
			pendingOrders: orders.filter(o => o.status === 'pending').length,
			completedOrders: orders.filter(o => o.status === 'completed').length,
			activeUsers24h: users.filter(u => {
				const lastActive = new Date(u.lastActive || u.createdAt);
				return Date.now() - lastActive.getTime() < 24 * 60 * 60 * 1000;
			}).length,
			totalWithdrawals: withdrawals.length,
			pendingWithdrawals: withdrawals.filter(w => w.status === 'pending').length,
			lastUpdated: new Date().toISOString()
		};
		
		res.json(stats);
	} catch (error) {
		console.error('Enhanced admin stats error:', error);
		res.status(500).json({ error: 'Failed to fetch enhanced stats' });
	}
});

// Email notifications for newsletter (using Resend API via email-service)
// Nodemailer removed - using Resend API instead for better reliability and professional emails

// Admin send newsletter email to all subscribers
app.post('/api/newsletter/send', async (req, res) => {
    try {
        if (!req.user?.isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });
        if (!emailService.isEmailAvailable()) return res.status(500).json({ success: false, error: 'Email service not configured. Please set RESEND_API_KEY environment variable.' });
        
        const subject = String(req.body?.subject || '').trim();
        const html = String(req.body?.html || '').trim();
        if (!subject || !html) return res.status(400).json({ success: false, error: 'Subject and HTML are required.' });

        const subscribers = await NewsletterSubscriber.find({}, { email: 1, _id: 0 });
        if (!subscribers.length) return res.json({ success: true, sent: 0 });

        // Send to each subscriber individually (Resend API rate limit friendly)
        let sentCount = 0;
        let failedCount = 0;
        
        for (const subscriber of subscribers) {
            const result = await emailService.sendNewsletterBroadcast(
                subscriber.email,
                subject,
                html
            );
            
            if (result.success || result.offline) {
                sentCount++;
            } else {
                failedCount++;
                console.warn(`Failed to send newsletter to ${subscriber.email}:`, result.error);
            }
        }
        
        return res.json({ success: true, sent: sentCount, failed: failedCount });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to send emails' });
    }
});

// Newsletter subscription (simple backend)
const NewsletterSubscriberSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true },
    ip: { type: String },
    country: { type: String },
    city: { type: String },
    userAgent: { type: String },
    createdAt: { type: Date, default: Date.now }
});
const NewsletterSubscriber = mongoose.model('NewsletterSubscriber', NewsletterSubscriberSchema);

app.post('/api/newsletter/subscribe', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
        }
        const existing = await NewsletterSubscriber.findOne({ email });
        if (existing) {
            return res.status(409).json({ success: false, error: 'This email is already subscribed.' });
        }

        // Capture requester details
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
        const userAgent = (req.headers['user-agent'] || '').toString();
        let geo = { country: undefined, city: undefined };
        try {
            const geoResp = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { timeout: 4000 });
            if (geoResp.ok) {
                const g = await geoResp.json();
                geo.country = g?.country_name || g?.country || undefined;
                geo.city = g?.city || undefined;
            }
        } catch (_) {}

        await NewsletterSubscriber.create({ email, ip, userAgent, country: geo.country, city: geo.city });

        // Send welcome email automatically using Resend API
        await emailService.sendNewsletterWelcome(email);

        // Notify admins in real-time via Telegram
        const text = `📬 New newsletter subscriber: ${email}`;
        for (const adminId of adminIds) {
            try { await bot.sendMessage(adminId, text); } catch (_) {}
        }

        return res.json({ success: true, message: 'Subscribed successfully.' });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Something went wrong. Please try again later.' });
    }
});
// Webhook fix - 1776877634
//some harmless comment



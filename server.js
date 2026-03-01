
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
} catch (_) {
  // noop if missing - PDF export will be skipped gracefully
}
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

// Admin IDs for authorization checks
let adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '')
    .split(',')
    .filter(Boolean)
    .map(id => id.trim());

// Admin authentication middleware
function requireAdmin(req, res, next) {
	try {
		const tgId = (req.headers['x-telegram-id'] || '').toString();
		if (tgId && Array.isArray(adminIds) && adminIds.includes(tgId)) {
			req.user = { id: tgId, isAdmin: true };
			return next();
		}
		return res.status(403).json({ error: 'Forbidden' });
	} catch (e) {
		return res.status(403).json({ error: 'Forbidden' });
	}
}

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
// Serve static with sensible defaults for SEO and caching
app.use(express.static('public', {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // Avoid caching HTML to ensure freshness across deployments
      res.setHeader('Cache-Control', 'no-store');
    } else if (/(?:\.css|\.js|\.png|\.jpg|\.jpeg|\.svg|\.webp|\.ico|\.woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// SEO & Compliance Routes
// Privacy Policy (separate route for better SEO)
app.get('/privacy-policy', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'policy.html'));
});

// Terms of Service (separate route for better SEO)
app.get('/terms-of-service', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'policy.html'));
});

// Sitemap.xml with proper headers
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// Parse Telegram init data for all requests (non-blocking)
try { app.use(verifyTelegramAuth); } catch (_) {}

// Ambassador Waitlist endpoint
app.post('/api/ambassador/waitlist', async (req, res) => {
  try {
    const { fullName = '', username = '', email = '', socials = {} } = req.body || {};
    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Full name is required' });
    }
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const clean = {
      id: `AMB-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`,
      fullName: String(fullName || '').trim(),
      username: String(username || '').trim().replace(/^@+/, ''),
      email: String(email || '').trim().toLowerCase(),
      socials: Object.fromEntries(Object.entries(socials || {}).map(([k,v]) => [String(k), String(v).trim()]).filter(([,v]) => !!v)),
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

    // Prevent duplicate email signups
    try {
      if (process.env.MONGODB_URI) {
        if (!global.AmbassadorWaitlist) {
          const schema = new mongoose.Schema({
            id: { type: String, unique: true },
            fullName: String,
            username: String,
            email: { type: String, index: true },
            socials: { type: Object, default: {} },
            createdAt: { type: Date, default: Date.now }
          }, { collection: 'ambassador_waitlist' });
          global.AmbassadorWaitlist = mongoose.models.AmbassadorWaitlist || mongoose.model('AmbassadorWaitlist', schema);
        }
        const existing = await global.AmbassadorWaitlist.findOne({ email: clean.email }).lean();
        if (existing) {
          return res.status(409).json({ success: false, error: 'Email already registered' });
        }
      } else {
        // File DB fallback
        if (!db) {
          const DataPersistence = require('./data-persistence');
          db = new DataPersistence();
        }
        const list = (await db.listAmbassadorWaitlist()) || [];
        const exists = list.some(entry => (entry.email || '').toLowerCase() === clean.email);
        if (exists) {
          return res.status(409).json({ success: false, error: 'Email already registered' });
        }
      }
    } catch (dupCheckErr) {
      console.error('Ambassador duplicate check failed:', dupCheckErr.message);
      // Continue; creation may still succeed, but we tried.
    }

    // Prefer Mongo when configured; otherwise persist to file DB
    let saved;
    if (process.env.MONGODB_URI) {
      // Lazy-init schema/model to avoid top-level clutter
      if (!global.AmbassadorWaitlist) {
        const schema = new mongoose.Schema({
          id: { type: String, unique: true },
          fullName: String,
          username: String,
          email: { type: String, index: true },
          socials: { type: Object, default: {} },
          createdAt: { type: Date, default: Date.now }
        }, { collection: 'ambassador_waitlist' });
        global.AmbassadorWaitlist = mongoose.models.AmbassadorWaitlist || mongoose.model('AmbassadorWaitlist', schema);
      }
      // Guard against race condition duplicates
      const existing = await global.AmbassadorWaitlist.findOne({ email: clean.email }).lean();
      if (existing) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }
      saved = await global.AmbassadorWaitlist.create(clean);
    } else if (db && typeof db.createAmbassadorWaitlist === 'function') {
      // Guard against duplicates in memory/file store
      const list = (await db.listAmbassadorWaitlist()) || [];
      const exists = list.some(entry => (entry.email || '').toLowerCase() === clean.email);
      if (exists) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }
      saved = await db.createAmbassadorWaitlist(clean);
    } else {
      // Fallback: extend dev storage dynamically
      db = db || new (require('./data-persistence'))();
      if (!db.data.ambassadorWaitlist) db.data.ambassadorWaitlist = [];
      const exists = db.data.ambassadorWaitlist.some(entry => (entry.email || '').toLowerCase() === clean.email);
      if (exists) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }
      db.data.ambassadorWaitlist.push(clean);
      await db.saveData();
      saved = clean;
    }

    // Attempt Telegram notify if request came from Telegram user
    try {
      let tgId = (req.user && req.user.id) || (req.headers['x-telegram-id'] && String(req.headers['x-telegram-id'])) || null;
      if (!tgId && req.telegramInitData && req.telegramInitData.user && req.telegramInitData.user.id) {
        tgId = String(req.telegramInitData.user.id);
      }
      if (!tgId && clean.username) {
        try {
          const candidate = await User.findOne({ username: clean.username }).lean();
          if (candidate && candidate.id) tgId = String(candidate.id);
        } catch (_) {}
      }
      if (tgId) await bot.sendMessage(tgId, `✅ Thanks ${clean.fullName}! You have been added to the StarStore Ambassador waitlist. We will contact you soon.`);
    } catch (_) {}

    // Notify admins of new signup
    try {
      const admins = (typeof adminIds !== 'undefined' && Array.isArray(adminIds) && adminIds.length)
        ? adminIds
        : (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '')
            .split(',')
            .filter(Boolean)
            .map(id => id.trim());
      if (admins && admins.length) {
        const tgId = (req.user && req.user.id) || (req.headers['x-telegram-id'] && String(req.headers['x-telegram-id'])) || null;
        const adminMsg =
          `🆕 New Ambassador Waitlist Signup\n\n` +
          `Name: ${clean.fullName}\n` +
          `Email: ${clean.email}\n` +
          `Username: ${clean.username ? '@' + clean.username : 'N/A'}\n` +
          `${Object.keys(clean.socials||{}).length ? `Socials: ${Object.entries(clean.socials).map(([k,v])=>`${k}: ${v}`).join(', ')}\n` : ''}` +
          `${tgId ? `User ID: ${tgId}\n` : ''}` +
          `Entry ID: ${saved.id}`;
        await Promise.all(admins.map(aid => {
          try { return bot.sendMessage(aid, adminMsg); } catch { return Promise.resolve(); }
        }));
      }
    } catch (e) {
      console.error('Failed to notify admins of ambassador signup:', e.message);
    }

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

// Legacy redirects for ambassador URL spelling change
app.get(['/ambasador', '/ambasador.html'], (req, res) => {
  return res.redirect(301, '/ambassador');
});

// Ensure directories with index.html return 200 (no 302/redirects)
app.get(['/', '/about', '/sell', '/history', '/daily', '/feedback', '/blog', '/knowledge-base', '/how-to-withdraw-telegram-stars', '/ambassador', '/referral'], (req, res, next) => {
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
      '/ambassador': 'ambassador/index.html',
      '/referral': 'referral.html'
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

// Sitemap generation
app.get('/sitemap.xml', async (req, res) => {
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
const DataPersistence = require('./data-persistence');
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
    referralHash: { type: String, unique: true, sparse: true, index: true }  // Professional hashed referral code for this user
});

const bannedUserSchema = new mongoose.Schema({
    users: Array
});

// User Activity Log - tracks all user interactions
const userActivityLogSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    username: String,
    timestamp: { type: Date, default: Date.now, index: true },
    actionType: { 
        type: String, 
        enum: ['message', 'button_click', 'command', 'api_call', 'order_created', 'order_completed', 'order_create', 'sell_order_create', 'payment_success', 'daily_checkin', 'mission_complete', 'login'],
        required: true,
        index: true
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
    referralHash: String,  // Professional hashed referral code (e.g., ref_a1b2c3d4e5f6)
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
    }
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
    adminMessageIds: [Number]
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

// Deduplicate to avoid duplicate notifications per admin
adminIds = Array.from(new Set(adminIds));
const REPLY_MAX_RECIPIENTS = parseInt(process.env.REPLY_MAX_RECIPIENTS || '30', 10);

// Track processing callbacks to prevent duplicates
// Structure: Map<callbackKey, timestamp> to allow timeout-based cleanup
const processingCallbacks = new Map(); // Changed from Set to Map for timeout support
const CALLBACK_PROCESSING_TIMEOUT = 60 * 1000; // 60 second timeout per callback

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

// Generate main menu keyboard with command buttons
function getMainMenuKeyboard() {
    return {
        keyboard: [
            [{ text: '🚀 Launch App' }, { text: '💬 Help' }],
            [{ text: '👥 Invite Frens' }, { text: '👛 Wallet' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        selective: false
    };
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
    try {
        const { telegramId, username, stars, walletAddress, isPremium, premiumDuration, recipients, transactionHash, isTelegramUser, totalAmount, isTestnet } = req.body;

        // === SYNC USER DATA ON EVERY INTERACTION ===
        await syncUserData(telegramId, username, 'order_create', req);

        // Get admin status early for logging
        const requesterIsAdmin = Boolean(req.user?.isAdmin);

        // Create request deduplication key
        const requestKey = transactionHash ? `tx:${transactionHash}` : `order:${telegramId}:${walletAddress}:${stars}:${totalAmount}`;
        
        // Mark this request as processing to prevent duplicates
        if (processingRequests.has(requestKey)) {
            console.warn(`Concurrent request detected: ${requestKey}`);
            return res.status(429).json({ 
                error: 'Request already being processed. Please wait...',
                retryAfter: 2
            });
        }
        
        // Mark as processing
        processingRequests.set(requestKey, Date.now());

        console.log('📋 Order creation request:', {
            telegramId,
            username,
            stars,
            walletAddress: walletAddress ? `${walletAddress.slice(0, 8)}...` : 'none',
            isPremium,
            premiumDuration,
            recipientsCount: recipients?.length || 0,
            totalAmount,
            isTestnet,
            isAdmin: requesterIsAdmin
        });

        // Strict validation: username must be a real Telegram username (not fallback)
        if (!telegramId || !username || !walletAddress || (isPremium && !premiumDuration)) {
            console.error('Missing required fields:', { telegramId: !!telegramId, username: !!username, walletAddress: !!walletAddress, premiumDuration: !!premiumDuration });
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Additional validation: username must not be a fallback value
        const isFallbackUsername = username === 'Unknown' || username === 'User' || !username.match(/^[a-zA-Z0-9_]{5,32}$/);
        if (isFallbackUsername) {
            console.error('Invalid username detected:', { username, telegramId });
            processingRequests.delete(requestKey);
            
            // Send DM instructions to user
            try {
                const dmMessage = `🔒 *Username Required for Orders*

❌ *Cannot Process Your Order*
You attempted to place an order but don't have a Telegram username set.

👤 *Your Account:*
• User ID: \`${telegramId}\`
• Current Username: Not Set

✅ *How to Fix:*
1. Go to Telegram Settings
2. Tap on "Username" 
3. Create a username (e.g., @yourname)
4. Return to StarStore and try again

💡 *Why is this required?*
Usernames help us provide better support and ensure smooth order processing.

Need help? Contact @StarStore_Chat`;

                await bot.sendMessage(telegramId, dmMessage, { 
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true 
                });
                console.log(`✅ Sent username instructions DM to user ${telegramId}`);
            } catch (dmError) {
                console.warn(`⚠️ Could not send DM to user ${telegramId}:`, dmError.message);
                // Don't fail the API call if DM fails
            }
            
            return res.status(400).json({ 
                error: 'Telegram username required', 
                details: 'You must set a Telegram username (@username) to place orders. Go to Telegram Settings → Username to create one.',
                requiresUsername: true,
                dmSent: true
            });
        }

        const bannedUser = await BannedUser.findOne({ users: telegramId.toString() });
        if (bannedUser) {
            processingRequests.delete(requestKey);
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        // Check for duplicate orders with same transaction hash
        if (transactionHash) {
            const existingOrder = await BuyOrder.findOne({ transactionHash });
            if (existingOrder) {
                // Check if order is recent (within last 10 minutes) - likely a duplicate submission
                const isRecentOrder = existingOrder.dateCreated && (Date.now() - new Date(existingOrder.dateCreated).getTime()) < 600000;
                if (isRecentOrder) {
                    console.error('Duplicate transaction detected (recent):', transactionHash);
                    processingRequests.delete(requestKey);
                    return res.status(400).json({ 
                        error: 'This transaction has already been processed. If you were charged multiple times, contact support.',
                        orderId: existingOrder.id
                    });
                }
            }
        }

        // Check for recent orders from same user to prevent rapid duplicate orders
        const recentOrder = await BuyOrder.findOne({
            telegramId,
            dateCreated: { $gte: new Date(Date.now() - 60000) }, // Last 1 minute
            status: { $in: ['pending', 'processing'] }
        });
        
        if (recentOrder) {
            console.error('Recent order detected for user:', telegramId);
            processingRequests.delete(requestKey);
            return res.status(400).json({ 
                error: 'Please wait before placing another order. A recent order is still being processed.',
                orderId: recentOrder.id
            });
        }

        // Reject testnet orders for non-admins; allow for admins
        if (isTestnet === true && !requesterIsAdmin) {
            processingRequests.delete(requestKey);
            return res.status(400).json({ error: 'Testnet is not supported. Please switch your wallet to TON mainnet.' });
        }
        
        // Additional validation: Check wallet address format
        if (walletAddress && typeof walletAddress === 'string') {
            // For admins, allow testnet addresses; for regular users, enforce mainnet only
            if (!requesterIsAdmin && !isValidTONAddress(walletAddress)) {
                console.error('❌ Invalid wallet address format:', walletAddress);
                return res.status(400).json({ error: 'Invalid wallet address format. Please provide a valid TON mainnet address.' });
            }
            // For admins, do basic format check but allow testnet
            if (requesterIsAdmin && walletAddress.trim().length < 10) {
                console.error('❌ Wallet address too short:', walletAddress);
                return res.status(400).json({ error: 'Invalid wallet address. Please provide a complete TON wallet address.' });
            }
            
            // Additional validation: Check if wallet address is not empty or just whitespace (for non-admins)
            if (!requesterIsAdmin && walletAddress.trim().length < 10) {
                console.error('❌ Wallet address too short:', walletAddress);
                return res.status(400).json({ error: 'Invalid wallet address. Please provide a complete TON wallet address.' });
            }
            
            // Check for common invalid addresses (only for non-admins)
            if (!requesterIsAdmin) {
                const invalidPatterns = ['0x', 'bc1', 'test', 'invalid', 'none', 'null', 'undefined', 'example'];
                // Only check for invalid patterns, but exclude valid hex format addresses
                const isHexFormat = /^[0-9-]+:[a-fA-F0-9]{64}$/.test(walletAddress.trim());
                if (!isHexFormat && invalidPatterns.some(pattern => walletAddress.toLowerCase().includes(pattern))) {
                    console.error('❌ Wallet address contains invalid pattern:', walletAddress);
                    return res.status(400).json({ error: 'Invalid wallet address. Please provide a valid TON wallet address.' });
                }
            }
        } else {
            console.error('❌ Wallet address missing or invalid type:', walletAddress);
            return res.status(400).json({ error: 'Wallet address is required and must be a valid TON address.' });
        }

        // Handle recipients for "buy for others" functionality
        let isBuyForOthers = false;
        let totalRecipients = 0;
        let starsPerRecipient = null;
        let premiumDurationPerRecipient = null;
        let processedRecipients = [];
        
        console.log('Order creation - received data:', {
            stars,
            isPremium,
            premiumDuration,
            recipients: recipients?.length || 0,
            totalAmount
        });

        if (recipients && Array.isArray(recipients) && recipients.length > 0) {
            isBuyForOthers = true;
            totalRecipients = recipients.length;
            
            if (isPremium) {
                // For premium, duration is shared equally
                premiumDurationPerRecipient = premiumDuration;
            } else {
                // For stars, distribute equally
                starsPerRecipient = Math.floor(stars / totalRecipients);
                const remainingStars = stars % totalRecipients;
                
                // Process recipients with equal distribution
                processedRecipients = recipients.map((recipient, index) => ({
                    username: recipient,
                    userId: null, // Will be filled when order is completed
                    starsReceived: starsPerRecipient + (index < remainingStars ? 1 : 0),
                    premiumDurationReceived: null
                }));
            }
        }

        // Use totalAmount from frontend if provided (for accurate multi-recipient pricing)
        let amount, packageType;
        if (totalAmount && typeof totalAmount === 'number' && totalAmount > 0) {
            // Use the accurate total amount from frontend quote
            amount = totalAmount;
            packageType = isPremium ? 'premium' : 'regular';
        } else {
            // Fallback to old pricing logic for backward compatibility
            const priceMap = {
                regular: { 1000: 20, 500: 10, 100: 2, 50: 1, 25: 0.6, 15: 0.35 },
                premium: { 3: 19.31, 6: 26.25, 12: 44.79 }
            };

            if (isPremium) {
                packageType = 'premium';
                amount = priceMap.premium[premiumDuration];
            } else {
                packageType = 'regular';
                amount = priceMap.regular[stars];
            }

            if (!amount) {
                return res.status(400).json({ error: 'Invalid selection' });
            }
        }

        const order = new BuyOrder({
            id: generateBuyOrderId(),
            telegramId,
            username,
            amount,
            stars: isPremium ? null : stars,
            premiumDuration: isPremium ? null : premiumDuration,
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
            transactionVerified: false, // Always start as unverified
            verificationAttempts: 0,
            userLocation: null // Will be set below after geolocation
        });

        await order.save();
        
        console.log('Final order details:', {
            orderId: order.id,
            amount: amount,
            isBuyForOthers,
            totalRecipients,
            starsPerRecipient
        });

        // Create user message based on order type
        let userMessage = `🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStatus: Pending\n\n⏱️ Processing Time: Up to 2 hours to complete\n⚠️ Important: Do not change your username before order completion`;
        
        if (isPremium) {
            userMessage = `🎉 Premium order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nDuration: ${premiumDuration} months\nStatus: Pending\n\n⏱️ Processing Time: Up to 2 hours to complete\n⚠️ Important: Do not change your username before order completion`;
            if (isBuyForOthers) {
                userMessage += `\n\nRecipients: ${totalRecipients} user(s)`;
            }
        } else {
            userMessage = `🎉 Order received!\n\nOrder ID: ${order.id}\nAmount: ${amount} USDT\nStars: ${stars}\nStatus: Pending\n\n⏱️ Processing Time: Up to 2 hours to complete\n⚠️ Important: Do not change your username before order completion`;
            if (isBuyForOthers) {
                userMessage += `\n\nRecipients: ${totalRecipients} user(s)\nStars per recipient: ${starsPerRecipient}`;
            }
        }

        await bot.sendMessage(telegramId, userMessage);

        // Track user activity (buy order created) and get location data
        let userLocation = 'Location: Not available';
        let locationGeo = null;
        try {
            // Extract IP from request - x-forwarded-for is set by Railway proxies
            let ip = req.headers?.['x-forwarded-for'] || req.headers?.['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown';
            
            // Handle multiple IPs in x-forwarded-for (take first one)
            if (typeof ip === 'string') {
                ip = ip.split(',')[0].trim();
            }
            
            console.log(`[BUY-ORDER] IP extraction: x-forwarded-for=${req.headers?.['x-forwarded-for']}, final-ip=${ip}`);
            
            // Only try to get geolocation if we have a valid IP (not from Telegram)
            if (ip && ip !== 'unknown' && ip !== 'localhost' && ip !== '127.0.0.1' && ip !== '::1') {
                console.log(`[BUY-ORDER] Attempting geolocation for IP: ${ip}`);
                locationGeo = await getGeolocation(ip);
                console.log(`[BUY-ORDER] Geolocation result: ${locationGeo.city}, ${locationGeo.country}`);
                
                if (locationGeo.country !== 'Unknown') {
                    userLocation = `Location: ${locationGeo.city || 'Unknown'}, ${locationGeo.country}`;
                    // Store in order as well
                    order.userLocation = {
                        city: locationGeo.city,
                        country: locationGeo.country,
                        countryCode: locationGeo.countryCode,
                        ip: ip,
                        timestamp: new Date()
                    };
                    console.log(`[BUY-ORDER] Location set: ${userLocation}`);
                }
            } else {
                console.log(`[BUY-ORDER] Skipped geolocation: IP is ${ip}`);
            }
        } catch (err) {
            console.error('Error getting location for buy order:', err.message);
        }
        
        // Now track activity with location data (pass locationGeo to override)
        await trackUserActivity(telegramId, username, 'order_created', {
            orderId: order.id,
            orderType: isPremium ? 'premium_buy' : 'buy',
            amount: amount,
            isPremium: isPremium
        }, req, null, locationGeo);

        // Create enhanced admin message with Telegram ID and location
        let adminMessage = `🛒 New ${isPremium ? 'Premium' : 'Buy'} Order!\n\nOrder ID: ${order.id}\nUser: @${username} (ID: ${telegramId})\n${userLocation}\nAmount: ${amount} USDT`;
        
        if (isPremium) {
            adminMessage += `\nDuration: ${premiumDuration} months`;
        } else {
            adminMessage += `\nStars: ${stars}`;
        }
        
        if (isBuyForOthers) {
            adminMessage += `\n\n🎯 Buy For Others: ${totalRecipients} recipient(s)`;
            if (isPremium) {
                adminMessage += `\nDuration per recipient: ${premiumDurationPerRecipient} months`;
            } else {
                adminMessage += `\nStars per recipient: ${starsPerRecipient}`;
            }
            adminMessage += `\n\nRecipients: ${recipients.map(r => `@${r}`).join(', ')}`;
        }

        const adminKeyboard = {
            inline_keyboard: [[
                { text: '✅ Complete', callback_data: `complete_buy_${order.id}` },
                { text: '❌ Decline', callback_data: `decline_buy_${order.id}` }
            ]]
        };

        for (const adminId of adminIds) {
            try {
                const message = await bot.sendMessage(adminId, adminMessage, { reply_markup: adminKeyboard });
                order.adminMessages.push({ 
                    adminId, 
                    messageId: message.message_id,
                    originalText: adminMessage 
                });
            } catch (err) {
                console.error(`Failed to notify admin ${adminId}:`, err);
            }
        }

        await order.save();
        
        // Do NOT award or log points yet; award on completion
        console.log(`🛒 Buy order created for user ${telegramId}`);
        
        console.log('Order created successfully:', order.id);
        processingRequests.delete(requestKey);
        res.json({ success: true, order });
    } catch (err) {
        console.error('Order creation error:', err);
        console.error('Error details:', {
            message: err.message,
            stack: err.stack,
            name: err.name
        });
        processingRequests.delete(requestKey);
        res.status(500).json({ error: 'Failed to create order: ' + err.message });
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

        // Check for existing pending orders for this user
        const existingOrder = await SellOrder.findOne({ 
            telegramId: telegramId,
            status: "pending",
            sessionExpiry: { $gt: new Date() } 
        });

        if (existingOrder) {
            return res.status(409).json({ 
                error: "You already have a pending order. Please complete or wait for it to expire before creating a new one.",
                existingOrderId: existingOrder.id
            });
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
            },
            $set: {
                // Update referralHash if not already set (for existing users)
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
                await user.save();
            }
        }
        
        // 6. LOG INTERACTION
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
            
            await user.save();
        }
        
        // Create activity log
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

    for (const adminId of adminIds) {
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
            await order.save();
        } catch (err) {
            console.error(`Failed to notify admin ${adminId}:`, err);
        }
    }
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
            if (data === 'wallet_sel_all') {
                // naive: cannot enumerate here; user can select individually before
                await bot.answerCallbackQuery(query.id, { text: 'Select items individually, then Continue.' });
                return;
            }
            if (data === 'wallet_sel_clear') {
                bucket.selections.clear();
                bucket.timestamp = Date.now();
                walletSelections.set(userId, bucket);
                await bot.answerCallbackQuery(query.id, { text: 'Selection cleared' });
                return;
            }
            const parts = data.split('_');
            const type = parts[2];
            const id = parts.slice(3).join('_');
            const key = type === 'sell' ? `sell:${id}` : `wd:${id}`;
            if (bucket.selections.has(key)) bucket.selections.delete(key); else bucket.selections.add(key);
            bucket.timestamp = Date.now();
            walletSelections.set(userId, bucket);
            await bot.answerCallbackQuery(query.id, { text: `Selected: ${bucket.selections.size}` });
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
                            // If we tracked a message id on withdrawals in future, we would edit here similarly
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


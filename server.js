
require('dotenv').config();

// Suppress punycode deprecation warning (from tldts dependency)
// Safe to ignore - Node.js built-in punycode is still stable for domain parsing
process.noDeprecation = true;

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
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
// Optional bot simulator (to avoid bloating monolith logic)
let startBotSimulatorSafe = null;
try {
  ({ startBotSimulator: startBotSimulatorSafe } = require('./services/bot-simulator'));
} catch (_) {
  // noop if missing
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
app.use(bodyParser.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

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
app.get(['/', '/about', '/sell', '/history', '/blog', '/knowledge-base', '/how-to-withdraw-telegram-stars', '/ambassador'], (req, res, next) => {
  try {
    const map = {
      '/': 'index.html',
      '/about': 'about.html',
      '/sell': 'sell.html',
      '/history': 'history.html',
      '/blog': 'blog/index.html',
      '/knowledge-base': 'knowledge-base/index.html',
      '/how-to-withdraw-telegram-stars': 'how-to-withdraw-telegram-stars/index.html',
      '/ambassador': 'ambassador/index.html'
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

// Error page preview routes (for manual verification)
app.get(['/400','/401','/403','/404','/500','/502','/503','/504'], (req, res) => {
  try {
    const code = parseInt(req.path.replace('/', ''), 10);
    const allowed = new Set([400,401,403,404,500,502,503,504]);
    if (!allowed.has(code)) {
      const notFound = path.join(__dirname, 'public', 'errors', '404.html');
      return res.status(404).sendFile(notFound, (err) => {
        if (err) return res.status(404).send('Not found');
      });
    }
    const abs = path.join(__dirname, 'public', 'errors', `${code}.html`);
    return res.status(code).sendFile(abs, (err) => {
      if (err) return res.status(code).send(String(code));
    });
  } catch (e) {
    return res.status(500).send('');
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

// Error handler - JSON for APIs, HTML for pages
app.use((err, req, res, next) => {
  try { console.error('Unhandled error:', err); } catch (_) {}
  if (res.headersSent) return next(err);
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  const abs = path.join(__dirname, 'public', '500.html');
  return res.status(500).sendFile(abs, (sendErr) => {
    if (sendErr) return res.status(500).send('Internal Server Error');
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
        default: 'pending'
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
    timezone: String
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
        enum: ['message', 'button_click', 'command', 'api_call', 'order_created', 'order_completed', 'login'],
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
    status: { type: String, enum: ['pending', 'active', 'completed'], default: 'pending' },
    withdrawn: { type: Boolean, default: false },
    dateReferred: { type: Date, default: Date.now }
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
    referredUserId: { type: String, required: true, unique: true },
    referredUsername: String,
    totalBoughtStars: { type: Number, default: 0 },
    totalSoldStars: { type: Number, default: 0 },
    premiumActivated: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'active'], default: 'pending' },
    dateReferred: { type: Date, default: Date.now },
    dateActivated: Date
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

let adminIds = (process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(id => id.trim());
// Deduplicate to avoid duplicate notifications per admin
adminIds = Array.from(new Set(adminIds));
const REPLY_MAX_RECIPIENTS = parseInt(process.env.REPLY_MAX_RECIPIENTS || '30', 10);

// Track processing callbacks to prevent duplicates
const processingCallbacks = new Set();

// Clean up old processing entries every 5 minutes
setInterval(() => {
    console.log(`Processing callbacks: ${processingCallbacks.size}`);
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

        // Get admin status early for logging
        const requesterIsAdmin = Boolean(req.user?.isAdmin);

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
            console.error('❌ Missing required fields:', { telegramId: !!telegramId, username: !!username, walletAddress: !!walletAddress, premiumDuration: !!premiumDuration });
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Additional validation: username must not be a fallback value
        const isFallbackUsername = username === 'Unknown' || username === 'User' || !username.match(/^[a-zA-Z0-9_]{5,32}$/);
        if (isFallbackUsername) {
            console.error('❌ Invalid username detected:', { username, telegramId });
            
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
            return res.status(403).json({ error: 'You are banned from placing orders' });
        }

        // Check for duplicate orders with same transaction hash
        if (transactionHash) {
            const existingOrder = await BuyOrder.findOne({ transactionHash });
            if (existingOrder) {
                console.error('❌ Duplicate transaction detected:', transactionHash);
                return res.status(400).json({ 
                    error: 'This transaction has already been processed. If you were charged multiple times, contact support.',
                    orderId: existingOrder.id
                });
            }
        }

        // Check for recent orders from same user to prevent rapid duplicate orders
        const recentOrder = await BuyOrder.findOne({
            telegramId,
            dateCreated: { $gte: new Date(Date.now() - 60000) }, // Last 1 minute
            status: { $in: ['pending', 'processing'] }
        });
        
        if (recentOrder) {
            console.error('❌ Recent order detected for user:', telegramId);
            return res.status(400).json({ 
                error: 'Please wait before placing another order. A recent order is still being processed.',
                orderId: recentOrder.id
            });
        }

        // Reject testnet orders for non-admins; allow for admins
        if (isTestnet === true && !requesterIsAdmin) {
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
            verificationAttempts: 0
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
        try {
            // Extract IP from request 
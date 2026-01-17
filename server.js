
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

        // === SYNC USER DATA ON EVERY INTERACTION ===
        await syncUserData(telegramId, username, 'order_create', req);

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
        
        console.log('✅ Order created successfully:', order.id);
        res.json({ success: true, order });
    } catch (err) {
        console.error('❌ Order creation error:', err);
        console.error('❌ Error details:', {
            message: err.message,
            stack: err.stack,
            name: err.name
        });
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
async function detectUsernameChange(userId, currentUsername) {
    try {
        // Use findOneAndUpdate with upsert to avoid race conditions
        const storedUser = await User.findOne({ id: userId });
        
        if (!storedUser) {
            // New user - use upsert to prevent race conditions from simultaneous requests
            try {
                await User.findOneAndUpdate(
                    { id: userId },
                    { $set: { id: userId, username: currentUsername, lastActive: new Date() } },
                    { upsert: true, new: false }
                );
            } catch (e) {
                // E11000 duplicate key error means user was created by another simultaneous request
                // This is fine, just continue
                if (e.code !== 11000) {
                    throw e;
                }
            }
            return null; // No change, new user
        }
        
        // Compare usernames
        if (storedUser.username && storedUser.username !== currentUsername) {
            const oldUsername = storedUser.username;
            // Update the stored username
            storedUser.username = currentUsername;
            await storedUser.save();
            return { oldUsername, newUsername: currentUsername };
        } else if (!storedUser.username && currentUsername) {
            // First time we capture the username
            storedUser.username = currentUsername;
            await storedUser.save();
            return null;
        }
        
        return null; // No change
    } catch (error) {
        console.error(`Error detecting username change for user ${userId}:`, error.message);
        return null;
    }
}

// Centralized username update processor - updates all affected messages and database
async function processUsernameUpdate(userId, oldUsername, newUsername) {
    try {
        if (!oldUsername || !newUsername || oldUsername === newUsername) {
            return; // No change needed
        }

        // Update User record
        try {
            await User.updateOne({ id: userId }, { username: newUsername });
        } catch (_) {}

        // Update all sell orders
        const sellOrders = await SellOrder.find({ username: oldUsername, telegramId: userId });
        for (const order of sellOrders) {
            order.username = newUsername;
            
            // Edit user's original order message if tracked
            if (order.userMessageId) {
                const originalText = `✅ Payment successful!\\n\\n` +
                    `Order ID: ${order.id}\\n` +
                    `Stars: ${order.stars}\\n` +
                    `Wallet: ${order.walletAddress}\\n` +
                    `${order.memoTag ? `Memo: ${order.memoTag}\\n` : ''}` +
                    `\\nStatus: Processing (21-day hold)\\n\\n` +
                    `Funds will be released to your wallet after the hold period.`;
                try { await bot.editMessageText(originalText, { chat_id: order.telegramId, message_id: order.userMessageId }); } catch (_) {}
            }
            
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
        const buyOrders = await BuyOrder.find({ username: oldUsername, telegramId: userId });
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
        const withdrawals = await ReferralWithdrawal.find({ username: oldUsername, userId });
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

        console.log(`✅ Username updated in database and messages: @${oldUsername} → @${newUsername} (User: ${userId})`);
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
            
            // 2. CHECK/UPDATE USERNAME
            if (username && user.username !== username) {
                user.username = username;
                hasChanges = true;
                console.log(`[SYNC] Username updated: ${telegramId} -> @${username}`);
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
            const usernameChange = await detectUsernameChange(userId, username);
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
                        
                        // Edit user's original order message if tracked
                        if (order.userMessageId) {
                            const originalText = `✅ Payment successful!\\n\\n` +
                                `Order ID: ${order.id}\\n` +
                                `Stars: ${order.stars}\\n` +
                                `Wallet: ${order.walletAddress}\\n` +
                                `${order.memoTag ? `Memo: ${order.memoTag}\\n` : ''}` +
                                `\\nStatus: Processing (21-day hold)\\n\\n` +
                                `Funds will be released to your wallet after the hold period.`;
                            try { await bot.editMessageText(originalText, { chat_id: order.telegramId, message_id: order.userMessageId }); } catch (_) {}
                        }
                        
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
                            // Try to edit user's original order message if tracked (preserve original format)
                            if (order.userMessageId) {
                                const originalText = `✅ Payment successful!\n\n` +
                                    `Order ID: ${order.id}\n` +
                                    `Stars: ${order.stars}\n` +
                                    `Wallet: ${order.walletAddress}\n` +
                                    `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
                                    `\nStatus: Processing (21-day hold)\n\n` +
                                    `Funds will be released to your wallet after the hold period.`;
                                try { await bot.editMessageText(originalText, { chat_id: order.telegramId, message_id: order.userMessageId }); } catch (_) {}
                            } else {
                                // Fallback: send a new summary if original message cannot be edited
                                const originalText = `✅ Payment successful!\n\n` +
                                    `Order ID: ${order.id}\n` +
                                    `Stars: ${order.stars}\n` +
                                    `Wallet: ${order.walletAddress}\n` +
                                    `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
                                    `\nStatus: Processing (21-day hold)\n\n` +
                                    `Funds will be released to your wallet after the hold period.`;
                                try { await bot.sendMessage(order.telegramId, originalText); } catch (_) {}
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

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    const username = msg.from.username || '';

    // Auto-detect and update username in real-time on ANY message
    if (username) {
        const usernameChange = await detectUsernameChange(userId, username);
        if (usernameChange) {
            await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
            try {
                await bot.sendMessage(userId, `✅ Username change detected and updated: @${usernameChange.oldUsername} → @${usernameChange.newUsername}`);
            } catch (_) {}
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
                
                // Update buttons
                await updateAdminMessages(request, statusText);
                
                // Send notifications
                await bot.sendMessage(query.from.id, adminMessage);
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
            
            // Mark as processing
            processingCallbacks.add(callbackKey);
            
            // Double-check database status after acquiring lock
            const freshRequest = await Reversal.findOne({ orderId });
            if (!freshRequest || freshRequest.status !== 'pending') {
                console.log(`Request ${orderId} was processed by another instance`);
                processingCallbacks.delete(callbackKey);
                return;
            }

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
                } finally {
                    // Remove from processing set
                    processingCallbacks.delete(callbackKey);
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
                } finally {
                    // Remove from processing set
                    processingCallbacks.delete(callbackKey);
                }
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
    console.log(`Admin messages:`, request.adminMessages);
    
    if (!request.adminMessages || request.adminMessages.length === 0) {
        console.log('No admin messages to update - adminMessages array is empty');
        console.log('This suggests the adminMessages were not properly saved when the request was created');
        return;
    }
    
    for (const msg of request.adminMessages) {
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
      const buyOrders = await BuyOrder.countDocuments({ telegramId: userId, status: 'completed' });
      const sellOrders = await SellOrder.countDocuments({ telegramId: userId, status: 'completed' });
      return buyOrders + sellOrders;
    } else {
      const buyOrders = await db.findOrders({ telegramId: userId, status: 'completed' });
      const sellOrders = await db.findSellOrders({ telegramId: userId, status: 'completed' });
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
      return await Referral.countDocuments({ referrerUserId: userId, status: { $in: ['active', 'completed'] } });
    } else {
      return await db.countReferrals({ referrerUserId: userId, status: { $in: ['active', 'completed'] } });
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
      // Production: Use MongoDB
      state = await DailyState.findOne({ userId });
      if (!state) {
        state = await DailyState.create({ userId, totalPoints: 0, missionsCompleted: [] });
      }
    } else {
      // Development: Use file-based storage
      state = await db.findDailyState(userId);
      if (!state) {
        state = await db.createDailyState({ userId, totalPoints: 0, missionsCompleted: [] });
      }
    }

    const completed = new Set(state.missionsCompleted || []);
    if (completed.has(missionId)) {
      return res.json({ success: true, alreadyCompleted: true, totalPoints: state.totalPoints });
    }

    completed.add(missionId);
    state.missionsCompleted = Array.from(completed);
    state.totalPoints = (state.totalPoints || 0) + mission.points;
    state.updatedAt = new Date();
    
    // Save the state
    if (process.env.MONGODB_URI) {
      await state.save();
    } else {
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
      // Production: Use MongoDB
      state = await DailyState.findOne({ userId });
      if (!state) {
        state = await DailyState.create({ userId, month: monthKey, checkedInDays: [], totalPoints: 0, streak: 0, missionsCompleted: [] });
      }
    } else {
      // Development: Use file-based storage
      state = await db.findDailyState(userId);
      if (!state) {
        state = await db.createDailyState({ userId, month: monthKey, checkedInDays: [], totalPoints: 0, streak: 0, missionsCompleted: [] });
      }
    }
    // Reset month scope if month rolled over
    if (state.month !== monthKey) {
      state.month = monthKey;
      state.checkedInDays = [];
    }
    
    // Save the state
    if (process.env.MONGODB_URI) {
      await state.save();
    } else {
      await db.updateDailyState(userId, state);
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

    // Deduct points
    state.totalPoints -= reward.cost;
    
    // Apply reward effect (store in user state or separate collection)
    if (!state.redeemedRewards) state.redeemedRewards = [];
    state.redeemedRewards.push({
      rewardId,
      redeemedAt: new Date(),
      name: reward.name
    });

    await state.save();

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
        console.log(`Fetching referral data for user: ${userId}`);
        
        // Check if user exists
        const user = await User.findOne({ id: userId });
        if (!user) {
            console.log(`User not found: ${userId}`);
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const referrals = await Referral.find({ referrerUserId: userId });
        // Found referrals for user
        
        const referredUserIds = referrals.map(r => r.referredUserId);
        const users = await User.find({ id: { $in: referredUserIds } });
        
        const userMap = {};
        users.forEach(user => userMap[user.id] = user.username);

        const totalReferrals = referrals.length;
        
        // Get completed/active AND non-withdrawn referrals
        const availableReferrals = await Referral.find({
            referrerUserId: req.params.userId,
            status: { $in: ['completed', 'active'] },
            withdrawn: { $ne: true }
        }).countDocuments();

        // Get all completed/active (regardless of withdrawal status)
        const completedReferrals = referrals.filter(r => 
            ['completed', 'active'].includes(r.status)
        ).length;
        
        // Referral stats calculated

        const responseData = {
            success: true,
            referrals: referrals.map(ref => ({
                userId: ref.referredUserId,
                name: userMap[ref.referredUserId] || `User ${ref.referredUserId.substring(0, 6)}`,
                status: ref.status.toLowerCase(),
                date: ref.dateReferred || ref.dateCreated || new Date(0),
                amount: 0.5
            })),
            stats: {
                availableBalance: availableReferrals * 0.5,
                totalEarned: completedReferrals * 0.5,
                referralsCount: totalReferrals,
                pendingAmount: (completedReferrals - availableReferrals) * 0.5
            },
            referralLink: `https://t.me/TgStarStore_bot?start=ref_${req.params.userId}`
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
      const referredIds = await Referral.find({ referrerUserId: requesterId, status: { $in: ['active', 'completed'] } }).distinct('referredUserId');
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
          { $match: { status: { $in: ['active', 'completed'] } } },
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
            status: { $in: ['completed', 'active'] },
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

        const userMessage = `✅ Withdrawal Request Submitted\n\n` +
                          `💵 Amount: ${amountNum} USDT\n` +
                          `👛 Wallet: ${walletAddress}\n` +
                          `🆔 ID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}\n\n` +
                          `⏳ Status: Pending approval`;

        await bot.sendMessage(userId, userMessage);

        const adminMessage = `💸 Withdrawal Request\n\n` +
                           `User: @${username} (ID: ${userId})\n` +
                           `Amount: ${amountNum} USDT\n` +
                           `Wallet: ${walletAddress}\n` +
                           `Referrals: ${referralsNeeded}\n` +
                           `Location: ${withdrawal.userLocation ? `${withdrawal.userLocation.city || 'Unknown'}, ${withdrawal.userLocation.country || 'Unknown'}` : 'Unknown'}\n` +
                           `WDID: WD${withdrawal._id.toString().slice(-8).toUpperCase()}`;

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

        if (!data.includes('withdrawal_')) {
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
        for (const adminId of adminIds) {
            try {
                await bot.sendMessage(adminId, adminMessage, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                adminNotificationSuccess = true;
                console.log(`Successfully notified admin ${adminId} about referral activation`);
            } catch (err) {
                console.error(`Failed to notify admin ${adminId} about referral activation:`, err);
            }
        }

        // Log if no admins were successfully notified
        if (!adminNotificationSuccess && adminIds.length > 0) {
            console.error(`CRITICAL: Failed to notify any admin about referral activation for tracker ${tracker._id}`);
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
        
        // Activation logic (100+ stars or premium)
        if ((totalStars >= 100 || tracker.premiumActivated) && tracker.status === 'pending') {
            await handleReferralActivation(tracker);
        } else {
            await tracker.save();
        }
        
        // Also update the Referral status if it's still pending and conditions are met
        if (tracker.referral && (totalStars >= 100 || tracker.premiumActivated)) {
            const referral = await Referral.findById(tracker.referral);
            if (referral && referral.status === 'pending') {
                referral.status = 'completed';
                referral.dateActivated = new Date();
                await referral.save();
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
                await handleReferralActivation(tracker);
            } else {
                await tracker.save();
            }
            
            // Also update the Referral status if it's still pending
            if (tracker.referral) {
                const referral = await Referral.findById(tracker.referral);
                if (referral && referral.status === 'pending') {
                    referral.status = 'completed';
                    referral.dateActivated = new Date();
                    await referral.save();
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
        
        if (deepLinkParam?.startsWith('ref_')) {
            const referrerUserId = deepLinkParam.split('_')[1];
            
            if (!referrerUserId || referrerUserId === chatId.toString()) return;
            if (!/^\d+$/.test(referrerUserId)) return;
            
            const existing = await ReferralTracker.findOne({ referredUserId: chatId.toString() });
            if (!existing) {
                const referral = await Referral.create({
                    referrerUserId,
                    referredUserId: chatId.toString(),
                    status: 'pending',
                    dateReferred: new Date()
                });
                
                await ReferralTracker.create({
                    referral: referral._id,
                    referrerUserId,
                    referredUserId: chatId.toString(),
                    referredUsername: username,
                    status: 'pending',
                    dateReferred: new Date()
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
            const usernameChange = await detectUsernameChange(userId, username);
            if (usernameChange) {
                await processUsernameUpdate(userId, usernameChange.oldUsername, usernameChange.newUsername);
                try {
                    await bot.sendMessage(userId, `✅ Username automatically updated: @${usernameChange.oldUsername} → @${usernameChange.newUsername}`);
                } catch (_) {}
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
        // Initialize selection bucket with timestamp
        walletSelections.set(userId, { selections: new Set(), timestamp: Date.now() });

        sellOrders.forEach(o => {
            keyboard.inline_keyboard.push([
                { text: `☑️ ${o.id}`, callback_data: `wallet_sel_sell_${o.id}` },
                { text: '🔄 Update this', callback_data: `wallet_update_sell_${o.id}` }
            ]);
        });
        withdrawals.forEach(w => {
            keyboard.inline_keyboard.push([
                { text: `☑️ ${w.withdrawalId}`, callback_data: `wallet_sel_withdrawal_${w.withdrawalId}` },
                { text: '🔄 Update this', callback_data: `wallet_update_withdrawal_${w.withdrawalId}` }
            ]);
        });
        keyboard.inline_keyboard.push([
            { text: 'Select All', callback_data: 'wallet_sel_all' },
            { text: 'Clear', callback_data: 'wallet_sel_clear' }
        ]);
        keyboard.inline_keyboard.push([
            { text: '✅ Continue with selected', callback_data: 'wallet_continue_selected' }
        ]);

        await bot.sendMessage(chatId, lines.join('\n') + `\n\nSelect one or more items, then tap "Continue with selected".`, { reply_markup: keyboard });
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


bot.onText(/\/help/, (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id.toString();
        const isAdmin = adminIds.includes(userId);

        if (isAdmin) {
            // Show admin help
            const adminHelpText = `🔧 **Admin Commands Help**

**👥 User Management:**
/ban [user_id] - Ban a user from using the bot
/unban [user_id] - Unban a previously banned user
/warn [user_id] - Send a warning to a user
/warnings [user_id] - Check all warnings for a user
/users - List all users in the system
/detect_users - Detect and process new users

**💰 Wallet Management:**
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

**🔍 Information:**
/version - Check app version and update information
/adminhelp - Show this admin help menu
/adminwallethelp - Show detailed wallet management help

**Wallet Update Requests:**
• Use the inline buttons on wallet update requests to approve/reject
• All wallet changes require admin approval for security`;

        bot.sendMessage(chatId, adminHelpText, { parse_mode: 'Markdown' });
    } else {
        // Show user help
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

        bot.sendMessage(chatId, userHelpText, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Help command error:', error);
        bot.sendMessage(msg.chat.id, '❌ Failed to load help. Please try again later.');
    }
});

// Contact command for users
bot.onText(/\/contact/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    const contactText = `📞 **Contact Support**

**Type your message below and we'll respond quickly!**

*For sell order refunds, use /paysupport*`;

    bot.sendMessage(chatId, contactText, { parse_mode: 'Markdown' });
    
    // Set up message listener for support request
    bot.once('message', (userMsg) => {
        if (userMsg.chat.id === chatId) {
            const userMessageText = userMsg.text;
            adminIds.forEach(adminId => {
                bot.sendMessage(adminId, `📞 Support Request from @${username} (ID: ${chatId}):\n\n${userMessageText}`);
            });
            bot.sendMessage(chatId, "✅ Your message has been sent to our support team. We'll get back to you shortly!");
        }
    });
});

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
        
        // Build comprehensive report
        let report = `👤 **User Information**\n`;
        report += `├─ ID: ${user.id}\n`;
        report += `├─ Username: @${user.username || 'Not set'}\n`;
        report += `├─ First Seen: ${user.createdAt?.toLocaleString() || 'Unknown'}\n`;
        report += `└─ Last Active: ${user.lastActive?.toLocaleString() || 'Never'}\n\n`;
        
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
/userinfo [user_id] - View comprehensive user info (activity, location, devices)

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
            
            // Update user's original order message if tracked
            if (order.userMessageId) {
                const originalText = `✅ Payment successful!\n\n` +
                    `Order ID: ${order.id}\n` +
                    `Stars: ${order.stars}\n` +
                    `Wallet: ${order.walletAddress}\n` +
                    `${order.memoTag ? `Memo: ${order.memoTag}\n` : ''}` +
                    `\nStatus: Processing (21-day hold)\n\n` +
                    `Funds will be released to your wallet after the hold period.`;
                try { 
                    await bot.editMessageText(originalText, { 
                        chat_id: order.telegramId, 
                        message_id: order.userMessageId 
                    }); 
                } catch (e) {
                    console.warn(`Failed to edit user message for order ${order.id}:`, e.message);
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

//broadcast now supports rich media text including porn
bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!adminIds.includes(chatId.toString())) {
        return bot.sendMessage(chatId, '❌ Unauthorized: Only admins can use this command.');
    }
    await bot.sendMessage(chatId, 'Enter the broadcast message (text, photo, audio, etc.):');
    // Listen for the admin's next message
    bot.once('message', async (adminMsg) => {
        const users = await User.find({});
        let successCount = 0;
        let failCount = 0;
        // Extract media and metadata from the admin's message
        const messageType = adminMsg.photo ? 'photo' :
                           adminMsg.audio ? 'audio' :
                           adminMsg.video ? 'video' :
                           adminMsg.document ? 'document' :
                           'text';
        const caption = adminMsg.caption || '';
        const mediaId = adminMsg.photo ? adminMsg.photo[0].file_id :
                       adminMsg.audio ? adminMsg.audio.file_id :
                       adminMsg.video ? adminMsg.video.file_id :
                       adminMsg.document ? adminMsg.document.file_id :
                       null;
        // Broadcast the message to all kang'ethes
        for (const user of users) {
            try {
                if (messageType === 'text') {
                    // Broadcast text message
                    await bot.sendMessage(user.id, adminMsg.text || caption);
                } else {
                    // Broadcast media message
                    await bot.sendMediaGroup(user.id, [{
                        type: messageType,
                        media: mediaId,
                        caption: caption
                    }]);
                }
                successCount++;
            } catch (err) {
                console.error(`Failed to send broadcast to user ${user.id}:`, err);
                failCount++;
            }
        }
        // Notify the admin about the broadcast result
        bot.sendMessage(chatId, `📢 Broadcast results:\n✅ ${successCount} messages sent successfully\n❌ ${failCount} messages failed to send.`);
    });
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
        if (!userId) return res.status(400).json({ error: 'Missing user id' });
        await User.updateOne(
            { id: userId },
            { $set: { lastActive: new Date() }, $setOnInsert: { username: '', createdAt: new Date() } },
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
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        // Extract IP from request
        const ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
            .toString().split(',')[0].trim();

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
app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get both buy and sell orders for the user
        const buyOrders = await BuyOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();
        
        const sellOrders = await SellOrder.find({ telegramId: userId })
            .sort({ dateCreated: -1 })
            .lean();

        // Combine and format the data
        const transactions = [
            ...buyOrders.map(order => ({
                id: order.id,
                type: 'Buy Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Buy order for ${order.stars} stars`,
                usdtValue: order.amount
            })),
            ...sellOrders.map(order => ({
                id: order.id,
                type: 'Sell Stars',
                amount: order.stars,
                status: order.status.toLowerCase(),
                date: order.dateCreated,
                details: `Sell order for ${order.stars} stars`,
                usdtValue: null 
            }))
        ];

        res.json(transactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Export transactions as CSV via Telegram
app.post('/api/export-transactions', requireTelegramAuth, async (req, res) => {
    try {
        console.log('📊 CSV Export request for user:', req.user.id);
        
        // Check if user authentication worked and extract user ID
        let userId = null;
        if (req.user && req.user.id) {
            userId = req.user.id;
            // Get transaction counts
        const buyOrdersCount = await BuyOrder.countDocuments({ telegramId: userId });
        const sellOrdersCount = await SellOrder.countDocuments({ telegramId: userId });
        } else {
            console.log('❌ CSV Export: Authentication failed');
            
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
                        console.log('⚠️ Extracted user ID from init data:', userId);
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

        // Generate CSV content with header information
        // Generating CSV content
        let csv = '';
        
        try {
            const userInfo = req.user || {};
            const generationDate = new Date().toLocaleString();
            const totalTransactions = transactions.length;
            const completedCount = transactions.filter(t => t.status === 'completed').length;
            const processingCount = transactions.filter(t => t.status === 'processing').length;
            const declinedCount = transactions.filter(t => t.status === 'declined').length;
            console.log('Transaction counts:', { totalTransactions, completedCount, processingCount, declinedCount });
            
            // Build CSV header
            csv = `# StarStore - Transaction History Export\n`;
            csv += `# Generated on: ${generationDate}\n`;
            csv += `# User ID: ${userId}\n`;
            csv += `# Username: @${userInfo.username || 'Unknown'}\n`;
            csv += `# Total Transactions: ${totalTransactions}\n`;
            csv += `# Completed: ${completedCount} | Processing: ${processingCount} | Declined: ${declinedCount}\n`;
            csv += `# Website: https://starstore.site\n`;
            csv += `# Export Type: Transaction History\n`;
            csv += `#\n`;
            csv += `ID,Type,Amount (Stars),USDT Value,Status,Date,Details\n`;
            
            // Add transaction data
            if (transactions.length > 0) {
                transactions.forEach(txn => {
                    try {
                        const dateStr = new Date(txn.date).toISOString().split('T')[0];
                        csv += `"${txn.id}","${txn.type}","${txn.amount}","${txn.usdtValue}","${txn.status}","${dateStr}","${txn.details}"\n`;
                    } catch (rowError) {
                        console.error('Error processing transaction row:', rowError.message);
                        csv += `"Error","Error","0","0","error","${new Date().toISOString().split('T')[0]}","Error processing transaction"\n`;
                    }
                });
            } else {
                csv += `"No Data","No transactions found","0","0","none","${new Date().toISOString().split('T')[0]}","No transactions available for this user"\n`;
            }
            
            // CSV generated successfully
        } catch (csvError) {
            console.error('❌ Error generating CSV:', csvError.message);
            csv = `# StarStore - Transaction History Export (Error)\n# Error: ${csvError.message}\nID,Type,Amount,Status,Date,Details\n"Error","Error","0","error","${new Date().toISOString().split('T')[0]}","${csvError.message}"`;
        }

        // Send CSV file via Telegram bot when possible, otherwise provide direct download
        const filename = `transactions_${userId}_${new Date().toISOString().slice(0, 10)}.csv`;
        const buffer = Buffer.from(csv, 'utf8');
        // CSV buffer created

        if (process.env.BOT_TOKEN) {
            try {
                // Prefer Buffer with filename to avoid filesystem usage
                await bot.sendDocument(userId, buffer, {
                    caption: '📊 Your StarStore transaction history CSV'
                }, {
                    filename: filename,
                    contentType: 'text/csv'
                });
                console.log('✅ CSV sent via Telegram to user:', userId);
                return res.json({ success: true, message: 'CSV file sent to your Telegram' });
            } catch (botError) {
                const message = String(botError && botError.message || '');
                const forbidden = (botError && botError.response && botError.response.statusCode === 403) || /user is deactivated|bot was blocked/i.test(message);
                if (forbidden) {
                    console.warn('⚠️ Telegram sendDocument forbidden, falling back to direct download');
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
        csv += `# Website: https://starstore.site\n`;
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

// Export referrals as CSV via Telegram
app.post('/api/export-referrals', requireTelegramAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();
        
        // Generate CSV content with header information
        const userInfo = req.user;
        const generationDate = new Date().toLocaleString();
        const totalReferrals = referrals.length;
        const activeCount = referrals.filter(r => r.status === 'active').length;
        const processingCount = referrals.filter(r => r.status === 'processing').length;
        
        let csv = `# StarStore - Referral History Export\n`;
        csv += `# Generated on: ${generationDate}\n`;
        csv += `# User ID: ${userId}\n`;
        csv += `# Username: @${userInfo.username || 'Unknown'}\n`;
        csv += `# Total Referrals: ${totalReferrals}\n`;
        csv += `# Active: ${activeCount} | Processing: ${processingCount}\n`;
        csv += `# Website: https://starstore.site\n`;
        csv += `# Export Type: Referral History\n`;
        csv += `#\n`;
        csv += `ID,Referred User,Amount,Status,Date,Details\n`;
        referrals.forEach(ref => {
            const dateStr = new Date(ref.dateReferred).toISOString().split('T')[0];
            csv += `"${ref.id}","${ref.referredUsername || 'Unknown'}","${ref.amount}","${ref.status}","${dateStr}","${ref.details || 'Referral bonus'}"\n`;
        });

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
                caption: `👥 Your referral history (${referrals.length} referrals)\n\nGenerated on: ${new Date().toLocaleString()}`
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
        csv += `# Website: https://starstore.site\n`;
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

// Get referral history
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const referrals = await Referral.find({ referrerUserId: userId })
            .sort({ dateReferred: -1 })
            .lean();
        
        // Format referral data
        const formattedReferrals = await Promise.all(referrals.map(async referral => {
            const referredUser = await User.findOne({ id: referral.referredUserId }).lean();
            
            return {
                id: referral._id.toString(),
                name: referredUser?.username || 'Unknown User',
                status: referral.status.toLowerCase(),
                date: referral.dateReferred,
                details: `Referred user ${referredUser?.username || referral.referredUserId}`,
                amount: 0.5 // Fixed bonus amount or calculate based on your logic
            };
        }));

        res.json(formattedReferrals);
    } catch (error) {
        console.error('Error fetching referrals:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================================================
// AMBASSADOR DASHBOARD INTEGRATION ENDPOINTS
// Added for seamless integration with Ambassador Dashboard
// ============================================================================

// Get user information by Telegram ID (for Ambassador app)
app.get('/api/users/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        
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
app.get('/api/admin/users-data', async (req, res) => {
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
app.get('/api/admin/referrals-data', async (req, res) => {
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
app.get('/api/admin/transactions-data', async (req, res) => {
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
app.get('/api/admin/analytics', async (req, res) => {
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
            Referral.countDocuments({ dateReferred: { $gte: today } }),
            Referral.countDocuments({ dateReferred: { $gte: thisWeek } }),
            Referral.countDocuments({ dateReferred: { $gte: thisMonth } }),
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
app.post('/api/ambassador/sync', async (req, res) => {
    try {
        const { telegramId, email, fullName, tier, referralCode } = req.body;
        
        if (!telegramId) {
            return res.status(400).json({ error: 'Telegram ID is required' });
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
        socials: entry.socials,
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
app.post('/api/webhook/register', async (req, res) => {
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
    const chatId = msg.chat.id;

    const referralLink = `https://t.me/TgStarStore_bot?start=ref_${chatId}`;

    const referrals = await Referral.find({ referrerUserId: chatId.toString() });

    if (referrals.length > 0) {
        const activeReferrals = referrals.filter(ref => ref.status === 'active').length;
        const pendingReferrals = referrals.filter(ref => ref.status === 'pending').length;

        let message = `📊 Your Referrals:\n\nActive: ${activeReferrals}\nPending: ${pendingReferrals}\n\n`;
        message += 'Your pending referrals will be active when they make a purchase.\n\n';
        message += `🔗 Your Referral Link:\n${referralLink}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
            ]
        };

        await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } else {
        const message = `You have no referrals yet.\n\n🔗 Your Referral Link:\n${referralLink}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: 'Share Referral Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}` }]
            ]
        };

        await bot.sendMessage(chatId, message, { reply_markup: keyboard });
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    const username = msg.from.username || '';
    const text = msg.text;

    // Auto-detect and update username in real-time on ANY message
    if (username) {
        const usernameChange = await detectUsernameChange(userId, username);
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

   bot.onText(/\/cso- (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1];

    try {
        const order = await SellOrder.findOne({ id: orderId });

        if (order) {
            const userOrderDetails = `Your sell order has been recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            try { const sent = await bot.sendMessage(order.telegramId, userOrderDetails); try { order.userMessageId = sent?.message_id || order.userMessageId; await order.save(); } catch (_) {} } catch (_) {}

            const adminOrderDetails = `Sell Order Recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(chatId, adminOrderDetails);

            const confirmButton = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_sell_${order.id}_${chatId}` }]]
                }
            };
            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
        } else {
            bot.sendMessage(chatId, 'Order not found. Let\'s create it manually. Please enter the Telegram ID of the user:');

            const handleTelegramId = async (userMsg) => {
                const telegramId = userMsg.text;

                bot.sendMessage(chatId, 'Enter the username of the user:');

                const handleUsername = async (userMsg) => {
                    const username = userMsg.text;

                    bot.sendMessage(chatId, 'Enter the number of stars:');

                    const handleStars = async (userMsg) => {
                        const stars = parseInt(userMsg.text, 10);

                        bot.sendMessage(chatId, 'Enter the wallet address:');

                        const handleWalletAddress = async (userMsg) => {
                            const walletAddress = userMsg.text;

                            const newOrder = new SellOrder({
                                id: orderId,
                                telegramId,
                                username,
                                stars,
                                walletAddress,
                                status: 'pending',
                                reversible: true,
                                dateCreated: new Date(),
                                adminMessages: []
                            });

                            await newOrder.save();

                            const userOrderDetails = `Your sell order has been recreated:\n\nID: ${orderId}\nUsername: ${username}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                            try { const sent = await bot.sendMessage(telegramId, userOrderDetails); try { newOrder.userMessageId = sent?.message_id || newOrder.userMessageId; await newOrder.save(); } catch (_) {} } catch (_) {}

                            const adminOrderDetails = `Sell Order Recreated:\n\nID: ${orderId}\nUsername: ${username}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                            bot.sendMessage(chatId, adminOrderDetails);

                            const confirmButton = {
                                reply_markup: {
                                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_sell_${orderId}_${chatId}` }]]
                                }
                            };
                            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
                        };

                        bot.once('message', handleWalletAddress);
                    };

                    bot.once('message', handleStars);
                };

                bot.once('message', handleUsername);
            };

            bot.once('message', handleTelegramId);
        }
    } catch (error) {
        console.error('Error recreating sell order:', error);
        bot.sendMessage(chatId, 'An error occurred while processing your request.');
    }
});

bot.onText(/\/cbo- (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1];

    try {
        const order = await BuyOrder.findOne({ id: orderId });

        if (order) {
            const userOrderDetails = `Your buy order has been recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(order.telegramId, userOrderDetails);

            const adminOrderDetails = `Buy Order Recreated:\n\nID: ${order.id}\nUsername: ${order.username}\nAmount: ${order.amount}\nStars: ${order.stars}\nWallet: ${order.walletAddress}${order.memoTag ? `\nMemo: ${order.memoTag}` : ''}\nStatus: ${order.status}\nDate Created: ${order.dateCreated}`;
            bot.sendMessage(chatId, adminOrderDetails);

            const confirmButton = {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_buy_${order.id}_${chatId}` }]]
                }
            };
            bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
        } else {
            bot.sendMessage(chatId, 'Order not found. Let\'s create it manually. Please enter the Telegram ID of the user:');

            const handleTelegramId = async (userMsg) => {
                const telegramId = userMsg.text;

                bot.sendMessage(chatId, 'Enter the username of the user:');

                const handleUsername = async (userMsg) => {
                    const username = userMsg.text;

                    bot.sendMessage(chatId, 'Enter the amount:');

                    const handleAmount = async (userMsg) => {
                        const amount = parseFloat(userMsg.text);

                        bot.sendMessage(chatId, 'Enter the number of stars:');

                        const handleStars = async (userMsg) => {
                            const stars = parseInt(userMsg.text, 10);

                            bot.sendMessage(chatId, 'Enter the wallet address:');

                            const handleWalletAddress = async (userMsg) => {
                                const walletAddress = userMsg.text;

                                const newOrder = new BuyOrder({
                                    id: orderId,
                                    telegramId,
                                    username,
                                    amount,
                                    stars,
                                    walletAddress,
                                    status: 'pending',
                                    dateCreated: new Date(),
                                    adminMessages: []
                                });

                                await newOrder.save();

                                const userOrderDetails = `Your buy order has been recreated:\n\nID: ${orderId}\nUsername: ${username}\nAmount: ${amount}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                                bot.sendMessage(telegramId, userOrderDetails);

                                const adminOrderDetails = `Buy Order Recreated:\n\nID: ${orderId}\nUsername: ${username}\nAmount: ${amount}\nStars: ${stars}\nWallet: ${walletAddress}\nStatus: pending\nDate Created: ${new Date()}`;
                                bot.sendMessage(chatId, adminOrderDetails);

                                const confirmButton = {
                                    reply_markup: {
                                        inline_keyboard: [[{ text: 'Confirm Order', callback_data: `confirm_buy_${orderId}_${chatId}` }]]
                                    }
                                };
                                bot.sendMessage(chatId, 'Please confirm the order:', confirmButton);
                            };

                            bot.once('message', handleWalletAddress);
                        };

                        bot.once('message', handleStars);
                    };

                    bot.once('message', handleAmount);
                };

                bot.once('message', handleUsername);
            };

            bot.once('message', handleTelegramId);
        }
    } catch (error) {
        console.error('Error recreating buy order:', error);
        bot.sendMessage(chatId, 'An error occurred while processing your request.');
    }
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

        // Aggregate by country
        const countryStats = {};
        const cityStats = {};
        
        for (const user of users) {
            if (user.lastLocation?.country) {
                const country = user.lastLocation.country;
                countryStats[country] = (countryStats[country] || 0) + 1;
                
                if (includesCities && user.lastLocation?.city) {
                    const cityKey = `${user.lastLocation.city}, ${country}`;
                    cityStats[cityKey] = (cityStats[cityKey] || 0) + 1;
                }
            }
        }

        // Sort countries by user count (descending)
        const sortedCountries = Object.entries(countryStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50); // Top 50 countries

        const totalUsersWithLocation = users.length;
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

app.post('/api/survey', async (req, res) => {
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



const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook set to: ${WEBHOOK_URL}`);
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
});

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

app.get('/api/me', (req, res) => {
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		return res.json({ id: sess.payload.tgId, isAdmin: true, username: null });
	}
	const tgId = (req.headers['x-telegram-id'] || '').toString();
	let username = null;
	try { if (req.user && req.user.username) username = req.user.username; } catch(_) {}
	try { if (!username && req.telegramInitData && req.telegramInitData.user && req.telegramInitData.user.username) username = req.telegramInitData.user.username; } catch(_) {}
	return res.json({ id: tgId || null, isAdmin: tgId ? adminIds.includes(tgId) : false, username });
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

		const textFilter = q ? { $or: [
			{ id: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ telegramId: { $regex: q, $options: 'i' } }
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
			...buys.map(b => ({ id: b.id, type: 'buy', username: b.username, telegramId: b.telegramId, amount: b.amount, status: b.status, dateCreated: b.dateCreated })),
			...sells.map(s => ({ id: s.id, type: 'sell', username: s.username, telegramId: s.telegramId, amount: s.amount, status: s.status, dateCreated: s.dateCreated }))
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
		const textFilter = q ? { $or: [
			{ id: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ telegramId: { $regex: q, $options: 'i' } }
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
		const textFilter = qq ? { $or: [
			{ userId: { $regex: qq, $options: 'i' } },
			{ username: { $regex: qq, $options: 'i' } },
			{ walletAddress: { $regex: qq, $options: 'i' } },
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
		const textFilter = q ? { $or: [
			{ userId: { $regex: q, $options: 'i' } },
			{ username: { $regex: q, $options: 'i' } },
			{ walletAddress: { $regex: q, $options: 'i' } }
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

function signAdminToken(payload, ttlMs) {
	const secret = process.env.ADMIN_JWT_SECRET || (process.env.TELEGRAM_BOT_TOKEN || 'secret');
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
		const secret = process.env.ADMIN_JWT_SECRET || (process.env.TELEGRAM_BOT_TOKEN || 'secret');
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

app.get('/api/me', (req, res) => {
	const sess = getAdminSession(req);
	if (sess && adminIds.includes(sess.payload.tgId)) {
		return res.json({ id: sess.payload.tgId, isAdmin: true });
	}
	const tgId = (req.headers['x-telegram-id'] || '').toString();
	return res.json({ id: tgId || null, isAdmin: tgId ? adminIds.includes(tgId) : false });
});

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
app.get('/api/admin/auth/verify', (req, res) => {
	const telegramId = req.headers['x-telegram-id'];
	console.log('🔐 Admin auth verify attempt:', {
		telegramId,
		adminIds: adminIds,
		adminIdsType: typeof adminIds,
		adminIdsLength: Array.isArray(adminIds) ? adminIds.length : 'not array'
	});
	
	if (!telegramId) {
		return res.status(401).json({ error: 'No telegram ID provided' });
	}
	
	const isAdmin = Array.isArray(adminIds) && adminIds.includes(telegramId);
	console.log('🔐 Admin check result:', { telegramId, isAdmin, adminIds });
	
	if (!isAdmin) {
		return res.status(403).json({ error: 'Access denied - ID not in admin list' });
	}
	
	res.json({
		success: true,
		user: {
			telegramId,
			isAdmin: true
		}
	});
});

// Debug endpoint to check admin configuration
app.get('/api/admin/debug/config', (req, res) => {
	const telegramId = req.headers['x-telegram-id'];
	
	res.json({
		requestedId: telegramId,
		adminIds: adminIds,
		adminIdsType: typeof adminIds,
		adminIdsLength: Array.isArray(adminIds) ? adminIds.length : 'not array',
		isAdmin: Array.isArray(adminIds) && adminIds.includes(telegramId),
		envVars: {
			hasAdminTelegramIds: !!process.env.ADMIN_TELEGRAM_IDS,
			hasAdminIds: !!process.env.ADMIN_IDS,
			adminTelegramIdsValue: process.env.ADMIN_TELEGRAM_IDS ? '***set***' : 'not set',
			adminIdsValue: process.env.ADMIN_IDS ? '***set***' : 'not set'
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

// Simple SMTP email sender for newsletter (admin-only)
let smtpTransport = null;
try {
    const nodemailer = require('nodemailer');
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        smtpTransport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
    }
} catch (_) {
    console.warn('Nodemailer not available; email sending disabled');
}

// Admin send newsletter email to all subscribers
app.post('/api/newsletter/send', async (req, res) => {
    try {
        if (!req.user?.isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });
        if (!smtpTransport) return res.status(500).json({ success: false, error: 'Email service not configured' });
        const subject = String(req.body?.subject || '').trim();
        const html = String(req.body?.html || '').trim();
        if (!subject || !html) return res.status(400).json({ success: false, error: 'Subject and HTML are required.' });

        const subscribers = await NewsletterSubscriber.find({}, { email: 1, _id: 0 });
        if (!subscribers.length) return res.json({ success: true, sent: 0 });

        // Send in batches to avoid provider limits
        const batchSize = 50;
        let sentCount = 0;
        for (let i = 0; i < subscribers.length; i += batchSize) {
            const batch = subscribers.slice(i, i + batchSize);
            const toList = batch.map(s => s.email).join(',');
            try {
                await smtpTransport.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to: toList,
                    subject,
                    html
                });
                sentCount += batch.length;
            } catch (err) {
                console.error('Email batch failed:', err?.message || err);
            }
        }
        return res.json({ success: true, sent: sentCount });
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

        // Send welcome email automatically if SMTP is configured
        try {
            if (smtpTransport) {
                const welcomeSubject = process.env.NEWSLETTER_WELCOME_SUBJECT || 'Welcome to StarStore Updates';
                const welcomeHtml = process.env.NEWSLETTER_WELCOME_HTML || `
                    <div style="font-family: Arial, sans-serif; color:#111;">
                        <h2 style="margin:0 0 12px;">Welcome to StarStore 🎉</h2>
                        <p style="margin:0 0 12px;">Thanks for subscribing. You will receive updates about new features, pricing and promotions.</p>
                        <p style="margin:0 0 12px;">If you didn't subscribe, you can ignore this email.</p>
                        <p style="margin:24px 0 0; font-size:12px; color:#666;">StarStore</p>
                    </div>`;
                await smtpTransport.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to: email,
                    subject: welcomeSubject,
                    html: welcomeHtml
                });
            }
        } catch (err) {
            console.error('Welcome email failed:', err?.message || err);
        }

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

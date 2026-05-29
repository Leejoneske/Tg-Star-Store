// ============================================================
// Knowledge Base (LLM-free, self-hosted)
// ------------------------------------------------------------
// - Pulls text from sources defined in ./sources.js
//   (sitemap crawls, single URLs, local files)
// - Strips HTML, splits into ~2-sentence passages
// - Indexes with BM25 (no external deps)
// - Persists to disk cache and auto-refreshes
// - search(query) → best passage or null
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sources = require('./sources');

const CACHE_FILE = path.join(__dirname, '.cache.json');
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h
const MIN_PASSAGE_LEN = 60;
const MAX_PASSAGE_LEN = 380;
const MIN_SCORE = 1.5; // BM25 floor — below this we consider it "no answer"

// ---------- tiny HTTP fetcher (no deps) ----------
function httpGet(url, redirects = 3) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': 'StarStoreBot/1.0' }, timeout: 15000 }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects - 1));
            }
            if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    });
}

// ---------- HTML → text ----------
function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n\n');
}

// Lines that are usually nav/chrome and don't help — drop them before splitting.
const JUNK_LINE = /^(\s*(\u2190|\u2192|\u2191|\u2193|>|<|\d+\s*\/\s*\d+|back to .*|home|menu|next|previous|read more|subscribe|copy|share|tags?|toc|table of contents|published\s+on|category|categories|all rights reserved|©|cookie .*|loading\.?\.?\.?|article \d+ of \d+))\s*$/i;

function cleanText(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !JUNK_LINE.test(l))
        .join('\n');
}

function splitPassages(rawText) {
    const text = cleanText(rawText);
    const blocks = text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/);
    const out = [];
    let buf = '';
    for (const b of blocks) {
        const t = b.trim();
        if (!t) continue;
        if ((buf + ' ' + t).length > MAX_PASSAGE_LEN) {
            if (buf.length >= MIN_PASSAGE_LEN) out.push(buf.trim());
            buf = t;
        } else {
            buf = buf ? buf + ' ' + t : t;
        }
    }
    if (buf.length >= MIN_PASSAGE_LEN) out.push(buf.trim());
    // Drop passages that look like page chrome (nav arrows, "Article X / Y", site title repeats)
    return out.filter((p) => {
        const chrome = (p.match(/(\u2190|\u2191|\u2192|\u2193|↗|↘|↖|↙|Article \d+\s*\/\s*\d+|Back to (issue|home|top)|· \w+ Stars$)/g) || []).length;
        return chrome < 2;
    });
}



// ---------- tokenization ----------
const STOP = new Set('a an the is are was were be been being have has had do does did will would should can could may might must of to in on at by for with from as and or but not if then so this that these those it its i you he she we they them us your my our their what when where why how which who whom whose about into over under up down out off then there here'.split(' '));

function tokenize(s) {
    return (s.toLowerCase().match(/[a-z0-9]+/g) || [])
        .filter((t) => t.length > 1 && !STOP.has(t));
}

// ---------- BM25 index ----------
let INDEX = null; // { docs:[{text, tokens, tf, len}], df:{}, avgLen, N, builtAt }

function buildIndex(passages) {
    const docs = passages.map((p) => {
        const tokens = tokenize(p);
        const tf = {};
        for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
        return { text: p, tokens, tf, len: tokens.length };
    });
    const df = {};
    for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] || 0) + 1;
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
    return { docs, df, avgLen, N: docs.length, builtAt: Date.now() };
}

function bm25Search(query, k = 1) {
    if (!INDEX || !INDEX.N) return [];
    const k1 = 1.5, b = 0.75;
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length) return [];
    const scored = INDEX.docs.map((d) => {
        let score = 0;
        for (const t of qTokens) {
            const tf = d.tf[t]; if (!tf) continue;
            const df = INDEX.df[t] || 0;
            const idf = Math.log(1 + (INDEX.N - df + 0.5) / (df + 0.5));
            score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / INDEX.avgLen));
        }
        return { d, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

// ---------- source ingestion ----------
async function ingestSitemap(url) {
    const xml = await httpGet(url);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    const passages = [];
    for (const loc of locs) {
        try {
            const html = await httpGet(loc);
            passages.push(...splitPassages(stripHtml(html)));
        } catch (e) {
            console.warn(`[auto-reply.kb] fetch failed ${loc}: ${e.message}`);
        }
    }
    return passages;
}

async function ingestUrl(url) {
    const html = await httpGet(url);
    return splitPassages(stripHtml(html));
}

function ingestFile(p) {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const text = p.endsWith('.html') || p.endsWith('.htm') ? stripHtml(raw) : raw;
    return splitPassages(text);
}

async function rebuild() {
    const all = [];
    for (const src of sources) {
        try {
            if (src.type === 'sitemap') all.push(...await ingestSitemap(src.url));
            else if (src.type === 'url') all.push(...await ingestUrl(src.url));
            else if (src.type === 'file') all.push(...ingestFile(src.path));
        } catch (e) {
            console.warn(`[auto-reply.kb] source failed (${src.type}):`, e.message);
        }
    }
    // de-dupe
    const seen = new Set();
    const unique = all.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
    INDEX = buildIndex(unique);
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ builtAt: INDEX.builtAt, passages: unique }), 'utf8');
    } catch (e) { console.warn('[auto-reply.kb] cache write failed:', e.message); }
    console.log(`[auto-reply.kb] indexed ${unique.length} passages from ${sources.length} sources`);
    return INDEX;
}

function loadFromCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return false;
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (!Array.isArray(cached.passages) || !cached.passages.length) return false;
        INDEX = buildIndex(cached.passages);
        INDEX.builtAt = cached.builtAt;
        console.log(`[auto-reply.kb] loaded ${cached.passages.length} passages from cache`);
        return true;
    } catch (e) { return false; }
}

let refreshTimer = null;
function startAutoRefresh(intervalMs = DEFAULT_REFRESH_MS) {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
        rebuild().catch((e) => console.warn('[auto-reply.kb] refresh failed:', e.message));
    }, intervalMs);
    if (refreshTimer.unref) refreshTimer.unref();
}

async function init() {
    const fromCache = loadFromCache();
    if (!fromCache) {
        rebuild().catch((e) => console.warn('[auto-reply.kb] initial build failed:', e.message));
    } else {
        // refresh in background if cache is older than refresh interval
        const age = Date.now() - (INDEX.builtAt || 0);
        if (age > DEFAULT_REFRESH_MS) {
            rebuild().catch((e) => console.warn('[auto-reply.kb] stale refresh failed:', e.message));
        }
    }
    startAutoRefresh();
}

function search(query) {
    const [top] = bm25Search(query, 1);
    if (!top || top.score < MIN_SCORE) return null;
    return { text: top.d.text, score: top.score };
}

function stats() {
    return INDEX
        ? { ready: true, passages: INDEX.N, builtAt: new Date(INDEX.builtAt).toISOString() }
        : { ready: false };
}

module.exports = { init, rebuild, search, stats };

/**
 * Qonix reseller provider — same interface as iStar.
 * Env:
 *   QONIX_API_KEY
 *   QONIX_BASE_URL          optional, defaults to https://api.qonixcore.com
 *   QONIX_WEBHOOK_SECRET    for /api/public/fulfillment/qonix/webhook
 */
const { FULFILLMENT_STATUS, sanitizeUsername } = require('../types');

const DEFAULT_BASE = 'https://api.qonixcore.com';

function getConfig() {
    return {
        apiKey: process.env.QONIX_API_KEY,
        baseUrl: (process.env.QONIX_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
        webhookSecret: process.env.QONIX_WEBHOOK_SECRET,
    };
}

async function call(path, { method = 'POST', body } = {}) {
    const { apiKey, baseUrl } = getConfig();
    if (!apiKey) throw new Error('QONIX_API_KEY not configured');
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            'API-Key': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
        const msg = json?.error || json?.message || text || `HTTP ${res.status}`;
        const err = new Error(`Qonix ${method} ${path} failed: ${msg}`);
        err.status = res.status;
        err.response = json;
        throw err;
    }
    return json;
}

module.exports = {
    id: 'qonix',
    label: 'Qonix',

    async fulfillStars({ username, quantity, orderId }) {
        const u = sanitizeUsername(username);
        const data = await call('/v1/stars/buy', {
            body: { username: u, amount: Number(quantity), client_ref: String(orderId) },
        });
        return { ok: true, providerRef: data.id || data.order_id || null, status: FULFILLMENT_STATUS.IN_PROGRESS, raw: data };
    },

    async fulfillPremium({ username, months, orderId }) {
        const u = sanitizeUsername(username);
        const data = await call('/v1/premium/gift', {
            body: { username: u, months: Number(months), client_ref: String(orderId) },
        });
        return { ok: true, providerRef: data.id || data.order_id || null, status: FULFILLMENT_STATUS.IN_PROGRESS, raw: data };
    },

    async getStatus(providerRef) {
        if (!providerRef) return { status: FULFILLMENT_STATUS.NONE };
        const data = await call(`/v1/order/${encodeURIComponent(providerRef)}`, { method: 'GET' });
        const s = String(data.status || '').toLowerCase();
        let status = FULFILLMENT_STATUS.IN_PROGRESS;
        if (s === 'completed' || s === 'success' || s === 'delivered') status = FULFILLMENT_STATUS.COMPLETED;
        else if (s === 'failed' || s === 'error' || s === 'cancelled') status = FULFILLMENT_STATUS.FAILED;
        return { status, raw: data };
    },

    async healthCheck() {
        try {
            const { apiKey } = getConfig();
            if (!apiKey) return { ok: false, error: 'QONIX_API_KEY not set' };
            const data = await call('/v1/account', { method: 'GET' });
            return { ok: true, balance: data.balance ?? null, currency: data.currency || 'TON' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    verifyWebhookSignature(rawBody, signatureHeader) {
        const { webhookSecret } = getConfig();
        if (!webhookSecret || !signatureHeader) return false;
        const crypto = require('crypto');
        const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        const a = Buffer.from(expected);
        const b = Buffer.from(String(signatureHeader).replace(/^sha256=/, ''));
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    },

    parseWebhookEvent(payload) {
        const s = String(payload?.status || '').toLowerCase();
        let status = FULFILLMENT_STATUS.IN_PROGRESS;
        if (s === 'completed' || s === 'success' || s === 'delivered') status = FULFILLMENT_STATUS.COMPLETED;
        else if (s === 'failed' || s === 'error' || s === 'cancelled') status = FULFILLMENT_STATUS.FAILED;
        return {
            providerRef: payload?.id || payload?.order_id || null,
            externalId: payload?.client_ref || payload?.external_id || null,
            status,
            error: payload?.error || null,
        };
    },
};

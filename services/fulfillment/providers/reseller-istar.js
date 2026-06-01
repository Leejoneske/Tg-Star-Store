/**
 * iStar / fragmentapi.com reseller provider.
 *
 * Docs: https://istar.fragmentapi.com/docs (subject to change — verify current endpoints).
 * Auth: API key passed as `API-Key` header.
 * Webhook: configure provider dashboard to POST to /api/public/fulfillment/istar/webhook.
 *          Signed with HMAC-SHA256 using ISTAR_WEBHOOK_SECRET.
 *
 * Env (set as Lovable secrets):
 *   ISTAR_API_KEY            required for live calls
 *   ISTAR_BASE_URL           optional, defaults to https://api.fragmentapi.com
 *   ISTAR_WEBHOOK_SECRET     required to verify incoming webhooks
 */
const { FULFILLMENT_STATUS, sanitizeUsername } = require('../types');

const DEFAULT_BASE = 'https://istar.fragmentapi.com';

function getConfig() {
    return {
        apiKey: process.env.ISTAR_API_KEY,
        baseUrl: (process.env.ISTAR_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
        webhookSecret: process.env.ISTAR_WEBHOOK_SECRET,
    };
}

async function call(path, { method = 'POST', body } = {}) {
    const { apiKey, baseUrl } = getConfig();
    if (!apiKey) throw new Error('ISTAR_API_KEY not configured');
    let res;
    try {
        res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                'API-Key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.message || 'unknown';
        throw new Error(`iStar ${method} ${path} network error (${baseUrl}): ${cause}`);
    }
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
        const msg = json?.error || json?.message || text || `HTTP ${res.status}`;
        const err = new Error(`iStar ${method} ${path} failed: ${msg}`);
        err.status = res.status;
        err.response = json;
        throw err;
    }
    return json;
}

function isConfigured() {
    return Boolean(process.env.ISTAR_API_KEY);
}

module.exports = {
    id: 'istar',
    label: 'iStar (fragmentapi.com)',
    isConfigured,


    async fulfillStars({ username, quantity, orderId }) {
        const u = sanitizeUsername(username);
        const data = await call('/v1/order/stars', {
            body: { username: u, quantity: Number(quantity), external_id: String(orderId) },
        });
        return {
            ok: true,
            providerRef: data.id || data.order_id || null,
            status: FULFILLMENT_STATUS.IN_PROGRESS,
            raw: data,
        };
    },

    async fulfillPremium({ username, months, orderId }) {
        const u = sanitizeUsername(username);
        const data = await call('/v1/order/premium', {
            body: { username: u, months: Number(months), external_id: String(orderId) },
        });
        return {
            ok: true,
            providerRef: data.id || data.order_id || null,
            status: FULFILLMENT_STATUS.IN_PROGRESS,
            raw: data,
        };
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
            if (!apiKey) return { ok: false, error: 'ISTAR_API_KEY not set' };
            const data = await call('/v1/account/balance', { method: 'GET' });
            return { ok: true, balance: data.balance ?? null, currency: data.currency || 'TON' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    /**
     * Verify webhook signature. Provider sends X-Signature header containing
     * hex(HMAC_SHA256(secret, rawBody)).
     */
    verifyWebhookSignature(rawBody, signatureHeader) {
        const { webhookSecret } = getConfig();
        if (!webhookSecret) return false;
        if (!signatureHeader) return false;
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
            externalId: payload?.external_id || null,
            status,
            error: payload?.error || null,
        };
    },
};

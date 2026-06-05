/**
 * iStar / fragmentapi.com reseller provider.
 *
 * Docs: https://istar.fragmentapi.com/docs
 * Auth: API key passed as `API-Key` header.
 * Webhook: configure provider dashboard to POST to /api/public/fulfillment/istar/webhook.
 *          Signed with HMAC-SHA256 using ISTAR_WEBHOOK_SECRET (X-iStar-Signature header).
 *          iStar has no order-status polling endpoint — completion arrives via webhook.
 *
 * Env (set as Lovable secrets):
 *   ISTAR_API_KEY            required for live calls
 *   ISTAR_BASE_URL           optional, defaults to https://v1.fragmentapi.com/api/v1/partner
 *   ISTAR_WEBHOOK_SECRET     required to verify incoming webhooks
 */
const { FULFILLMENT_STATUS, sanitizeUsername } = require('../types');

const DEFAULT_BASE = 'https://v1.fragmentapi.com/api/v1/partner';

function mapStatus(raw) {
    const s = String(raw || '').toLowerCase();
    if (s === 'completed' || s === 'success' || s === 'delivered') return FULFILLMENT_STATUS.COMPLETED;
    if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'expired') return FULFILLMENT_STATUS.FAILED;
    return FULFILLMENT_STATUS.IN_PROGRESS;
}

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
        let msg = json?.error || json?.message || null;
        if (!msg) {
            // If HTML response, truncate and indicate it's HTML
            if (text && text.includes('<')) {
                msg = `HTTP ${res.status} (HTML response - likely wrong API key, endpoint, or server error)`;
            } else {
                msg = text || `HTTP ${res.status}`;
            }
        }
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
        const qty = Number(quantity);
        // iStar requires a recipient_hash obtained from the recipient lookup.
        const search = await call(`/star/recipient/search?username=${encodeURIComponent(u)}&quantity=${qty}`, { method: 'GET' });
        if (!search || search.success === false || !search.recipient) {
            throw new Error(`iStar recipient lookup failed for @${u}: ${search?.error || search?.message || 'no recipient hash returned'}`);
        }
        const data = await call('/orders/star', {
            body: { username: u, recipient_hash: search.recipient, quantity: qty, wallet_type: 'TON' },
        });
        return {
            ok: true,
            providerRef: data.order_id || data.id || null,
            status: mapStatus(data.status),
            raw: data,
        };
    },

    async fulfillPremium({ username, months, orderId }) {
        const u = sanitizeUsername(username);
        const m = Number(months);
        const search = await call(`/premium/recipient/search?username=${encodeURIComponent(u)}&months=${m}`, { method: 'GET' });
        if (!search || search.success === false || !search.recipient) {
            throw new Error(`iStar recipient lookup failed for @${u}: ${search?.error || search?.message || 'no recipient hash returned'}`);
        }
        const data = await call('/orders/premium', {
            body: { username: u, recipient_hash: search.recipient, months: m, wallet_type: 'TON' },
        });
        return {
            ok: true,
            providerRef: data.order_id || data.id || null,
            status: mapStatus(data.status),
            raw: data,
        };
    },

    async healthCheck() {
        try {
            const { apiKey } = getConfig();
            if (!apiKey) return { ok: false, error: 'ISTAR_API_KEY not set' };
            const data = await call('/wallet/balance', { method: 'GET' });
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
        // iStar payload shape: { event_type, order: { id, status, payload: {...} }, error }
        const order = payload?.order || {};
        const evt = String(payload?.event_type || '').toLowerCase();
        let status = mapStatus(order.status || payload?.status);
        if (evt === 'order.completed') status = FULFILLMENT_STATUS.COMPLETED;
        else if (evt === 'order.failed') status = FULFILLMENT_STATUS.FAILED;
        return {
            providerRef: order.id || payload?.id || payload?.order_id || null,
            externalId: order?.payload?.external_id || payload?.external_id || null,
            status,
            error: payload?.error || order?.payload?.reason || null,
        };
    },
};

/**
 * Fulfillment service facade.
 *
 * Strategy: pluggable providers (manual, iStar, Qonix, fragment-sdk).
 * Settings stored in Mongo (FulfillmentSettings singleton).
 *
 * Usage from server.js:
 *   const fulfillment = require('./services/fulfillment');
 *   await fulfillment.init({ mongoose, BuyOrder, bot, adminIds });
 *   await fulfillment.tryAutoFulfill(order);
 */

const { PROVIDERS, FULFILLMENT_STATUS, sanitizeUsername } = require('./types');

const manual = require('./providers/manual');
const istar = require('./providers/reseller-istar');
const qonix = require('./providers/reseller-qonix');
const fragmentSdk = require('./providers/fragment-sdk');

const providers = {
    [PROVIDERS.MANUAL]: manual,
    [PROVIDERS.ISTAR]: istar,
    [PROVIDERS.QONIX]: qonix,
    [PROVIDERS.FRAGMENT_SDK]: fragmentSdk,
};

let ctx = null; // { mongoose, BuyOrder, Settings, bot, adminIds, logger }
let retryTimer = null;

const DEFAULT_SETTINGS = {
    autoFulfillEnabled: false,
    starsProvider: PROVIDERS.MANUAL,
    premiumProvider: PROVIDERS.MANUAL,
    fallbackStarsProvider: PROVIDERS.MANUAL,
    fallbackPremiumProvider: PROVIDERS.MANUAL,
    maxAutoAmountUsdt: 100,
    requireOnChainConfirm: true,
    maxAttempts: 3,
};

function getProvider(id) {
    return providers[id] || providers[PROVIDERS.MANUAL];
}

async function getSettings() {
    if (!ctx) throw new Error('fulfillment not initialized');
    let doc = await ctx.Settings.findOne({ _id: 'singleton' });
    if (!doc) {
        doc = await ctx.Settings.create({ _id: 'singleton', ...DEFAULT_SETTINGS });
    }
    // Fill in any missing defaults (schema evolution safety)
    const out = { ...DEFAULT_SETTINGS, ...doc.toObject() };
    return out;
}

async function updateSettings(patch) {
    if (!ctx) throw new Error('fulfillment not initialized');
    const allowed = ['autoFulfillEnabled', 'starsProvider', 'premiumProvider', 'fallbackStarsProvider', 'fallbackPremiumProvider', 'maxAutoAmountUsdt', 'requireOnChainConfirm', 'maxAttempts'];
    const update = {};
    for (const k of allowed) if (k in patch) update[k] = patch[k];
    // Validate provider ids
    for (const k of ['starsProvider', 'premiumProvider', 'fallbackStarsProvider', 'fallbackPremiumProvider']) {
        if (k in update && !providers[update[k]]) {
            throw new Error(`Unknown provider: ${update[k]}`);
        }
    }
    await ctx.Settings.findOneAndUpdate(
        { _id: 'singleton' },
        { $set: update },
        { upsert: true, new: true }
    );
    return getSettings();
}

async function appendLog(orderId, level, message) {
    try {
        await ctx.BuyOrder.findOneAndUpdate(
            { id: orderId },
            { $push: { fulfillmentLog: { ts: new Date(), level, message: String(message).slice(0, 500) } } }
        );
    } catch (err) {
        console.error('[fulfillment] log append failed', err.message);
    }
}

async function notifyAdmins(message) {
    if (!ctx?.bot || !ctx?.adminIds?.length) return;
    for (const adminId of ctx.adminIds) {
        try { await ctx.bot.sendMessage(adminId, message); } catch {}
    }
}

/**
 * Try to auto-fulfill an order. Idempotent.
 * Returns { triggered, providerId, status, error? }.
 */
async function tryAutoFulfill(orderOrId) {
    const settings = await getSettings();
    if (!settings.autoFulfillEnabled) return { triggered: false, reason: 'auto-fulfill disabled' };

    const order = typeof orderOrId === 'string'
        ? await ctx.BuyOrder.findOne({ id: orderOrId })
        : orderOrId;
    if (!order) return { triggered: false, reason: 'order not found' };

    // Skip if already fulfilled or in progress
    if (order.fulfillmentStatus === FULFILLMENT_STATUS.COMPLETED) {
        return { triggered: false, reason: 'already completed' };
    }
    if (order.fulfillmentStatus === FULFILLMENT_STATUS.IN_PROGRESS) {
        return { triggered: false, reason: 'already in progress' };
    }

    // Max-amount guardrail
    if (Number(order.amount) > Number(settings.maxAutoAmountUsdt)) {
        await appendLog(order.id, 'warn', `Amount ${order.amount} exceeds max auto ${settings.maxAutoAmountUsdt}; manual review`);
        return { triggered: false, reason: 'amount exceeds max-auto threshold' };
    }

    // Pick provider per product type
    const primaryId = order.isPremium ? settings.premiumProvider : settings.starsProvider;
    const fallbackId = order.isPremium ? settings.fallbackPremiumProvider : settings.fallbackStarsProvider;
    if (primaryId === PROVIDERS.MANUAL) {
        return { triggered: false, reason: 'provider is manual' };
    }

    // Idempotency guard via atomic transition
    const claimed = await ctx.BuyOrder.findOneAndUpdate(
        {
            id: order.id,
            fulfillmentStatus: { $in: [FULFILLMENT_STATUS.NONE, FULFILLMENT_STATUS.QUEUED, FULFILLMENT_STATUS.FAILED, null, undefined] },
        },
        {
            $set: {
                fulfillmentStatus: FULFILLMENT_STATUS.IN_PROGRESS,
                fulfillmentProvider: primaryId,
            },
            $inc: { fulfillmentAttempts: 1 },
        },
        { new: true }
    );
    if (!claimed) {
        return { triggered: false, reason: 'already claimed by another worker' };
    }

    const username = sanitizeUsername(order.username);

    async function callProvider(providerId) {
        const provider = getProvider(providerId);
        if (order.isPremium) {
            return provider.fulfillPremium({
                username,
                months: Number(order.premiumDurationPerRecipient || order.premiumDuration),
                orderId: order.id,
            });
        }
        return provider.fulfillStars({
            username,
            quantity: Number(order.starsPerRecipient || order.stars),
            orderId: order.id,
        });
    }

    // Try primary, then fallback (if configured and different from primary/manual)
    const tryOrder = [primaryId];
    if (fallbackId && fallbackId !== PROVIDERS.MANUAL && fallbackId !== primaryId) {
        tryOrder.push(fallbackId);
    }

    let lastError = null;
    for (const providerId of tryOrder) {
        await appendLog(order.id, 'info', `Auto-fulfill attempt via ${providerId} (try #${claimed.fulfillmentAttempts})`);
        try {
            const result = await callProvider(providerId);
            await ctx.BuyOrder.findOneAndUpdate(
                { id: order.id },
                {
                    $set: {
                        fulfillmentProvider: providerId,
                        fulfillmentRef: result.providerRef || null,
                        fulfillmentStatus: result.status || FULFILLMENT_STATUS.IN_PROGRESS,
                        fulfillmentError: null,
                    },
                }
            );
            await appendLog(order.id, 'info', `Provider ${providerId} accepted. Ref=${result.providerRef || '-'} status=${result.status}`);
            if (result.status === FULFILLMENT_STATUS.COMPLETED) {
                await markOrderCompleted(order.id, providerId);
            }
            return { triggered: true, providerId, status: result.status, failoverUsed: providerId !== primaryId };
        } catch (err) {
            lastError = err;
            const errMsg = String(err.message || err).slice(0, 500);
            await appendLog(order.id, 'warn', `Provider ${providerId} failed: ${errMsg}`);
        }
    }

    // All providers failed
    const errMsg = String(lastError?.message || lastError || 'unknown').slice(0, 500);
    await ctx.BuyOrder.findOneAndUpdate(
        { id: order.id },
        { $set: { fulfillmentStatus: FULFILLMENT_STATUS.FAILED, fulfillmentError: errMsg } }
    );
    await appendLog(order.id, 'error', `All providers failed. Last error: ${errMsg}`);
    await notifyAdmins(`⚠️ Auto-fulfill failed (primary + fallback)\nOrder #${order.id}\nTried: ${tryOrder.join(', ')}\nError: ${errMsg}\n\nManual action may be needed.`);
    return { triggered: true, providerId: primaryId, status: FULFILLMENT_STATUS.FAILED, error: errMsg };
}

/**
 * Called when a provider webhook confirms completion, or when getStatus polling
 * sees completion. Hands off to server.js's onAutoComplete callback so the
 * existing trackStars / trackPremiumActivation / user notification logic
 * runs unchanged.
 */
async function markOrderCompleted(orderId, providerId) {
    await ctx.BuyOrder.findOneAndUpdate(
        { id: orderId },
        { $set: { fulfillmentStatus: FULFILLMENT_STATUS.COMPLETED } }
    );
    await appendLog(orderId, 'info', `Marked completed via ${providerId}`);
    if (typeof ctx.onAutoComplete === 'function') {
        try { await ctx.onAutoComplete(orderId, providerId); } catch (err) {
            await appendLog(orderId, 'error', `onAutoComplete handler threw: ${err.message}`);
        }
    }
}

/**
 * Webhook entry point. Returns true if the event was accepted.
 */
async function handleWebhook(providerId, rawBody, signatureHeader) {
    const provider = providers[providerId];
    if (!provider || typeof provider.verifyWebhookSignature !== 'function') {
        throw Object.assign(new Error('Unknown provider'), { status: 404 });
    }
    if (!provider.verifyWebhookSignature(rawBody, signatureHeader)) {
        throw Object.assign(new Error('Invalid signature'), { status: 401 });
    }
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }

    const evt = provider.parseWebhookEvent(payload);
    if (!evt.externalId && !evt.providerRef) {
        return { ok: true, ignored: true };
    }

    const query = evt.externalId
        ? { id: evt.externalId }
        : { fulfillmentRef: evt.providerRef };
    const order = await ctx.BuyOrder.findOne(query);
    if (!order) return { ok: true, ignored: true, reason: 'order not found' };

    await appendLog(order.id, 'info', `Webhook ${providerId}: status=${evt.status}`);

    if (evt.status === FULFILLMENT_STATUS.COMPLETED) {
        await markOrderCompleted(order.id, providerId);
    } else if (evt.status === FULFILLMENT_STATUS.FAILED) {
        await ctx.BuyOrder.findOneAndUpdate(
            { id: order.id },
            { $set: { fulfillmentStatus: FULFILLMENT_STATUS.FAILED, fulfillmentError: evt.error || 'provider reported failure' } }
        );
        await notifyAdmins(`⚠️ Provider reported failure\nOrder #${order.id}\nProvider: ${providerId}\nError: ${evt.error || 'unknown'}`);
    }
    return { ok: true };
}

/**
 * Manual retry endpoint helper.
 */
async function retryOrder(orderId) {
    const order = await ctx.BuyOrder.findOne({ id: orderId });
    if (!order) throw new Error('Order not found');
    // Reset status so tryAutoFulfill will claim it
    await ctx.BuyOrder.findOneAndUpdate(
        { id: orderId },
        { $set: { fulfillmentStatus: FULFILLMENT_STATUS.QUEUED, fulfillmentError: null } }
    );
    return tryAutoFulfill(orderId);
}

/**
 * Background poll: re-attempt orders stuck in_progress >10min or queued.
 * Also polls provider getStatus for orders with a ref but not yet completed.
 */
async function runRetryTick() {
    try {
        const settings = await getSettings();
        if (!settings.autoFulfillEnabled) return;
        const cutoff = new Date(Date.now() - 10 * 60 * 1000);
        const stuck = await ctx.BuyOrder.find({
            fulfillmentStatus: FULFILLMENT_STATUS.IN_PROGRESS,
            updatedAt: { $lt: cutoff },
            fulfillmentAttempts: { $lt: settings.maxAttempts },
        }).limit(20);

        for (const order of stuck) {
            if (order.fulfillmentRef && order.fulfillmentProvider) {
                const p = providers[order.fulfillmentProvider];
                if (p?.getStatus) {
                    try {
                        const s = await p.getStatus(order.fulfillmentRef);
                        if (s.status === FULFILLMENT_STATUS.COMPLETED) {
                            await markOrderCompleted(order.id, order.fulfillmentProvider);
                            continue;
                        }
                        if (s.status === FULFILLMENT_STATUS.FAILED) {
                            await ctx.BuyOrder.findOneAndUpdate(
                                { id: order.id },
                                { $set: { fulfillmentStatus: FULFILLMENT_STATUS.FAILED, fulfillmentError: 'poll: provider reported failure' } }
                            );
                            continue;
                        }
                    } catch (err) {
                        await appendLog(order.id, 'warn', `poll failed: ${err.message}`);
                    }
                }
            }
            // No ref yet, or still in progress: re-trigger
            await ctx.BuyOrder.findOneAndUpdate(
                { id: order.id },
                { $set: { fulfillmentStatus: FULFILLMENT_STATUS.QUEUED } }
            );
            await tryAutoFulfill(order.id);
        }
    } catch (err) {
        console.error('[fulfillment] retry tick error', err.message);
    }
}

async function healthAll() {
    const out = {};
    for (const [id, p] of Object.entries(providers)) {
        try { out[id] = await p.healthCheck(); }
        catch (err) { out[id] = { ok: false, error: err.message }; }
    }
    return out;
}

function init(opts) {
    const { mongoose, BuyOrder, bot, adminIds, onAutoComplete } = opts;
    if (!mongoose || !BuyOrder) throw new Error('init requires mongoose + BuyOrder');

    const settingsSchema = new mongoose.Schema({
        _id: { type: String, default: 'singleton' },
        autoFulfillEnabled: { type: Boolean, default: DEFAULT_SETTINGS.autoFulfillEnabled },
        starsProvider: { type: String, default: DEFAULT_SETTINGS.starsProvider },
        premiumProvider: { type: String, default: DEFAULT_SETTINGS.premiumProvider },
        fallbackStarsProvider: { type: String, default: DEFAULT_SETTINGS.fallbackStarsProvider },
        fallbackPremiumProvider: { type: String, default: DEFAULT_SETTINGS.fallbackPremiumProvider },
        maxAutoAmountUsdt: { type: Number, default: DEFAULT_SETTINGS.maxAutoAmountUsdt },
        requireOnChainConfirm: { type: Boolean, default: DEFAULT_SETTINGS.requireOnChainConfirm },
        maxAttempts: { type: Number, default: DEFAULT_SETTINGS.maxAttempts },
    }, { timestamps: true, _id: false });
    const Settings = mongoose.models.FulfillmentSettings || mongoose.model('FulfillmentSettings', settingsSchema);

    ctx = { mongoose, BuyOrder, Settings, bot, adminIds: adminIds || [], onAutoComplete };

    if (retryTimer) clearInterval(retryTimer);
    retryTimer = setInterval(runRetryTick, 60 * 1000);
    retryTimer.unref?.();
    console.log('[fulfillment] initialized');
}

function listProviders() {
    return Object.values(providers).map(p => ({ id: p.id, label: p.label }));
}

module.exports = {
    init,
    PROVIDERS,
    FULFILLMENT_STATUS,
    listProviders,
    getSettings,
    updateSettings,
    tryAutoFulfill,
    retryOrder,
    handleWebhook,
    healthAll,
    runRetryTick,
};

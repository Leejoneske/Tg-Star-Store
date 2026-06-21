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
    // Timestamp auto-fulfill was (most recently) turned on. Orders created
    // before this are NOT auto-fulfilled, so enabling the feature never sweeps
    // up a backlog of pre-existing orders. Reset each time it is re-enabled.
    autoFulfillActivatedAt: null,
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

/**
 * True if an order was created before auto-fulfill was activated and so must
 * not be auto-fulfilled. Orders with an unknown creation time are not blocked.
 */
function predatesActivation(order, settings) {
    if (!settings || !settings.autoFulfillActivatedAt) return false;
    const activated = new Date(settings.autoFulfillActivatedAt).getTime();
    if (!Number.isFinite(activated)) return false;
    const created = order && order.dateCreated ? new Date(order.dateCreated).getTime() : NaN;
    if (!Number.isFinite(created)) return false;
    return created < activated;
}

async function getSettings() {
    if (!ctx) throw new Error('fulfillment not initialized');
    let doc = await ctx.Settings.findOne({ _id: 'singleton' });
    if (!doc) {
        doc = await ctx.Settings.create({ _id: 'singleton', ...DEFAULT_SETTINGS });
    }
    // Fill in any missing defaults (schema evolution safety)
    const out = { ...DEFAULT_SETTINGS, ...doc.toObject() };
    // Backfill an activation time for instances that already had auto-fulfill
    // enabled before this guard existed, so "henceforth" starts from now rather
    // than retroactively sweeping the existing backlog.
    if (out.autoFulfillEnabled && !out.autoFulfillActivatedAt) {
        const now = new Date();
        try {
            await ctx.Settings.findOneAndUpdate(
                { _id: 'singleton', $or: [{ autoFulfillActivatedAt: null }, { autoFulfillActivatedAt: { $exists: false } }] },
                { $set: { autoFulfillActivatedAt: now } }
            );
        } catch (err) {
            console.error('[fulfillment] failed to backfill autoFulfillActivatedAt', err.message);
        }
        out.autoFulfillActivatedAt = now;
    }
    return out;
}

async function updateSettings(patch) {
    if (!ctx) throw new Error('fulfillment not initialized');
    const allowed = ['autoFulfillEnabled', 'autoFulfillActivatedAt', 'starsProvider', 'premiumProvider', 'fallbackStarsProvider', 'fallbackPremiumProvider', 'maxAutoAmountUsdt', 'requireOnChainConfirm', 'maxAttempts'];
    const update = {};
    for (const k of allowed) if (k in patch) update[k] = patch[k];
    // Validate provider ids
    for (const k of ['starsProvider', 'premiumProvider', 'fallbackStarsProvider', 'fallbackPremiumProvider']) {
        if (k in update && !providers[update[k]]) {
            throw new Error(`Unknown provider: ${update[k]}`);
        }
    }
    // Stamp the activation time when auto-fulfill transitions off -> on, so only
    // orders created from this point forward are eligible for auto-fulfillment
    // (unless the caller explicitly set autoFulfillActivatedAt themselves).
    if (update.autoFulfillEnabled === true && !('autoFulfillActivatedAt' in update)) {
        const current = await getSettings();
        if (!current.autoFulfillEnabled) {
            update.autoFulfillActivatedAt = new Date();
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
async function tryAutoFulfill(orderOrId, opts = {}) {
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

    // SECURITY: Never auto-fulfill an order that hasn't been verified on-chain.
    // This is the last line of defense against testnet orders, replay attacks,
    // or orders that slipped through without a confirmed blockchain transaction.
    if (!order.transactionVerified) {
        await appendLog(order.id, 'warn', 'Auto-fulfill blocked: transactionVerified is false. Payment not confirmed on-chain.');
        return { triggered: false, reason: 'payment not verified on-chain' };
    }

    // Activation cutoff: never auto-fulfill orders created before auto-fulfill
    // was turned on (admins can still complete them manually). A manual retry
    // bypasses this via opts.bypassActivationCutoff.
    if (!opts.bypassActivationCutoff && predatesActivation(order, settings)) {
        await appendLog(order.id, 'info', `Skipped auto-fulfill: order created ${order.dateCreated ? new Date(order.dateCreated).toISOString() : 'unknown'} predates auto-fulfill activation ${new Date(settings.autoFulfillActivatedAt).toISOString()}`);
        return { triggered: false, reason: 'order predates auto-fulfill activation' };
    }

    // Max-amount guardrail
    if (Number(order.amount) > Number(settings.maxAutoAmountUsdt)) {
        await appendLog(order.id, 'warn', `Amount ${order.amount} exceeds max auto ${settings.maxAutoAmountUsdt}; manual review`);
        return { triggered: false, reason: 'amount exceeds max-auto threshold' };
    }

    // Stars minimum quantity guardrail (don't auto-fulfill stars below 50)
    if (!order.isPremium) {
        const quantity = Number(order.starsPerRecipient || order.stars);
        if (quantity < 50) {
            await appendLog(order.id, 'warn', `Stars quantity ${quantity} below minimum auto-fulfill threshold (50); manual review`);
            return { triggered: false, reason: 'stars quantity below minimum (50)' };
        }
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

    // Build the list of fulfillment targets.
    // For "buy for others" orders each recipient gets their own delivery.
    // For self-purchase orders the single target is the buyer's own username.
    let targets; // Array of { username, quantity (stars) | months (premium) }
    if (order.isBuyForOthers && Array.isArray(order.recipients) && order.recipients.length > 0) {
        if (order.isPremium) {
            targets = order.recipients.map(r => ({
                username: r.username,
                months: Number(order.premiumDurationPerRecipient || order.premiumDuration),
            }));
        } else {
            targets = order.recipients.map(r => ({
                username: r.username,
                quantity: Number(r.starsReceived || order.starsPerRecipient),
            }));
        }
    } else {
        // Self-purchase — single target is the buyer
        const buyerUsername = sanitizeUsername(order.username);
        if (order.isPremium) {
            targets = [{ username: buyerUsername, months: Number(order.premiumDurationPerRecipient || order.premiumDuration) }];
        } else {
            targets = [{ username: buyerUsername, quantity: Number(order.starsPerRecipient || order.stars) }];
        }
    }

    async function callProviderForTarget(providerId, target) {
        const provider = getProvider(providerId);
        const username = sanitizeUsername(target.username);
        if (order.isPremium) {
            return provider.fulfillPremium({ username, months: target.months, orderId: order.id });
        }
        return provider.fulfillStars({ username, quantity: target.quantity, orderId: order.id });
    }

    // Try primary, then fallback (if configured and different from primary/manual)
    const candidates = [primaryId];
    if (fallbackId && fallbackId !== PROVIDERS.MANUAL && fallbackId !== primaryId) {
        candidates.push(fallbackId);
    }
    // Skip any provider missing its env-var configuration so we don't waste an attempt
    const tryOrder = [];
    for (const pid of candidates) {
        const p = getProvider(pid);
        if (typeof p.isConfigured === 'function' && !p.isConfigured()) {
            await appendLog(order.id, 'warn', `Skipping ${pid}: missing API key / secrets in environment`);
            continue;
        }
        tryOrder.push(pid);
    }
    if (tryOrder.length === 0) {
        // Revert the in_progress claim so the order stays awaiting manual review
        // (we don't mark it failed — admin may still fulfill it manually or fix env vars and retry).
        await ctx.BuyOrder.findOneAndUpdate(
            { id: order.id },
            {
                $set: { fulfillmentStatus: FULFILLMENT_STATUS.QUEUED, fulfillmentError: null },
                $inc: { fulfillmentAttempts: -1 },
            }
        );
        await appendLog(order.id, 'warn', `No configured providers for ${primaryId}${fallbackId ? ' / ' + fallbackId : ''}. Left pending for manual review.`);
        await notifyAdmins(`⚠️ Auto-fulfill could not run\nOrder #${order.id}\nReason: provider not configured (missing API key / low balance / network)\nSelected: ${primaryId}${fallbackId ? ' / fallback ' + fallbackId : ''}\nOrder left pending — fulfill manually or set env vars on host and retry.`);
        return { triggered: false, reason: 'no configured providers (missing env vars)' };
    }

    // Fulfill each target (recipient) in sequence.
    // We track per-recipient results so partial failures surface clearly.
    const recipientResults = []; // { username, ok, providerRef, status, error }
    let usedProviderId = primaryId;

    for (const target of targets) {
        let targetSuccess = false;
        let lastTargetError = null;

        for (const providerId of tryOrder) {
            await appendLog(order.id, 'info', `Fulfilling @${target.username} via ${providerId} (try #${claimed.fulfillmentAttempts})`);
            try {
                const result = await callProviderForTarget(providerId, target);
                usedProviderId = providerId;
                await appendLog(order.id, 'info', `@${target.username}: provider ${providerId} accepted. Ref=${result.providerRef || '-'} status=${result.status}`);
                recipientResults.push({ username: target.username, ok: true, providerRef: result.providerRef || null, status: result.status });
                targetSuccess = true;
                break;
            } catch (err) {
                lastTargetError = err;
                const errMsg = String(err.message || err).slice(0, 500);
                await appendLog(order.id, 'warn', `@${target.username}: provider ${providerId} failed: ${errMsg}`);
            }
        }

        if (!targetSuccess) {
            recipientResults.push({ username: target.username, ok: false, error: String(lastTargetError?.message || lastTargetError || 'unknown').slice(0, 300) });
        }
    }

    // Assess overall outcome
    const allSucceeded = recipientResults.every(r => r.ok);
    const anySucceeded = recipientResults.some(r => r.ok);
    const failedRecipients = recipientResults.filter(r => !r.ok);
    const succeededRecipients = recipientResults.filter(r => r.ok);

    // fulfillmentRef = first provider ref (kept simple for webhook lookup backward-compat).
    // Per-recipient refs are stored on the recipients array entries themselves.
    const primaryRef = recipientResults.find(r => r.providerRef)?.providerRef || null;

    // Stamp each recipient entry in the order with its individual providerRef so
    // the webhook can find the order even when multiple recipients were fulfilled.
    if (order.isBuyForOthers && Array.isArray(order.recipients) && order.recipients.length > 0) {
        const refMap = new Map(recipientResults.map(r => [r.username, r.providerRef || null]));
        await ctx.BuyOrder.findOneAndUpdate(
            { id: order.id },
            {
                $set: Object.fromEntries(
                    order.recipients.map((r, i) => [`recipients.${i}.providerRef`, refMap.get(r.username) || null])
                ),
            }
        );
    }

    if (allSucceeded) {
        const allCompleted = recipientResults.every(r => r.status === FULFILLMENT_STATUS.COMPLETED);
        await ctx.BuyOrder.findOneAndUpdate(
            { id: order.id },
            {
                $set: {
                    fulfillmentProvider: usedProviderId,
                    fulfillmentRef: primaryRef,
                    fulfillmentStatus: allCompleted ? FULFILLMENT_STATUS.COMPLETED : FULFILLMENT_STATUS.IN_PROGRESS,
                    fulfillmentError: null,
                },
            }
        );
        if (allCompleted) {
            await markOrderCompleted(order.id, usedProviderId);
        }
        return { triggered: true, providerId: usedProviderId, status: allCompleted ? FULFILLMENT_STATUS.COMPLETED : FULFILLMENT_STATUS.IN_PROGRESS, failoverUsed: usedProviderId !== primaryId };
    }

    if (anySucceeded) {
        // Partial failure — some recipients delivered, some not
        const errSummary = failedRecipients.map(r => `@${r.username}: ${r.error}`).join('; ');
        const okSummary = succeededRecipients.map(r => `@${r.username}`).join(', ');
        await ctx.BuyOrder.findOneAndUpdate(
            { id: order.id },
            {
                $set: {
                    fulfillmentProvider: usedProviderId,
                    fulfillmentRef: combinedRef,
                    fulfillmentStatus: FULFILLMENT_STATUS.FAILED,
                    fulfillmentError: `Partial: delivered to ${okSummary}. Failed: ${errSummary}`,
                },
            }
        );
        await appendLog(order.id, 'error', `Partial fulfillment: ${succeededRecipients.length}/${targets.length} delivered. Failed: ${errSummary}`);
        await notifyAdmins(`⚠️ Partial auto-fulfill failure\nOrder #${order.id}\nDelivered to: ${okSummary}\nFailed:\n${failedRecipients.map(r => `  @${r.username}: ${r.error}`).join('\n')}\n\nManual action needed for failed recipients.`);
        return { triggered: true, providerId: usedProviderId, status: FULFILLMENT_STATUS.FAILED, partialFailure: true, failedRecipients };
    }

    // All recipients failed
    const errMsg = failedRecipients.map(r => `@${r.username}: ${r.error}`).join('; ').slice(0, 500);
    await ctx.BuyOrder.findOneAndUpdate(
        { id: order.id },
        { $set: { fulfillmentStatus: FULFILLMENT_STATUS.FAILED, fulfillmentError: errMsg } }
    );
    await appendLog(order.id, 'error', `All providers failed for all recipients. ${errMsg}`);
    await notifyAdmins(`⚠️ Auto-fulfill failed (primary + fallback)\nOrder #${order.id}\nTried: ${tryOrder.join(', ')}\nRecipients: ${targets.map(t => `@${t.username}`).join(', ')}\nError: ${errMsg}\n\nManual action may be needed.`);
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

    let order = null;
    if (evt.externalId) {
        order = await ctx.BuyOrder.findOne({ id: evt.externalId });
    } else if (evt.providerRef) {
        // Primary lookup: direct fulfillmentRef match (single recipient or self-purchase)
        order = await ctx.BuyOrder.findOne({ fulfillmentRef: evt.providerRef });
        // Fallback: search inside per-recipient providerRef entries (multi-recipient orders)
        if (!order) {
            order = await ctx.BuyOrder.findOne({ 'recipients.providerRef': evt.providerRef });
        }
    }
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
    // Manual retry is an explicit admin action, so it is allowed to fulfill
    // orders that predate auto-fulfill activation.
    return tryAutoFulfill(orderId, { bypassActivationCutoff: true });
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
            if (order.fulfillmentProvider) {
                const p = providers[order.fulfillmentProvider];
                if (p?.getStatus) {
                    // For multi-recipient orders poll each recipient ref individually.
                    // For self-purchase poll the single fulfillmentRef.
                    const refsToCheck = (order.isBuyForOthers && Array.isArray(order.recipients) && order.recipients.length > 0)
                        ? order.recipients.filter(r => r.providerRef).map(r => r.providerRef)
                        : (order.fulfillmentRef ? [order.fulfillmentRef] : []);

                    if (refsToCheck.length > 0) {
                        try {
                            const statuses = await Promise.all(
                                refsToCheck.map(ref => p.getStatus(ref).catch(() => ({ status: FULFILLMENT_STATUS.IN_PROGRESS })))
                            );
                            const allDone  = statuses.every(s => s.status === FULFILLMENT_STATUS.COMPLETED);
                            const anyFailed = statuses.some(s => s.status === FULFILLMENT_STATUS.FAILED);
                            if (allDone) {
                                await markOrderCompleted(order.id, order.fulfillmentProvider);
                                continue;
                            }
                            if (anyFailed) {
                                await ctx.BuyOrder.findOneAndUpdate(
                                    { id: order.id },
                                    { $set: { fulfillmentStatus: FULFILLMENT_STATUS.FAILED, fulfillmentError: 'poll: provider reported failure' } }
                                );
                                continue;
                            }
                        } catch (err) {
                            await appendLog(order.id, 'warn', `poll failed: ${err.message}`);
                        }
                        // Still in_progress — keep waiting, do NOT re-submit
                        continue;
                    } else {
                        // Provider has no refs yet but has getStatus — awaiting webhook
                        await appendLog(order.id, 'info', 'Has provider but no refs yet; awaiting webhook (not re-submitting).');
                        continue;
                    }
                } else {
                    // Provider has no status-poll endpoint (e.g. iStar): completion arrives via webhook.
                    // Do NOT re-submit — that would double-fulfill.
                    await appendLog(order.id, 'info', 'Has provider ref but no status poll; awaiting webhook (not re-submitting).');
                    continue;
                }
            }
            // No provider claimed yet — re-trigger
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
        try {
            if (typeof p.isConfigured === 'function' && !p.isConfigured()) {
                out[id] = { ok: false, configured: false, error: 'Not configured (missing env vars on host)' };
                continue;
            }
            out[id] = { ok: true, configured: true, ...(await p.healthCheck()) };
        } catch (err) { out[id] = { ok: false, configured: true, error: err.message }; }
    }
    return out;
}


function init(opts) {
    const { mongoose, BuyOrder, bot, adminIds, onAutoComplete } = opts;
    if (!mongoose || !BuyOrder) throw new Error('init requires mongoose + BuyOrder');

    const settingsSchema = new mongoose.Schema({
        _id: { type: String, default: 'singleton' },
        autoFulfillEnabled: { type: Boolean, default: DEFAULT_SETTINGS.autoFulfillEnabled },
        autoFulfillActivatedAt: { type: Date, default: DEFAULT_SETTINGS.autoFulfillActivatedAt },
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
    predatesActivation,
};

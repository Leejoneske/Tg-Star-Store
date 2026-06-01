/**
 * Shared types/constants for the fulfillment subsystem.
 */
const PROVIDERS = Object.freeze({
    MANUAL: 'manual',
    ISTAR: 'istar',
    QONIX: 'qonix',
    FRAGMENT_SDK: 'fragment-sdk',
});

const FULFILLMENT_STATUS = Object.freeze({
    NONE: 'none',
    QUEUED: 'queued',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    FAILED: 'failed',
});

/**
 * Normalize a Telegram username. Strips leading @, lowercases.
 * Throws if invalid.
 */
function sanitizeUsername(raw) {
    if (!raw || typeof raw !== 'string') throw new Error('Username required');
    const u = raw.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(u)) throw new Error('Invalid Telegram username');
    return u;
}

module.exports = { PROVIDERS, FULFILLMENT_STATUS, sanitizeUsername };

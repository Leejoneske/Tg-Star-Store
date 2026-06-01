/**
 * Self-hosted Fragment provider (Phase 3, scaffold only).
 *
 * Wraps the `fragment-tg` npm package. Requires:
 *   TON_SEED_PHRASE           24-word TON wallet seed (HIGH RISK — store in secrets)
 *   FRAGMENT_STEL_SSID        Fragment session cookie
 *   FRAGMENT_STEL_DT          Fragment session cookie
 *   FRAGMENT_STEL_TOKEN       Fragment session cookie
 *   FRAGMENT_STEL_TON_TOKEN   Fragment session cookie
 *   TONAPI_KEY                tonconsole.com API key
 *
 * The package is NOT installed by default — this stub returns a clear
 * "not configured" error until an operator enables it.
 */
const { FULFILLMENT_STATUS } = require('../types');

function isConfigured() {
    return Boolean(
        process.env.TON_SEED_PHRASE &&
        process.env.FRAGMENT_STEL_SSID &&
        process.env.FRAGMENT_STEL_DT &&
        process.env.FRAGMENT_STEL_TOKEN &&
        process.env.FRAGMENT_STEL_TON_TOKEN &&
        process.env.TONAPI_KEY
    );
}

function notReady() {
    throw new Error('fragment-sdk provider not configured. Install `fragment-tg`, set TON_SEED_PHRASE and FRAGMENT_STEL_* secrets, then enable.');
}

module.exports = {
    id: 'fragment-sdk',
    label: 'Self-hosted (fragment-tg)',

    async fulfillStars() { notReady(); },
    async fulfillPremium() { notReady(); },
    async getStatus() { return { status: FULFILLMENT_STATUS.NONE }; },
    async healthCheck() {
        return isConfigured()
            ? { ok: false, error: 'fragment-tg package not yet wired (Phase 3)' }
            : { ok: false, error: 'Not configured: missing TON_SEED_PHRASE / FRAGMENT_STEL_* / TONAPI_KEY' };
    },
};

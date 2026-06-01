/**
 * Manual provider — no-op. Used when auto-fulfillment is disabled
 * or as a fallback when an auto provider is misconfigured.
 * The admin still completes orders via the existing /admin/orders/:id/complete flow.
 */
const { FULFILLMENT_STATUS } = require('../types');

module.exports = {
    id: 'manual',
    label: 'Manual (admin review)',
    isConfigured: () => true,


    async fulfillStars({ orderId }) {
        return { ok: true, providerRef: null, status: FULFILLMENT_STATUS.NONE, message: 'Manual: awaiting admin' };
    },
    async fulfillPremium({ orderId }) {
        return { ok: true, providerRef: null, status: FULFILLMENT_STATUS.NONE, message: 'Manual: awaiting admin' };
    },
    async getStatus() {
        return { status: FULFILLMENT_STATUS.NONE };
    },
    async healthCheck() {
        return { ok: true, balance: null, info: 'Manual provider is always available' };
    },
};

'use strict';

// Verifies the iStar provider hits the documented endpoints
// (https://istar.fragmentapi.com/docs) with the required fields, so the
// "404 page not found" from POST /order/stars cannot recur.

const istar = require('../../services/fulfillment/providers/reseller-istar');
const { FULFILLMENT_STATUS } = require('../../services/fulfillment/types');

const realFetch = global.fetch;
const ORIG_KEY = process.env.ISTAR_API_KEY;

function mockSequence(handlers) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url, opts });
        const handler = handlers.shift();
        if (!handler) throw new Error(`Unexpected fetch to ${url}`);
        const { status = 200, body } = handler(url, opts);
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
    };
    return calls;
}

beforeEach(() => { process.env.ISTAR_API_KEY = 'test-key'; });
afterEach(() => { global.fetch = realFetch; if (ORIG_KEY === undefined) delete process.env.ISTAR_API_KEY; else process.env.ISTAR_API_KEY = ORIG_KEY; });

describe('iStar fulfillStars', () => {
    test('looks up recipient then POSTs to /orders/star with recipient_hash + wallet_type', async () => {
        const calls = mockSequence([
            () => ({ body: { success: true, recipient: 'HASH123', name: 'John' } }),
            () => ({ body: { order_id: 'ord-1', status: 'pending', quantity: 100 } }),
        ]);

        const res = await istar.fulfillStars({ username: '@johndoe', quantity: 100, orderId: 'BUY1' });

        // 1) recipient search endpoint + params
        expect(calls[0].url).toContain('/star/recipient/search?username=johndoe&quantity=100');
        expect((calls[0].opts.method || 'GET')).toBe('GET');

        // 2) order endpoint is the documented /orders/star (NOT /order/stars)
        expect(calls[1].url).toContain('/orders/star');
        expect(calls[1].url).not.toContain('/order/stars');
        const sentBody = JSON.parse(calls[1].opts.body);
        expect(sentBody).toMatchObject({ username: 'johndoe', recipient_hash: 'HASH123', quantity: 100, wallet_type: 'TON' });

        // 3) response mapped: order_id -> providerRef, pending -> IN_PROGRESS
        expect(res.providerRef).toBe('ord-1');
        expect(res.status).toBe(FULFILLMENT_STATUS.IN_PROGRESS);
    });

    test('throws a clear error when recipient lookup fails (no silent bad order)', async () => {
        mockSequence([
            () => ({ body: { success: false, error: 'user not found' } }),
        ]);
        await expect(istar.fulfillStars({ username: 'ghost', quantity: 100, orderId: 'BUY2' }))
            .rejects.toThrow(/recipient lookup failed/i);
    });
});

describe('iStar fulfillPremium', () => {
    test('POSTs to /orders/premium with recipient_hash, months and wallet_type', async () => {
        const calls = mockSequence([
            () => ({ body: { success: true, recipient: 'PHASH' } }),
            () => ({ body: { order_id: 'ord-2', status: 'pending', months: 3 } }),
        ]);
        const res = await istar.fulfillPremium({ username: 'johndoe', months: 3, orderId: 'BUY3' });
        expect(calls[0].url).toContain('/premium/recipient/search?username=johndoe&months=3');
        expect(calls[1].url).toContain('/orders/premium');
        const sentBody = JSON.parse(calls[1].opts.body);
        expect(sentBody).toMatchObject({ username: 'johndoe', recipient_hash: 'PHASH', months: 3, wallet_type: 'TON' });
        expect(res.providerRef).toBe('ord-2');
    });
});

describe('iStar parseWebhookEvent', () => {
    test('maps order.completed payload shape to COMPLETED with provider ref', () => {
        const evt = istar.parseWebhookEvent({
            event_type: 'order.completed',
            order: { id: 'ord-1', status: 'completed', order_type: 'star' },
            tx_hash: 'abc',
        });
        expect(evt.status).toBe(FULFILLMENT_STATUS.COMPLETED);
        expect(evt.providerRef).toBe('ord-1');
    });

    test('maps order.failed payload shape to FAILED with reason', () => {
        const evt = istar.parseWebhookEvent({
            event_type: 'order.failed',
            order: { id: 'ord-9', status: 'failed', payload: { reason: 'Fragment transaction expired' } },
            error: 'Fragment transaction expired',
        });
        expect(evt.status).toBe(FULFILLMENT_STATUS.FAILED);
        expect(evt.providerRef).toBe('ord-9');
        expect(evt.error).toMatch(/expired/i);
    });
});

describe('iStar provider surface', () => {
    test('does not expose a getStatus poll method (iStar has no status endpoint)', () => {
        expect(istar.getStatus).toBeUndefined();
    });
});

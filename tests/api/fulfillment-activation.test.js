'use strict';

const fulfillment = require('../../services/fulfillment');

describe('fulfillment: predatesActivation (pure)', () => {
    const activatedAt = new Date('2026-01-01T00:00:00Z');

    test('no cutoff configured -> never blocks', () => {
        expect(fulfillment.predatesActivation({ dateCreated: new Date('2020-01-01') }, {})).toBe(false);
        expect(fulfillment.predatesActivation({ dateCreated: new Date('2020-01-01') }, { autoFulfillActivatedAt: null })).toBe(false);
    });

    test('order created before activation is blocked', () => {
        expect(fulfillment.predatesActivation(
            { dateCreated: new Date('2025-12-31T23:59:59Z') },
            { autoFulfillActivatedAt: activatedAt }
        )).toBe(true);
    });

    test('order created at/after activation is allowed', () => {
        expect(fulfillment.predatesActivation(
            { dateCreated: activatedAt },
            { autoFulfillActivatedAt: activatedAt }
        )).toBe(false);
        expect(fulfillment.predatesActivation(
            { dateCreated: new Date('2026-02-01T00:00:00Z') },
            { autoFulfillActivatedAt: activatedAt }
        )).toBe(false);
    });

    test('unknown order creation time is not blocked', () => {
        expect(fulfillment.predatesActivation({}, { autoFulfillActivatedAt: activatedAt })).toBe(false);
        expect(fulfillment.predatesActivation({ dateCreated: 'not-a-date' }, { autoFulfillActivatedAt: activatedAt })).toBe(false);
    });
});

// In-memory stand-ins for the Mongo models the service expects via ctx.
function makeMocks(initialSettings) {
    let settingsDoc = initialSettings ? { _id: 'singleton', ...initialSettings } : null;
    const orders = new Map();

    const Settings = {
        async findOne() {
            return settingsDoc ? { toObject: () => ({ ...settingsDoc }) } : null;
        },
        async create(doc) {
            settingsDoc = { ...doc };
            return { toObject: () => ({ ...settingsDoc }) };
        },
        async findOneAndUpdate(query, update) {
            const set = update.$set || {};
            settingsDoc = { ...(settingsDoc || { _id: 'singleton' }), ...set };
            return { toObject: () => ({ ...settingsDoc }) };
        },
    };

    const BuyOrder = {
        async findOne(query) {
            return orders.get(query.id) || null;
        },
        async findOneAndUpdate(query, update) {
            const o = orders.get(query.id);
            if (!o) return null;
            const set = update.$set || {};
            Object.assign(o, set);
            const inc = update.$inc || {};
            for (const k of Object.keys(inc)) o[k] = (o[k] || 0) + inc[k];
            if (update.$push) {
                for (const k of Object.keys(update.$push)) {
                    o[k] = o[k] || [];
                    o[k].push(update.$push[k]);
                }
            }
            return o;
        },
        addOrder(o) { orders.set(o.id, o); },
    };

    // Minimal mongoose stub: init() only needs Schema + model.
    const mongoose = {
        models: {},
        Schema: function () {},
        model() { return Settings; },
    };

    return { mongoose, BuyOrder, Settings, orders };
}

describe('fulfillment: activation cutoff end-to-end (mocked ctx)', () => {
    test('enabling auto-fulfill stamps activation time; old orders are skipped, new ones proceed', async () => {
        const { mongoose, BuyOrder } = makeMocks({ autoFulfillEnabled: false });
        fulfillment.init({ mongoose, BuyOrder, bot: null, adminIds: [] });

        // Turn it on -> activation time should be stamped.
        const after = await fulfillment.updateSettings({ autoFulfillEnabled: true, starsProvider: 'manual' });
        expect(after.autoFulfillEnabled).toBe(true);
        expect(after.autoFulfillActivatedAt).toBeTruthy();
        const activatedMs = new Date(after.autoFulfillActivatedAt).getTime();

        // Old order (created before activation) must NOT be auto-fulfilled.
        BuyOrder.addOrder({
            id: 'OLD-1',
            dateCreated: new Date(activatedMs - 60 * 60 * 1000),
            amount: 10,
            isPremium: false,
            stars: 100,
            fulfillmentStatus: 'none',
        });
        const oldRes = await fulfillment.tryAutoFulfill('OLD-1');
        expect(oldRes.triggered).toBe(false);
        expect(oldRes.reason).toMatch(/predates auto-fulfill activation/);

        // New order (created after activation) is not blocked by the cutoff;
        // it stops only at the manual-provider guard (provider is 'manual').
        BuyOrder.addOrder({
            id: 'NEW-1',
            dateCreated: new Date(activatedMs + 60 * 1000),
            amount: 10,
            isPremium: false,
            stars: 100,
            fulfillmentStatus: 'none',
        });
        const newRes = await fulfillment.tryAutoFulfill('NEW-1');
        expect(newRes.reason).not.toMatch(/predates auto-fulfill activation/);
    });

    test('backfills activation time when already enabled without a timestamp', async () => {
        const { mongoose, BuyOrder } = makeMocks({ autoFulfillEnabled: true });
        fulfillment.init({ mongoose, BuyOrder, bot: null, adminIds: [] });

        const settings = await fulfillment.getSettings();
        expect(settings.autoFulfillEnabled).toBe(true);
        expect(settings.autoFulfillActivatedAt).toBeTruthy();
    });

    test('manual retry bypasses the activation cutoff', async () => {
        const { mongoose, BuyOrder } = makeMocks({
            autoFulfillEnabled: true,
            autoFulfillActivatedAt: new Date(),
        });
        fulfillment.init({ mongoose, BuyOrder, bot: null, adminIds: [] });

        BuyOrder.addOrder({
            id: 'OLD-RETRY',
            dateCreated: new Date(Date.now() - 24 * 60 * 60 * 1000),
            amount: 10,
            isPremium: false,
            stars: 100,
            fulfillmentStatus: 'failed',
        });
        const res = await fulfillment.retryOrder('OLD-RETRY');
        // Bypasses cutoff, so it is NOT skipped for predating activation.
        expect(res.reason).not.toMatch(/predates auto-fulfill activation/);
    });
});

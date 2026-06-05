'use strict';

const pv = require('../../services/payment-verification');

const STORE = 'EQAstoreWalletAddressForTests000000000000000000000001';

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
    return async () => ({ ok, status, json: async () => payload });
}

function throwingFetch(message = 'network down') {
    return async () => { throw new Error(message); };
}

describe('payment-verification: expected-amount math', () => {
    test('computeExpectedNanoTon converts USDT to nanoTON via rate', () => {
        // 17.9 USDT at 2.10 USDT/TON ≈ 8.523809e9 nanoTON
        expect(pv.computeExpectedNanoTon(17.9, 2.10)).toBe(Math.round((17.9 / 2.10) * 1e9));
        expect(pv.computeExpectedNanoTon(2.10, 2.10)).toBe(1e9);
    });

    test('computeExpectedNanoTon rejects bad input', () => {
        expect(pv.computeExpectedNanoTon(0, 2.10)).toBeNull();
        expect(pv.computeExpectedNanoTon(17.9, 0)).toBeNull();
        expect(pv.computeExpectedNanoTon(-1, 2.10)).toBeNull();
        expect(pv.computeExpectedNanoTon('x', 2.10)).toBeNull();
    });

    test('computeExpectedUsdtUnits uses 6 decimals', () => {
        expect(pv.computeExpectedUsdtUnits(17.9)).toBe(17900000);
        expect(pv.computeExpectedUsdtUnits(0)).toBeNull();
    });
});

describe('payment-verification: tolerance', () => {
    test('accepts exact and small fee shortfall, rejects large under/over', () => {
        const exp = 1_000_000_000; // 1 TON in nanoTON
        expect(pv.amountWithinTolerance(exp, exp)).toBe(true);
        expect(pv.amountWithinTolerance(exp * 0.98, exp)).toBe(true);  // within 3%
        expect(pv.amountWithinTolerance(exp * 0.90, exp)).toBe(false); // too low
        expect(pv.amountWithinTolerance(exp * 2.5, exp)).toBe(false);  // absurdly high
        expect(pv.amountWithinTolerance(5, 0)).toBe(false);            // no expected
    });
});

describe('payment-verification: address normalization', () => {
    test('raw addresses compare case-insensitively', () => {
        const a = '0:ABCDEF0000000000000000000000000000000000000000000000000000000001';
        const b = '0:abcdef0000000000000000000000000000000000000000000000000000000001';
        expect(pv.sameAddress(a, b)).toBe(true);
        expect(pv.sameAddress(a, '0:ffff')).toBe(false);
        expect(pv.sameAddress(null, b)).toBe(false);
    });
});

describe('verifyTonPayment', () => {
    const expectedNanoTon = pv.computeExpectedNanoTon(17.9, 2.10); // ≈ 8.523e9

    test('verifies a matching native TON transfer', async () => {
        const utime = Math.floor(Date.now() / 1000);
        const payload = { result: [
            { utime, lt: '5', hash: 'H5', in_msg: { value: String(expectedNanoTon) } }
        ] };
        const res = await pv.verifyTonPayment({
            storeAddress: STORE, expectedNanoTon, fetch: fakeFetch(payload)
        });
        expect(res.verified).toBe(true);
        expect(res.txKey).toBe('5:H5');
    });

    test('does NOT treat the USDT figure as TON (regression for the unit bug)', async () => {
        // The old code compared 17.9 USDT as 17.9 TON. A transfer of 17.9 TON
        // must NOT satisfy an order that truly expects ~8.52 TON.
        const utime = Math.floor(Date.now() / 1000);
        const payload = { result: [
            { utime, lt: '9', hash: 'H9', in_msg: { value: String(Math.round(17.9 * 1e9)) } }
        ] };
        const res = await pv.verifyTonPayment({
            storeAddress: STORE, expectedNanoTon, fetch: fakeFetch(payload)
        });
        expect(res.verified).toBe(false);
    });

    test('rejects an underpaid transfer', async () => {
        const utime = Math.floor(Date.now() / 1000);
        const payload = { result: [
            { utime, lt: '1', hash: 'H1', in_msg: { value: String(Math.floor(expectedNanoTon * 0.5)) } }
        ] };
        const res = await pv.verifyTonPayment({ storeAddress: STORE, expectedNanoTon, fetch: fakeFetch(payload) });
        expect(res.verified).toBe(false);
        expect(res.reason).toMatch(/no matching/i);
    });

    test('ignores transfers older than sinceUtime', async () => {
        const now = Math.floor(Date.now() / 1000);
        const payload = { result: [
            { utime: now - 5000, lt: '2', hash: 'H2', in_msg: { value: String(expectedNanoTon) } }
        ] };
        const res = await pv.verifyTonPayment({
            storeAddress: STORE, expectedNanoTon, sinceUtime: now - 900, fetch: fakeFetch(payload)
        });
        expect(res.verified).toBe(false);
    });

    test('skips a transfer already used by another order', async () => {
        const utime = Math.floor(Date.now() / 1000);
        const payload = { result: [
            { utime, lt: '7', hash: 'H7', in_msg: { value: String(expectedNanoTon) } }
        ] };
        const res = await pv.verifyTonPayment({
            storeAddress: STORE, expectedNanoTon,
            isTxUsed: async (k) => k === '7:H7',
            fetch: fakeFetch(payload)
        });
        expect(res.verified).toBe(false);
    });

    test('returns unverified (not an error) when the explorer is down', async () => {
        const res = await pv.verifyTonPayment({ storeAddress: STORE, expectedNanoTon, fetch: throwingFetch() });
        expect(res.verified).toBe(false);
        expect(res.reason).toMatch(/toncenter error/i);
    });

    test('requires a store address and an expected amount', async () => {
        expect((await pv.verifyTonPayment({ expectedNanoTon, fetch: fakeFetch({}) })).verified).toBe(false);
        expect((await pv.verifyTonPayment({ storeAddress: STORE, expectedNanoTon: 0, fetch: fakeFetch({}) })).verified).toBe(false);
    });
});

describe('verifyUsdtPayment', () => {
    const expectedUsdtUnits = pv.computeExpectedUsdtUnits(17.9); // 17_900_000

    function op(over = {}) {
        return Object.assign({
            operation: 'transfer',
            utime: Math.floor(Date.now() / 1000),
            lt: '10',
            transaction_hash: 'JH',
            jetton: { address: pv.USDT_JETTON_MASTER },
            destination: { address: STORE },
            amount: String(expectedUsdtUnits)
        }, over);
    }

    test('verifies a matching incoming USDT transfer', async () => {
        const res = await pv.verifyUsdtPayment({
            storeAddress: STORE, expectedUsdtUnits, fetch: fakeFetch({ operations: [op()] })
        });
        expect(res.verified).toBe(true);
        expect(res.txKey).toBe('10:JH');
    });

    test('rejects a transfer of a different jetton', async () => {
        const res = await pv.verifyUsdtPayment({
            storeAddress: STORE, expectedUsdtUnits,
            fetch: fakeFetch({ operations: [op({ jetton: { address: '0:deadbeef' } })] })
        });
        expect(res.verified).toBe(false);
    });

    test('rejects an outgoing transfer (store not the destination)', async () => {
        const res = await pv.verifyUsdtPayment({
            storeAddress: STORE, expectedUsdtUnits,
            fetch: fakeFetch({ operations: [op({ destination: { address: '0:someoneelse' } })] })
        });
        expect(res.verified).toBe(false);
    });

    test('rejects an underpaid USDT transfer', async () => {
        const res = await pv.verifyUsdtPayment({
            storeAddress: STORE, expectedUsdtUnits,
            fetch: fakeFetch({ operations: [op({ amount: String(Math.floor(expectedUsdtUnits * 0.5)) })] })
        });
        expect(res.verified).toBe(false);
    });
});

describe('verifyOrderPayment routing', () => {
    test('routes USDT orders to the jetton verifier using frozen units', async () => {
        const order = {
            paymentCurrency: 'USDT',
            amount: 17.9,
            expectedPaymentUsdtUnits: String(pv.computeExpectedUsdtUnits(17.9)),
            dateCreated: new Date()
        };
        const payload = { operations: [{
            operation: 'transfer', utime: Math.floor(Date.now() / 1000), lt: '3', transaction_hash: 'X',
            jetton: { address: pv.USDT_JETTON_MASTER }, destination: { address: STORE },
            amount: order.expectedPaymentUsdtUnits
        }] };
        const res = await pv.verifyOrderPayment(order, { storeAddress: STORE, fetch: fakeFetch(payload) });
        expect(res.verified).toBe(true);
    });

    test('routes TON orders to the native verifier using frozen nanoTON', async () => {
        const expectedNanoTon = pv.computeExpectedNanoTon(17.9, 2.10);
        const order = {
            paymentCurrency: 'TON',
            amount: 17.9,
            expectedPaymentNanoTon: String(expectedNanoTon),
            dateCreated: new Date()
        };
        const payload = { result: [
            { utime: Math.floor(Date.now() / 1000), lt: '4', hash: 'Y', in_msg: { value: String(expectedNanoTon) } }
        ] };
        const res = await pv.verifyOrderPayment(order, { storeAddress: STORE, fetch: fakeFetch(payload) });
        expect(res.verified).toBe(true);
    });
});

'use strict';

/**
 * Currency-aware on-chain payment verification for buy orders.
 *
 * Buy orders are priced in USDT (`order.amount`) but paid on-chain either as
 * native TON or as a USDT-TON jetton transfer. The expected on-chain amount is
 * frozen at order-creation time so that a later change in the TON/USDT rate
 * cannot reject a legitimate payment:
 *   - TON  : expectedPaymentNanoTon  = round(amountUsdt / rate * 1e9)
 *   - USDT : expectedPaymentUsdtUnits = round(amountUsdt * 1e6)
 *
 * Verification compares the same units (nanoTON vs nanoTON, USDT units vs USDT
 * units) against transactions credited to the store wallet. There is NO
 * format-only fallback: if the chain cannot be queried or no matching transfer
 * is found, the payment stays unverified so the order is retried / reviewed
 * manually rather than auto-fulfilled.
 */

let nodeFetch;
try { nodeFetch = require('node-fetch'); } catch (_) { nodeFetch = null; }

const DEFAULT_TON_USDT_RATE = 2.10;
// USDT-TON jetton master (mainnet).
const USDT_JETTON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
// USDT-TON uses 6 decimals; native TON uses 9.
const USDT_DECIMALS = 1e6;
const NANO = 1e9;

function getFetch(injected) {
    const f = injected || nodeFetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('No fetch implementation available');
    return f;
}

function computeExpectedNanoTon(amountUsdt, rate) {
    const a = Number(amountUsdt);
    const r = Number(rate);
    if (!(a > 0) || !(r > 0)) return null;
    return Math.round((a / r) * NANO);
}

function computeExpectedUsdtUnits(amountUsdt) {
    const a = Number(amountUsdt);
    if (!(a > 0)) return null;
    return Math.round(a * USDT_DECIMALS);
}

/**
 * Amount is acceptable if it is at least `expected` minus a small fee tolerance
 * and not absurdly higher (guards against matching an unrelated large payment).
 */
function amountWithinTolerance(received, expected, { lowerPct = 0.03, upperFactor = 2 } = {}) {
    const r = Number(received);
    const e = Number(expected);
    if (!(e > 0) || !(r >= 0)) return false;
    return r >= e * (1 - lowerPct) && r <= e * upperFactor;
}

/**
 * Best-effort normalization of a TON address to raw `wc:hex` (lowercase) so that
 * friendly (EQ.../UQ...) and raw forms compare equal. Falls back to a lowercased
 * string when decoding is not possible.
 */
function normalizeTonAddress(addr) {
    if (!addr || typeof addr !== 'string') return null;
    const a = addr.trim();
    if (a.includes(':')) return a.toLowerCase();
    try {
        const b64 = a.replace(/-/g, '+').replace(/_/g, '/');
        const buf = Buffer.from(b64, 'base64');
        // 1 tag + 1 workchain + 32 hash + 2 crc = 36 bytes
        if (buf.length < 34) return a.toLowerCase();
        const wc = buf[1] === 0xff ? -1 : buf[1];
        const hash = buf.slice(2, 34).toString('hex');
        return `${wc}:${hash}`;
    } catch (_) {
        return a.toLowerCase();
    }
}

function sameAddress(a, b) {
    const na = normalizeTonAddress(a);
    const nb = normalizeTonAddress(b);
    return !!na && !!nb && na === nb;
}

async function getTonUsdtRate(deps = {}) {
    try {
        const fetchFn = getFetch(deps.fetch);
        const res = await fetchFn(
            'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
            { timeout: 3000 }
        );
        if (res && res.ok) {
            const data = await res.json();
            const rate = Number(data && data['the-open-network'] && data['the-open-network'].usd);
            if (rate > 0) return rate;
        }
    } catch (_) { /* fall through to default */ }
    return DEFAULT_TON_USDT_RATE;
}

/**
 * Verify a native TON payment credited to the store wallet.
 * Returns { verified, reason?, txKey?, receivedNanoTon?, utime? }.
 */
async function verifyTonPayment(opts = {}) {
    const { storeAddress, expectedNanoTon, sinceUtime, apiKey, isTxUsed } = opts;
    if (!storeAddress) return { verified: false, reason: 'store address not configured' };
    const expected = Number(expectedNanoTon);
    if (!(expected > 0)) return { verified: false, reason: 'no expected on-chain amount' };

    let data;
    try {
        const fetchFn = getFetch(opts.fetch);
        const url = `https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(storeAddress)}&limit=50${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
        const res = await fetchFn(url, { headers: { Accept: 'application/json' }, timeout: 15000 });
        if (!res || !res.ok) return { verified: false, reason: `toncenter HTTP ${res ? res.status : 'no response'}` };
        data = await res.json();
    } catch (e) {
        return { verified: false, reason: `toncenter error: ${e.message}` };
    }

    const txs = Array.isArray(data && data.result) ? data.result : [];
    for (const tx of txs) {
        const utime = Number(tx.utime || 0);
        if (sinceUtime && utime < sinceUtime) continue;
        const inMsg = tx.in_msg;
        if (!inMsg || inMsg.value == null) continue;
        // A native TON transfer has no jetton body; jetton transfers carry a body
        // and (typically) zero TON value. Require a real TON value here.
        const received = Number(inMsg.value);
        if (!(received > 0)) continue;
        if (!amountWithinTolerance(received, expected)) continue;
        const txKey = `${(tx.transaction_id && tx.transaction_id.lt) || tx.lt || ''}:${(tx.transaction_id && tx.transaction_id.hash) || tx.hash || ''}`;
        if (isTxUsed && await isTxUsed(txKey)) continue;
        return { verified: true, txKey, receivedNanoTon: received, utime };
    }
    return { verified: false, reason: 'no matching TON transfer found' };
}

/**
 * Verify a USDT-TON jetton transfer credited to the store wallet using the
 * tonapi jetton-history endpoint.
 * Returns { verified, reason?, txKey?, receivedUnits?, utime? }.
 */
async function verifyUsdtPayment(opts = {}) {
    const { storeAddress, expectedUsdtUnits, sinceUtime, isTxUsed } = opts;
    if (!storeAddress) return { verified: false, reason: 'store address not configured' };
    const expected = Number(expectedUsdtUnits);
    if (!(expected > 0)) return { verified: false, reason: 'no expected on-chain amount' };

    let data;
    try {
        const fetchFn = getFetch(opts.fetch);
        const url = `https://tonapi.io/v2/accounts/${encodeURIComponent(storeAddress)}/jettons/history?limit=50`;
        const res = await fetchFn(url, { headers: { Accept: 'application/json' }, timeout: 15000 });
        if (!res || !res.ok) return { verified: false, reason: `tonapi HTTP ${res ? res.status : 'no response'}` };
        data = await res.json();
    } catch (e) {
        return { verified: false, reason: `tonapi error: ${e.message}` };
    }

    const ops = Array.isArray(data && data.operations) ? data.operations : [];
    for (const op of ops) {
        if (op.operation !== 'transfer') continue;
        const utime = Number(op.utime || 0);
        if (sinceUtime && utime < sinceUtime) continue;
        if (!sameAddress(op.jetton && op.jetton.address, USDT_JETTON_MASTER)) continue;
        // Incoming transfer: store wallet must be the destination.
        if (!sameAddress(op.destination && op.destination.address, storeAddress)) continue;
        const received = Number(op.amount);
        if (!amountWithinTolerance(received, expected, { lowerPct: 0.01 })) continue;
        const txKey = `${op.lt || ''}:${op.transaction_hash || ''}`;
        if (isTxUsed && await isTxUsed(txKey)) continue;
        return { verified: true, txKey, receivedUnits: received, utime };
    }
    return { verified: false, reason: 'no matching USDT transfer found' };
}

/**
 * Verify the payment for a buy order. Picks the TON or USDT path based on
 * `order.paymentCurrency` and uses the expected on-chain amount frozen on the
 * order (falling back to a recomputation if it is missing on legacy orders).
 */
async function verifyOrderPayment(order, deps = {}) {
    if (!order) return { verified: false, reason: 'no order' };
    const storeAddress = deps.storeAddress || process.env.WALLET_ADDRESS;
    const isTxUsed = deps.isTxUsed;
    const fetchFn = deps.fetch;

    // Only consider transfers at/after the order was created (minus a small
    // skew) so an unrelated/older payment cannot be matched to this order.
    let sinceUtime;
    if (order.dateCreated) {
        const created = new Date(order.dateCreated).getTime();
        if (Number.isFinite(created)) sinceUtime = Math.floor(created / 1000) - 900;
    }

    const currency = order.paymentCurrency === 'USDT' ? 'USDT' : 'TON';
    if (currency === 'USDT') {
        let expectedUsdtUnits = order.expectedPaymentUsdtUnits != null ? Number(order.expectedPaymentUsdtUnits) : null;
        if (!(expectedUsdtUnits > 0)) expectedUsdtUnits = computeExpectedUsdtUnits(order.amount);
        return verifyUsdtPayment({ storeAddress, expectedUsdtUnits, sinceUtime, isTxUsed, fetch: fetchFn });
    }

    let expectedNanoTon = order.expectedPaymentNanoTon != null ? Number(order.expectedPaymentNanoTon) : null;
    if (!(expectedNanoTon > 0)) {
        const rate = Number(order.paymentRateSnapshot) > 0 ? Number(order.paymentRateSnapshot) : await getTonUsdtRate({ fetch: fetchFn });
        expectedNanoTon = computeExpectedNanoTon(order.amount, rate);
    }
    return verifyTonPayment({
        storeAddress,
        expectedNanoTon,
        sinceUtime,
        apiKey: process.env.TON_API_KEY || process.env.TONCENTER_API_KEY,
        isTxUsed,
        fetch: fetchFn
    });
}

module.exports = {
    DEFAULT_TON_USDT_RATE,
    USDT_JETTON_MASTER,
    computeExpectedNanoTon,
    computeExpectedUsdtUnits,
    amountWithinTolerance,
    normalizeTonAddress,
    sameAddress,
    getTonUsdtRate,
    verifyTonPayment,
    verifyUsdtPayment,
    verifyOrderPayment
};

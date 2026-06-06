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
    console.debug(`[TON Verify] Found ${txs.length} transactions, looking for TON transfers to ${storeAddress}, expected: ${expected} nanoTON`);
    
    for (const tx of txs) {
        const utime = Number(tx.utime || 0);
        if (sinceUtime && utime < sinceUtime) {
            console.debug(`[TON Verify] Skipped: utime ${utime} is before sinceUtime ${sinceUtime}`);
            continue;
        }
        
        const inMsg = tx.in_msg;
        if (!inMsg || inMsg.value == null) {
            console.debug(`[TON Verify] Skipped: no in_msg or value`);
            continue;
        }
        
        // A native TON transfer has no jetton body; jetton transfers carry a body
        // and (typically) zero TON value. Require a real TON value here.
        const received = Number(inMsg.value);
        if (!(received > 0)) {
            console.debug(`[TON Verify] Skipped: no positive value (received=${received})`);
            continue;
        }
        
        if (!amountWithinTolerance(received, expected)) {
            console.debug(`[TON Verify] Skipped: amount ${received} outside tolerance (expected ${expected}, range: ${expected * 0.97}-${expected * 2})`);
            continue;
        }
        
        const txKey = `${(tx.transaction_id && tx.transaction_id.lt) || tx.lt || ''}:${(tx.transaction_id && tx.transaction_id.hash) || tx.hash || ''}`;
        if (isTxUsed && await isTxUsed(txKey)) {
            console.debug(`[TON Verify] Skipped: transaction ${txKey} already used`);
            continue;
        }
        
        console.debug(`[TON Verify] Match found: received=${received}, txKey=${txKey}, utime=${utime}`);
        return { verified: true, txKey, receivedNanoTon: received, utime };
    }
    
    console.debug(`[TON Verify] No matching TON transfer found for store ${storeAddress}`);
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
    console.debug(`[USDT Verify] Found ${ops.length} operations, looking for USDT transfers to ${storeAddress}, expected: ${expected} units (${(expected / 1e6).toFixed(2)} USDT)`);
    
    // Track mismatches for better error reporting
    let closestMismatch = null;
    let closestMismatchDistance = Infinity;
    
    for (const op of ops) {
        console.debug(`[USDT Verify] Checking operation: type=${op.operation}, lt=${op.lt}, amount=${op.amount}`);
        
        if (op.operation !== 'transfer') {
            console.debug(`[USDT Verify] Skipped: operation type is '${op.operation}', not 'transfer'`);
            continue;
        }
        
        const utime = Number(op.utime || 0);
        if (sinceUtime && utime < sinceUtime) {
            console.debug(`[USDT Verify] Skipped: utime ${utime} is before sinceUtime ${sinceUtime}`);
            continue;
        }
        
        const jettonAddr = op.jetton && op.jetton.address;
        const destAddr = op.destination && op.destination.address;
        console.debug(`[USDT Verify] Jetton address: ${jettonAddr}, Expected: ${USDT_JETTON_MASTER}, Destination: ${destAddr}`);
        
        if (!sameAddress(jettonAddr, USDT_JETTON_MASTER)) {
            console.debug(`[USDT Verify] Skipped: jetton address mismatch`);
            continue;
        }
        
        // Incoming transfer: store wallet must be the destination.
        if (!sameAddress(destAddr, storeAddress)) {
            console.debug(`[USDT Verify] Skipped: destination ${destAddr} does not match store ${storeAddress}`);
            continue;
        }
        
        const received = Number(op.amount);
        const receivedUsdt = received / 1e6;
        const expectedUsdt = expected / 1e6;
        const pctDiff = Math.abs(received - expected) / expected * 100;
        
        if (!amountWithinTolerance(received, expected, { lowerPct: 0.01 })) {
            console.warn(`[USDT Verify] Amount mismatch: received ${received} units (${receivedUsdt.toFixed(2)} USDT, ${pctDiff.toFixed(1)}% off) vs expected ${expected} units (${expectedUsdt.toFixed(2)} USDT)`);
            // Track the closest mismatch for error reporting
            const distance = Math.abs(received - expected);
            if (distance < closestMismatchDistance) {
                closestMismatchDistance = distance;
                closestMismatch = { received, receivedUsdt, expectedUsdt, pctDiff };
            }
            continue;
        }
        
        const txKey = `${op.lt || ''}:${op.transaction_hash || ''}`;
        if (isTxUsed && await isTxUsed(txKey)) {
            console.debug(`[USDT Verify] Skipped: transaction ${txKey} already used`);
            continue;
        }
        
        console.debug(`[USDT Verify] Match found: received=${received}, txKey=${txKey}, utime=${utime}`);
        return { verified: true, txKey, receivedUnits: received, utime };
    }
    
    // Provide detailed error if we found a close mismatch
    if (closestMismatch) {
        const msg = `Found USDT transfer of ${closestMismatch.receivedUsdt.toFixed(2)} USDT (expected ${closestMismatch.expectedUsdt.toFixed(2)} USDT, ${closestMismatch.pctDiff.toFixed(1)}% off). Please send the exact amount.`;
        console.warn(`[USDT Verify] ${msg}`);
        return { verified: false, reason: msg };
    }
    
    console.warn(`[USDT Verify] No matching USDT transfer found for store ${storeAddress}. Expected: ${expected} units (${(expected / 1e6).toFixed(2)} USDT)`);
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

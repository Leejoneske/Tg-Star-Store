/**
 * Celo Transaction Service — verifies MiniPay stablecoin payments.
 *
 * MiniPay is a non-custodial wallet on the Celo network (EVM, chain id 42220).
 * Payments arrive as an ERC-20 `transfer(address,uint256)` call on one of the
 * supported stablecoins (cUSD, USDC, USDT — all pegged 1:1 to USD, so no
 * exchange-rate snapshot is needed, unlike TON).
 *
 * Verification works the same way as the TON/USDT path: given a transaction
 * hash the client reports, fetch the on-chain receipt directly from a public
 * Celo RPC endpoint (no SDK, just JSON-RPC over HTTP via axios) and confirm:
 *   - the transaction actually succeeded,
 *   - it emitted an ERC-20 Transfer log from the expected token contract,
 *   - the transfer's recipient is our store wallet,
 *   - the amount is within tolerance of what the order expects.
 * The frontend-reported hash is never trusted on its own — only the decoded
 * on-chain log is.
 */

const axios = require('axios');

const CELO_CHAIN_ID = 42220;
const CELO_RPC_URL = process.env.CELO_RPC_URL || 'https://forno.celo.org';

// Mainnet stablecoin contracts MiniPay supports, and their decimals.
const CELO_TOKENS = Object.freeze({
    cUSD: { address: '0x765de816845861e75a25fca122bb6898b8b1282a', decimals: 18 },
    USDC: { address: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6 },
    USDT: { address: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', decimals: 6 },
});

// keccak256("Transfer(address,address,uint256)") — standard ERC-20 event topic.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function computeExpectedCeloUnits(amountUsd, decimals) {
    const a = Number(amountUsd);
    if (!(a > 0) || !decimals) return null;
    // String-based scaling avoids float drift for the (rare) 18-decimal cUSD case.
    return BigInt(Math.round(a * 1e6)) * (10n ** BigInt(decimals - 6));
}

/**
 * Amount is acceptable if it's at least `expected` minus a small tolerance
 * and not absurdly higher (guards against matching an unrelated large payment).
 */
function amountWithinTolerance(received, expected, { lowerPct = 0.01, upperFactor = 2 } = {}) {
    if (!(expected > 0n) || received < 0n) return false;
    const lowerBound = expected - (expected * BigInt(Math.round(lowerPct * 10000))) / 10000n;
    const upperBound = expected * BigInt(upperFactor);
    return received >= lowerBound && received <= upperBound;
}

function addressFromTopic(topic) {
    if (!topic || topic.length < 42) return null;
    return `0x${topic.slice(-40)}`.toLowerCase();
}

function sameAddress(a, b) {
    return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

async function rpcCall(method, params) {
    const res = await axios.post(CELO_RPC_URL, {
        jsonrpc: '2.0',
        id: 1,
        method,
        params
    }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
    if (res.data && res.data.error) {
        throw new Error(res.data.error.message || 'RPC error');
    }
    return res.data ? res.data.result : null;
}

/**
 * Verify a MiniPay stablecoin transfer credited to the store wallet.
 * opts: { txHash, tokenSymbol ('cUSD'|'USDC'|'USDT'), storeAddress, expectedUnits (string|bigint), isTxUsed }
 * Returns { verified, reason?, txKey?, receivedUnits? } — same shape used by
 * the TON/USDT verifiers so `payment-verification.js` can treat all three
 * currencies uniformly.
 */
async function verifyMiniPayPayment(opts = {}) {
    const { txHash, tokenSymbol, storeAddress, expectedUnits, isTxUsed } = opts;

    if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return { verified: false, reason: 'no transaction hash provided' };
    }
    if (!storeAddress) return { verified: false, reason: 'store Celo wallet not configured' };
    const token = CELO_TOKENS[tokenSymbol];
    if (!token) return { verified: false, reason: `unsupported token: ${tokenSymbol}` };

    const expected = typeof expectedUnits === 'bigint' ? expectedUnits : BigInt(expectedUnits || 0);
    if (!(expected > 0n)) return { verified: false, reason: 'no expected on-chain amount' };

    let receipt;
    try {
        receipt = await rpcCall('eth_getTransactionReceipt', [txHash]);
    } catch (e) {
        return { verified: false, reason: `celo RPC error: ${e.message}` };
    }
    if (!receipt) return { verified: false, reason: 'transaction not found yet (may still be pending)' };
    if (receipt.status !== '0x1') return { verified: false, reason: 'transaction failed on-chain' };

    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    let closestMismatch = null;
    let closestMismatchDistance = null;

    for (const log of logs) {
        if (!sameAddress(log.address, token.address)) continue;
        if (!Array.isArray(log.topics) || log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;

        const to = addressFromTopic(log.topics[2]);
        if (!sameAddress(to, storeAddress)) continue;

        let received;
        try {
            received = BigInt(log.data);
        } catch (_) {
            continue;
        }

        if (!amountWithinTolerance(received, expected)) {
            const distance = received > expected ? received - expected : expected - received;
            if (closestMismatchDistance === null || distance < closestMismatchDistance) {
                closestMismatchDistance = distance;
                closestMismatch = received;
            }
            continue;
        }

        const txKey = `celo:${txHash.toLowerCase()}`;
        if (isTxUsed && await isTxUsed(txKey)) continue;

        return { verified: true, txKey, receivedUnits: received.toString() };
    }

    if (closestMismatch !== null) {
        const divisor = 10 ** token.decimals;
        return {
            verified: false,
            reason: `Found a ${tokenSymbol} transfer of ${(Number(closestMismatch) / divisor).toFixed(2)} ` +
                `(expected ${(Number(expected) / divisor).toFixed(2)}). Please send the exact amount.`
        };
    }

    return { verified: false, reason: `no matching ${tokenSymbol} transfer found to the store wallet` };
}

module.exports = {
    CELO_CHAIN_ID,
    CELO_RPC_URL,
    CELO_TOKENS,
    computeExpectedCeloUnits,
    amountWithinTolerance,
    sameAddress,
    verifyMiniPayPayment,
};

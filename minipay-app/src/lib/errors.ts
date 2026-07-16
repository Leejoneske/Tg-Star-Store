// Wallet providers (including MiniPay's injected window.ethereum) often
// reject with a plain {code, message} object, NOT a real Error instance —
// checking `e instanceof Error` alone silently swallows the real reason.
function rawErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const obj = e as { message?: unknown; code?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    if ('code' in obj) return `${fallback} (code ${obj.code}).`;
  }
  return fallback;
}

// Wallet/RPC errors come back as raw blockchain jargon — "execution
// reverted: ERC20: transfer amount exceeds balance" isn't something most
// people can act on. Translate the common cases to plain English; anything
// unrecognized falls through to the raw message rather than being hidden.
const FRIENDLY_PATTERNS: Array<[RegExp, string]> = [
  [/transfer amount exceeds balance/i, "You don't have enough in your wallet to cover this payment."],
  [/insufficient funds for gas|insufficient funds/i, "You don't have enough in your wallet to cover this payment and its network fee."],
  [/gas required exceeds allowance/i, "Your wallet doesn't have enough to cover the network fee."],
  [/user rejected|user denied/i, 'Payment cancelled.'],
  [/network ?error|failed to fetch/i, 'Connection problem — check your internet and try again.'],
  [/nonce too low|already known/i, 'That payment was already submitted — check your order status before retrying.'],
  [/timeout|timed out/i, 'That took too long to respond. Please try again.'],
];

export function extractErrorMessage(e: unknown, fallback: string): string {
  const raw = rawErrorMessage(e, fallback);
  for (const [pattern, friendly] of FRIENDLY_PATTERNS) {
    if (pattern.test(raw)) return friendly;
  }
  // Raw hex/JSON-RPC blobs are never useful to a buyer — collapse anything
  // that looks like one down to the generic fallback instead of showing it.
  if (/0x[0-9a-f]{8,}|"jsonrpc"|execution reverted/i.test(raw)) {
    return fallback;
  }
  return raw;
}

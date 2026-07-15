// Wallet providers (including MiniPay's injected window.ethereum) often
// reject with a plain {code, message} object, NOT a real Error instance —
// checking `e instanceof Error` alone silently swallows the real reason.
export function extractErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null) {
    const obj = e as { message?: unknown; code?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    if ('code' in obj) return `${fallback} (code ${obj.code}).`;
  }
  return fallback;
}

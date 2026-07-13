// Mirrors MINIPAY_PRICE_MAP in server.js — used only for instant UI feedback.
// The server always recomputes and is the source of truth at order-creation time.
export const STAR_PACKAGES = [15, 25, 50, 100, 500, 1000] as const;
export const PREMIUM_DURATIONS = [3, 6, 12] as const;

export const STAR_PRICES: Record<number, number> = {
  15: 0.29,
  25: 0.45,
  50: 0.9,
  100: 1.79,
  500: 8.95,
  1000: 17.9,
};

export const PREMIUM_PRICES: Record<number, number> = {
  3: 12.99,
  6: 16.99,
  12: 29.99,
};

// Manual/custom star entry floor — below the smallest preset package, this
// is enforced client-side purely for a sane UX; the server independently
// enforces its own floor of 15.
export const MIN_CUSTOM_STARS = 50;
export const MAX_CUSTOM_STARS = 100000;

// Same fallback formula as the miss-case in MINIPAY_PRICE_MAP.regular inside
// server.js: known packages use their fixed price, any other amount (e.g. a
// manually-entered custom amount) is priced at a flat per-star rate.
export function computeStarPrice(stars: number): number {
  return STAR_PRICES[stars] ?? Number((stars * 0.0179).toFixed(4));
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

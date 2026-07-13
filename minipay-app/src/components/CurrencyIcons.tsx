// Real Telegram-style iconography for Stars and Premium — a four-point
// "sparkle" mark (the same silhouette Telegram uses for both its Stars
// currency and Premium badge) rendered with the two products' actual
// gradient colors, instead of a generic lucide Star/Crown glyph.
import { useId } from 'react';

const SPARKLE_PATH =
  'M12 0c0 6.627 5.373 12 12 12-6.627 0-12 5.373-12 12 0-6.627-5.373-12-12-12 6.627 0 12-5.373 12-12z';

export function TelegramStarIcon({ size = 24 }: { size?: number }) {
  const gradId = `tg-star-grad-${useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFDF6E" />
          <stop offset="1" stopColor="#FF9F0A" />
        </linearGradient>
      </defs>
      <path d={SPARKLE_PATH} fill={`url(#${gradId})`} />
    </svg>
  );
}

export function TelegramPremiumIcon({ size = 24 }: { size?: number }) {
  const gradId = `tg-premium-grad-${useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6EA8FE" />
          <stop offset="0.55" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#E36EFF" />
        </linearGradient>
      </defs>
      <path d={SPARKLE_PATH} fill={`url(#${gradId})`} />
    </svg>
  );
}

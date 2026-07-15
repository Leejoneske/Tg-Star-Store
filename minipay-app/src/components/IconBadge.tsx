import { TelegramStarIcon, TelegramPremiumIcon } from './CurrencyIcons';
import './IconBadge.css';

type BadgeKind = 'star' | 'premium';

export function IconBadge({ kind, size = 40 }: { kind: BadgeKind; size?: number }) {
  const Icon = kind === 'star' ? TelegramStarIcon : TelegramPremiumIcon;
  return (
    <div className={`icon-badge icon-badge-${kind}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.78)} />
    </div>
  );
}

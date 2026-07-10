import './IconBadge.css';

type BadgeKind = 'star' | 'premium' | 'wallet' | 'recipient' | 'network';

const ICONS: Record<BadgeKind, string> = {
  star: '⭐',
  premium: '💎',
  wallet: '👛',
  recipient: '👤',
  network: '⛓️',
};

export function IconBadge({ kind, size = 40 }: { kind: BadgeKind; size?: number }) {
  return (
    <div className={`icon-badge icon-badge-${kind}`} style={{ width: size, height: size, fontSize: size * 0.46 }}>
      {ICONS[kind]}
    </div>
  );
}

import { Star, Crown } from 'lucide-react';
import './IconBadge.css';

type BadgeKind = 'star' | 'premium';

export function IconBadge({ kind, size = 40 }: { kind: BadgeKind; size?: number }) {
  const Icon = kind === 'star' ? Star : Crown;
  const color = kind === 'star' ? 'var(--gold)' : 'var(--purple)';
  return (
    <div className={`icon-badge icon-badge-${kind}`} style={{ width: size, height: size }}>
      <Icon size={size * 0.5} color={color} fill={color} strokeWidth={1.4} />
    </div>
  );
}

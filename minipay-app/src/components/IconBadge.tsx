import './IconBadge.css';

type BadgeKind = 'star' | 'premium';

function StarGlyph() {
  return (
    <svg width="46%" height="46%" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1.5l2.47 5.14 5.53.72-4.06 3.9 1.03 5.6L10 14.1l-4.97 2.76 1.03-5.6-4.06-3.9 5.53-.72L10 1.5z"
        fill="var(--gold)"
        stroke="#c98f1c"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PremiumGlyph() {
  return (
    <svg width="46%" height="46%" viewBox="0 0 20 20" fill="none">
      <path d="M4 7l3-4h6l3 4-6 10L4 7z" fill="var(--purple)" />
      <path d="M4 7h12M8.5 3l1.5 4 1.5-4" stroke="#5b21b6" strokeWidth="0.7" strokeLinejoin="round" />
    </svg>
  );
}

export function IconBadge({ kind, size = 40 }: { kind: BadgeKind; size?: number }) {
  return (
    <div className={`icon-badge icon-badge-${kind}`} style={{ width: size, height: size }}>
      {kind === 'star' ? <StarGlyph /> : <PremiumGlyph />}
    </div>
  );
}

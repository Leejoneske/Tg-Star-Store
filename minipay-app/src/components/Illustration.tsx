// Flat, layered illustrations in the spirit of MiniPay's own onboarding —
// soft blob backdrop, stacked rounded shapes, small sparkle accents — built
// from scratch for StarStore's own subject matter (stars, wallets, delivery),
// not traced from any reference asset.

export function StarsIllustration() {
  return (
    <svg width="220" height="180" viewBox="0 0 220 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="110" cy="98" rx="98" ry="72" fill="var(--green-soft)" />
      <ellipse cx="150" cy="55" rx="34" ry="34" fill="var(--blue-soft)" opacity="0.7" />

      {/* back star (green) */}
      <g transform="translate(48,58) rotate(-12)">
        <path
          d="M34 0 L41 24 L66 24 L46 39 L53 63 L34 48 L15 63 L22 39 L2 24 L27 24 Z"
          fill="var(--green)"
        />
      </g>

      {/* front star (gold, larger, StarStore's actual star color) */}
      <g transform="translate(88,44)">
        <path
          d="M46 0 L56 32 L90 32 L62 52 L72 85 L46 65 L20 85 L30 52 L2 32 L36 32 Z"
          fill="var(--gold)"
        />
        <path
          d="M46 0 L56 32 L90 32 L62 52 L72 85 L46 65 Z"
          fill="#e4a622"
          opacity="0.55"
        />
      </g>

      {/* coin stack, bottom right */}
      <g transform="translate(148,96)">
        <ellipse cx="20" cy="34" rx="24" ry="9" fill="var(--blue)" />
        <rect x="-4" y="16" width="48" height="18" rx="9" fill="var(--blue)" />
        <ellipse cx="20" cy="16" rx="24" ry="9" fill="#5589f2" />
        <text x="20" y="21" textAnchor="middle" fontFamily="var(--font-display)" fontSize="12" fontWeight="700" fill="white">
          $
        </text>
      </g>

      {/* sparkles */}
      <path d="M180 30 l3 8 8 3 -8 3 -3 8 -3-8-8-3 8-3z" fill="var(--green)" />
      <path d="M26 30 l2.4 6.4 6.4 2.4 -6.4 2.4 -2.4 6.4 -2.4-6.4-6.4-2.4 6.4-2.4z" fill="var(--gold)" />
      <circle cx="196" cy="90" r="3.5" fill="var(--blue)" />
    </svg>
  );
}

export function CheckIllustration() {
  return (
    <svg width="180" height="150" viewBox="0 0 180 150" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="90" cy="80" rx="82" ry="62" fill="var(--green-soft)" />
      <circle cx="140" cy="35" r="20" fill="var(--blue-soft)" opacity="0.8" />

      <g transform="translate(50,32)">
        <rect x="0" y="10" width="80" height="80" rx="26" fill="var(--green)" />
        <rect x="0" y="10" width="80" height="80" rx="26" fill="var(--green-deep)" opacity="0.25" />
        <path
          d="M22 52 L38 68 L60 34"
          stroke="white"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>

      <path d="M28 40 l2.4 6.4 6.4 2.4 -6.4 2.4 -2.4 6.4 -2.4-6.4-6.4-2.4 6.4-2.4z" fill="var(--gold)" />
      <circle cx="150" cy="105" r="4" fill="var(--blue)" />
      <circle cx="24" cy="100" r="3" fill="var(--green)" />
    </svg>
  );
}

export function WalletIllustration() {
  return (
    <svg width="120" height="100" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="60" cy="52" rx="54" ry="40" fill="var(--blue-soft)" />
      <rect x="24" y="26" width="72" height="50" rx="14" fill="var(--ink)" />
      <rect x="24" y="26" width="72" height="18" rx="9" fill="var(--green)" />
      <circle cx="80" cy="58" r="8" fill="var(--gold)" />
    </svg>
  );
}

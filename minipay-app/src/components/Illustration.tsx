// Glossy, layered illustrations matching the reference's dark-onboarding
// treatment: a soft radial glow behind a single bold centered icon with a
// subtle highlight for dimension. Built from scratch for our own subject
// matter (stars, delivery), not traced from any reference asset.

export function StarsIllustration() {
  return (
    <svg width="160" height="160" viewBox="0 0 160 160" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="starFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffd873" />
          <stop offset="100%" stopColor="var(--gold)" />
        </linearGradient>
      </defs>

      <circle cx="80" cy="80" r="78" fill="url(#glow)" />

      <g transform="translate(80,80)">
        <path
          d="M0 -46 L14.8 -14.2 L48 -9.5 L24 13.5 L29.6 46 L0 30.5 L-29.6 46 L-24 13.5 L-48 -9.5 L-14.8 -14.2 Z"
          fill="url(#starFill)"
          stroke="#c98f1c"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* glossy highlight */}
        <path d="M0 -46 L14.8 -14.2 L4 -10 L-4 -26 Z" fill="white" opacity="0.35" />
      </g>

      <circle cx="34" cy="34" r="3" fill="var(--teal)" />
      <circle cx="128" cy="42" r="2.5" fill="white" opacity="0.6" />
    </svg>
  );
}

export function CheckIllustration() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="checkGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="75" cy="75" r="72" fill="url(#checkGlow)" />
      <g transform="translate(35,35)">
        <rect x="0" y="0" width="80" height="80" rx="26" fill="var(--green)" />
        <path
          d="M22 42 L36 56 L58 26"
          stroke="white"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
    </svg>
  );
}

export function WalletIllustration() {
  return (
    <svg width="120" height="100" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="walletGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="50" r="52" fill="url(#walletGlow)" />
      <rect x="24" y="26" width="72" height="50" rx="14" fill="var(--ink)" />
      <rect x="24" y="26" width="72" height="18" rx="9" fill="var(--coral)" />
      <circle cx="80" cy="58" r="8" fill="var(--gold)" />
    </svg>
  );
}

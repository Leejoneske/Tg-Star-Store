export function DollarHero() {
  return (
    <svg className="dollar-hero" viewBox="0 0 240 220" fill="none" aria-hidden="true">
      <circle cx="198" cy="36" r="34" fill="var(--mint-2)" />
      <circle cx="22" cy="78" r="28" stroke="var(--mint-2)" strokeWidth="10" />
      <circle cx="58" cy="42" r="6" fill="#ffd7e0" />
      <text x="120" y="142" textAnchor="middle" fontFamily="var(--font-display)" fontSize="150" fontWeight="800" fill="var(--green)">$</text>
      <text x="126" y="150" textAnchor="middle" fontFamily="var(--font-display)" fontSize="150" fontWeight="800" fill="var(--green-deep)" opacity=".9">$</text>
      <text x="120" y="142" textAnchor="middle" fontFamily="var(--font-display)" fontSize="150" fontWeight="800" fill="var(--green)">$</text>
    </svg>
  );
}

export function StarsIllustration() {
  return (
    <svg width="238" height="190" viewBox="0 0 238 190" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M37 111c-9-43 34-85 84-82 57 4 95 45 86 91-8 40-51 61-96 58-39-2-67-32-74-67Z" fill="var(--mint)"/>
      <g transform="translate(40 45) rotate(-10)">
        <path d="M43 2 54 35l35 1-28 20 10 34-28-21-29 20 11-34L-2 35l34-1L43 2Z" fill="var(--gold)"/>
        <path d="M43 2 54 35l35 1-28 20 10 34-28-21Z" fill="#d49314" opacity=".38"/>
        <path d="M12 37 33 35 43 7" stroke="white" strokeWidth="5" strokeLinecap="round" opacity=".45"/>
      </g>
      <g transform="translate(130 66)">
        <ellipse cx="35" cy="66" rx="38" ry="12" fill="#2f6fed" opacity=".2"/>
        <rect x="2" y="16" width="72" height="50" rx="25" fill="var(--blue)"/>
        <ellipse cx="38" cy="18" rx="36" ry="15" fill="#6da0ff"/>
        <text x="38" y="27" textAnchor="middle" fontFamily="var(--font-display)" fontSize="22" fontWeight="800" fill="white">★</text>
      </g>
      <path d="m190 37 4 11 11 4-11 4-4 11-4-11-11-4 11-4 4-11Z" fill="var(--green)"/>
      <path d="m31 36 3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8Z" fill="var(--rose)"/>
    </svg>
  );
}

export function CheckIllustration() { return <StarsIllustration />; }
export function WalletIllustration() { return <StarsIllustration />; }

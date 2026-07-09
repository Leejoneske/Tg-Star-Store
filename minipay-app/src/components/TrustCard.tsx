import './TrustCard.css';

const POINTS = [
  'You approve this exact payment inside MiniPay',
  'Funds go straight to StarStore\u2019s wallet — no middlemen',
  'Delivery starts the moment payment confirms on-chain',
];

export function TrustCard() {
  return (
    <div className="trust-card">
      <div className="trust-title">You're always in control</div>
      <div className="trust-list">
        {POINTS.map((p) => (
          <div className="trust-row" key={p}>
            <span className="trust-check">
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

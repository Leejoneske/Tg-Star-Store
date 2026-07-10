import './TrustCard.css';

const POINTS = [
  { title: 'You approve every payment', body: 'Nothing leaves your wallet without your confirmation in MiniPay.' },
  { title: 'Sent straight to StarStore', body: 'No middlemen — your payment goes directly to our wallet.' },
  { title: 'Delivered automatically', body: 'Stars or Premium arrive the moment your payment confirms on-chain.' },
];

export function TrustCard() {
  return (
    <div className="trust-card">
      <div className="trust-badge">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path
            d="M11 2l7 3v5c0 5-3.4 8.4-7 10-3.6-1.6-7-5-7-10V5l7-3z"
            fill="var(--green)"
          />
          <path d="M7.5 11l2.3 2.3L14.8 8" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="trust-title">You're always in control</div>
      <div className="trust-list">
        {POINTS.map((p) => (
          <div className="trust-row" key={p.title}>
            <span className="trust-check">
              <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                <path d="M1 4.5L4 7.5L10 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="trust-row-title">{p.title}</div>
              <div className="trust-row-body">{p.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { ShieldCheck, Check } from 'lucide-react';
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
        <ShieldCheck size={22} color="var(--green)" strokeWidth={2} />
      </div>
      <div className="trust-title">You're always in control</div>
      <div className="trust-list">
        {POINTS.map((p) => (
          <div className="trust-row" key={p.title}>
            <span className="trust-check">
              <Check size={11} color="white" strokeWidth={3} />
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

import { Check } from 'lucide-react';
import './Intro.css';

const POINTS = [
  { title: 'Pay with what you already have', body: 'Uses the stablecoins already sitting in your MiniPay wallet.' },
  { title: 'You approve every payment', body: 'Nothing moves without your confirmation — no surprises.' },
  { title: 'Delivered to Telegram instantly', body: 'Stars or Premium land on your account the moment payment confirms.' },
];

// No hero icon/visual at all — just the brand row and animated typography,
// so the screen reads as clean and uncluttered rather than leaning on
// another icon graphic.
export function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="screen intro-screen">
      <div className="brand-row intro-brand">
        <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
        <span className="brand-name intro-brand-name">StarStore</span>
      </div>

      <h1 className="intro-title">A gate for your wallet.</h1>
      <p className="intro-subtitle">Every payment has to ask before it moves a cent.</p>

      <div className="intro-points">
        {POINTS.map((p, i) => (
          <div className="intro-point" key={p.title} style={{ animationDelay: `${0.2 + i * 0.09}s` }}>
            <span className="intro-point-check">
              <Check size={13} color="white" strokeWidth={3} />
            </span>
            <div>
              <div className="intro-point-title">{p.title}</div>
              <div className="intro-point-body">{p.body}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="sticky-footer intro-footer">
        <button className="btn-primary intro-cta" onClick={onContinue} data-testid="intro-get-started-button">
          Get started
        </button>
      </div>
    </div>
  );
}

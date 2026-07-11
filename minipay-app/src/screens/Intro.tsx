import { Check } from 'lucide-react';
import './Intro.css';

const POINTS = [
  { title: 'Pay with what you already have', body: 'Uses the stablecoins already sitting in your MiniPay wallet.' },
  { title: 'You approve every payment', body: 'Nothing moves without your confirmation — no surprises.' },
  { title: 'Delivered to Telegram instantly', body: 'Stars or Premium land on your account the moment payment confirms.' },
];

export function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="screen intro-screen">
      <div className="brand-row intro-brand">
        <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
        <span className="brand-name intro-brand-name">StarStore</span>
      </div>

      <div className="intro-hero">
        <div className="intro-hero-glow" />
        <div className="intro-hero-frame">
          <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="intro-hero-img" />
          <div className="intro-hero-shine" />
        </div>
      </div>

      <h1 className="intro-title">Buy Telegram Stars with MiniPay</h1>

      <div className="intro-points">
        {POINTS.map((p) => (
          <div className="intro-point" key={p.title}>
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

      <div className="sticky-footer dark">
        <button className="btn-light intro-cta" onClick={onContinue} data-testid="intro-get-started-button">
          Get started
        </button>
      </div>
    </div>
  );
}

import { StarsIllustration } from '../components/Illustration';
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

      <div className="intro-illustration">
        <StarsIllustration />
      </div>

      <h1 className="intro-title">Buy Telegram Stars with MiniPay</h1>

      <div className="intro-points">
        {POINTS.map((p) => (
          <div className="intro-point" key={p.title}>
            <span className="intro-point-check">
              <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                <path d="M1 4.5L4 7.5L10 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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

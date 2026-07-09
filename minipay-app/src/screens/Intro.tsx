import { StarsIllustration } from '../components/Illustration';
import './Intro.css';

export function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="screen intro-screen">
      <div className="brand-row">
        <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
        <span className="brand-name">StarStore</span>
      </div>

      <div className="intro-sheet">
        <div className="intro-handle" />
        <div className="intro-illustration">
          <StarsIllustration />
        </div>
        <h1 className="intro-title">Buy Stars, the easy way</h1>
        <p className="intro-subtitle">
          Pay with the stablecoins already in your MiniPay wallet — no cards, no waiting, delivered straight to your
          Telegram account.
        </p>
        <button className="btn-primary intro-cta" onClick={onContinue}>
          Get started
        </button>
      </div>
    </div>
  );
}

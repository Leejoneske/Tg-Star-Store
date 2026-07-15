import { Check, Send, ShieldCheck } from 'lucide-react';
import { TelegramStarIcon } from '../components/CurrencyIcons';
import './Intro.css';

const POINTS = [
  { title: 'Pay with what you already have', body: 'Uses the stablecoins already sitting in your MiniPay wallet.' },
  { title: 'You approve every payment', body: 'Nothing moves without your confirmation; no surprises.' },
  { title: 'Delivered to Telegram instantly', body: 'Stars or Premium land on your account the moment payment confirms.' },
];

interface IntroProps {
  onContinue: () => void;
  onViewOrders: () => void;
}


export function Intro({ onContinue, onViewOrders }: IntroProps) {
  return (
    <div className="screen intro-screen">
      <div className="brand-row intro-brand">
        <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
        <span className="brand-name intro-brand-name">StarStore</span>
      </div>

      <div className="intro-hero">
        <div className="intro-icon-tile intro-icon-telegram">
          <Send size={24} color="white" strokeWidth={2.2} />
        </div>
        <div className="intro-icon-tile intro-icon-star">
          <TelegramStarIcon size={30} />
        </div>
        <div className="intro-icon-tile intro-icon-wallet">
          <ShieldCheck size={26} color="var(--green)" strokeWidth={2.2} />
        </div>
      </div>

      <h1 className="intro-title">
        Buy Telegram Stars
        <br />
        with your wallet.
      </h1>
      <p className="intro-subtitle">Pay in cUSD, USDC, or USDT — Stars land in your Telegram account instantly.</p>

      <div className="intro-points">
        {POINTS.map((p, i) => (
          <div className="intro-point" key={p.title} style={{ animationDelay: `${0.5 + i * 0.09}s` }}>
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
        <button className="btn-intro-secondary intro-cta" onClick={onViewOrders} data-testid="intro-view-orders-button">
          I already have an order
        </button>
      </div>
    </div>
  );
}

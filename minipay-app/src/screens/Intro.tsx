import { HeroCard } from '../components/HeroCard';
import './Intro.css';

const FEATURES = [
  { icon: '⚡', title: 'Instant delivery', body: 'Stars or Premium land on the Telegram account you name, right after payment confirms.' },
  { icon: '🛡️', title: 'You stay in control', body: 'Every payment is approved by you in your wallet — nothing is ever pulled automatically.' },
  { icon: '🪙', title: 'Pay in stablecoins', body: 'cUSD, USDC, or USDT on Celo — whichever your MiniPay wallet is holding.' },
];

export function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="screen intro-screen">
      <div className="intro-brand">
        <div className="intro-mark">S</div>
        <span>StarStore</span>
      </div>

      <HeroCard>
        <div className="intro-hero-kicker">MINIPAY CHECKOUT</div>
        <h1 className="intro-hero-title">Buy Telegram Stars &amp; Premium with your stablecoin wallet</h1>
        <div className="intro-hero-badge">Built for MiniPay</div>
      </HeroCard>

      <div className="intro-features">
        {FEATURES.map((f) => (
          <div className="intro-feature" key={f.title}>
            <div className="intro-feature-icon">{f.icon}</div>
            <div>
              <div className="intro-feature-title">{f.title}</div>
              <div className="intro-feature-body">{f.body}</div>
            </div>
          </div>
        ))}
      </div>

      <button className="btn-primary intro-cta" onClick={onContinue}>
        Get started
      </button>
    </div>
  );
}

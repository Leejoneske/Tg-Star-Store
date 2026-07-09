import { DollarHero } from '../components/Illustration';
import './Intro.css';

export function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="screen intro-screen">
      <div className="intro-orbits" aria-hidden="true" />
      <div className="intro-stage">
        <DollarHero />
        <h1><span>Easy & secure</span><strong>dollar checkout</strong></h1>
        <p>Buy Telegram Stars and Premium with the stablecoins already in your MiniPay wallet.</p>
      </div>
      <div className="intro-dock">
        <button className="btn-primary intro-cta" onClick={onContinue}>Get started</button>
        <p>Pay on Celo in USDC, USDT, or cUSD. Delivered to your Telegram username.</p>
      </div>
    </div>
  );
}

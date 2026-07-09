import { useEffect, useState } from 'react';
import { HeroCard } from '../components/HeroCard';
import { NextSteps } from '../components/NextSteps';
import { STAR_PACKAGES, PREMIUM_DURATIONS, STAR_PRICES, PREMIUM_PRICES, formatUsd } from '../lib/pricing';
import { isMiniPayAvailable, connectWallet, sendStablecoinPayment } from '../lib/minipay';
import { createOrder, submitTx, type TokenSymbol } from '../lib/api';
import type { BuyPrefill } from '../App';
import './Buy.css';

const TELEGRAM_BOT_URL = 'https://t.me/TgStarStore_bot';

type PurchaseType = 'stars' | 'premium';

interface BuyProps {
  prefill: BuyPrefill;
  onOrderPlaced: (orderId: string, stars: number | null, isPremium: boolean, premiumDuration: number | null) => void;
}

export function Buy({ prefill, onOrderPlaced }: BuyProps) {
  const [miniPayDetected, setMiniPayDetected] = useState(true);
  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [type, setType] = useState<PurchaseType>(prefill.isPremium ? 'premium' : 'stars');
  const [stars, setStars] = useState(prefill.stars && STAR_PRICES[prefill.stars] ? prefill.stars : 25);
  const [duration, setDuration] = useState(prefill.premiumDuration && PREMIUM_PRICES[prefill.premiumDuration] ? prefill.premiumDuration : 6);
  const [token, setToken] = useState<TokenSymbol>('USDC');
  const [username, setUsername] = useState(prefill.username || '');

  const [paying, setPaying] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMiniPayDetected(isMiniPayAvailable());
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      const addr = await connectWallet();
      setWallet(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect wallet');
    } finally {
      setConnecting(false);
    }
  }

  const total = type === 'stars' ? STAR_PRICES[stars] : PREMIUM_PRICES[duration];
  const usernameValid = username.trim().length >= 5;

  async function handlePay() {
    setError(null);
    if (!usernameValid) {
      setError('Enter a valid Telegram username first.');
      return;
    }
    if (!wallet) {
      setError('Connect your wallet first.');
      return;
    }

    setPaying(true);
    setStatusMsg('Creating order…');
    try {
      const order = await createOrder({
        username: username.trim(),
        stars: type === 'stars' ? stars : undefined,
        isPremium: type === 'premium',
        premiumDuration: type === 'premium' ? duration : undefined,
        token,
      });

      setStatusMsg('Confirm the payment in MiniPay…');
      const txHash = await sendStablecoinPayment({
        fromAddress: wallet,
        tokenAddress: order.tokenAddress,
        tokenSymbol: order.tokenSymbol,
        toAddress: order.recipientWallet,
        amountUnits: order.amountUnits,
      });

      setStatusMsg('Verifying payment…');
      await submitTx(order.orderId, txHash, wallet);

      onOrderPlaced(order.orderId, type === 'stars' ? stars : null, type === 'premium', type === 'premium' ? duration : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong';
      setError(msg.includes('User rejected') ? 'Payment cancelled.' : msg);
      setPaying(false);
      setStatusMsg(null);
    }
  }

  return (
    <div className="screen buy-screen">
      <div className="buy-topbar">
        <div className="welcome-chip">
          <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
          <span>Welcome to StarStore! 👋</span>
        </div>
        <button className="scan-btn" aria-label="Scan code">
          <svg viewBox="0 0 24 24" className="mini-icon"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M8 8h1M15 8h1M8 16h1M12 12h1M16 16h1" stroke="currentColor" strokeWidth="2.3" fill="none" strokeLinecap="round"/></svg>
        </button>
      </div>

      {!miniPayDetected && (
        <div className="notice-card">
          <div className="notice-icon">📲</div>
          <p>
            Open this page inside <strong>MiniPay</strong> or the <strong>Opera Mini</strong> browser to pay with a
            stablecoin wallet.
          </p>
          <a className="notice-link" href="https://minipay.to" target="_blank" rel="noopener noreferrer">
            Get MiniPay
          </a>
        </div>
      )}

      <div className="telegram-fallback">
        Want to pay with TON, GRAM, or your Telegram Stars balance instead?{' '}
        <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer">
          Open StarStore in Telegram
        </a>
      </div>

      <HeroCard>
        <div className="hero-kicker">Telegram checkout</div>
        <div className="hero-total-row">
          <div>
            <div className="hero-total-value">{formatUsd(total)}</div>
            <div className="hero-total-unit">{type === 'stars' ? `${stars} Stars` : `Premium · ${duration} mo`} · paid in {token}</div>
          </div>
          <div className="currency-switch"><strong>USD</strong><span>CELO</span></div>
        </div>
        <div className="hero-actions">
          <button onClick={() => setType('stars')} className={type === 'stars' ? 'hero-action active' : 'hero-action'}><span>★</span> Stars</button>
          <button onClick={() => setType('premium')} className={type === 'premium' ? 'hero-action active' : 'hero-action'}><span>◆</span> Premium</button>
        </div>
      </HeroCard>

      <NextSteps
        steps={[
          { label: 'Connect wallet', sublabel: 'MiniPay auto-connects', done: !!wallet },
          { label: 'Choose a package', sublabel: `${type === 'stars' ? stars + ' stars' : duration + ' months'} selected`, done: true },
          { label: 'Pay & deliver', sublabel: `To @${username || '…'}`, done: false },
        ]}
      />

      <div className="purchase-panel">
        <div className="section-title">Choose package</div>

        {type === 'stars' ? (
          <div className="pkg-grid">
            {STAR_PACKAGES.map((n) => (
              <button key={n} className={stars === n ? 'pkg active' : 'pkg'} onClick={() => setStars(n)}>
                <div className="pkg-n">{n}</div>
                <div className="pkg-u">{formatUsd(STAR_PRICES[n])}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="pkg-grid">
            {PREMIUM_DURATIONS.map((m) => (
              <button key={m} className={duration === m ? 'pkg active' : 'pkg'} onClick={() => setDuration(m)}>
                <div className="pkg-n">{m} mo</div>
                <div className="pkg-u">{formatUsd(PREMIUM_PRICES[m])}</div>
              </button>
            ))}
          </div>
        )}

        <div className="field-label">Telegram username to deliver to</div>
        <input
          className="text-input"
          type="text"
          placeholder="e.g. john_doe (without @)"
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
        />
      </div>

      <div className="pay-panel">
        <div className="section-title">Pay with</div>
        <div className="token-row">
          {(['cUSD', 'USDC', 'USDT'] as TokenSymbol[]).map((t) => (
            <button key={t} className={token === t ? 'token-pill active' : 'token-pill'} onClick={() => setToken(t)}>
              {t}
            </button>
          ))}
        </div>

        {!wallet ? (
          <button className="btn-primary" disabled={!miniPayDetected || connecting} onClick={handleConnect}>
            {connecting ? 'Connecting…' : miniPayDetected ? 'Connect MiniPay' : 'MiniPay not detected'}
          </button>
        ) : (
          <button className="btn-primary" disabled={paying} onClick={handlePay}>
            {paying ? statusMsg || 'Processing…' : `Pay ${formatUsd(total)}`}
          </button>
        )}

        {error && <div className="status-text error">{error}</div>}
        {!error && statusMsg && paying && <div className="status-text">{statusMsg}</div>}
      </div>
    </div>
  );
}

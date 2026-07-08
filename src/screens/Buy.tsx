import { useEffect, useState } from 'react';
import { HeroCard } from '../components/HeroCard';
import { StepTracker } from '../components/StepTracker';
import { STAR_PACKAGES, PREMIUM_DURATIONS, STAR_PRICES, PREMIUM_PRICES, formatUsd } from '../lib/pricing';
import { isMiniPayAvailable, connectWallet, sendStablecoinPayment } from '../lib/minipay';
import { createOrder, submitTx, type TokenSymbol } from '../lib/api';
import type { BuyPrefill } from '../App';
import './Buy.css';

// Fill in your bot's real username here — this is the fallback for anyone
// who wants to pay with TON/GRAM (your MiniPay wallet only ever holds Celo
// stablecoins, so that path can only ever exist inside Telegram).
const TELEGRAM_BOT_URL = 'https://t.me/YourStarStoreBot';

type PurchaseType = 'stars' | 'premium';

function shortAddr(a: string) {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

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
  const stepIndex = paying ? 2 : wallet ? 1 : 0;

  async function handlePay() {
    setError(null);
    if (username.trim().length < 5) {
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
        <div className="buy-brand">
          <div className="buy-mark">S</div>
          <span>StarStore</span>
        </div>
        {wallet && (
          <div className="wallet-chip">
            <span className="wallet-dot" />
            {shortAddr(wallet)}
          </div>
        )}
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
        <div className="hero-top">
          <div>
            <div className="hero-kicker">{type === 'stars' ? 'STARS ORDER' : 'PREMIUM ORDER'}</div>
            <div className="hero-package">
              {type === 'stars' ? `${stars} ⭐ Stars` : `Premium · ${duration} mo`}
            </div>
          </div>
          <div className="hero-total">
            <div className="hero-total-value">{formatUsd(total)}</div>
            <div className="hero-total-unit">paid in {token}</div>
          </div>
        </div>
        <StepTracker steps={['Connect', 'Review', 'Delivered']} currentIndex={stepIndex} />
      </HeroCard>

      <div className="card">
        <div className="section-title">What are you buying?</div>
        <div className="type-toggle">
          <button className={type === 'stars' ? 'type-pill active' : 'type-pill'} onClick={() => setType('stars')}>
            ⭐ Stars
          </button>
          <button className={type === 'premium' ? 'type-pill active' : 'type-pill'} onClick={() => setType('premium')}>
            💎 Premium
          </button>
        </div>

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

      <div className="card">
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

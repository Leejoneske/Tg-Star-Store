import { useEffect, useState } from 'react';
import { HeroCard } from '../components/HeroCard';
import { NextSteps } from '../components/NextSteps';
import { ConfirmSummary } from '../components/ConfirmSummary';
import { TrustCard } from '../components/TrustCard';
import { ReviewHeader } from '../components/ReviewHeader';
import { PackageRow } from '../components/PackageRow';
import { STAR_PACKAGES, PREMIUM_DURATIONS, STAR_PRICES, PREMIUM_PRICES, formatUsd } from '../lib/pricing';
import { isMiniPayAvailable, connectWallet, sendStablecoinPayment } from '../lib/minipay';
import { createOrder, submitTx, type TokenSymbol } from '../lib/api';
import type { BuyPrefill } from '../App';
import './Buy.css';

const TELEGRAM_BOT_URL = 'https://t.me/TgStarStore_bot';

type PurchaseType = 'stars' | 'premium';
type Mode = 'form' | 'review';

function shortAddr(a: string) {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

interface BuyProps {
  prefill: BuyPrefill;
  onOrderPlaced: (orderId: string, stars: number | null, isPremium: boolean, premiumDuration: number | null) => void;
}

export function Buy({ prefill, onOrderPlaced }: BuyProps) {
  const [mode, setMode] = useState<Mode>('form');
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
  const packageLabel = type === 'stars' ? `${stars} Stars` : `Premium · ${duration} months`;

  function goToReview() {
    setError(null);
    if (!usernameValid) {
      setError('Enter a valid Telegram username first.');
      return;
    }
    setMode('review');
  }

  async function handlePay() {
    setError(null);
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
        <div className="brand-row">
          <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
          <span className="brand-name">StarStore</span>
        </div>
        {wallet && (
          <div className="wallet-chip">
            <span className="wallet-dot" />
            {shortAddr(wallet)}
          </div>
        )}
      </div>

      {mode === 'form' && !miniPayDetected && (
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

      {mode === 'form' && (
        <div className="telegram-fallback">
          Want to pay with TON, GRAM, or your Telegram Stars balance instead?{' '}
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer">
            Open StarStore in Telegram
          </a>
        </div>
      )}

      <HeroCard>
        <div className="hero-kicker">{type === 'stars' ? 'STARS ORDER' : 'PREMIUM ORDER'}</div>
        <div className="hero-package">{packageLabel}</div>
        <div className="hero-total-row">
          <div className="hero-total-value">{formatUsd(total)}</div>
          <div className="hero-total-unit">paid in {token}</div>
        </div>
      </HeroCard>

      {mode === 'form' && (
        <>
          <NextSteps
            steps={[
              { label: 'Choose a package', sublabel: `${packageLabel} selected`, done: true },
              { label: 'Add a recipient', sublabel: usernameValid ? `Delivering to @${username}` : 'Enter a Telegram username', done: usernameValid },
              { label: 'Review & pay', sublabel: 'Confirm the details before paying', done: false },
            ]}
          />

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

            <div className="pkg-list">
              {type === 'stars'
                ? STAR_PACKAGES.map((n) => (
                    <PackageRow
                      key={n}
                      badge="star"
                      title={`${n} Stars`}
                      subtitle="Delivered instantly"
                      price={formatUsd(STAR_PRICES[n])}
                      active={stars === n}
                      onClick={() => setStars(n)}
                    />
                  ))
                : PREMIUM_DURATIONS.map((m) => (
                    <PackageRow
                      key={m}
                      badge="premium"
                      title={`${m} month${m > 1 ? 's' : ''}`}
                      subtitle="Telegram Premium"
                      price={formatUsd(PREMIUM_PRICES[m])}
                      active={duration === m}
                      onClick={() => setDuration(m)}
                    />
                  ))}
            </div>

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
            <button className="btn-primary" onClick={goToReview}>
              Review order
            </button>
            {error && <div className="status-text error">{error}</div>}
          </div>
        </>
      )}

      {mode === 'review' && (
        <>
          <ReviewHeader />

          <ConfirmSummary
            rows={[
              { label: 'Package', value: packageLabel },
              { label: 'Recipient', value: `@${username}` },
              { label: 'Network', value: 'Celo' },
              { label: 'Network fee', value: 'Covered by MiniPay' },
            ]}
            totalLabel={`You'll pay in ${token}`}
            totalValue={formatUsd(total)}
          />

          <TrustCard />

          {!wallet ? (
            <button className="btn-primary" disabled={!miniPayDetected || connecting} onClick={handleConnect}>
              {connecting ? 'Connecting…' : miniPayDetected ? 'Connect MiniPay' : 'MiniPay not detected'}
            </button>
          ) : (
            <button className="btn-primary" disabled={paying} onClick={handlePay}>
              {paying ? statusMsg || 'Processing…' : `Confirm & pay ${formatUsd(total)}`}
            </button>
          )}

          {!paying && (
            <button className="btn-outline" onClick={() => setMode('form')}>
              Edit order
            </button>
          )}

          {error && <div className="status-text error">{error}</div>}
          {!error && statusMsg && paying && <div className="status-text">{statusMsg}</div>}
        </>
      )}
    </div>
  );
}

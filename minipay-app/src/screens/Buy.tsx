import { useEffect, useState } from 'react';
import { Smartphone, ChevronDown, ChevronUp } from 'lucide-react';
import { NextSteps } from '../components/NextSteps';
import { ConfirmSummary } from '../components/ConfirmSummary';
import { TrustCard } from '../components/TrustCard';
import { ReviewHeader } from '../components/ReviewHeader';
import { PackageRow } from '../components/PackageRow';
import { TelegramStarIcon, TelegramPremiumIcon } from '../components/CurrencyIcons';
import {
  STAR_PACKAGES,
  PREMIUM_DURATIONS,
  STAR_PRICES,
  PREMIUM_PRICES,
  MIN_CUSTOM_STARS,
  MAX_CUSTOM_STARS,
  computeStarPrice,
  formatUsd,
} from '../lib/pricing';
import { isMiniPayAvailable, connectWallet, sendStablecoinPayment } from '../lib/minipay';
import { createOrder, submitTx, type TokenSymbol } from '../lib/api';
import type { BuyPrefill } from '../App';
import './Buy.css';

// Fill in your bot's real username here — this is the fallback for anyone
// who wants to pay with TON/GRAM/their Telegram Stars balance instead (your
// MiniPay wallet only ever holds Celo stablecoins, so that path can only
// ever exist inside Telegram).
const TELEGRAM_BOT_URL = 'https://t.me/TgStarStore_bot';

// Same rule the main Telegram app enforces (see sanitizeUsername in
// services/fulfillment/types.js and isTelegramUsernameFormatValid in
// public/index.html): letters, numbers, underscores, 5–32 characters.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{5,32}$/;

const STAR_PACKAGES_VISIBLE = 3;

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

  const [showAllStarPackages, setShowAllStarPackages] = useState(false);
  const [customAmount, setCustomAmount] = useState('');

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

  const total = type === 'stars' ? computeStarPrice(stars) : PREMIUM_PRICES[duration];
  const usernameValid = USERNAME_PATTERN.test(username.trim());
  const packageLabel = type === 'stars' ? `${stars} Stars` : `Premium · ${duration} months`;

  const visibleStarPackages = showAllStarPackages ? STAR_PACKAGES : STAR_PACKAGES.slice(0, STAR_PACKAGES_VISIBLE);
  const hasMoreStarPackages = STAR_PACKAGES.length > STAR_PACKAGES_VISIBLE;

  const customAmountNum = customAmount ? Number(customAmount) : null;
  const customAmountTooLow = customAmountNum !== null && customAmountNum > 0 && customAmountNum < MIN_CUSTOM_STARS;
  const customAmountActive = customAmountNum !== null && customAmountNum >= MIN_CUSTOM_STARS && customAmountNum === stars;

  function selectStarPackage(n: number) {
    setStars(n);
    setCustomAmount('');
  }

  function handleCustomAmountChange(raw: string) {
    const digitsOnly = raw.replace(/[^0-9]/g, '');
    setCustomAmount(digitsOnly);
    const n = Number(digitsOnly);
    if (digitsOnly && n >= MIN_CUSTOM_STARS && n <= MAX_CUSTOM_STARS) {
      setStars(n);
    }
  }

  function goToReview() {
    setError(null);
    if (!usernameValid) {
      setError('Enter a valid Telegram username (5–32 letters, numbers, or underscores).');
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
          <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon circle" />
          <div className="brand-text">
            <span className="brand-name">StarStore</span>
            <span className="brand-sub">Buy & Sell Telegram Stars</span>
          </div>
        </div>
        {wallet && (
          <div className="wallet-chip" data-testid="wallet-connected-chip">
            <span className="wallet-dot" />
            {shortAddr(wallet)}
          </div>
        )}
      </div>

      {mode === 'form' && !miniPayDetected && (
        <div className="notice-card" data-testid="minipay-not-detected-notice">
          <div className="notice-icon">
            <Smartphone size={20} color="var(--coral)" strokeWidth={1.8} />
          </div>
          <p>
            Open this page inside <strong>MiniPay</strong> or the <strong>Opera Mini</strong> browser to pay with a
            stablecoin wallet.
          </p>
          <a className="notice-link" href="https://minipay.to" target="_blank" rel="noopener noreferrer" data-testid="get-minipay-link">
            Get MiniPay
          </a>
        </div>
      )}

      {mode === 'form' && (
        <div className="telegram-fallback">
          Want to pay with TON, GRAM, or your Telegram Stars balance instead?{' '}
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" data-testid="open-telegram-link">
            Open StarStore in Telegram
          </a>
        </div>
      )}

      {mode === 'form' && (
        <>
          <div className="hero-card" data-testid="order-total-hero">
            <div className="hero-card-top">
              <span className="hero-card-label">Total to pay</span>
              <div className="type-toggle">
                <button
                  className={type === 'stars' ? 'type-pill active' : 'type-pill'}
                  onClick={() => setType('stars')}
                  data-testid="type-toggle-stars"
                >
                  Stars
                </button>
                <button
                  className={type === 'premium' ? 'type-pill active' : 'type-pill'}
                  onClick={() => setType('premium')}
                  data-testid="type-toggle-premium"
                >
                  Premium
                </button>
              </div>
            </div>
            <div className="hero-card-amount" data-testid="order-total-amount">{formatUsd(total)}</div>
            <div className="hero-card-sub">{packageLabel}</div>
          </div>

          <NextSteps
            steps={[
              { label: 'Choose a package', sublabel: `${packageLabel} selected`, done: true },
              { label: 'Add a recipient', sublabel: usernameValid ? `Delivering to @${username}` : 'Enter a Telegram username', done: usernameValid },
              { label: 'Review & pay', sublabel: 'Confirm the details before paying', done: false },
            ]}
          />

          <div className="card">
            <div className="section-title-row">
              {type === 'stars' ? <TelegramStarIcon size={16} /> : <TelegramPremiumIcon size={16} />}
              <div className="section-title">{type === 'stars' ? 'Choose a star pack' : 'Choose a duration'}</div>
            </div>

            <div className="pkg-list">
              {type === 'stars'
                ? visibleStarPackages.map((n) => (
                    <PackageRow
                      key={n}
                      title={`${n} Stars`}
                      subtitle="Delivered instantly"
                      price={formatUsd(STAR_PRICES[n])}
                      active={!customAmountActive && stars === n}
                      onClick={() => selectStarPackage(n)}
                    />
                  ))
                : PREMIUM_DURATIONS.map((m) => (
                    <PackageRow
                      key={m}
                      title={`${m} month${m > 1 ? 's' : ''}`}
                      subtitle="Telegram Premium"
                      price={formatUsd(PREMIUM_PRICES[m])}
                      active={duration === m}
                      onClick={() => setDuration(m)}
                    />
                  ))}
            </div>

            {type === 'stars' && hasMoreStarPackages && (
              <button
                type="button"
                className="pkg-more-toggle"
                onClick={() => setShowAllStarPackages((v) => !v)}
                data-testid="toggle-star-packages"
              >
                {showAllStarPackages ? 'Show fewer packages' : `Show ${STAR_PACKAGES.length - STAR_PACKAGES_VISIBLE} more packages`}
                {showAllStarPackages ? <ChevronUp size={15} strokeWidth={2.4} /> : <ChevronDown size={15} strokeWidth={2.4} />}
              </button>
            )}

            {type === 'stars' && (
              <div className={customAmountActive ? 'custom-amount active' : 'custom-amount'}>
                <div className="field-label">Or enter a custom amount</div>
                <input
                  className="text-input"
                  type="number"
                  inputMode="numeric"
                  min={MIN_CUSTOM_STARS}
                  max={MAX_CUSTOM_STARS}
                  placeholder={`e.g. 250`}
                  value={customAmount}
                  onChange={(e) => handleCustomAmountChange(e.target.value)}
                  data-testid="custom-stars-input"
                />
                <div className={customAmountTooLow ? 'custom-amount-hint error' : 'custom-amount-hint'}>
                  {customAmountTooLow ? `Minimum ${MIN_CUSTOM_STARS} stars for a custom amount.` : `Minimum ${MIN_CUSTOM_STARS} stars.`}
                </div>
              </div>
            )}

            <div className="field-label">Telegram username to deliver to</div>
            <input
              className="text-input"
              type="text"
              placeholder="e.g. john_doe (without @)"
              value={username}
              onChange={(e) => setUsername(e.target.value.replace(/^@/, ''))}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              data-testid="username-input"
            />
          </div>

          <div className="card">
            <div className="section-title">Pay with</div>
            <div className="token-row">
              {(['cUSD', 'USDC', 'USDT'] as TokenSymbol[]).map((t) => (
                <button
                  key={t}
                  className={token === t ? 'token-pill active' : 'token-pill'}
                  onClick={() => setToken(t)}
                  data-testid={`token-pill-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="sticky-footer">
            <button className="btn-primary" onClick={goToReview} data-testid="continue-to-review-button">
              Continue — {formatUsd(total)}
            </button>
            {error && <div className="status-text error" data-testid="buy-form-error">{error}</div>}
          </div>
        </>
      )}

      {mode === 'review' && (
        <>
          <ReviewHeader
            badge={type === 'stars' ? 'star' : 'premium'}
            amount={formatUsd(total)}
            packageLabel={packageLabel}
          />

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

          <div className="sticky-footer">
            {!wallet ? (
              <button
                className="btn-primary"
                disabled={!miniPayDetected || connecting}
                onClick={handleConnect}
                data-testid="connect-wallet-button"
              >
                {connecting ? 'Connecting…' : miniPayDetected ? 'Connect MiniPay' : 'MiniPay not detected'}
              </button>
            ) : (
              <button className="btn-primary" disabled={paying} onClick={handlePay} data-testid="confirm-pay-button">
                {paying ? statusMsg || 'Processing…' : `Confirm & pay ${formatUsd(total)}`}
              </button>
            )}

            {!paying && (
              <button className="btn-outline" onClick={() => setMode('form')} data-testid="edit-order-button">
                Edit order
              </button>
            )}

            {error && <div className="status-text error" data-testid="review-error">{error}</div>}
            {!error && statusMsg && paying && <div className="status-text" data-testid="review-status-message">{statusMsg}</div>}
          </div>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIllustration, WalletIllustration } from '../components/Illustration';
import { getOrderStatus } from '../lib/api';
import './Status.css';

interface StatusProps {
  orderId: string;
  stars: number | null;
  isPremium: boolean;
  premiumDuration: number | null;
  onStartOver: () => void;
}

type Phase = 'confirming' | 'delivering' | 'review' | 'done' | 'failed' | 'timeout';

export function Status({ orderId, stars, isPremium, premiumDuration, onStartOver }: StatusProps) {
  // Matches the platform's real auto-fulfill guardrail (services/fulfillment/
  // index.js): star orders under 50 always go to manual admin review and can
  // take up to ~2 hours once payment is confirmed. That's a DIFFERENT thing
  // from confirming the payment itself — every order, regardless of size,
  // must show "Confirming on-chain…" first and only move on once
  // transactionVerified is actually true. Never assume payment succeeded
  // just because the buyer reached this screen.
  const isManualReview = !isPremium && stars !== null && stars < 50;

  const [phase, setPhase] = useState<Phase>('confirming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const attemptsRef = useRef(0);

  const checkOnce = useCallback(async () => {
    try {
      const data = await getOrderStatus(orderId);
      if (data.fulfillmentStatus === 'completed') {
        setPhase('done');
        return true;
      }
      if (data.fulfillmentStatus === 'failed') {
        setPhase('failed');
        setErrorMsg(data.fulfillmentError || 'Delivery failed — our team has been notified.');
        return true;
      }
      if (!data.transactionVerified) {
        // Payment not confirmed on-chain yet — stay on the "Confirming"
        // screen regardless of order size. This is the step that was being
        // skipped entirely for sub-50-star orders.
        setPhase('confirming');
        return false;
      }
      // Payment is confirmed on-chain. From here it's either queued for
      // manual review (small star orders) or actively auto-delivering.
      if (isManualReview) {
        setPhase('review');
        return true; // stop the fast auto-poll; buyer checks manually from here
      }
      setPhase('delivering');
    } catch {
      // transient network hiccup — leave phase as-is
    }
    return false;
  }, [orderId, isManualReview]);

  // Every order polls every 3s until payment is confirmed on-chain (and,
  // for auto-fulfilled orders, until delivery completes too) — with a
  // 2-minute safety timeout, since on-chain confirmation is normally much
  // faster than that regardless of order size.
  useEffect(() => {
    let cancelled = false;
    const maxAttempts = 40; // ~2 minutes at 3s interval

    async function poll() {
      if (cancelled) return;
      attemptsRef.current += 1;
      const settled = await checkOnce();
      if (cancelled || settled) return;

      if (attemptsRef.current >= maxAttempts) {
        setPhase('timeout');
        return;
      }
      setTimeout(poll, 3000);
    }

    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkOnce]);

  async function handleCheckStatus() {
    setChecking(true);
    await checkOnce();
    setChecking(false);
  }

  const packageLabel = isPremium ? `Premium · ${premiumDuration} mo` : `${stars} Stars`;

  return (
    <div className="screen status-screen">
      <div className="status-sheet">
        {(phase === 'confirming' || phase === 'delivering') && (
          <>
            <div className="status-illustration">
              <WalletIllustration />
              <div className="status-ring" />
            </div>
            <h1 className="status-title">{phase === 'confirming' ? 'Confirming on-chain…' : 'Delivering your order…'}</h1>
            <p className="status-subtitle">
              {packageLabel} — {phase === 'confirming' ? 'usually 2 minutes or faster.' : 'almost there.'}
            </p>
          </>
        )}

        {phase === 'review' && (
          <>
            <div className="status-illustration">
              <WalletIllustration />
            </div>
            <h1 className="status-title">Payment confirmed — order under review</h1>
            <p className="status-subtitle">
              {packageLabel} — orders under 50 Stars are reviewed by our team and typically delivered within about 2
              hours. No need to wait here — check back any time with your order ID.
            </p>
            <div className="order-id-chip" data-testid="order-id-chip">{orderId}</div>
            <button className="btn-primary status-cta" onClick={handleCheckStatus} disabled={checking} data-testid="check-status-button">
              {checking ? 'Checking…' : 'Check status'}
            </button>
            <button className="btn-outline status-cta-secondary" onClick={onStartOver} data-testid="back-to-store-button">
              Back to store
            </button>
          </>
        )}

        {phase === 'done' && (
          <>
            <div className="status-illustration">
              <CheckIllustration />
            </div>
            <h1 className="status-title">Delivered!</h1>
            <p className="status-subtitle">
              {isPremium
                ? `Telegram Premium (${premiumDuration} months) is on its way to your account.`
                : `${stars} Stars have been delivered.`}
            </p>
            <button className="btn-primary status-cta" onClick={onStartOver} data-testid="buy-again-button">
              Buy again
            </button>
          </>
        )}

        {(phase === 'failed' || phase === 'timeout') && (
          <>
            <div className="fail-badge">!</div>
            <h1 className="status-title">{phase === 'timeout' ? 'Still confirming' : 'Delivery failed'}</h1>
            <p className="status-subtitle">
              {phase === 'timeout' ? 'This is taking longer than usual. Keep your order ID for support:' : errorMsg}
            </p>
            <div className="order-id-chip" data-testid="order-id-chip">{orderId}</div>
            {phase === 'timeout' && (
              <button className="btn-primary status-cta" onClick={handleCheckStatus} disabled={checking} data-testid="check-status-button">
                {checking ? 'Checking…' : 'Check status'}
              </button>
            )}
            <button className="btn-outline status-cta" onClick={onStartOver} data-testid="back-to-store-button">
              Back to store
            </button>
          </>
        )}
      </div>
    </div>
  );
}

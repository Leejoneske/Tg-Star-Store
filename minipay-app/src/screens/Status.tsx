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
  // take up to ~2 hours, so we don't make the buyer sit on a spinner for
  // that — show "under review" right away with the order ID instead.
  const isManualReview = !isPremium && stars !== null && stars < 50;

  const [phase, setPhase] = useState<Phase>(isManualReview ? 'review' : 'confirming');
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
      if (isManualReview) {
        setPhase('review');
      } else {
        setPhase(data.transactionVerified ? 'delivering' : 'confirming');
      }
    } catch {
      // transient network hiccup — leave phase as-is
    }
    return false;
  }, [orderId, isManualReview]);

  // Auto-fulfilled orders (premium, or 50+ stars): keep the fast spinner and
  // poll every 3s, with a 2-minute safety timeout since these are usually
  // done well before that.
  useEffect(() => {
    if (isManualReview) return;
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
  }, [isManualReview, checkOnce]);

  // Manual-review orders: one quiet check on load (in case it was already
  // handled fast), then leave it to the buyer to tap "Check status" — no
  // spinner, no 2-minute timeout, since this can legitimately take hours.
  useEffect(() => {
    if (isManualReview) checkOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManualReview]);

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
            <h1 className="status-title">Order under review</h1>
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
            <h1 className="status-title">{phase === 'timeout' ? 'Still processing' : 'Delivery failed'}</h1>
            <p className="status-subtitle">
              {phase === 'timeout' ? 'This is taking longer than usual. Keep your order ID for support:' : errorMsg}
            </p>
            <div className="order-id-chip" data-testid="order-id-chip">{orderId}</div>
            <button className="btn-outline status-cta" onClick={onStartOver} data-testid="back-to-store-button">
              Back to store
            </button>
          </>
        )}
      </div>
    </div>
  );
}

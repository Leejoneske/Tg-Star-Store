import { useEffect, useRef, useState } from 'react';
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

type Phase = 'confirming' | 'delivering' | 'done' | 'failed' | 'timeout';

export function Status({ orderId, stars, isPremium, premiumDuration, onStartOver }: StatusProps) {
  const [phase, setPhase] = useState<Phase>('confirming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const maxAttempts = 40; // ~2 minutes at 3s interval

    async function poll() {
      if (cancelled) return;
      attemptsRef.current += 1;
      try {
        const data = await getOrderStatus(orderId);
        if (cancelled) return;

        if (data.fulfillmentStatus === 'completed') {
          setPhase('done');
          return;
        }
        if (data.fulfillmentStatus === 'failed') {
          setPhase('failed');
          setErrorMsg(data.fulfillmentError || 'Delivery failed — our team has been notified.');
          return;
        }
        setPhase(data.transactionVerified ? 'delivering' : 'confirming');
      } catch {
        // transient network hiccup — keep polling
      }

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
  }, [orderId]);

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
              {packageLabel} — {phase === 'confirming' ? 'usually under a minute.' : 'almost there.'}
            </p>
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

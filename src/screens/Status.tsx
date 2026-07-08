import { useEffect, useRef, useState } from 'react';
import { HeroCard } from '../components/HeroCard';
import { StepTracker } from '../components/StepTracker';
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

  const stepIndex = phase === 'confirming' ? 1 : phase === 'delivering' ? 2 : phase === 'done' ? 3 : 1;

  return (
    <div className="screen status-screen">
      <HeroCard>
        <div className="hero-kicker">ORDER {orderId}</div>
        <div className="hero-package">
          {isPremium ? `Premium · ${premiumDuration} mo` : `${stars} ⭐ Stars`}
        </div>
        <div className="status-steptracker">
          <StepTracker steps={['Connect', 'Review', 'Delivered']} currentIndex={stepIndex} />
        </div>
      </HeroCard>

      <div className="card status-card">
        {phase === 'confirming' && (
          <>
            <div className="spinner" />
            <div className="status-title">Confirming on-chain…</div>
            <p className="status-body">This usually takes under a minute.</p>
          </>
        )}
        {phase === 'delivering' && (
          <>
            <div className="spinner" />
            <div className="status-title">Payment confirmed — delivering…</div>
            <p className="status-body">Almost there.</p>
          </>
        )}
        {phase === 'done' && (
          <>
            <div className="success-icon">
              <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                <path d="M7 15.5l5 5 11-12" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="status-title">Delivered!</div>
            <p className="status-body">
              {isPremium
                ? `Telegram Premium (${premiumDuration} months) is on its way to your account.`
                : `${stars} Stars have been delivered.`}
            </p>
            <button className="btn-secondary" onClick={onStartOver}>
              Buy again
            </button>
          </>
        )}
        {(phase === 'failed' || phase === 'timeout') && (
          <>
            <div className="fail-icon">!</div>
            <div className="status-title">
              {phase === 'timeout' ? 'Still processing' : 'Delivery failed'}
            </div>
            <p className="status-body">
              {phase === 'timeout'
                ? 'This is taking longer than usual. Keep your order ID for support:'
                : errorMsg}
            </p>
            <div className="order-id-chip">{orderId}</div>
            <button className="btn-secondary" onClick={onStartOver}>
              Back to store
            </button>
          </>
        )}
      </div>
    </div>
  );
}

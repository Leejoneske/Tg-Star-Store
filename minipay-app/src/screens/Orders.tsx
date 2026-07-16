import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { getMySession, saveSession, clearSession } from '../lib/session';
import { requestAuthNonce, verifyAuthSignature, getMyOrders, type MiniPayOrderSummary } from '../lib/api';
import { connectWallet, signMessage, isMiniPayAvailable } from '../lib/minipay';
import { extractErrorMessage } from '../lib/errors';
import './Orders.css';

function describeStatus(o: MiniPayOrderSummary): { text: string; tone: 'pending' | 'success' | 'fail' } {
  if (o.fulfillmentStatus === 'completed') return { text: 'Delivered', tone: 'success' };
  if (o.fulfillmentStatus === 'failed') return { text: 'Failed', tone: 'fail' };
  if (!o.transactionVerified) return { text: 'Confirming payment…', tone: 'pending' };
  const isManualReview = !o.isPremium && o.stars !== null && o.stars < 50;
  return { text: isManualReview ? 'Under review' : 'Delivering…', tone: 'pending' };
}

export function Orders({ onBack }: { onBack: () => void }) {
  const [session, setSession] = useState(getMySession());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<MiniPayOrderSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadOrders(token: string) {
    setLoading(true);
    setError(null);
    try {
      const list = await getMyOrders(token);
      setOrders(list);
    } catch (e) {
      // An expired/invalid token surfaces as a fetch failure — drop the
      // stale session so the buyer sees "Connect MiniPay" again instead of
      // a silent, confusing error.
      clearSession();
      setSession(null);
      setError(e instanceof Error ? e.message : 'Could not load orders — please sign in again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session) loadOrders(session.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignIn() {
    setConnecting(true);
    setError(null);
    try {
      const address = await connectWallet();
      const message = await requestAuthNonce(address);
      const signature = await signMessage(address, message);
      const token = await verifyAuthSignature(address, signature);
      saveSession(token, address);
      setSession({ token, address });
      await loadOrders(token);
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not sign in.'));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="screen orders-screen">
      <div className="orders-topbar">
        <button className="orders-icon-button" onClick={onBack} aria-label="Back" data-testid="orders-back-button">
          <ArrowLeft size={20} />
        </button>
        <div className="orders-title">My orders</div>
        {session ? (
          <button
            className="orders-icon-button"
            onClick={() => loadOrders(session.token)}
            aria-label="Refresh"
            disabled={loading}
            data-testid="orders-refresh-button"
          >
            <RefreshCw size={18} className={loading ? 'spinning' : ''} />
          </button>
        ) : (
          <span className="orders-icon-spacer" />
        )}
      </div>

      {!session && (
        <div className="card orders-signin">
          <p className="orders-signin-copy">Connect your wallet to see your past orders.</p>
          <button className="btn-primary" onClick={handleSignIn} disabled={connecting} data-testid="orders-signin-button">
            {connecting ? 'Connecting…' : 'Connect MiniPay'}
          </button>
          {!isMiniPayAvailable() && (
            <p className="orders-signin-hint">Open this page inside MiniPay to connect a wallet.</p>
          )}
          {error && (
            <div className="status-text error" data-testid="orders-signin-error">
              {error}
            </div>
          )}
        </div>
      )}

      {session && (
        <>
          {error && (
            <div className="status-text error" data-testid="orders-load-error">
              {error}
            </div>
          )}

          {loading && !orders && <div className="orders-empty">Loading your orders…</div>}

          {orders && orders.length === 0 && !loading && (
            <div className="orders-empty" data-testid="orders-empty-state">
              No orders yet from this wallet.
            </div>
          )}

          {orders && orders.length > 0 && (
            <div className="orders-list">
              {orders.map((o) => {
                const s = describeStatus(o);
                const label = o.isPremium ? `Premium · ${o.premiumDuration} mo` : `${o.stars} Stars`;
                return (
                  <div className="order-card" key={o.orderId} data-testid={`order-card-${o.orderId}`}>
                    <div className="order-card-top">
                      <span className="order-card-label">{label}</span>
                      <span className={`order-card-status ${s.tone}`}>{s.text}</span>
                    </div>
                    <div className="order-card-meta">
                      ${o.amountUsd.toFixed(2)} · {o.token} · {new Date(o.dateCreated).toLocaleDateString()}
                    </div>
                    <div className="order-card-id">{o.orderId}</div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

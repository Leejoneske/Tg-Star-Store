import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { SiTelegram } from '@icons-pack/react-simple-icons';
import { TelegramStarIcon } from '../components/CurrencyIcons';
import { isMiniPayAvailable, connectWallet, signMessage } from '../lib/minipay';
import { requestAuthNonce, verifyAuthSignature } from '../lib/api';
import { getMySession, saveSession } from '../lib/session';
import './Intro.css';

interface IntroProps {
  onContinue: () => void;
  onViewOrders: () => void;
}

export function Intro({ onContinue, onViewOrders }: IntroProps) {
  const [connecting, setConnecting] = useState(false);

  async function handleGetStarted() {
    setConnecting(true);
    try {
      if (isMiniPayAvailable() && !getMySession()) {
        const address = await connectWallet();
        const message = await requestAuthNonce(address);
        const signature = await signMessage(address, message);
        const token = await verifyAuthSignature(address, signature);
        saveSession(token, address);
      }
    } catch {
    } finally {
      setConnecting(false);
      onContinue();
    }
  }

  return (
    <div className="screen intro-screen">
      <div className="brand-row intro-brand">
        <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="StarStore" className="brand-icon" />
        <span className="brand-name intro-brand-name">StarStore</span>
      </div>

      <div className="intro-center">
        <div className="intro-hero">
          <div className="intro-icon-tile intro-icon-telegram">
            <SiTelegram size={24} color="white" />
          </div>
          <div className="intro-icon-tile intro-icon-star">
            <TelegramStarIcon size={30} />
          </div>
          <div className="intro-icon-tile intro-icon-wallet">
            <ShieldCheck size={26} color="var(--green)" strokeWidth={2.2} />
          </div>
        </div>

        <h1 className="intro-title">
          Buy Telegram Stars
          <br />
          with your wallet.
        </h1>
        <p className="intro-subtitle">Pay in cUSD, USDC, or USDT — Stars land in your Telegram account instantly.</p>
      </div>

      <div className="sticky-footer intro-footer">
        <button className="btn-primary intro-cta" onClick={handleGetStarted} disabled={connecting} data-testid="intro-get-started-button">
          {connecting ? 'Connecting…' : 'Get started'}
        </button>
        <button className="btn-intro-secondary intro-cta" onClick={onViewOrders} data-testid="intro-view-orders-button">
          I already have an order
        </button>
      </div>
    </div>
  );
}

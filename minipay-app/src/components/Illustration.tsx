// Icon illustrations used on the Status screen: a soft radial glow behind a
// clean lucide-react icon inside a rounded frame — consistent, crisp
// iconography instead of hand-traced shapes.
import { Check, Wallet } from 'lucide-react';

function GlowIcon({ icon: Icon, glowColor, frameBg }: { icon: typeof Check; glowColor: string; frameBg: string }) {
  return (
    <div className="glow-icon">
      <div className="glow-icon-halo" style={{ background: `radial-gradient(circle, ${glowColor} 0%, transparent 72%)` }} />
      <div className="glow-icon-frame" style={{ background: frameBg }}>
        <Icon size={30} color="white" strokeWidth={2.3} />
      </div>
    </div>
  );
}

export function CheckIllustration() {
  return <GlowIcon icon={Check} glowColor="var(--green)" frameBg="var(--green)" />;
}

export function WalletIllustration() {
  return <GlowIcon icon={Wallet} glowColor="var(--teal)" frameBg="var(--ink)" />;
}

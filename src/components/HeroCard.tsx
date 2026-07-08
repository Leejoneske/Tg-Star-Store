import type { ReactNode } from 'react';
import './HeroCard.css';

export function HeroCard({ children }: { children: ReactNode }) {
  return (
    <div className="hero-card">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-content">{children}</div>
    </div>
  );
}

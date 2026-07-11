import { Check } from 'lucide-react';
import { IconBadge } from './IconBadge';
import './PackageRow.css';

interface PackageRowProps {
  badge: 'star' | 'premium';
  title: string;
  subtitle: string;
  price: string;
  active: boolean;
  onClick: () => void;
}

export function PackageRow({ badge, title, subtitle, price, active, onClick }: PackageRowProps) {
  return (
    <button className={active ? 'pkg-row active' : 'pkg-row'} onClick={onClick} type="button">
      <IconBadge kind={badge} size={40} />
      <div className="pkg-row-text">
        <div className="pkg-row-title">{title}</div>
        <div className="pkg-row-subtitle">{subtitle}</div>
      </div>
      <div className="pkg-row-trailing">
        <div className="pkg-row-price">{price}</div>
        <div className={active ? 'pkg-row-check active' : 'pkg-row-check'}>
          {active && <Check size={12} color="white" strokeWidth={3} />}
        </div>
      </div>
    </button>
  );
}

import { Check } from 'lucide-react';
import './PackageRow.css';

interface PackageRowProps {
  title: string;
  subtitle: string;
  price: string;
  active: boolean;
  onClick: () => void;
}

// No per-row icon — the star/premium mark is shown once in the section
// title above the list instead of being repeated on every row.
export function PackageRow({ title, subtitle, price, active, onClick }: PackageRowProps) {
  return (
    <button className={active ? 'pkg-row active' : 'pkg-row'} onClick={onClick} type="button">
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

import { IconBadge } from './IconBadge';
import './ReviewHeader.css';

interface ReviewHeaderProps {
  badge: 'star' | 'premium';
  amount: string;
  packageLabel: string;
}

export function ReviewHeader({ badge, amount, packageLabel }: ReviewHeaderProps) {
  return (
    <div className="review-header">
      <div className="review-eyebrow">Confirm Transaction</div>
      <div className="review-hero">
        <IconBadge kind={badge} size={56} />
        <div className="review-amount" data-testid="review-total-amount">{amount}</div>
        <div className="review-package">{packageLabel}</div>
      </div>
      <p className="review-subtitle">Review the details below before paying with MiniPay.</p>
    </div>
  );
}

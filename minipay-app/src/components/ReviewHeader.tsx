import './ReviewHeader.css';

export function ReviewHeader() {
  return (
    <div className="review-header">
      <div className="review-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="12" fill="var(--blue)" />
          <path d="M7 12.5l3.2 3.2L17 8.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="review-title">Confirm your order</h1>
      <p className="review-subtitle">Review the details below before paying with MiniPay.</p>
    </div>
  );
}

import './ConfirmSummary.css';

export interface SummaryRow {
  label: string;
  value: string;
}

export function ConfirmSummary({ rows, totalLabel, totalValue }: { rows: SummaryRow[]; totalLabel: string; totalValue: string }) {
  return (
    <div className="card confirm-summary">
      {rows.map((r) => (
        <div className="confirm-row" key={r.label}>
          <span className="confirm-label">{r.label}</span>
          <span className="confirm-value">{r.value}</span>
        </div>
      ))}
      <div className="confirm-row confirm-total">
        <span className="confirm-label">{totalLabel}</span>
        <span className="confirm-value">{totalValue}</span>
      </div>
    </div>
  );
}

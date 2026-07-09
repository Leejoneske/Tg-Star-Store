import './NextSteps.css';

export interface Step {
  label: string;
  sublabel: string;
  done: boolean;
}

export function NextSteps({ steps }: { steps: Step[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="card next-steps">
      <div className="next-steps-header">
        <span className="next-steps-title">Next steps</span>
        <span className="next-steps-badge">
          {doneCount} of {steps.length}
        </span>
      </div>
      <div className="next-steps-track">
        <div className="next-steps-fill" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <div className="next-steps-list">
        {steps.map((step) => (
          <div className="next-step-row" key={step.label}>
            <div className={step.done ? 'next-step-check done' : 'next-step-check'}>
              {step.done && (
                <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                  <path d="M1 4.5L4 7.5L10 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <div>
              <div className={step.done ? 'next-step-label done' : 'next-step-label'}>{step.label}</div>
              <div className="next-step-sublabel">{step.sublabel}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

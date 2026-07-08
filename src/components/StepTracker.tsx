import './StepTracker.css';

interface StepTrackerProps {
  steps: string[];
  currentIndex: number; // 0-based index of the active/most-recent step
}

export function StepTracker({ steps, currentIndex }: StepTrackerProps) {
  return (
    <div className="step-tracker" role="list" aria-label="Order progress">
      {steps.map((label, i) => {
        const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
        return (
          <div className="step" data-state={state} key={label} role="listitem">
            <div className="step-bar" />
            <div className="step-label">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

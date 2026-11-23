export type StepState = "done" | "current" | "todo" | "skip";

export interface StepItem {
  label: string;
  state: StepState;
  detail?: React.ReactNode;
}

const SR: Record<StepState, string> = { done: "done", current: "in progress", todo: "to do", skip: "not needed" };

/** A short checklist that shows where a multi-transaction action stands. */
export function Steps({ items, label }: { items: StepItem[]; label: string }) {
  return (
    <ol className="steps" aria-label={label}>
      {items.map((item) => (
        <li key={item.label} className={`step step-${item.state}`} aria-current={item.state === "current" ? "step" : undefined}>
          <span className="step-dot" aria-hidden="true" />
          <span className="step-label">
            {item.label}
            <span className="sr-only"> ({SR[item.state]})</span>
          </span>
          {item.detail ? <span className="step-detail small">{item.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

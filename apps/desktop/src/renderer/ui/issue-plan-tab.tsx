import type { Task } from "@loom/core";
import { useStore } from "../store/react.js";

export function IssuePlanTab({ task }: { task: Task }) {
  const plan = useStore((s) => s.snapshot.plans[task.id]);
  const approval = useStore((s) =>
    s.snapshot.approvals.find(
      (item) => item.taskId === task.id && item.kind === "plan",
    ),
  );
  if (!plan) {
    return (
      <div className="pad faint">
        No plan yet. A planner run writes it before Todo leaves the queue.
      </div>
    );
  }
  return (
    <div className="pad">
      <div className="section-title">Goal</div>
      <div>{plan.goal}</div>
      {approval ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <span className={`chip ${approval.voidedAt ? "danger" : "good"}`}>
            {approval.voidedAt ? `voided: ${approval.voidReason}` : "approved"}
          </span>{" "}
          plan v{approval.kind === "plan" ? approval.planVersion : 0}
        </div>
      ) : null}
      <div className="section-title">Non-goals</div>
      <ul className="plain">
        {plan.nonGoals.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Steps</div>
      {plan.steps.map((step, index) => (
        <div className="panel" key={step.title}>
          <strong>
            {index + 1}. {step.title}
          </strong>
          <div className="dim">{step.detail}</div>
        </div>
      ))}
      <div className="section-title">Areas</div>
      <div className="detail-meta">
        {plan.areas.map((area) => (
          <span className="chip mono" key={area}>
            {area}
          </span>
        ))}
      </div>
      <div className="section-title">Acceptance criteria</div>
      <ul className="plain">
        {plan.acceptanceCriteria.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Test plan</div>
      <ul className="plain">
        {plan.testPlan.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="section-title">Risks</div>
      <ul className="plain">
        {plan.risks.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {plan.openQuestions.length > 0 ? (
        <>
          <div className="section-title">Open questions</div>
          <ul className="plain">
            {plan.openQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

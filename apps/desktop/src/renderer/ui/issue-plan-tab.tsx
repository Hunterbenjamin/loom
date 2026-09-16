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
    <div className="pr-overview issue-plan">
      <main className="pr-story">
        <section className="pr-description">
          <h3>Goal</h3>
          <div>{plan.goal}</div>
        </section>
        <PlanList title="Non-goals" items={plan.nonGoals} />
        <section className="pr-description">
          <h3>Steps</h3>
          <ol className="issue-plan-steps">
            {plan.steps.map((step, index) => (
              <li key={`${index}:${step.title}`}>
                <strong>{step.title}</strong>
                <div className="dim">{step.detail}</div>
              </li>
            ))}
          </ol>
        </section>
        <PlanList title="Acceptance criteria" items={plan.acceptanceCriteria} />
        <PlanList title="Test plan" items={plan.testPlan} />
        <PlanList title="Risks" items={plan.risks} />
        {plan.openQuestions.length > 0 ? (
          <PlanList title="Open questions" items={plan.openQuestions} />
        ) : null}
      </main>
      <aside className="pr-rail" aria-label="Plan properties">
        <section>
          <h3>Approval</h3>
          {approval ? (
            <div className="pr-property overview-status">
              <span className={`chip ${approval.voidedAt ? "danger" : "good"}`}>
                {approval.voidedAt ? `voided: ${approval.voidReason}` : "approved"}
              </span>
              <span>
                plan v{approval.kind === "plan" ? approval.planVersion : 0}
              </span>
            </div>
          ) : (
            <div className="pr-property faint">Not approved</div>
          )}
        </section>
        <section>
          <h3>Version</h3>
          <div className="pr-property">plan v{plan.version}</div>
        </section>
        <section>
          <h3>Areas</h3>
          <div className="detail-meta">
            {plan.areas.map((area) => (
              <span className="chip mono" key={area}>
                {area}
              </span>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="pr-description">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

import { useBriefState } from "../store/brief-state.js";
import { Group } from "./settings-fields.js";

export function BriefSettings() {
  const { state, error, busy, act } = useBriefState();
  return (
    <Group
      title="Daily brief"
      description="Daily at 7:00 a.m. · Asia/Makassar · Claude Sonnet, $3 limit per run. Applies immediately to this instance, across all repositories."
    >
      <div className="settings-row">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor="brief-schedule">
            Daily schedule
          </label>
          <div className="settings-row-description">
            The coordinator must be running. After sleep, today’s missed brief
            runs when it wakes.
          </div>
        </div>
        <input
          id="brief-schedule"
          type="checkbox"
          checked={state?.schedule.enabled ?? false}
          disabled={!state || busy}
          onChange={(event) =>
            void act({
              kind: "set_brief_schedule",
              enabled: event.target.checked,
            })
          }
        />
      </div>
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}
    </Group>
  );
}

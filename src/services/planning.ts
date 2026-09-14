import type { Entity } from "../domain/types.js";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function timestamp(value: unknown): number | null {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : null;
}
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];
}
export function submissionFor(a: Entity, submissions: Entity[]): Entity | null {
  return (
    submissions.find(
      (s) =>
        s.course_id === a.course_id &&
        String(s.data.assignment_id ?? s.id) === a.id,
    ) ?? null
  );
}

function effectiveWork(a: Entity, submission: Entity | null) {
  const data = submission?.data ?? record(a.data.submission);
  return {
    data,
    due: timestamp(data.cached_due_date) ?? timestamp(a.data.due_at),
  };
}

export function classifyWork(
  a: Entity,
  submission: Entity | null,
  now = new Date(),
) {
  const { data: s, due } = effectiveWork(a, submission);
  const known = Object.keys(s).length > 0;
  const state = text(s.workflow_state);
  const excused = s.excused === true;
  const complete =
    excused ||
    state === "graded" ||
    state === "submitted" ||
    state === "pending_review" ||
    timestamp(s.submitted_at) !== null;
  const missing = typeof s.missing === "boolean" ? s.missing : null;
  const late = typeof s.late === "boolean" ? s.late : null;
  const types = strings(a.data.submission_types);
  const online = types.some(
    (t) => !["none", "not_graded", "on_paper"].includes(t),
  );
  const pastDue =
    !complete &&
    known &&
    online &&
    state === "unsubmitted" &&
    due !== null &&
    due < now.getTime();
  const failed = ["failed", "incomplete"].includes(state ?? "");
  return {
    missing: excused ? false : missing,
    late,
    past_due_unsubmitted: pastDue,
    failed_or_incomplete: failed,
    submission_known: known,
    workflow_state: state,
    excused,
    complete,
    needs_work: !excused && (missing === true || !complete),
    reasons: [
      missing === true && !excused ? "Canvas explicitly flags missing" : null,
      late ? "Canvas explicitly flags late" : null,
      pastDue
        ? "Past due with an explicit unsubmitted state (not a Canvas missing flag)"
        : null,
      failed ? `Canvas submission state: ${state}` : null,
      !known ? "Submission state unavailable" : null,
    ].filter((x): x is string => x !== null),
  };
}

export function prioritize(
  a: Entity,
  submission: Entity | null,
  group: Entity | null,
  now = new Date(),
) {
  const state = classifyWork(a, submission, now);
  const { data: s, due } = effectiveWork(a, submission);
  const days = due === null ? null : (due - now.getTime()) / 86400000;
  let score = days === null ? 0 : days < 0 ? 60 : Math.max(0, 50 - days * 5);
  const reasons = [...state.reasons];
  if (days !== null)
    reasons.push(
      days < 0 ? "Due date has passed" : `Due in ${Math.ceil(days)} day(s)`,
    );
  const points = numeric(a.data.points_possible);
  if (points !== null) {
    score += Math.min(20, Math.max(0, points / 5));
    reasons.push(`${points} points possible; not a calculated grade impact`);
  }
  const weight = numeric(group?.data.group_weight);
  if (weight !== null) {
    score += Math.min(10, Math.max(0, weight / 5));
    reasons.push(`Assignment group weight: ${weight}%`);
  }
  if (state.missing) score += 20;
  const limit = numeric(a.data.allowed_attempts);
  const attempted = numeric(s.attempt);
  const remaining =
    limit === null || limit < 0 || attempted === null
      ? null
      : Math.max(0, limit - attempted);
  const lock = timestamp(a.data.lock_at);
  const unlock = timestamp(a.data.unlock_at);
  const locked =
    a.data.locked_for_user === true ||
    (lock !== null && lock <= now.getTime()) ||
    (unlock !== null && unlock > now.getTime());
  if (locked)
    reasons.push("Currently locked or outside the availability window");
  if (remaining === 0) reasons.push("No submission attempts remaining");
  if (remaining === 1) {
    score += 3;
    reasons.push("One submission attempt remaining");
  }
  const actionable = state.needs_work && !locked && remaining !== 0;
  if (!actionable) score = 0;
  return {
    assignment: a,
    score: Math.round(score * 100) / 100,
    actionable,
    reasons,
    state,
    days_until_due: days,
    remaining_attempts: remaining,
    estimated_effort: null,
    group_weight: weight,
    prerequisite_assessment:
      "See module prerequisites in assignment context; no effort or grade impact inferred",
  };
}

export function upcoming(
  assignments: Entity[],
  submissions: Entity[],
  days = 7,
  now = new Date(),
  groups: Entity[] = [],
) {
  const horizon = now.getTime() + days * 86400000;
  return assignments
    .filter((a) => {
      const s = submissionFor(a, submissions);
      const { due } = effectiveWork(a, s);
      return (
        due !== null &&
        due >= now.getTime() &&
        due <= horizon &&
        classifyWork(a, s, now).needs_work
      );
    })
    .map((a) =>
      prioritize(
        a,
        submissionFor(a, submissions),
        groups.find(
          (g) =>
            g.id === String(a.data.assignment_group_id) &&
            g.course_id === a.course_id,
        ) ?? null,
        now,
      ),
    )
    .sort(
      (a, b) =>
        b.score - a.score || a.assignment.id.localeCompare(b.assignment.id),
    );
}

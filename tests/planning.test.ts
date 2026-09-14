import { describe, it, expect } from "vitest";
import {
  classifyWork,
  prioritize,
  upcoming,
} from "../src/services/planning.js";
import type { Entity } from "../src/domain/types.js";
const now = new Date("2026-09-14T12:00:00Z");
const assignment = (data: Record<string, unknown> = {}): Entity => ({
  kind: "assignments",
  id: "10",
  course_id: "1",
  title: "Project",
  updated_at: null,
  data: {
    due_at: "2026-09-15T12:00:00Z",
    points_possible: 100,
    submission_types: ["online_upload"],
    ...data,
  },
  raw: {},
});
const submission = (data: Record<string, unknown>): Entity => ({
  kind: "submissions",
  id: "10",
  course_id: "1",
  title: "",
  updated_at: null,
  data,
  raw: {},
});
describe("academic state and priority", () => {
  it("keeps explicit not-missing distinct from past-due unsubmitted", () => {
    const a = assignment({ due_at: "2026-09-12T12:00:00Z" });
    expect(
      classifyWork(
        a,
        submission({ missing: false, workflow_state: "unsubmitted" }),
        now,
      ),
    ).toMatchObject({ missing: false, past_due_unsubmitted: true });
  });
  it("does not infer absent submission state or off-platform work is missing", () => {
    const a = assignment({ due_at: "2026-09-12T12:00:00Z" });
    expect(classifyWork(a, null, now)).toMatchObject({
      missing: null,
      past_due_unsubmitted: false,
      submission_known: false,
    });
    expect(
      classifyWork(
        assignment({ ...a.data, submission_types: ["on_paper"] }),
        submission({ workflow_state: "unsubmitted" }),
        now,
      ).past_due_unsubmitted,
    ).toBe(false);
  });
  it("excludes excused work and recognizes graded zero as completed", () => {
    expect(
      classifyWork(
        assignment(),
        submission({ excused: true, missing: true }),
        now,
      ).needs_work,
    ).toBe(false);
    expect(
      classifyWork(
        assignment(),
        submission({ workflow_state: "graded", score: 0 }),
        now,
      ).needs_work,
    ).toBe(false);
  });
  it("explains locked work and exhausted attempts without inventing effort", () => {
    const p = prioritize(
      assignment({ locked_for_user: true, allowed_attempts: 1 }),
      submission({ attempt: 1, workflow_state: "unsubmitted" }),
      null,
      now,
    );
    expect(p.actionable).toBe(false);
    expect(p.reasons.join(" ")).toMatch(/locked/i);
    expect(p.estimated_effort).toBeNull();
  });
  it("uses embedded submission due dates consistently when detail records are absent", () => {
    const embedded = (due_at: string | null, cached_due_date: string) =>
      assignment({
        due_at,
        submission: { workflow_state: "unsubmitted", cached_due_date },
      });
    const extended = embedded("2026-09-12T12:00:00Z", "2026-09-15T12:00:00Z");
    const undated = { ...embedded(null, "2026-09-16T12:00:00Z"), id: "11" };
    const later = {
      ...embedded("2026-09-15T12:00:00Z", "2026-10-01T12:00:00Z"),
      id: "12",
    };
    const overdue = {
      ...embedded("2026-09-15T12:00:00Z", "2026-09-13T12:00:00Z"),
      id: "13",
    };
    const result = upcoming([extended, undated, later, overdue], [], 7, now);
    expect(result.map((x) => x.assignment.id)).toEqual(["10", "11"]);
    expect(result.map((x) => x.days_until_due)).toEqual([1, 2]);
    expect(result[0]).toEqual(prioritize(extended, null, null, now));
    expect(classifyWork(extended, null, now).past_due_unsubmitted).toBe(false);
    expect(classifyWork(overdue, null, now).past_due_unsubmitted).toBe(true);
    const detail = submission({
      workflow_state: "unsubmitted",
      cached_due_date: "2026-10-01T12:00:00Z",
    });
    expect(upcoming([extended], [detail], 7, now)).toEqual([]);
  });
  it("includes horizon boundaries and omits undated or completed work", () => {
    const work = [
      assignment(),
      { ...assignment({ due_at: null }), id: "11" },
      { ...assignment({ due_at: "2026-09-21T12:00:00Z" }), id: "12" },
    ];
    expect(upcoming(work, [], 7, now).map((x) => x.assignment.id)).toEqual([
      "10",
      "12",
    ]);
  });
});

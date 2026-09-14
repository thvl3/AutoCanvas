import { describe, expect, it } from "vitest";
import type { Entity, EntityKind } from "../src/domain/types.js";
import {
  detectExam,
  examStudyContext,
  listExams,
} from "../src/services/exam-context.js";

function e(
  kind: EntityKind,
  id: string,
  course_id = "1",
  data: Record<string, unknown> = {},
): Entity {
  return {
    kind,
    id,
    course_id,
    title: String(data.title ?? data.name ?? `${kind} ${id}`),
    updated_at: null,
    data: { id, ...data },
    raw: { id, ...data },
  };
}

class FakeRepo {
  rows = new Map<string, Entity[]>();
  set(kind: EntityKind, courseId: string, entities: Entity[]): void {
    this.rows.set(`${kind}:${courseId}`, entities);
  }
  list(kind: EntityKind, courseId?: string): Entity[] {
    if (courseId !== undefined)
      return this.rows.get(`${kind}:${courseId}`) ?? [];
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${kind}:`))
      .flatMap(([, value]) => value);
  }
  get(kind: EntityKind, id: string, courseId?: string): Entity | undefined {
    return this.list(kind, courseId).find((entity) => entity.id === id);
  }
  syncState(): unknown {
    return { run: { status: "complete" } };
  }
}

function scenario() {
  const repo = new FakeRepo();
  repo.set("courses", "1", [e("courses", "1", null, { name: "Course" })]);
  repo.set("modules", "1", [
    e("modules", "m1", "1", { position: 1, name: "Foundations" }),
    e("modules", "m2", "1", { position: 2, name: "Application" }),
    e("modules", "m3", "1", { position: 3, name: "Exam week" }),
  ]);
  const exam = e("assignments", "exam", "1", {
    name: "Midterm Exam",
    due_at: "2026-03-15T00:00:00Z",
    points_possible: 100,
  });
  const a1 = e("assignments", "a1", "1", {
    name: "Homework 1",
    due_at: "2026-03-01T00:00:00Z",
  });
  const a2 = e("assignments", "a2", "1", {
    name: "Homework 2",
    due_at: "2026-03-10T00:00:00Z",
  });
  const a3 = e("assignments", "a3", "1", {
    name: "Homework 3",
    due_at: "2026-03-20T00:00:00Z",
  });
  repo.set("assignments", "1", [exam, a1, a2, a3]);
  repo.set("module_items", "1", [
    e("module_items", "i1", "1", {
      module_id: "m1",
      position: 1,
      type: "Assignment",
      content_id: "a1",
    }),
    e("module_items", "i2", "1", {
      module_id: "m2",
      position: 1,
      type: "Assignment",
      content_id: "a2",
    }),
    e("module_items", "i3", "1", {
      module_id: "m2",
      position: 2,
      type: "Page",
      page_url: "reading",
      content_id: "page2",
    }),
    e("module_items", "i4", "1", {
      module_id: "m3",
      position: 1,
      type: "Page",
      page_url: "review",
      content_id: "page3",
    }),
    e("module_items", "i5", "1", {
      module_id: "m3",
      position: 2,
      type: "Assignment",
      content_id: "exam",
    }),
    e("module_items", "i6", "1", {
      module_id: "m3",
      position: 3,
      type: "Assignment",
      content_id: "a3",
    }),
  ]);
  repo.set("pages", "1", [
    e("pages", "page2", "1", { url: "reading", body: "<p>Read this</p>" }),
    e("pages", "page3", "1", { url: "review", body: "<p>Review this</p>" }),
  ]);
  repo.set("files", "1", [e("files", "f1", "1", { filename: "notes.pdf" })]);
  return { repo, exam, a1, a2, a3 };
}

describe("detectExam", () => {
  it.each([
    ["Midterm Exam", true],
    ["Final Exam", true],
    ["Quiz 3", true],
    ["Unit Test", true],
    ["Midterm Self-Grade", false],
    ["Final Self-Grade", false],
    ["W13 End-of-Course Evaluation", false],
    ["W05 Student Feedback to Instructor", false],
    ["Week 01 Tasks", false],
  ])("classifies %j as exam=%s", (title, expected) => {
    expect(detectExam(e("assignments", "x", "1", { name: title }))).toEqual(
      expected
        ? { is_exam: true, reason: "name_match" }
        : { is_exam: false, reason: null },
    );
  });
});

describe("listExams", () => {
  it("returns only name-detected exams across courses with detection reason", () => {
    const { repo } = scenario();
    const exams = listExams(repo, "1");
    expect(exams).toEqual([
      expect.objectContaining({
        assignment_id: "exam",
        title: "Midterm Exam",
        detection: { is_exam: true, reason: "name_match" },
      }),
    ]);
  });
});

describe("examStudyContext", () => {
  it("resolves taught-order and due-date views preceding the exam", () => {
    const { repo, exam } = scenario();
    const context = examStudyContext(repo, "1", exam.id);
    expect(context.detection).toEqual({ is_exam: true, reason: "name_match" });
    expect(context.by_module_position.modules.map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(context.by_module_position.items.map((i) => i.id)).toEqual([
      "i1",
      "i2",
      "i3",
      "i4",
    ]);
    expect(context.by_module_position.assignments.map((a) => a.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(context.by_module_position.pages.map((p) => p.id)).toEqual([
      "page2",
      "page3",
    ]);
    expect(context.by_due_date.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
  it("treats an explicitly selected non-matching assignment as a manual override", () => {
    const { repo, a3 } = scenario();
    const context = examStudyContext(repo, "1", a3.id);
    expect(context.detection).toEqual({
      is_exam: true,
      reason: "manual_override",
    });
    // a3 (due 03-20) is a manual override; everything due before it — including
    // the named Midterm Exam (03-15) — is its due-date view.
    expect(context.by_due_date.map((a) => a.id)).toEqual(["a1", "a2", "exam"]);
  });
  it("excludes the exam itself from both views and honors include_rubric", () => {
    const { repo, exam } = scenario();
    const withRubric = examStudyContext(repo, "1", exam.id, {
      include_rubric: true,
    });
    expect(withRubric.by_due_date.map((a) => a.id)).not.toContain("exam");
    expect(withRubric.by_module_position.items.map((i) => i.id)).not.toContain(
      "i5",
    );
    const noRubric = examStudyContext(repo, "1", exam.id, {
      include_rubric: false,
    });
    expect(noRubric.rubric).toBeNull();
  });
});

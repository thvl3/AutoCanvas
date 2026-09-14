import { expect, it } from "vitest";
import type { Entity, EntityKind } from "../src/domain/types.js";
import {
  assignmentContext,
  studyContext,
} from "../src/services/assignment-context.js";
const e = (
  kind: EntityKind,
  id: string,
  data: Record<string, unknown> = {},
): Entity => ({
  kind,
  id,
  course_id: kind === "courses" ? null : "1",
  title: String(data.title ?? id),
  updated_at: null,
  data,
  raw: {},
});
const entities = [
  e("courses", "1"),
  e("assignments", "10", {
    description:
      '<p>Build a graph. <a href="/courses/1/files/50/download">starter</a></p>',
    rubric: [{ description: "Tests", points: 10 }],
    assignment_group_id: "3",
  }),
  e("assignment_groups", "3"),
  e("modules", "20", { prerequisite_module_ids: ["19"] }),
  e("module_items", "30", {
    module_id: "20",
    type: "Assignment",
    content_id: "10",
  }),
  e("module_items", "31", {
    module_id: "20",
    type: "Page",
    page_url: "graphs",
  }),
  e("module_items", "32", {
    module_id: "20",
    type: "ExternalUrl",
    external_url: "https://example.edu/reading",
  }),
  e("pages", "40", { url: "graphs", body: "Graph readings" }),
  e("files", "50", { filename: "starter.zip" }),
  e("submissions", "10", {
    assignment_id: "10",
    workflow_state: "unsubmitted",
    submission_comments: [{ comment: "Add tests" }],
  }),
  e("announcements", "60", { message: "Review /assignments/10 before Sunday" }),
  e("discussions", "70", { assignment_id: "10" }),
];
const repo = {
  list: (kind: EntityKind, course?: string) =>
    entities.filter(
      (e) => e.kind === kind && (!course || e.course_id === course),
    ),
  get: (kind: EntityKind, id: string, course?: string) =>
    entities.find(
      (e) =>
        e.kind === kind && e.id === id && (!course || e.course_id === course),
    ),
  syncState: () => ({ completed_at: "2026-09-14T12:00:00Z" }),
};
it("aggregates module pages, linked files, rubric and instructor feedback", () => {
  const c = assignmentContext(repo, "1", "10");
  expect(c.modules[0]?.id).toBe("20");
  expect(c.related_pages[0]?.id).toBe("40");
  expect(c.files[0]?.id).toBe("50");
  expect(c.assignment_group?.id).toBe("3");
  expect(c.submission?.data.submission_comments).toEqual([
    { comment: "Add tests" },
  ]);
  expect(c.external_links).toEqual(["https://example.edu/reading"]);
  expect(c.announcements).toHaveLength(1);
  expect(c.discussions).toHaveLength(1);
});
it.each([
  ["Review /assignments/100 before Sunday", false],
  ['<a href="/courses/1/assignments/100">Review</a>', false],
  ['<a href="https://canvas.test/courses/2/assignments/10">Review</a>', false],
  ["Review /assignments/10extra", false],
  ['<a href="/courses/1/assignments/10.json">Review</a>', false],
  ["Review /assignments/10.5", false],
  ["Review /assignments/10.", true],
  ["Review (/courses/1/assignments/10).", true],
  [
    '<a href="//canvas.test/courses/1/assignments/10?module_item_id=2&amp;x=1">Review</a>',
    true,
  ],
  ['<a href="/courses/1/assignments/10#details">Review</a>', true],
  ["Review /assignments/10/submissions", true],
])("matches exact course-scoped assignment links in %j", (message, matches) => {
  const announcement = e("announcements", "review", { message });
  const testRepo = {
    ...repo,
    list: (kind: EntityKind, course?: string) =>
      kind === "announcements" ? [announcement] : repo.list(kind, course),
  };
  expect(assignmentContext(testRepo, "1", "10").announcements).toEqual(
    matches ? [announcement] : [],
  );
});

it("honors assignment context include flags and course boundaries", () => {
  const c = assignmentContext(repo, "1", "10", {
    include_files: false,
    include_rubric: false,
    include_related_module: false,
    include_announcements: false,
  });
  expect(c.files).toEqual([]);
  expect(c.rubric).toBeNull();
  expect(c.modules).toEqual([]);
  expect(c.announcements).toEqual([]);
  expect(() => assignmentContext(repo, "2", "10")).toThrow(/not found/i);
});
it("study retrieval returns source material for selected modules without generated concepts", () => {
  const c = studyContext(repo, "1", { module_ids: ["20"] });
  expect(c.pages[0]?.id).toBe("40");
  expect(c.assignments[0]?.id).toBe("10");
  expect(c.key_concepts).toBeNull();
  expect(() => studyContext(repo, "1", { module_ids: ["99"] })).toThrow(
    /not found/i,
  );
});

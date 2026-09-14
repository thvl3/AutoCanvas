import { describe, it, expect } from "vitest";
import { normalize } from "../src/domain/normalize.js";
import { entityKinds } from "../src/domain/types.js";

describe("Canvas normalization", () => {
  it("validates calendar dates and preserves explicitly unzoned ISO values without guessing a timezone", () => {
    for (const due_at of [
      "2026-02-30T12:00:00Z",
      {},
      42,
      "2026-09-15 garbage",
    ]) {
      expect(() => normalize("assignments", { id: 1, due_at })).toThrow(
        /Invalid Canvas assignments payload/,
      );
    }
    const entity = normalize(
      "pages",
      { page_id: 1, title: "Scheduled", publish_at: "2026-09-15T00:00:00" },
      "7",
    );
    expect(entity.data.publish_at).toBe("2026-09-15T00:00:00");
  });
  it("uses kind-specific identities and titles including planner wrappers and unsubmitted work", () => {
    const examples = [
      ["courses", { id: 7, name: "Biology" }, "7", "Biology", null],
      ["assignment_groups", { id: 1, name: "Homework" }, "1", "Homework", "7"],
      ["modules", { id: 2, name: "Week 1" }, "2", "Week 1", "7"],
      [
        "module_items",
        { id: 3, title: "Reading", type: "Page", content_id: 9 },
        "3",
        "Reading",
        "7",
      ],
      [
        "pages",
        { page_id: 9, url: "intro", title: "Introduction" },
        "9",
        "Introduction",
        "7",
      ],
      [
        "files",
        {
          id: 10,
          display_name: "guide.pdf",
          "content-type": "application/pdf",
        },
        "10",
        "guide.pdf",
        "7",
      ],
      [
        "discussions",
        { id: 11, title: "Week 1 discussion" },
        "11",
        "Week 1 discussion",
        "7",
      ],
      ["announcements", { id: 12, title: "Welcome" }, "12", "Welcome", "7"],
      [
        "enrollments",
        { id: 13, type: "StudentEnrollment", user_id: 2 },
        "13",
        "StudentEnrollment",
        "7",
      ],
      [
        "rubrics",
        { id: "_criterion", description: "Clarity", points: 10 },
        "_criterion",
        "Clarity",
        "7",
      ],
      [
        "submissions",
        {
          id: null,
          assignment_id: 42,
          user_id: 2,
          workflow_state: "unsubmitted",
        },
        "42:2",
        "Submission 42",
        "7",
      ],
      [
        "planner",
        {
          plannable_id: 42,
          plannable_type: "assignment",
          plannable: { id: 42, title: "Essay" },
          plannable_date: "2026-09-15T00:00:00Z",
        },
        "assignment:42",
        "Essay",
        "7",
      ],
      [
        "planner",
        {
          type: "submitting",
          assignment: { id: 42, name: "Essay", course_id: 7 },
        },
        "todo:submitting:42",
        "Essay",
        "7",
      ],
    ] as const;
    for (const [kind, raw, id, title, course_id] of examples) {
      expect(
        normalize(kind, raw, kind === "courses" ? undefined : "7"),
      ).toMatchObject({ kind, id, title, course_id });
    }
    expect(
      normalize(
        "planner",
        {
          plannable_id: 42,
          plannable_type: "assignment",
          plannable: { id: 42, title: "Essay" },
          plannable_date: "2026-09-15T00:00:00Z",
        },
        "7",
      ).data.plannable_date,
    ).toBe("2026-09-15T00:00:00.000Z");
  });
  it("rejects invalid shapes, unsafe numeric IDs and malformed dates without echoing payloads", () => {
    for (const raw of [
      null,
      [],
      "private-token",
      {},
      { id: true },
      { id: 9007199254740992 },
      { id: 1, name: 12 },
      { id: 1, due_at: "private-token" },
      { id: 1, submission: "private-token" },
      { id: 1, rubric: "private-token" },
      { id: 1, points_possible: "private-token" },
      { id: 1, course_id: { secret: "private-token" } },
    ]) {
      expect(() => normalize("assignments", raw)).toThrow(
        /^Invalid Canvas assignments payload/,
      );
    }
    expect(() =>
      normalize("assignments", { id: 1, course_id: 8 }, "7"),
    ).toThrow(/course context mismatch/);
    expect(
      normalize(
        "assignments",
        { id: "9007199254740993", name: "Large id" },
        "7",
      ).id,
    ).toBe("9007199254740993");
  });
  it("normalizes assignment identity, nested IDs and timestamps while preserving a separate raw payload", () => {
    const raw = {
      id: 42,
      course_id: 7,
      name: "Essay",
      due_at: "2026-09-15T13:00:00-06:00",
      updated_at: "2026-09-10T00:00:00Z",
      points_possible: 15,
      published: true,
      submission: { id: 9, user_id: 2, submitted_at: null },
      rubric: [
        { id: "_criterion", points: 5, ratings: [{ id: 11, points: 5 }] },
      ],
      assignment_ids: [1, 2],
      description: "<p>Write</p>",
    };
    const entity = normalize("assignments", raw);
    expect(entity).toMatchObject({
      kind: "assignments",
      id: "42",
      course_id: "7",
      title: "Essay",
      updated_at: "2026-09-10T00:00:00.000Z",
      data: {
        id: "42",
        course_id: "7",
        due_at: "2026-09-15T19:00:00.000Z",
        submission: { id: "9", user_id: "2", submitted_at: null },
        assignment_ids: ["1", "2"],
        rubric: [{ id: "_criterion", ratings: [{ id: "11" }] }],
        description: "<p>Write</p>",
        points_possible: 15,
        published: true,
      },
      raw,
    });
    expect(entity.data).not.toBe(entity.raw);
    expect(entityKinds).toEqual([
      "courses",
      "assignments",
      "assignment_groups",
      "modules",
      "module_items",
      "pages",
      "files",
      "discussions",
      "announcements",
      "submissions",
      "rubrics",
      "enrollments",
      "planner",
    ]);
  });
});

import { expect, it, vi } from "vitest";
import { Repository } from "../src/db/repository.js";
import { AcademicService, publicData } from "../src/services/academic.js";
import type { Entity, EntityKind } from "../src/domain/types.js";
const entities: Entity[] = [
  {
    kind: "courses",
    id: "1",
    course_id: null,
    title: "Algorithms",
    updated_at: null,
    data: {},
    raw: { secret: "raw" },
  },
  {
    kind: "assignments",
    id: "2",
    course_id: "1",
    title: "Graph lab",
    updated_at: null,
    data: { due_at: "2099-09-16T12:00:00Z", points_possible: 20 },
    raw: {},
  },
  {
    kind: "enrollments",
    id: "3",
    course_id: "1",
    title: "Student",
    updated_at: null,
    data: {
      grades: { current_score: 82, current_grade: "B", final_score: 70 },
    },
    raw: {},
  },
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
  syncState: () => null,
  recentChanges: () => [],
};
it("paginates read queries and fails unknown objects", async () => {
  const service = new AcademicService(repo);
  expect(
    await service.invoke("canvas_list_courses", { limit: 1, offset: 0 }),
  ).toMatchObject({ total: 1, has_more: false, items: [{ id: "1" }] });
  await expect(
    service.invoke("canvas_get_course", { course_id: "9" }),
  ).rejects.toThrow(/not found/i);
});
it("reports real grade fields without estimating grades", async () => {
  const result = await new AcademicService(repo).invoke(
    "canvas_get_grade_summary",
    {},
  );
  expect(result).toMatchObject({
    courses: [
      { course_id: "1", grades: [{ current_score: 82, final_score: 70 }] },
    ],
  });
});
it.each([
  "/courses/1/files/50/download",
  "//canvas.test/courses/1/files/50/download",
  "courses/1/files/50/download",
  "./files/50/download",
  "../files/50/download",
  "https://canvas.test/courses/1/files/50/download",
  "",
])(
  "strips signed queries from URL reference %j without rewriting surrounding text",
  (path) => {
    const signed = `${path}?download=1&amp;verifier=REVIEW_SECRET&amp;X-Amz-Signature=REVIEW_SECRET#section`;
    expect(
      publicData({
        url: signed,
        description: `<p>Read <a href="${signed}">the file</a>. Then continue.</p>`,
        note: `See (${signed}). Keep studying!`,
        ordinary:
          "Why? Read A &amp; B; /files/50?download=1 and https://example.test/?q=hello%20world.",
      }),
    ).toEqual({
      url: `${path}#section`,
      description: `<p>Read <a href="${path}#section">the file</a>. Then continue.</p>`,
      note: `See (${path}#section). Keep studying!`,
      ordinary:
        "Why? Read A &amp; B; /files/50?download=1 and https://example.test/?q=hello%20world.",
    });
  },
);

it("preserves sentence punctuation after signed relative links", () => {
  expect(
    publicData(
      "Download /courses/1/files/50/download?verifier=REVIEW_SECRET. Next task!",
    ),
  ).toBe("Download /courses/1/files/50/download. Next task!");
});

it("queries real cached changes identically for equivalent UTC and +14 cutoffs", async () => {
  const cache = new Repository(":memory:");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-13T23:59:59Z"));
    cache.upsert(entities[0]!);
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    cache.upsert(entities[1]!);
    vi.setSystemTime(new Date("2026-09-14T01:00:00Z"));
    cache.upsert(entities[2]!);
    const service = new AcademicService(cache);
    const utc = await service.invoke("canvas_get_recent_changes", {
      since: "2026-09-14T00:00:00.000Z",
    });
    expect(utc).toMatchObject({ changes: [{ id: "3" }, { id: "2" }] });
    const offset = await service.invoke("canvas_get_recent_changes", {
      since: "2026-09-14T14:00:00+14:00",
    });
    expect(offset).toEqual(utc);
    expect(
      await service.invoke("canvas_get_recent_changes", {
        since: "2026-09-14T00:00:00Z",
      }),
    ).toEqual(utc);
    expect(await service.invoke("canvas_get_recent_changes", {})).toMatchObject(
      { changes: [{ id: "3" }, { id: "2" }, { id: "1" }] },
    );
  } finally {
    vi.useRealTimers();
    cache.close();
  }
});

it("removes raw objects and bearer-like URL query secrets from public results", () => {
  expect(
    publicData({
      raw: { token: "hidden" },
      data: { url: "https://canvas.test/files/5?verifier=secret&download=1" },
      title: "Hi",
    }),
  ).toEqual({ data: { url: "https://canvas.test/files/5" }, title: "Hi" });
});

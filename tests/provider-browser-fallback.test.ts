import { describe, expect, it, vi } from "vitest";
import { BrowserSessionProvider } from "../src/providers/browser-session.js";
import type { EntityKind } from "../src/domain/types.js";
const config = {
  baseUrl: "https://school.instructure.com",
  timeoutMs: 1000,
  maxDownloadBytes: 8388608,
};
function setup(bodies: unknown[]) {
  const operations: any[] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const request = vi.fn(async (op: any) => {
    operations.push(op);
    return { status: 200, body: bodies.shift() };
  });
  return {
    provider: new BrowserSessionProvider(config, { request }, logger),
    operations,
    logger,
  };
}
const targets: [
  EntityKind,
  string,
  Record<string, unknown>,
  Record<string, string>,
][] = [
  [
    "assignments",
    "/api/v1/courses/1/assignments",
    { id: "10" },
    { "include[]": "submission" },
  ],
  ["modules", "/api/v1/courses/1/modules", { id: "10" }, {}],
  [
    "enrollments",
    "/api/v1/courses/1/enrollments",
    { id: "10", user_id: "9" },
    { user_id: "self" },
  ],
  [
    "submissions",
    "/api/v1/courses/1/students/submissions",
    { assignment_id: "10", user_id: "9" },
    {},
  ],
  [
    "assignment_groups",
    "/api/v1/courses/1/assignment_groups",
    { id: "10", rules: { drop_lowest: 1 } },
    {},
  ],
  ["pages", "/api/v1/courses/1/pages", { page_id: "10", url: "read-this" }, {}],
  ["files", "/api/v1/courses/1/files", { id: "10", size: 42 }, {}],
  [
    "discussions",
    "/api/v1/courses/1/discussion_topics",
    { id: "10", message: "Topic" },
    {},
  ],
  [
    "announcements",
    "/api/v1/announcements",
    { id: "10" },
    {
      "context_codes[]": "course_1",
      start_date: "1970-01-01",
      end_date: "2100-01-01",
    },
  ],
  [
    "planner",
    "/api/v1/planner/items",
    { plannable_type: "assignment", plannable_id: "10" },
    {
      "context_codes[]": "course_1",
      start_date: "1970-01-01",
      end_date: "2100-01-01",
    },
  ],
];
describe("browser fallback routing", () => {
  it.each([
    null,
    { nodes: [], pageInfo: {} },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
  ])(
    "retains complete GET membership when the course GraphQL connection is incomplete",
    async (bad) => {
      const { provider, operations, logger } = setup([
        [{ id: "2", name: "Current", syllabus_body: "Complete" }],
        { id: "9" },
        { data: { user: { enrollmentsConnection: bad } } },
      ]);
      const courses = await provider.courses();
      expect(courses).toHaveLength(1);
      expect(courses[0]?.data).toMatchObject({
        id: "2",
        syllabus_body: "Complete",
        source: { transport: "canvas-get" },
      });
      expect(logger.warn).toHaveBeenCalled();
      expect(operations).toHaveLength(3);
    },
  );
  it("reuses authoritative course discovery when GraphQL enrichment is unsupported", async () => {
    const { provider, operations } = setup([
      [
        { id: "2", name: "Current" },
        { id: "3", name: "Also current" },
      ],
      { id: "9" },
      { errors: [{ message: "unknown field" }] },
    ]);
    const courses = await provider.courses();
    expect(courses.map((course) => course.id)).toEqual(["2", "3"]);
    for (const course of courses) {
      expect(course.data.source).toEqual({
        transport: "canvas-get",
        reason: "graphql_errors",
      });
      expect(course.raw.source).toEqual(course.data.source);
    }
    expect(
      operations.filter(
        (op) => op.type === "canvas-get" && op.path.includes("/courses"),
      ),
    ).toHaveLength(1);
    expect(operations).toHaveLength(3);
  });
  it("redacts signed attachment metadata nested in self submission records", async () => {
    const { provider } = setup([
      { id: "9" },
      { errors: [{ message: "unknown" }] },
      {
        assignment_id: "10",
        user_id: "9",
        attachments: [
          {
            id: "7",
            filename: "proof.pdf",
            url: "https://cdn.test?signature=secret",
          },
        ],
      },
    ]);
    const submission = await provider.submission("1", "10");
    expect(submission.data.attachments).toEqual([
      { id: "7", filename: "proof.pdf" },
    ]);
    expect(JSON.stringify(submission.raw)).not.toContain("secret");
  });
  it.each([undefined, "1"])(
    "preserves todo routing for course %s",
    async (courseId) => {
      const { provider, operations } = setup([
        [
          {
            type: "submitting",
            assignment: { id: "10", course_id: "1", name: "Work" },
          },
        ],
      ]);
      expect((await provider.todo(courseId))[0]?.kind).toBe("planner");
      expect(operations[0].path).toBe(
        `${courseId ? "/api/v1/courses/1" : "/api/v1/users/self"}/todo?per_page=100`,
      );
    },
  );
  it("requires dedicated traversal for module items and rubrics", async () => {
    const { provider, operations } = setup([]);
    await expect(provider.collection("module_items", "1")).rejects.toThrow(
      "moduleItems",
    );
    await expect(provider.collection("rubrics", "1")).rejects.toThrow(
      "assignment data.rubric",
    );
    expect(operations).toHaveLength(0);
  });
  it.each(["course", "assignment", "submission"] as const)(
    "falls back completely when %s detail GraphQL fields are unsupported",
    async (method) => {
      const raw =
        method === "submission"
          ? { assignment_id: "10", user_id: "9", submission_comments: [] }
          : { id: method === "course" ? "1" : "10", name: "Complete" };
      const { provider, operations } = setup([
        ...(method === "course" ? [] : [{ id: "9" }]),
        { errors: [{ message: "unknown field" }] },
        raw,
      ]);
      const value = await provider[method]("1", "10");
      expect(value.data).toMatchObject({
        ...raw,
        source: { transport: "canvas-get", reason: "graphql_errors" },
      });
      expect(operations.at(-1).type).toBe("canvas-get");
    },
  );
  it("redacts signed file URLs from both normalized and raw metadata", async () => {
    const { provider } = setup([
      {
        id: "7",
        filename: "reading.pdf",
        url: "https://cdn.test/file?token=secret",
        thumbnail_url: "https://cdn.test/thumb?sig=secret",
      },
    ]);
    const entity = await provider.file("1", "7");
    expect(entity.data.url).toBeUndefined();
    expect(entity.raw.url).toBeUndefined();
    expect(JSON.stringify(entity)).not.toContain("secret");
  });
  it.each([
    [
      "page",
      "7",
      "/api/v1/courses/1/pages/page_id:7",
      { page_id: "7", title: "Read", body: "<p>Text</p>" },
    ],
    [
      "page",
      "read-this",
      "/api/v1/courses/1/pages/read-this",
      { page_id: "7", title: "Read", body: "<p>Text</p>" },
    ],
    [
      "file",
      "7",
      "/api/v1/courses/1/files/7",
      { id: "7", filename: "reading.pdf", size: 42 },
    ],
  ] as const)(
    "retrieves %s details through isolated session GET",
    async (method, id, path, raw) => {
      const { provider, operations } = setup([raw]);
      const entity = await provider[method]("1", id);
      expect(entity.data).toMatchObject({
        ...raw,
        source: { transport: "canvas-get" },
      });
      expect(operations).toEqual([{ type: "canvas-get", path }]);
    },
  );
  it("traverses module items separately and retains content details", async () => {
    const { provider, operations } = setup([
      [
        {
          id: "8",
          type: "Page",
          page_url: "read-this",
          content_details: { locked_for_user: false },
        },
      ],
    ]);
    const [entity] = await provider.moduleItems("1", "7");
    expect(entity?.data).toMatchObject({
      module_id: "7",
      type: "Page",
      page_url: "read-this",
      content_details: { locked_for_user: false },
    });
    expect(operations[0].path).toContain("/modules/7/items?");
    expect(operations[0].path).toContain("include%5B%5D=content_details");
  });
  it.each(targets)(
    "preserves %s session GET semantics",
    async (kind, endpoint, raw, params) => {
      const usesGraphql = [
        "assignments",
        "modules",
        "enrollments",
        "submissions",
      ].includes(kind);
      const { provider, operations, logger } = setup([
        ...(usesGraphql
          ? [{ id: "9" }, { errors: [{ message: "unknown field" }] }]
          : []),
        [raw],
      ]);
      const entities = await provider.collection(kind, "1");
      expect(entities[0]?.data).toMatchObject({
        ...raw,
        source: { transport: "canvas-get" },
      });
      const op = operations.at(-1);
      const url = new URL(op.path, config.baseUrl);
      expect(op.type).toBe("canvas-get");
      expect(url.pathname).toBe(endpoint);
      expect(url.searchParams.get("per_page")).toBe("100");
      for (const [key, value] of Object.entries(params))
        expect(url.searchParams.get(key)).toBe(value);
      expect(url.searchParams.has("student_ids[]")).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    },
  );
});

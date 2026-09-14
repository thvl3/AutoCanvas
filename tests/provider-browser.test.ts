import { describe, expect, it, vi } from "vitest";
import { BrowserSessionProvider } from "../src/providers/browser-session.js";
import { BridgeError, validateOperation } from "../src/bridge/protocol.js";

const config = {
  baseUrl: "https://school.instructure.com",
  timeoutMs: 1000,
  maxDownloadBytes: 8 * 1024 * 1024,
};
const result = (body: unknown, status = 200) => ({ status, body });
function setup(responses: ReturnType<typeof result>[]) {
  const operations: any[] = [];
  const bridge = {
    request: vi.fn(async (operation: any) => {
      validateOperation(operation);
      operations.push(operation);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected bridge request");
      return response;
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    provider: new BrowserSessionProvider(config, bridge, logger),
    bridge,
    operations,
    logger,
  };
}
const identity = result({ id: "9", name: "Student" });

const connection = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const course = {
  _id: "1",
  name: "Math",
  courseCode: "M1",
  state: "available",
  syllabusBody: "<p>Study</p>",
  term: { _id: "5", name: "Fall" },
};
const enrollment = {
  _id: "2",
  userId: "9",
  state: "active",
  type: "StudentEnrollment",
  grades: { currentScore: 91, finalScore: null },
  course,
};

const assignment = {
  _id: "10",
  name: "Proof",
  description: "<p>Prove it</p>",
  courseId: "1",
  pointsPossible: 20,
  dueAt: "2026-09-30T23:59:00-06:00",
  lockAt: null,
  unlockAt: null,
  lockInfo: { isLocked: false },
  allowedAttempts: null,
  allowedExtensions: ["pdf"],
  submissionTypes: ["online_upload"],
  state: "published",
  published: true,
  assignmentGroupId: "5",
  rubric: {
    _id: "6",
    title: "Proof rubric",
    pointsPossible: 20,
    criteria: [
      {
        _id: "criterion",
        points: 20,
        description: "Reasoning",
        ratings: [{ _id: "rating", points: 20, description: "Sound" }],
      },
    ],
  },
  submissionsConnection: connection([
    {
      _id: "11",
      assignmentId: "10",
      userId: "9",
      state: "unsubmitted",
      attempt: 0,
      grade: null,
      score: null,
      missing: true,
    },
  ]),
};

describe("BrowserSessionProvider", () => {
  it("returns an authoritative empty course scope without requesting historical GraphQL content", async () => {
    const { provider, operations } = setup([result([])]);
    expect(await provider.courses()).toEqual([]);
    expect(operations).toHaveLength(1);
    expect(operations[0].path).toContain("/api/v1/courses?");
  });
  it.each([403, 503])(
    "fails with actionable guidance when course membership GET fails (%s)",
    async (status) => {
      const operations: any[] = [];
      const provider = new BrowserSessionProvider(config, {
        request: async (operation) => {
          operations.push(operation);
          if (operation.type === "canvas-get") {
            if (operation.path === "/api/v1/users/self/profile")
              return identity;
            return result({ private: "do not expose" }, status);
          }
          return result({
            data: { user: { enrollmentsConnection: connection([enrollment]) } },
          });
        },
      });
      await expect(provider.courses()).rejects.toMatchObject({
        status,
        message:
          "Current course membership unavailable. Check your Canvas browser session and course access, then retry sync.",
      });
      expect(operations).toHaveLength(1);
      expect(operations[0].path).toContain("/api/v1/courses?");
    },
  );
  it("uses session GET membership while preferring GraphQL content for current courses", async () => {
    const operations: any[] = [];
    const provider = new BrowserSessionProvider(config, {
      request: async (operation) => {
        validateOperation(operation);
        operations.push(operation);
        if (operation.type === "canvas-get") {
          if (operation.path === "/api/v1/users/self/profile") return identity;
          const url = new URL(operation.path, config.baseUrl);
          expect(url.pathname).toBe("/api/v1/courses");
          if (url.searchParams.get("page") === "2")
            return result([
              { id: "3", name: "GET-only current", syllabus_body: "Retain" },
            ]);
          expect(url.searchParams.get("enrollment_state")).toBe("active");
          expect(url.searchParams.getAll("state[]")).toEqual(["available"]);
          expect(url.searchParams.getAll("include[]")).toEqual([
            "syllabus_body",
            "term",
            "total_scores",
          ]);
          expect(url.searchParams.get("per_page")).toBe("100");
          return {
            ...result([
              { id: 2, name: "GET current", syllabus_body: "GET text" },
            ]),
            link: '</api/v1/courses?page=2>; rel="next"',
          };
        }
        expect(operation.type).toBe("graphql-query");
        return result({
          data: {
            user: {
              enrollmentsConnection: connection([
                enrollment,
                {
                  ...enrollment,
                  _id: "4",
                  course: { ...course, _id: "2", name: "GraphQL current" },
                },
              ]),
            },
          },
        });
      },
    });
    const courses = await provider.courses();
    expect(courses.map((item) => item.id)).toEqual(["2", "3"]);
    expect(courses[0]?.data).toMatchObject({
      name: "GraphQL current",
      syllabus_body: "<p>Study</p>",
      enrollments: [{ id: "4", grades: { current_score: 91 } }],
      source: { transport: "graphql", membership: "canvas-get" },
    });
    expect(courses[1]?.data).toMatchObject({
      name: "GET-only current",
      syllabus_body: "Retain",
      source: { transport: "canvas-get", reason: "current_course_membership" },
    });
    expect(operations[0].type).toBe("canvas-get");
    expect(operations[0].path).toContain("/api/v1/courses?");
    expect(
      operations.filter(
        (op) => op.type === "canvas-get" && op.path.includes("/courses"),
      ),
    ).toHaveLength(2);
  });
  it("rejects malformed collection course IDs before any identity lookup", async () => {
    const { provider, operations } = setup([]);
    await expect(provider.collection("assignments", "1/path")).rejects.toThrow(
      "Invalid Canvas identifier",
    );
    expect(operations).toHaveLength(0);
  });
  it("does not erase rubric criteria omitted from a GraphQL rubric object", async () => {
    const { provider } = setup([
      identity,
      result({
        data: {
          course: {
            assignmentsConnection: connection([
              { ...assignment, rubric: { _id: "6", title: "Partial" } },
            ]),
          },
        },
      }),
      result({}, 403),
    ]);
    await expect(provider.collection("assignments", "1")).rejects.toMatchObject(
      { status: 403 },
    );
  });
  it("falls back rather than treating missing module prerequisites as complete", async () => {
    const { provider } = setup([
      identity,
      result({
        data: {
          course: {
            modulesConnection: connection([{ _id: "7", prerequisites: null }]),
          },
        },
      }),
      result({}, 403),
    ]);
    await expect(provider.collection("modules", "1")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("routes the courses collection to the active self course query", async () => {
    const { provider } = setup([
      result([{ id: "1" }]),
      identity,
      result({
        data: { user: { enrollmentsConnection: connection([enrollment]) } },
      }),
    ]);
    expect((await provider.collection("courses", "1"))[0]?.id).toBe("1");
  });
  it("normalizes bridge login errors to actionable retryable guidance", async () => {
    const provider = new BrowserSessionProvider(config, {
      request: async () => {
        throw new BridgeError(
          "canvas_authentication_required",
          "private",
          false,
        );
      },
    });
    await expect(provider.authCheck()).rejects.toMatchObject({
      status: 401,
      retryable: true,
      message: "Open Canvas in your browser and sign in.",
    });
  });
  it("rejects invalid constructor limits and origin", () => {
    for (const bad of [
      { ...config, timeoutMs: 0 },
      { ...config, maxDownloadBytes: -1 },
      { ...config, baseUrl: "https://school.instructure.com/path" },
    ])
      expect(
        () => new BrowserSessionProvider(bad, { request: vi.fn() }),
      ).toThrow();
  });
  it.each([
    [
      "submissions",
      { data: { course: { submissionsConnection: connection([]) } } },
    ],
    [
      "submissions",
      {
        data: {
          course: {
            submissionsConnection: connection([
              { assignmentId: "10", userId: "99" },
            ]),
          },
        },
      },
    ],
    [
      "enrollments",
      {
        data: {
          user: {
            enrollmentsConnection: connection([
              { ...enrollment, userId: "99" },
            ]),
          },
        },
      },
    ],
    [
      "enrollments",
      {
        data: {
          user: {
            enrollmentsConnection: connection([
              { ...enrollment, grades: undefined },
            ]),
          },
        },
      },
    ],
  ] as const)(
    "requires a complete self-scoped %s record or fails visibly",
    async (kind, body) => {
      const { provider } = setup([identity, result(body), result({}, 403)]);
      await expect(provider.collection(kind, "1")).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it.each(["course", "assignment", "submission"] as const)(
    "rejects malformed %s identifiers before requesting the bridge",
    async (method) => {
      const { provider, operations } = setup([]);
      await expect(provider[method]("1/path", "10")).rejects.toThrow(
        /identifier/,
      );
      expect(operations).toHaveLength(0);
    },
  );
  it.each([
    "canvas_not_open",
    "extension_disconnected",
    "bridge_disconnected",
  ] as const)("reports %s accurately", async (code) => {
    const provider = new BrowserSessionProvider(config, {
      request: async () => {
        throw new BridgeError(code, "private error details", true);
      },
    });
    const health = await provider.healthCheck();
    expect(health.state).toBe(code);
    expect(JSON.stringify(health)).not.toContain("private error");
  });
  it("bounds unresponsive bridge requests by timeoutMs", async () => {
    const provider = new BrowserSessionProvider(
      { ...config, timeoutMs: 5 },
      { request: () => new Promise(() => {}) },
    );
    await expect(provider.authCheck()).rejects.toMatchObject({
      code: "bridge_timeout",
      retryable: true,
    });
  });
  it.each([
    { ...result("<html><form>Login</form></html>"), contentType: "text/html" },
    { ...result("Sign in"), contentType: "text/html" },
    {
      ...result({ page_id: "10", body: "<p>Content</p>" }, 401),
      contentType: "text/html",
    },
    {
      ...result({ page_id: "10", body: "<p>Content</p>" }, 302),
      contentType: "text/html",
    },
  ])(
    "does not accept login HTML or auth failures as semantic content",
    async (response) => {
      const { provider } = setup([result({}, 405), response]);
      await expect(provider.page("1", "10")).rejects.toMatchObject({
        status: 401,
        retryable: true,
      });
    },
  );
  it("still rejects structured text/html for session GET instead of accepting it as JSON", async () => {
    const { provider } = setup([
      { ...identity, contentType: "text/html" } as any,
    ]);
    await expect(provider.authCheck()).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    ["page", { page_id: "11", id: "11", body: "<p>Wrong page</p>" }],
    ["page", { page_id: "10", id: "11", body: "<p>Contradictory ID</p>" }],
    ["page", { page_id: "10", id: "10", title: "Empty shell" }],
    ["assignment", { id: "11", description: "<p>Wrong assignment</p>" }],
    ["assignment", { id: "10", name: "Empty shell" }],
  ] as const)(
    "rejects invalid structured %s semantic content",
    async (kind, body) => {
      const { provider } = setup([
        ...(kind === "assignment"
          ? [identity, result({ errors: [{ message: "unknown" }] })]
          : []),
        result({}, 405),
        {
          ...result({ ...body, source: "canvas-page" }),
          contentType: "text/html",
        } as any,
      ]);
      await expect(provider[kind]("1", "10")).rejects.toThrow(
        "Invalid Canvas semantic content",
      );
    },
  );
  it.each(["page", "assignment"] as const)(
    "accepts structured %s semantic content with the executor's text/html content type",
    async (kind) => {
      const body =
        kind === "page"
          ? {
              page_id: "10",
              id: "10",
              title: "Reading",
              body: "<p>Semantic content</p>",
              source: "canvas-page",
            }
          : {
              id: "10",
              name: "Work",
              description: "<p>Semantic content</p>",
              source: "canvas-page",
            };
      const { provider } = setup([
        ...(kind === "assignment"
          ? [identity, result({ errors: [{ message: "unknown" }] })]
          : []),
        result({}, 405),
        { ...result(body), contentType: "text/html" } as any,
      ]);
      const entity = await provider[kind]("1", "10");
      expect(entity.id).toBe("10");
      expect(entity.data[kind === "page" ? "body" : "description"]).toBe(
        "<p>Semantic content</p>",
      );
      expect(entity.data.source).toEqual({
        transport: "canvas-page",
        reason: "session_get_unsupported",
        complete: false,
      });
    },
  );
  it.each(["page", "assignment"] as const)(
    "uses semantic %s extraction only when session GET is unsupported",
    async (kind) => {
      const { provider, operations } = setup([
        ...(kind === "assignment"
          ? [identity, result({ errors: [{ message: "unknown" }] })]
          : []),
        result({}, 405),
        result(
          kind === "page"
            ? {
                page_id: "10",
                title: "Reading",
                body: "<p>Semantic content</p>",
              }
            : {
                id: "10",
                name: "Work",
                description: "<p>Semantic content</p>",
              },
        ),
      ]);
      const entity = await provider[kind]("1", "10");
      expect(entity.data.source).toMatchObject({
        transport: "canvas-page",
        complete: false,
      });
      expect(operations.at(-1)).toEqual({
        type: "canvas-page",
        kind,
        courseId: "1",
        id: "10",
      });
    },
  );
  it("does not treat a page permission denial as permission to scrape", async () => {
    const { provider, operations } = setup([result({}, 403)]);
    await expect(provider.page("1", "10")).rejects.toMatchObject({
      status: 403,
    });
    expect(operations).toHaveLength(1);
  });
  it("exposes a fixed read-only schema inspection query with fields and argument types", async () => {
    const schema = {
      queryType: { name: "Query" },
      types: [{ name: "Course", fields: [{ name: "assignmentsConnection" }] }],
    };
    const { provider, operations } = setup([
      result({ data: { __schema: schema } }),
    ]);
    expect(await provider.schema()).toEqual(schema);
    expect(operations[0].type).toBe("graphql-query");
    expect(operations[0].query).toContain("__schema");
    expect(operations[0].query).toContain("fields(includeDeprecated: true)");
    expect(operations[0].query).toContain("args");
    expect(operations[0].query).toContain("ofType");
    expect(operations[0].query).not.toMatch(/mutation\s*\{/);
  });
  it("reports bridge session health without exporting the user profile", async () => {
    const { provider, operations } = setup([identity]);
    expect(await provider.healthCheck()).toMatchObject({
      provider: "browser-session",
      state: "connected",
      origin: config.baseUrl,
    });
    expect(operations).toEqual([{ type: "session-health" }]);
  });
  it("reports retryable authentication guidance and health state", async () => {
    const { provider } = setup([result({}, 401), result({}, 401)]);
    await expect(provider.authCheck()).rejects.toMatchObject({
      status: 401,
      retryable: true,
      message: "Open Canvas in your browser and sign in.",
    });
    expect(await provider.healthCheck()).toMatchObject({
      state: "authentication_required",
      message: "Open Canvas in your browser and sign in.",
    });
  });
  it("retrieves self submission detail and complete feedback using an explicit GET supplement", async () => {
    const { provider, operations } = setup([
      identity,
      result({
        data: {
          submission: {
            _id: "11",
            assignmentId: "10",
            userId: "9",
            state: "graded",
            score: 19,
          },
        },
      }),
      result({
        id: "11",
        assignment_id: "10",
        user_id: "9",
        score: 19,
        submission_comments: [{ id: "22", comment: "Feedback" }],
        rubric_assessment: { criterion: { points: 19 } },
      }),
    ]);
    const entity = await provider.submission("1", "10");
    expect(entity.data).toMatchObject({
      submission_comments: [{ comment: "Feedback" }],
      rubric_assessment: { criterion: { points: 19 } },
      source: { transport: "canvas-get", reason: "submission_feedback" },
    });
    expect(operations[1].query).toContain("userId: $userId");
    expect(operations[2].path).toContain("/assignments/10/submissions/self?");
    expect(operations[2].path).toContain("rubric_assessment");
  });
  it.each(["%%%", "QUJDRA==", undefined])(
    "rejects malformed or oversized download bytes",
    async (bytesBase64) => {
      const { provider } = setup([{ ...result(null), bytesBase64 } as any]);
      const file = {
        kind: "files" as const,
        id: "7",
        course_id: "1",
        title: "File",
        updated_at: null,
        data: {},
        raw: {},
      };
      await expect(provider.download(file, 3)).rejects.toThrow(/download/i);
    },
  );
  it("caps browser download requests at the protocol limit", async () => {
    const { provider, operations } = setup([
      { ...result(null), bytesBase64: "" } as any,
    ]);
    const file = {
      kind: "files" as const,
      id: "7",
      course_id: "1",
      title: "File",
      updated_at: null,
      data: {},
      raw: {},
    };
    await provider.download(file, 50 * 1024 * 1024);
    expect(operations[0].maxBytes).toBe(8 * 1024 * 1024);
    await expect(
      provider.download({ ...file, course_id: null }, 100),
    ).rejects.toThrow();
    await expect(
      provider.download({ ...file, data: { locked_for_user: true } }, 100),
    ).rejects.toThrow();
    await expect(provider.download(file, -1)).rejects.toThrow();
    expect(operations).toHaveLength(1);
  });
  it("downloads bounded bytes by IDs only, never a signed URL", async () => {
    const { provider, operations } = setup([
      {
        ...result(null),
        bytesBase64: Buffer.from("PDF").toString("base64"),
        contentType: "application/pdf",
      } as any,
    ]);
    const file = {
      kind: "files" as const,
      id: "7",
      course_id: "1",
      title: "File",
      updated_at: null,
      data: { url: "https://cdn.test?secret=token" },
      raw: {},
    };
    const download = await provider.download(file, 100);
    expect(Buffer.from(download.bytes).toString()).toBe("PDF");
    expect(download.contentType).toBe("application/pdf");
    expect(operations).toEqual([
      { type: "download-file", courseId: "1", fileId: "7", maxBytes: 100 },
    ]);
  });
  it("decodes a multi-megabyte download without a regex stack overflow", async () => {
    const size = 5 * 1024 * 1024;
    const { provider } = setup([
      {
        ...result(null),
        bytesBase64: Buffer.alloc(size, 7).toString("base64"),
        contentType: "application/octet-stream",
      } as any,
    ]);
    const file = {
      kind: "files" as const,
      id: "7",
      course_id: "1",
      title: "Big",
      updated_at: null,
      data: {},
      raw: {},
    };
    const download = await provider.download(file, size);
    expect(download.bytes.length).toBe(size);
  });
  it("still rejects non-canonical multi-megabyte download bytes", async () => {
    const size = 5 * 1024 * 1024;
    // Zero bytes encode to all "A" characters, so a substitution is guaranteed.
    const encoded = Buffer.alloc(size, 0).toString("base64").replace("A", "!");
    const { provider } = setup([
      { ...result(null), bytesBase64: encoded } as any,
    ]);
    const file = {
      kind: "files" as const,
      id: "7",
      course_id: "1",
      title: "Big",
      updated_at: null,
      data: {},
      raw: {},
    };
    await expect(provider.download(file, size)).rejects.toThrow(/download/i);
  });
  it("retrieves a course with independently paginated self enrollment grades", async () => {
    const { provider } = setup([
      result({ data: { course } }),
      identity,
      result({
        data: { user: { enrollmentsConnection: connection([enrollment]) } },
      }),
    ]);
    expect((await provider.course("1")).data).toMatchObject({
      id: "1",
      syllabus_body: "<p>Study</p>",
      enrollments: [{ grades: { current_score: 91 } }],
    });
  });
  it.each([400, 403, 404, 405, 422, 501])(
    "falls back visibly when GraphQL endpoint is unavailable (%s)",
    async (status) => {
      const { provider, logger } = setup([
        result([{ id: "1", name: "REST" }]),
        identity,
        result({}, status),
      ]);
      expect((await provider.courses())[0]?.title).toBe("REST");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: `graphql_http_${status}` }),
        expect.any(String),
      );
    },
  );
  it("does not turn GraphQL authentication errors into a fallback", async () => {
    const { provider, operations } = setup([
      result([{ id: "1" }]),
      identity,
      result({
        errors: [
          { extensions: { code: "UNAUTHENTICATED" }, message: "private" },
        ],
      }),
    ]);
    await expect(provider.courses()).rejects.toMatchObject({ status: 401 });
    expect(operations).toHaveLength(3);
  });
  it("maps paginated modules without trusting inline truncated items", async () => {
    const { provider, operations } = setup([
      identity,
      result({
        data: {
          course: {
            modulesConnection: connection([
              {
                _id: "7",
                name: "Week",
                position: 1,
                published: true,
                unlockAt: null,
                moduleItemsTotalCount: 4,
                prerequisites: [{ _id: "6" }],
                requireSequentialProgress: true,
              },
            ]),
          },
        },
      }),
    ]);
    const [entity] = await provider.collection("modules", "1");
    expect(entity?.data).toMatchObject({
      id: "7",
      position: 1,
      items_count: 4,
      prerequisite_module_ids: ["6"],
      require_sequential_progress: true,
    });
    expect(operations[1].query).not.toContain("moduleItems {");
    expect(operations[1].query).not.toContain("progression");
  });
  it("paginates only the authenticated student's submissions", async () => {
    const sub = {
      _id: "11",
      assignmentId: "10",
      userId: "9",
      state: "graded",
      score: 19,
      grade: "A",
      submittedAt: "2026-09-01T12:00:00Z",
      late: false,
      missing: false,
    };
    const { provider, operations } = setup([
      identity,
      result({
        data: { course: { submissionsConnection: connection([sub]) } },
      }),
    ]);
    const [entity] = await provider.collection("submissions", "1");
    expect(entity?.data).toMatchObject({
      assignment_id: "10",
      user_id: "9",
      workflow_state: "graded",
      score: 19,
      grade: "A",
    });
    expect(operations[1].query).toContain("studentIds: [$userId]");
    expect(operations[1].variables.userId).toBe("9");
  });
  it("keeps self enrollment and total-course grade semantics including nullable grades", async () => {
    const { provider, operations } = setup([
      identity,
      result({
        data: {
          user: {
            enrollmentsConnection: connection([
              enrollment,
              { ...enrollment, _id: "3", grades: null },
            ]),
          },
        },
      }),
    ]);
    const values = await provider.collection("enrollments", "1");
    expect(values[0]?.data).toMatchObject({
      type: "StudentEnrollment",
      user_id: "9",
      grades: { current_score: 91, final_score: null },
    });
    expect(values[1]?.data.grades).toBeNull();
    expect(operations[1].query).toContain("grades(gradingPeriodId: null)");
    expect(operations[1].query).toContain("courseId: $courseId");
    expect(operations[1].variables.userId).toBe("9");
  });
  it("retrieves individual assignments with the same GraphQL adapter", async () => {
    const { provider, operations } = setup([
      identity,
      result({ data: { assignment } }),
    ]);
    expect((await provider.assignment("1", "10")).data).toMatchObject({
      id: "10",
      allowed_attempts: -1,
    });
    expect(operations[1].variables).toMatchObject({
      assignmentId: "10",
      userId: "9",
    });
  });
  it.each([
    { ...assignment, allowedAttempts: undefined },
    { ...assignment, lockInfo: null },
    { ...assignment, rubric: undefined },
    { ...assignment, submissionsConnection: connection([], "more") },
    {
      ...assignment,
      submissionsConnection: connection([{ assignmentId: "10", userId: "99" }]),
    },
  ])(
    "uses complete assignment fallback when critical data cannot be trusted",
    async (node) => {
      const { provider, operations } = setup([
        identity,
        result({
          data: { course: { assignmentsConnection: connection([node]) } },
        }),
        result([
          {
            id: "10",
            name: "Complete",
            allowed_attempts: 2,
            locked_for_user: true,
            rubric: [],
          },
        ]),
      ]);
      expect(
        (await provider.collection("assignments", "1"))[0]?.data,
      ).toMatchObject({
        allowed_attempts: 2,
        locked_for_user: true,
        source: { transport: "canvas-get" },
      });
      expect(operations[2].path).toContain("include%5B%5D=submission");
    },
  );
  it("adapts GraphQL assignments including rubric, effective dates, limits, and self submission", async () => {
    const { provider, operations } = setup([
      identity,
      result({
        data: { course: { assignmentsConnection: connection([assignment]) } },
      }),
    ]);
    const [entity] = await provider.collection("assignments", "1");
    expect(entity?.data).toMatchObject({
      id: "10",
      description: "<p>Prove it</p>",
      allowed_attempts: -1,
      locked_for_user: false,
      submission_types: ["online_upload"],
      due_at: "2026-10-01T05:59:00.000Z",
      rubric: [{ id: "criterion", ratings: [{ id: "rating" }] }],
      rubric_settings: { id: "6", title: "Proof rubric" },
      submission: {
        assignment_id: "10",
        user_id: "9",
        workflow_state: "unsubmitted",
      },
    });
    expect(operations[1].query).toContain("gradingPeriodId: null");
    expect(operations[1].query).toContain("applyOverrides: true");
    expect(operations[1].query).toContain("userId: $userId");
  });
  it.each([
    "https://evil.test/api/v1/courses?page=2",
    "/api/v1/users/self/profile",
    "/api/v1/courses?access_token=secret",
    "/api/v1/courses?per_page=100&enrollment_state=active&state%5B%5D=available&include%5B%5D=syllabus_body&include%5B%5D=term&include%5B%5D=total_scores",
  ])("rejects unsafe or repeated fallback pagination: %s", async (target) => {
    const { provider, operations } = setup([
      { ...result([{ id: "1" }]), link: `<${target}>; rel="next"` } as any,
    ]);
    await expect(provider.courses()).rejects.toThrow(/pagination|operation/);
    expect(operations).toHaveLength(1);
  });
  it.each([
    { nodes: [enrollment], pageInfo: { hasNextPage: true, endCursor: null } },
    { nodes: [enrollment], pageInfo: {} },
    null,
  ])(
    "never silently truncates a malformed or permission-limited connection",
    async (bad) => {
      const { provider } = setup([
        identity,
        result({ data: { user: { enrollmentsConnection: bad } } }),
        result({}, 403),
      ]);
      await expect(
        provider.collection("enrollments", "1"),
      ).rejects.toMatchObject({ status: 403 });
    },
  );
  it("rejects a repeated Relay cursor before returning partial records", async () => {
    const page = result({
      data: {
        user: { enrollmentsConnection: connection([enrollment], "repeat") },
      },
    });
    const { provider } = setup([result([{ id: "1" }]), identity, page, page]);
    await expect(provider.courses()).rejects.toThrow("pagination");
  });
  it.each([
    result({ error: "private" }, 401),
    result("<html>login</html>"),
    result({}, 302),
  ])(
    "preserves authentication failure as status 401 without fallback",
    async (response) => {
      const { provider, operations } = setup([response]);
      await expect(provider.authCheck()).rejects.toMatchObject({ status: 401 });
      expect(operations).toHaveLength(1);
    },
  );
  it("replaces partial GraphQL data with complete paginated session GET records", async () => {
    const { provider, operations, logger } = setup([
      {
        ...result([{ id: "1", name: "Complete", syllabus_body: "Retained" }]),
        link: '<https://school.instructure.com/api/v1/courses?page=2>; rel="next"',
      } as any,
      result([{ id: "2", name: "Second" }]),
      identity,
      result({
        data: { user: { enrollmentsConnection: connection([enrollment]) } },
        errors: [
          {
            message: "private content field missing",
            extensions: { code: "undefinedField" },
          },
        ],
      }),
    ]);
    const courses = await provider.courses();
    expect(courses.map((c) => c.title)).toEqual(["Complete", "Second"]);
    expect(courses[0]?.data.source).toEqual({
      transport: "canvas-get",
      reason: "graphql_errors",
    });
    expect(operations[0].path).toContain("enrollment_state=active");
    expect(operations[1].path).toBe("/api/v1/courses?page=2");
    expect(operations).toHaveLength(4);
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      "private content",
    );
  });
  it("paginates active self enrollments into deduplicated normalized courses", async () => {
    const { provider, operations } = setup([
      result([{ id: "1" }, { id: "90071992547409931" }]),
      identity,
      result({
        data: {
          user: {
            enrollmentsConnection: connection([enrollment], "opaque+cursor"),
          },
        },
      }),
      result({
        data: {
          user: {
            enrollmentsConnection: connection([
              { ...enrollment, _id: "3" },
              {
                ...enrollment,
                _id: "4",
                course: { ...course, _id: "90071992547409931" },
              },
            ]),
          },
        },
      }),
    ]);
    const courses = await provider.courses();
    expect(courses.map((c) => c.id)).toEqual(["1", "90071992547409931"]);
    expect(courses[0]?.data).toMatchObject({
      syllabus_body: "<p>Study</p>",
      course_code: "M1",
      term: { id: "5" },
      enrollments: [
        { id: "2", grades: { current_score: 91, final_score: null } },
        { id: "3" },
      ],
      source: { transport: "graphql" },
    });
    expect(operations[2].query).toContain("currentOnly: true");
    expect(operations[2].variables.userId).toBe("9");
    expect(operations[3].variables.after).toBe("opaque+cursor");
  });
  it("resolves self identity through a session GET, not a guessed viewer field", async () => {
    const { provider, operations } = setup([identity]);
    expect(await provider.authCheck()).toEqual({ id: "9", name: "Student" });
    expect(operations).toEqual([
      { type: "canvas-get", path: "/api/v1/users/self/profile" },
    ]);
  });
});

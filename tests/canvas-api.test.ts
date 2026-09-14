import { describe, it, expect, vi } from "vitest";
import { CanvasClient } from "../src/canvas/client.js";
import { CanvasApi } from "../src/canvas/api.js";

const config = {
  baseUrl: "https://canvas.example",
  accessToken: "token",
  timeoutMs: 100,
  maxRetries: 0,
};
const setup = (payload: unknown) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
    );
  return {
    api: new CanvasApi(new CanvasClient(config, { fetch: fetcher })),
    fetcher,
  };
};
const requestUrl = (
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  index = 0,
) => new URL(String(fetcher.mock.calls[index]![0]));

describe("CanvasApi", () => {
  it("loads detail resources with course context and only self submission comments", async () => {
    const { api, fetcher } = setup({
      id: 3,
      name: "Item",
      course_id: 7,
      assignment_id: 3,
      user_id: 2,
    });
    expect((await api.course("7")).kind).toBe("courses");
    expect((await api.assignment("7", "3")).kind).toBe("assignments");
    expect((await api.file("7", "3")).kind).toBe("files");
    expect((await api.submission("7", "3")).kind).toBe("submissions");
    expect(
      fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname),
    ).toEqual([
      "/api/v1/courses/7",
      "/api/v1/courses/7/assignments/3",
      "/api/v1/courses/7/files/3",
      "/api/v1/courses/7/assignments/3/submissions/self",
    ]);
    expect(requestUrl(fetcher, 1).searchParams.getAll("include[]")).toContain(
      "submission",
    );
    expect(requestUrl(fetcher, 3).searchParams.getAll("include[]")).toContain(
      "submission_comments",
    );
  });
  it("retrieves page body and disambiguates numeric IDs with page_id prefix", async () => {
    const { api, fetcher } = setup({
      page_id: 42,
      title: "Intro",
      body: "<h1>Hello</h1>",
    });
    for (const value of ["42", "page_id:42", "intro"]) {
      expect((await api.page("7", value)).data.body).toBe("<h1>Hello</h1>");
    }
    expect(
      fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname),
    ).toEqual([
      "/api/v1/courses/7/pages/page_id:42",
      "/api/v1/courses/7/pages/page_id:42",
      "/api/v1/courses/7/pages/intro",
    ]);
    for (const value of ["..", "../other", "", "https://evil.example"])
      await expect(api.page("7", value)).rejects.toThrow(
        /Invalid Canvas page identifier/,
      );
  });
  it("retrieves module items separately with content details", async () => {
    const { api, fetcher } = setup([{ id: 3, title: "Read", content_id: 9 }]);
    expect(await api.moduleItems("7", "4")).toMatchObject([
      {
        kind: "module_items",
        course_id: "7",
        data: { content_id: "9", module_id: "4" },
      },
    ]);
    expect(requestUrl(fetcher).pathname).toBe(
      "/api/v1/courses/7/modules/4/items",
    );
    expect(requestUrl(fetcher).searchParams.getAll("include[]")).toEqual([
      "content_details",
    ]);
  });
  it("validates auth identity and exposes only id and optional name", async () => {
    const { api, fetcher } = setup({
      id: 2,
      name: "Student",
      primary_email: "private@example.test",
    });
    expect(await api.authCheck()).toEqual({ id: "2", name: "Student" });
    expect(requestUrl(fetcher).pathname).toBe("/api/v1/users/self/profile");
    await expect(
      setup({ id: 9007199254740992 }).api.authCheck(),
    ).rejects.toThrow(/^Invalid Canvas user payload$/);
  });
  it("retrieves self todo without invoking any completion or dismissal writes", async () => {
    const { api, fetcher } = setup([
      {
        type: "submitting",
        assignment: { id: 3, name: "Essay", course_id: 7 },
      },
    ]);
    expect(await api.todo("7")).toMatchObject([
      { kind: "planner", id: "todo:submitting:3", course_id: "7" },
    ]);
    expect(requestUrl(fetcher).pathname).toBe("/api/v1/courses/7/todo");
    await api.todo();
    expect(requestUrl(fetcher, 1).pathname).toBe("/api/v1/users/self/todo");
    expect(fetcher.mock.calls.every((call) => call[1]?.method === "GET")).toBe(
      true,
    );
  });
  it("normalizes paginated course collections using documented endpoint names", async () => {
    const kinds = [
      "assignments",
      "assignment_groups",
      "modules",
      "pages",
      "files",
      "discussions",
      "announcements",
      "submissions",
      "enrollments",
      "planner",
    ] as const;
    const paths = [
      "courses/7/assignments",
      "courses/7/assignment_groups",
      "courses/7/modules",
      "courses/7/pages",
      "courses/7/files",
      "courses/7/discussion_topics",
      "announcements",
      "courses/7/students/submissions",
      "courses/7/enrollments",
      "planner/items",
    ];
    for (const [index, kind] of kinds.entries()) {
      const { api, fetcher } = setup([
        {
          id: 3,
          page_id: 3,
          name: "Item",
          course_id: 7,
          assignment_id: 3,
          user_id: 2,
        },
      ]);
      expect(await api.collection(kind, "7")).toMatchObject([
        { kind, course_id: "7", title: "Item" },
      ]);
      expect(requestUrl(fetcher).pathname).toBe(`/api/v1/${paths[index]}`);
      expect(fetcher).toHaveBeenCalledOnce();
      if (kind === "assignments")
        expect(requestUrl(fetcher).searchParams.getAll("include[]")).toContain(
          "submission",
        );
      if (kind === "submissions") {
        expect(requestUrl(fetcher).searchParams.has("student_ids[]")).toBe(
          false,
        ); // omitted means caller only
        expect(requestUrl(fetcher).searchParams.has("grouped")).toBe(false);
      }
      if (kind === "enrollments")
        expect(requestUrl(fetcher).searchParams.get("user_id")).toBe("self");
      if (kind === "announcements" || kind === "planner") {
        expect(
          requestUrl(fetcher).searchParams.getAll("context_codes[]"),
        ).toEqual(["course_7"]);
        expect(requestUrl(fetcher).searchParams.get("start_date")).toBe(
          "1970-01-01",
        );
        expect(requestUrl(fetcher).searchParams.get("end_date")).toBe(
          "2100-01-01",
        );
      }
    }
  });
  it("refuses unsupported collection kinds and hostile course IDs without a request", async () => {
    const { api, fetcher } = setup([]);
    for (const kind of ["rubrics", "module_items"] as const)
      await expect(api.collection(kind, "7")).rejects.toThrow(/requires/);
    await expect(
      api.collection("assignments", "7/../../users"),
    ).rejects.toThrow(/Invalid Canvas identifier/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("lists active available courses with syllabus metadata", async () => {
    const { api, fetcher } = setup([
      { id: 1, name: "Biology", syllabus_body: "<p>Study</p>" },
    ]);
    expect(await api.courses()).toMatchObject([
      {
        kind: "courses",
        id: "1",
        course_id: null,
        title: "Biology",
        data: { syllabus_body: "<p>Study</p>" },
      },
    ]);
    const url = requestUrl(fetcher);
    expect(url.pathname).toBe("/api/v1/courses");
    expect(url.searchParams.get("enrollment_state")).toBe("active");
    expect(url.searchParams.getAll("state[]")).toEqual(["available"]);
    expect(url.searchParams.getAll("include[]")).toContain("syllabus_body");
  });
});

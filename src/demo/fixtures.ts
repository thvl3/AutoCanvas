// Synthetic fixtures only. Explicit --demo selects this transport; it never contacts Canvas.
const epoch = new Date();
epoch.setUTCHours(23, 59, 0, 0);
const date = (days: number) =>
  new Date(epoch.getTime() + days * 86400000).toISOString();
const updated = date(-5);
const courses = [
  {
    id: 101,
    name: "Algorithms",
    course_code: "CSE310",
    workflow_state: "available",
  },
  {
    id: 102,
    name: "Technical Writing",
    course_code: "ENG201",
    workflow_state: "available",
  },
  {
    id: 103,
    name: "Statistics",
    course_code: "MAT250",
    workflow_state: "available",
  },
];
export function demoAssignments(courseId: number) {
  const base = courseId * 100;
  const shared = {
    course_id: courseId,
    assignment_group_id: courseId * 10,
    points_possible: 100,
    submission_types: ["online_upload"],
    allowed_extensions: ["md", "pdf", "zip"],
    allowed_attempts: 3,
    locked_for_user: false,
    lock_at: date(14),
    unlock_at: date(-30),
    updated_at: updated,
  };
  return [
    {
      ...shared,
      id: base + 1,
      name: "Graph search project",
      description: `<h2>Requirements</h2><p>Explain your approach in 300 words. Include a heading named Results.</p><p>Upload your report and source code. <a href="/courses/${courseId}/files/${base + 50}/download">Starter file</a></p>`,
      due_at: date(2),
      rubric: [
        {
          id: "r1",
          description: "Explanation",
          long_description: "Explain the algorithm and justify its complexity.",
          points: 60,
        },
        {
          id: "r2",
          description: "Tests",
          long_description: "Provide tests and discuss the results.",
          points: 40,
        },
      ],
      submission: {
        assignment_id: base + 1,
        user_id: 7,
        workflow_state: "unsubmitted",
        missing: false,
        late: false,
        attempt: 0,
        score: null,
        grade: null,
        submitted_at: null,
      },
    },
    {
      ...shared,
      id: base + 2,
      name: "Week 1 reflection",
      description: "<p>Reflect on the assigned reading.</p>",
      points_possible: 10,
      due_at: date(-3),
      submission: {
        assignment_id: base + 2,
        user_id: 7,
        workflow_state: "unsubmitted",
        missing: true,
        late: false,
        attempt: 0,
        score: null,
      },
    },
    {
      ...shared,
      id: base + 3,
      name: "Foundations quiz",
      description: "<p>Review foundational concepts.</p>",
      points_possible: 20,
      due_at: date(-7),
      submission_types: ["online_quiz"],
      submission: {
        assignment_id: base + 3,
        user_id: 7,
        workflow_state: "graded",
        missing: false,
        late: false,
        attempt: 1,
        score: 18,
        grade: "18",
        submitted_at: date(-8),
      },
    },
    {
      ...shared,
      id: base + 4,
      name: "Midterm review",
      description: "<p>Study Modules 1 and 2.</p>",
      points_possible: 30,
      due_at: date(6),
      submission: {
        assignment_id: base + 4,
        user_id: 7,
        workflow_state: "unsubmitted",
        missing: false,
        late: false,
        attempt: 0,
      },
    },
  ];
}
export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const path = url.pathname;
  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  if (init?.method && init.method !== "GET")
    return json({ errors: [{ message: "Demo supports GET only" }] }, 405);
  if (path === "/api/v1/users/self/profile" || path === "/api/v1/users/self")
    return json({ id: 7, name: "Demo Student" });
  if (path === "/api/v1/courses")
    return url.searchParams.get("page") === "2"
      ? json(courses.slice(2))
      : json(courses.slice(0, 2), 200, {
          Link: '<https://canvas.example.invalid/api/v1/courses?page=2>; rel="next"',
        });
  if (path === "/api/v1/users/self/todo" || path === "/api/v1/planner/items")
    return json([]);
  if (path === "/api/v1/announcements") {
    const id = Number(
      url.searchParams.get("context_codes[]")?.replace("course_", "") ?? 101,
    );
    return json([
      {
        id: id * 100 + 60,
        context_code: `course_${id}`,
        title: "Graph search project reminder",
        message: "<p>Include tests and explain your results.</p>",
        posted_at: date(-1),
        updated_at: updated,
      },
    ]);
  }
  const match = path.match(/^\/api\/v1\/courses\/(\d+)(.*)$/);
  if (match) {
    const id = Number(match[1]);
    const suffix = match[2];
    const base = id * 100;
    if (!courses.some((c) => c.id === id))
      return json({ errors: [{ message: "Course not found" }] }, 404);
    if (!suffix) return json(courses.find((c) => c.id === id));
    if (suffix === "/assignments") return json(demoAssignments(id));
    if (suffix === "/assignment_groups")
      return json([{ id: id * 10, name: "Projects", group_weight: 40 }]);
    if (suffix === "/modules")
      return json([
        {
          id: id * 10 + 1,
          name: "Module 1: Graphs",
          position: 1,
          items_count: 3,
          prerequisite_module_ids: [],
          state: "started",
        },
      ]);
    if (suffix === `/modules/${id * 10 + 1}/items`)
      return json([
        {
          id: base + 31,
          title: "Graph search project",
          position: 1,
          type: "Assignment",
          content_id: base + 1,
        },
        {
          id: base + 32,
          title: "Graph traversal notes",
          position: 2,
          type: "Page",
          page_url: "graph-traversal",
        },
        {
          id: base + 33,
          title: "Starter data",
          position: 3,
          type: "File",
          content_id: base + 50,
        },
      ]);
    if (suffix === "/pages")
      return json([
        {
          page_id: base + 40,
          url: "graph-traversal",
          title: "Graph traversal notes",
          updated_at: updated,
        },
      ]);
    if (suffix?.startsWith("/pages/"))
      return json({
        page_id: base + 40,
        url: "graph-traversal",
        title: "Graph traversal notes",
        body: "<h2>Breadth-first search</h2><p>Use a queue to explore a graph by distance from the start vertex.</p>",
        updated_at: updated,
      });
    if (suffix === "/files")
      return json([
        {
          id: base + 50,
          filename: "starter.txt",
          display_name: "starter.txt",
          size: 27,
          "content-type": "text/plain",
          url: `https://canvas.example.invalid/files/${base + 50}/download`,
          updated_at: updated,
          locked_for_user: false,
        },
      ]);
    if (suffix === "/discussion_topics")
      return json([
        {
          id: base + 70,
          title: "Graph discussion",
          message: "Compare BFS and DFS.",
          assignment_id: base + 1,
          posted_at: updated,
        },
      ]);
    if (suffix === "/enrollments")
      return json([
        {
          id: base + 80,
          course_id: id,
          user_id: 7,
          type: "StudentEnrollment",
          enrollment_state: "active",
          grades: {
            current_score: 90,
            current_grade: "A-",
            final_score: 45,
            final_grade: null,
          },
        },
      ]);
    if (suffix === "/todo") return json([]);
    const assignment = suffix?.match(
      /^\/assignments\/(\d+)(\/submissions\/(?:self|7))?$/,
    );
    if (assignment) {
      const a = demoAssignments(id).find((a) => a.id === Number(assignment[1]));
      if (a)
        return json(
          assignment[2]
            ? {
                ...a.submission,
                submission_comments: [
                  {
                    id: 1,
                    comment:
                      "Remember to include a test case for a disconnected graph.",
                    created_at: updated,
                  },
                ],
              }
            : a,
        );
    }
  }
  const fileMatch = path.match(/^\/api\/v1\/(?:courses\/\d+\/)?files\/(\d+)$/);
  if (fileMatch)
    return json({
      id: Number(fileMatch[1]),
      filename: "starter.txt",
      size: 27,
      "content-type": "text/plain",
      url: `https://canvas.example.invalid/files/${fileMatch[1]}/download`,
      updated_at: updated,
    });
  if (/^\/files\/\d+\/download$/.test(path))
    return new Response("A -> B\nB -> C\nC -> A\nD -> E\n", {
      headers: { "Content-Type": "text/plain" },
    });
  return json({ errors: [{ message: "Unimplemented fixture route" }] }, 404);
};

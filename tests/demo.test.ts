import { expect, it } from "vitest";
import { demoFetch } from "../src/demo/fixtures.js";
it("serves realistic authenticated paginated Canvas fixtures and refuses unknown routes", async () => {
  const response = await demoFetch(
    "https://canvas.example.invalid/api/v1/courses",
  );
  const courses = await response.json();
  expect(courses).toHaveLength(2);
  expect(response.headers.get("Link")).toContain('rel="next"');
  const assignments = await (
    await demoFetch(
      "https://canvas.example.invalid/api/v1/courses/101/assignments",
    )
  ).json();
  expect(assignments.length).toBeGreaterThan(2);
  expect(assignments.some((a: Record<string, unknown>) => a.rubric)).toBe(true);
  expect(
    (await demoFetch("https://canvas.example.invalid/api/v1/unhandled")).status,
  ).toBe(404);
});

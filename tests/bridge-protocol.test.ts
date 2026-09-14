import { describe, it, expect } from "vitest";
import {
  operationSchema,
  requestSchema,
  responseSchema,
  validateOperation,
  BridgeError,
} from "../src/bridge/protocol.js";

describe("bridge protocol", () => {
  it("never inherits HTTP status values from arbitrary error-code keys", () => {
    for (const code of ["__proto__", "constructor", "toString"])
      expect(
        new BridgeError(code, "Invalid extension response").status,
      ).toBeUndefined();
    expect(
      new BridgeError("canvas_authentication_required", "Sign in").status,
    ).toBe(401);
  });
  it("allowlists Canvas read paths without normalization or other-user access", () => {
    const allowed = [
      "/api/v1/users/self/profile",
      "/api/v1/courses?enrollment_state=active&state[]=available",
      "/api/v1/courses/1/assignments/2?include[]=submission",
      "/api/v1/courses/1/modules/2/items?page=2&per_page=100",
      "/api/v1/courses/1/pages/page_id:2",
      "/api/v1/courses/1/pages/week-one",
      "/api/v1/courses/1/students/submissions",
      "/api/v1/courses/1/assignments/2/submissions/self",
      "/api/v1/courses/1/enrollments?user_id=self",
      "/api/v1/users/self/todo",
      "/api/v1/announcements?context_codes[]=course_1&start_date=1970-01-01",
      "/api/v1/planner/items",
      "/api/v1/files/2",
    ];
    for (const path of allowed)
      expect(validateOperation({ type: "canvas-get", path })).toEqual({
        type: "canvas-get",
        path,
      });
    const denied = [
      "/api/v1/courses?per_page=1?x&as_user_id=2",
      "https://evil.test/api/v1/courses",
      "//evil.test/api/v1/courses",
      "/api/v1/courses/1/../2",
      "/api/v1/courses/%2e%2e/users",
      "/api/v1/courses/1/pages/%252e%252e",
      "/api/v1/courses/1/pages/a%2fb",
      "/api/v1/users/2/profile",
      "/api/v1/courses/1/enrollments",
      "/api/v1/courses/1/enrollments?user_id=2",
      "/api/v1/courses/1/assignments/2/submissions/3",
      "/api/v1/courses?as_user_id=2",
      "/api/v1/courses?access_token=secret",
      "/api/v1/courses?unknown=1",
      "/api/v1/courses?per_page=999999",
      "/api/v1/courses?context_codes[]=group_1",
      "/api/v1/courses#x",
      "/api/v1/courses/1/discussion_topics/2/entries",
      "/api/v1/courses/1/pages/%00",
      "/api/v1/courses/1/pages/a\\b",
    ];
    for (const path of denied)
      expect(
        () => validateOperation({ type: "canvas-get", path }),
        path,
      ).toThrow(BridgeError);
    expect(() =>
      validateOperation({
        type: "canvas-get",
        path: "/api/v1/courses",
        method: "DELETE",
      }),
    ).toThrow(BridgeError);
  });
  it("parses GraphQL and rejects writes, SDL, cycles and resource exhaustion", () => {
    const invalid = [
      "mutation { deleteCourse(id:1) }",
      "subscription { updates }",
      "query A { id } query B { id }",
      "type Evil { field: String }",
      "{ ...A } fragment A on Query { ...B } fragment B on Query { ...A }",
      "{ ...Missing }",
      "{ " + "x { ".repeat(25) + "id" + " }".repeat(25) + " }",
      "{ " +
        Array.from({ length: 1001 }, (_, i) => `a${i}:id`).join(" ") +
        " }",
      "#".repeat(65537),
      "{ malformed",
    ];
    for (const query of invalid) {
      expect(
        () => validateOperation({ type: "graphql-query", query }),
        query,
      ).toThrow(BridgeError);
      expect(
        operationSchema.safeParse({ type: "graphql-query", query }).success,
      ).toBe(false);
    }
    expect(() =>
      validateOperation({
        type: "graphql-query",
        query: "query Q($x: String) { id }",
        variables: { x: "x".repeat(65537) },
      }),
    ).toThrow(BridgeError);
    const circular: Record<string, unknown> = {};
    circular.x = circular;
    expect(() =>
      validateOperation({
        type: "graphql-query",
        query: "{id}",
        variables: circular,
      }),
    ).toThrow(BridgeError);
    expect(
      validateOperation({
        type: "graphql-query",
        query: "query Q { ...F } fragment F on Query { __typename }",
      }).type,
    ).toBe("graphql-query");
  });
  it("accepts only strict typed read operations and envelopes", () => {
    expect(validateOperation({ type: "session-health" })).toEqual({
      type: "session-health",
    });
    expect(
      validateOperation({
        type: "graphql-query",
        query: "{ __schema { queryType { name } } }",
      }).type,
    ).toBe("graphql-query");
    expect(
      validateOperation({
        type: "canvas-page",
        kind: "page",
        courseId: "1",
        id: "2",
      }).type,
    ).toBe("canvas-page");
    expect(
      validateOperation({
        type: "download-file",
        courseId: "1",
        fileId: "2",
        maxBytes: 1024,
      }).type,
    ).toBe("download-file");
    for (const operation of [
      { type: "fetch", url: "https://evil.test" },
      { type: "session-health", method: "POST" },
      { type: "canvas-page", kind: "page", courseId: "0", id: "2" },
      {
        type: "download-file",
        courseId: "1",
        fileId: "2",
        maxBytes: 20_000_000,
      },
    ]) {
      expect(operationSchema.safeParse(operation).success).toBe(false);
      expect(() => validateOperation(operation)).toThrow(BridgeError);
    }
    const requestId = "f69a75b1-0551-45bc-aada-996ff975dbcc";
    expect(
      requestSchema.safeParse({
        protocolVersion: 1,
        requestId,
        operation: { type: "session-health" },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        protocolVersion: 2,
        requestId,
        operation: { type: "session-health" },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        protocolVersion: 1,
        requestId,
        ok: true,
        result: { status: 200, body: {} },
      }).success,
    ).toBe(true);
    expect(
      responseSchema.safeParse({
        protocolVersion: 1,
        requestId,
        ok: false,
        error: {
          code: "canvas_not_open",
          message: "Open Canvas",
          retryable: true,
        },
      }).success,
    ).toBe(true);
  });
});

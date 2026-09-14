import type { BridgeOperation, BrowserResult } from "../bridge/protocol.js";
import { validateOperation } from "../bridge/protocol.js";
import { normalize } from "../domain/normalize.js";
import type { Entity, EntityKind } from "../domain/types.js";
import { record } from "./graphql.js";

export { GraphqlGap } from "./graphql.js";
function stripFileUrls(value: unknown, isFile = false): unknown {
  if (Array.isArray(value))
    return value.map((item) => stripFileUrls(item, isFile));
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const file =
    isFile ||
    (input.id !== undefined &&
      (input.filename !== undefined || input["content-type"] !== undefined));
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !(file && (key === "url" || key.endsWith("_url"))))
      .map(([key, item]) => [
        key,
        stripFileUrls(item, key === "attachments" || key === "attachment"),
      ]),
  );
}
function safeRaw(kind: EntityKind, value: unknown): Record<string, unknown> {
  return record(stripFileUrls(record(value), kind === "files"));
}
export function queryPath(
  path: string,
  query: Record<string, string | string[]> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const item of Array.isArray(value) ? value : [value])
      params.append(key, item);
  return `${path}${params.size ? `?${params}` : ""}`;
}
export const COURSE_QUERY_PARAMS = {
  enrollment_state: "active",
  "state[]": ["available"],
  "include[]": ["syllabus_body", "term", "total_scores"],
};
export function collectionPath(kind: EntityKind, courseId: string): string {
  const base = `/api/v1/courses/${courseId}`;
  const dates = {
    start_date: "1970-01-01",
    end_date: "2100-01-01",
    "context_codes[]": [`course_${courseId}`],
    per_page: "100",
  };
  switch (kind) {
    case "announcements":
      return queryPath("/api/v1/announcements", dates);
    case "planner":
      return queryPath("/api/v1/planner/items", dates);
    case "assignments":
      return queryPath(`${base}/assignments`, {
        per_page: "100",
        "include[]": ["submission"],
      });
    case "submissions":
      return queryPath(`${base}/students/submissions`, { per_page: "100" });
    case "enrollments":
      return queryPath(`${base}/enrollments`, {
        per_page: "100",
        user_id: "self",
      });
    case "discussions":
      return queryPath(`${base}/discussion_topics`, { per_page: "100" });
    case "modules":
    case "pages":
    case "files":
    case "assignment_groups":
      return queryPath(`${base}/${kind}`, { per_page: "100" });
    default:
      throw new Error("Collection requires a dedicated Canvas method");
  }
}
export class SessionFallback {
  constructor(
    private readonly origin: string,
    private readonly request: (
      operation: BridgeOperation,
    ) => Promise<BrowserResult>,
  ) {}
  async detail(
    kind: EntityKind,
    path: string,
    courseId?: string,
    reason = "schema_gap",
  ): Promise<Entity> {
    validateOperation({ type: "canvas-get", path });
    const response = await this.request({ type: "canvas-get", path });
    return normalize(
      kind,
      {
        ...safeRaw(kind, response.body),
        source: { transport: "canvas-get", reason },
      },
      courseId,
    );
  }
  async list(
    kind: EntityKind,
    path: string,
    courseId?: string,
    reason = "schema_gap",
  ): Promise<Entity[]> {
    let next: string | undefined = path;
    const entities: Entity[] = [];
    const seen = new Set<string>();
    const endpoint = new URL(path, this.origin).pathname;
    while (next) {
      validateOperation({ type: "canvas-get", path: next });
      const canonical = new URL(next, this.origin);
      canonical.searchParams.sort();
      if (seen.has(canonical.href) || seen.size >= 10000)
        throw new Error("Invalid Canvas pagination");
      seen.add(canonical.href);
      const response = await this.request({ type: "canvas-get", path: next });
      if (!Array.isArray(response.body))
        throw new Error("Invalid Canvas collection payload");
      entities.push(
        ...response.body.map((raw) =>
          normalize(
            kind,
            {
              ...safeRaw(kind, raw),
              source: { transport: "canvas-get", reason },
            },
            courseId,
          ),
        ),
      );
      const entries =
        response.link?.match(/<[^>]*>(?:[^,"<]|"(?:\\.|[^"\\])*")*/g) ?? [];
      next = undefined;
      for (const entry of entries) {
        const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(entry);
        if (
          !(relation?.[1] ?? relation?.[2] ?? "").split(/\s+/).includes("next")
        )
          continue;
        const target = /^<([^>]*)>/.exec(entry)?.[1];
        if (!target) throw new Error("Invalid Canvas pagination");
        const url = new URL(target, this.origin);
        if (
          url.origin !== this.origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !== endpoint
        )
          throw new Error("Unsafe Canvas pagination");
        next = `${url.pathname}${url.search}`;
      }
    }
    return entities;
  }
}

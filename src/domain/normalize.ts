import { canvasIdSchema, canvasSchemas } from "./schemas.js";
import type { Entity, EntityKind } from "./types.js";
import { z } from "zod";

const offsetTime = z.iso.datetime({ offset: true });
const localTime = z.iso.datetime({ local: true });
const dateOnly = z.iso.date();

function normalized(value: unknown, key = ""): unknown {
  if (value === null || value === undefined) return value;
  if (key === "id" || key.endsWith("_id")) return canvasIdSchema.parse(value);
  if (
    key.endsWith("_at") ||
    ["plannable_date", "todo_date", "start_date", "end_date"].includes(key)
  ) {
    if (
      offsetTime.safeParse(value).success ||
      dateOnly.safeParse(value).success
    )
      return new Date(value as string).toISOString();
    // Canvas documents unzoned publish_at values. Preserve their ISO local
    // representation rather than silently assigning the machine's timezone.
    if (localTime.safeParse(value).success) return value;
    throw new Error("Invalid timestamp");
  }
  if (Array.isArray(value))
    return value.map((item) =>
      normalized(item, key.endsWith("_ids") ? "id" : ""),
    );
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        normalized(item, name),
      ]),
    );
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalize(
  kind: EntityKind,
  raw: unknown,
  courseId?: string,
): Entity {
  try {
    const parsed = canvasSchemas[kind].parse(raw);
    const data = normalized(parsed) as Record<string, unknown>;
    const plannable = object(data.plannable);
    const assignment = object(data.assignment);
    let id = text(data.id);
    if (kind === "pages") id = text(data.page_id) ?? id;
    if (kind === "submissions") id ??= `${data.assignment_id}:${data.user_id}`;
    if (kind === "planner") {
      if (data.plannable_id != null && text(data.plannable_type))
        id = `${data.plannable_type}:${data.plannable_id}`;
      else if (text(data.type) && text(assignment.id))
        id = `todo:${data.type}:${assignment.id}`;
    }
    if (!id) throw new Error("Missing identity");
    const rawCourseId = text(data.course_id) ?? text(assignment.course_id);
    if (courseId && rawCourseId && rawCourseId !== courseId)
      throw new Error("course context mismatch");
    const course_id =
      kind === "courses" ? null : (rawCourseId ?? courseId ?? null);
    if (course_id !== null) data.course_id = canvasIdSchema.parse(course_id);
    const title =
      text(data.name) ??
      text(data.title) ??
      text(data.display_name) ??
      text(data.filename) ??
      text(plannable.title) ??
      text(plannable.name) ??
      text(assignment.name) ??
      (kind === "rubrics" ? text(data.description) : undefined) ??
      (kind === "enrollments" ? text(data.type) : undefined) ??
      (kind === "submissions"
        ? `Submission ${data.assignment_id}`
        : `${kind} ${id}`);
    return {
      kind,
      id,
      course_id,
      title,
      updated_at: text(data.updated_at) ?? null,
      data,
      raw: structuredClone(raw) as Record<string, unknown>,
    };
  } catch (error) {
    // Zod issues, raw payloads, HTML and bad field values must not reach logs.
    const suffix =
      error instanceof Error && error.message === "course context mismatch"
        ? ": course context mismatch"
        : "";
    throw new Error(`Invalid Canvas ${kind} payload${suffix}`);
  }
}

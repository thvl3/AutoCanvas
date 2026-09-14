import type { CanvasClient, Query } from "./client.js";
import { normalize } from "../domain/normalize.js";
import type { Entity, EntityKind } from "../domain/types.js";
import { canvasIdSchema } from "../domain/schemas.js";
import { z } from "zod";

function identifier(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid Canvas identifier");
  return value;
}
const broadDates = { start_date: "1970-01-01", end_date: "2100-01-01" };

export class CanvasApi {
  constructor(private readonly client: CanvasClient) {}

  async authCheck(): Promise<{ id: string; name?: string }> {
    const raw = await this.client.get<unknown>("/api/v1/users/self/profile");
    const parsed = z
      .object({ id: canvasIdSchema, name: z.string().optional() })
      .safeParse(raw);
    if (!parsed.success) throw new Error("Invalid Canvas user payload");
    return parsed.data;
  }

  async course(courseId: string): Promise<Entity> {
    return normalize(
      "courses",
      await this.client.get(`/api/v1/courses/${identifier(courseId)}`, {
        "include[]": ["syllabus_body", "term", "total_scores"],
      }),
    );
  }

  async assignment(courseId: string, id: string): Promise<Entity> {
    return normalize(
      "assignments",
      await this.client.get(
        `/api/v1/courses/${identifier(courseId)}/assignments/${identifier(id)}`,
        { "include[]": ["submission"] },
      ),
      courseId,
    );
  }

  async page(courseId: string, slugOrId: string): Promise<Entity> {
    if (
      !slugOrId ||
      /[\\/\x00-\x20\x7f]/.test(slugOrId) ||
      [".", ".."].includes(slugOrId)
    )
      throw new Error("Invalid Canvas page identifier");
    const locator = /^\d+$/.test(slugOrId)
      ? `page_id:${slugOrId}`
      : /^page_id:\d+$/.test(slugOrId)
        ? slugOrId
        : encodeURIComponent(slugOrId);
    return normalize(
      "pages",
      await this.client.get(
        `/api/v1/courses/${identifier(courseId)}/pages/${locator}`,
      ),
      courseId,
    );
  }

  async file(courseId: string, id: string): Promise<Entity> {
    return normalize(
      "files",
      await this.client.get(
        `/api/v1/courses/${identifier(courseId)}/files/${identifier(id)}`,
      ),
      courseId,
    );
  }

  async submission(courseId: string, assignmentId: string): Promise<Entity> {
    return normalize(
      "submissions",
      await this.client.get(
        `/api/v1/courses/${identifier(courseId)}/assignments/${identifier(assignmentId)}/submissions/self`,
        { "include[]": ["submission_comments", "rubric_assessment"] },
      ),
      courseId,
    );
  }

  async moduleItems(courseId: string, moduleId: string): Promise<Entity[]> {
    const entities = await this.list(
      "module_items",
      `/api/v1/courses/${identifier(courseId)}/modules/${identifier(moduleId)}/items`,
      courseId,
      { "include[]": ["content_details"] },
    );
    for (const entity of entities) entity.data.module_id = moduleId;
    return entities;
  }

  async todo(courseId?: string): Promise<Entity[]> {
    return this.list(
      "planner",
      courseId === undefined
        ? "/api/v1/users/self/todo"
        : `/api/v1/courses/${identifier(courseId)}/todo`,
      courseId,
    );
  }

  private async list(
    kind: EntityKind,
    path: string,
    courseId?: string,
    query?: Query,
  ): Promise<Entity[]> {
    const entities: Entity[] = [];
    for await (const raw of this.client.paginate(path, {
      per_page: 100,
      ...query,
    }))
      entities.push(normalize(kind, raw, courseId));
    return entities;
  }

  async collection(kind: EntityKind, courseId: string): Promise<Entity[]> {
    const base = `/api/v1/courses/${identifier(courseId)}`;
    switch (kind) {
      case "courses":
        return this.courses();
      case "assignments":
        return this.list(kind, `${base}/assignments`, courseId, {
          "include[]": ["submission"],
        });
      case "assignment_groups":
      case "modules":
      case "pages":
      case "files":
        return this.list(kind, `${base}/${kind}`, courseId);
      case "discussions":
        return this.list(kind, `${base}/discussion_topics`, courseId);
      case "announcements":
        return this.list(kind, "/api/v1/announcements", courseId, {
          "context_codes[]": [`course_${courseId}`],
          ...broadDates,
        });
      // The documented default, with student_ids omitted, is the calling user.
      case "submissions":
        return this.list(kind, `${base}/students/submissions`, courseId);
      case "enrollments":
        return this.list(kind, `${base}/enrollments`, courseId, {
          user_id: "self",
        });
      case "planner":
        return this.list(kind, "/api/v1/planner/items", courseId, {
          "context_codes[]": [`course_${courseId}`],
          ...broadDates,
        });
      case "module_items":
        throw new Error(
          "module_items collection requires a module ID; use moduleItems",
        );
      case "rubrics":
        throw new Error(
          "rubrics collection requires extraction from assignment data.rubric",
        );
    }
  }

  async courses(): Promise<Entity[]> {
    const entities: Entity[] = [];
    for await (const raw of this.client.paginate("/api/v1/courses", {
      enrollment_state: "active",
      "state[]": ["available"],
      "include[]": ["syllabus_body", "term", "total_scores"],
      per_page: 100,
    })) {
      entities.push(normalize("courses", raw));
    }
    return entities;
  }
}

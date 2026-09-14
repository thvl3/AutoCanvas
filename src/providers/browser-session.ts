import { validateBaseUrl, type Config } from "../config.js";
import type { BridgeOperation, BrowserResult } from "../bridge/protocol.js";
import { BridgeError } from "../bridge/protocol.js";
import { canvasIdSchema } from "../domain/schemas.js";
import { normalize } from "../domain/normalize.js";
import type { Entity, EntityKind } from "../domain/types.js";
import {
  ASSIGNMENT_QUERY,
  ASSIGNMENTS_QUERY,
  assignmentFields,
  COURSE_QUERY,
  COURSES_QUERY,
  ENROLLMENTS_QUERY,
  MODULES_QUERY,
  moduleFields,
  SCHEMA_QUERY,
  SUBMISSION_QUERY,
  SUBMISSIONS_QUERY,
  fromGraphql,
  record,
} from "./graphql.js";
import {
  collectionPath,
  COURSE_QUERY_PARAMS,
  GraphqlGap,
  queryPath,
  SessionFallback,
} from "./fallback.js";
import type { CanvasDataProvider, ProviderHealth } from "./types.js";
function identifier(...values: string[]): void {
  if (values.some((value) => !/^[1-9]\d*$/.test(value) || value.length > 30))
    throw new Error("Invalid Canvas identifier");
}

export class BrowserSessionProvider implements CanvasDataProvider {
  constructor(
    private readonly config: Pick<
      Config,
      "baseUrl" | "timeoutMs" | "maxDownloadBytes"
    >,
    private readonly bridge: {
      request(operation: BridgeOperation): Promise<BrowserResult>;
    },
    private readonly logger?: {
      info(data: object, message: string): void;
      warn(data: object, message: string): void;
    },
  ) {
    validateBaseUrl(config.baseUrl);
    if (
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 300000 ||
      !Number.isSafeInteger(config.maxDownloadBytes) ||
      config.maxDownloadBytes < 1
    )
      throw new Error("Invalid Canvas provider limits");
  }
  async schema(): Promise<unknown> {
    return record((await this.graphql(SCHEMA_QUERY, {})).__schema);
  }
  async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await this.request({ type: "session-health" });
      canvasIdSchema.parse(record(response.body).id);
      return {
        provider: "browser-session",
        state: "connected",
        origin: this.config.baseUrl,
      };
    } catch (error) {
      let state: ProviderHealth["state"] = "unknown";
      if (error instanceof BridgeError) {
        if (error.status === 401) state = "authentication_required";
        else if (
          error.code === "canvas_not_open" ||
          error.code === "extension_disconnected" ||
          error.code === "bridge_disconnected"
        )
          state = error.code;
      }
      return {
        provider: "browser-session",
        state,
        origin: this.config.baseUrl,
        message:
          state === "authentication_required"
            ? "Open Canvas in your browser and sign in."
            : "Canvas session health unavailable",
      };
    }
  }
  private async request(operation: BridgeOperation): Promise<BrowserResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: BrowserResult;
    try {
      response = await Promise.race([
        this.bridge.request(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BridgeError(
                  "bridge_timeout",
                  "Canvas browser request timed out.",
                  true,
                ),
              ),
            this.config.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof BridgeError && error.status === 401)
        throw new BridgeError(
          "canvas_authentication_required",
          "Open Canvas in your browser and sign in.",
          true,
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      (response.contentType?.includes("text/html") &&
        !(
          operation.type === "canvas-page" &&
          response.body !== null &&
          typeof response.body === "object" &&
          !Array.isArray(response.body)
        )) ||
      (typeof response.body === "string" && /^\s*</.test(response.body))
    )
      throw new BridgeError(
        "canvas_authentication_required",
        "Open Canvas in your browser and sign in.",
        true,
      );
    if (response.status < 200 || response.status >= 300)
      throw new BridgeError(
        response.status === 403
          ? "canvas_permission_denied"
          : "canvas_http_error",
        "Canvas request failed",
        false,
        response.status,
      );
    return response;
  }
  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: BrowserResult;
    try {
      response = await this.request({
        type: "graphql-query",
        query,
        variables,
      });
    } catch (error) {
      if (
        error instanceof BridgeError &&
        [400, 403, 404, 405, 422, 501].includes(error.status ?? 0)
      )
        throw new GraphqlGap(`graphql_http_${error.status}`);
      throw error;
    }
    const body = record(response.body);
    if (Array.isArray(body.errors) && body.errors.length) {
      if (
        body.errors.some((error) => {
          if (!error || typeof error !== "object") return false;
          const extension = (
            error as { extensions?: { code?: string; status?: number } }
          ).extensions;
          return (
            extension?.code === "UNAUTHENTICATED" || extension?.status === 401
          );
        })
      )
        throw new BridgeError(
          "canvas_authentication_required",
          "Open Canvas in your browser and sign in.",
          true,
        );
      throw new GraphqlGap("graphql_errors");
    }
    return record(body.data);
  }
  private async connection(
    query: string,
    variables: Record<string, unknown>,
    path: string[],
  ): Promise<Record<string, unknown>[]> {
    const nodes: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      let value: unknown = await this.graphql(query, { ...variables, after });
      for (const key of path) value = record(value)[key];
      const connection = record(value);
      if (!Array.isArray(connection.nodes))
        throw new GraphqlGap("incomplete_connection");
      nodes.push(...connection.nodes.map(record));
      const pageInfo = record(connection.pageInfo);
      if (
        typeof pageInfo.hasNextPage !== "boolean" ||
        (pageInfo.hasNextPage &&
          (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor))
      )
        throw new GraphqlGap("incomplete_connection");
      after = pageInfo.hasNextPage ? (pageInfo.endCursor as string) : null;
      if (after !== null) {
        if (seen.has(after) || seen.size >= 10000)
          throw new Error("Invalid Canvas GraphQL pagination");
        seen.add(after);
      }
    } while (after !== null);
    return nodes;
  }
  private get fallback(): SessionFallback {
    return new SessionFallback(this.config.baseUrl, (operation) =>
      this.request(operation),
    );
  }
  private gap(error: unknown, kind: EntityKind): string {
    if (!(error instanceof GraphqlGap)) throw error;
    this.logger?.warn(
      { provider: "browser-session", kind, reason: error.reason },
      "Canvas session fallback",
    );
    return error.reason;
  }
  async page(courseId: string, slugOrId: string): Promise<Entity> {
    const locator = /^\d+$/.test(slugOrId)
      ? `page_id:${slugOrId}`
      : /^page_id:\d+$/.test(slugOrId)
        ? slugOrId
        : encodeURIComponent(slugOrId);
    return this.contentDetail(
      "page",
      courseId,
      locator.replace(/^page_id:/, ""),
      `/api/v1/courses/${courseId}/pages/${locator}`,
      "schema_gap",
    );
  }
  private async contentDetail(
    kind: "page" | "assignment",
    courseId: string,
    id: string,
    path: string,
    reason: string,
  ): Promise<Entity> {
    const entityKind = kind === "page" ? "pages" : "assignments";
    try {
      return await this.fallback.detail(entityKind, path, courseId, reason);
    } catch (error) {
      if (
        !(error instanceof BridgeError) ||
        ![404, 405, 501].includes(error.status ?? 0) ||
        !/^[1-9]\d*$/.test(id)
      )
        throw error;
      this.logger?.warn(
        {
          provider: "browser-session",
          kind: entityKind,
          reason: "session_get_unsupported",
          status: error.status,
        },
        "Canvas semantic content fallback",
      );
      const response = await this.request({
        type: "canvas-page",
        kind,
        courseId,
        id,
      });
      const content = record(response.body);
      const contentId =
        kind === "page" ? (content.page_id ?? content.id) : content.id;
      if (
        contentId !== id ||
        (content.id !== undefined && content.id !== id) ||
        typeof content[kind === "page" ? "body" : "description"] !== "string"
      )
        throw new Error("Invalid Canvas semantic content");
      return normalize(
        entityKind,
        {
          ...content,
          source: {
            transport: "canvas-page",
            reason: "session_get_unsupported",
            complete: false,
          },
        },
        courseId,
      );
    }
  }
  async file(courseId: string, id: string): Promise<Entity> {
    return this.fallback.detail(
      "files",
      `/api/v1/courses/${courseId}/files/${id}`,
      courseId,
    );
  }
  async moduleItems(courseId: string, moduleId: string): Promise<Entity[]> {
    const items = await this.fallback.list(
      "module_items",
      queryPath(`/api/v1/courses/${courseId}/modules/${moduleId}/items`, {
        per_page: "100",
        "include[]": ["content_details"],
      }),
      courseId,
    );
    for (const item of items) item.data.module_id = moduleId;
    return items;
  }
  async submission(courseId: string, assignmentId: string): Promise<Entity> {
    identifier(courseId, assignmentId);
    const { id: userId } = await this.authCheck();
    let reason = "submission_feedback";
    try {
      const data = await this.graphql(SUBMISSION_QUERY, {
        assignmentId,
        userId,
      });
      normalize("submissions", fromGraphql(data.submission), courseId);
    } catch (error) {
      reason = this.gap(error, "submissions");
    }
    this.logger?.warn(
      { provider: "browser-session", kind: "submissions", reason },
      "Canvas session fallback",
    );
    return this.fallback.detail(
      "submissions",
      queryPath(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self`,
        { "include[]": ["submission_comments", "rubric_assessment"] },
      ),
      courseId,
      reason,
    );
  }
  async download(
    file: Entity,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    if (
      file.kind !== "files" ||
      !file.course_id ||
      !/^[1-9]\d*$/.test(file.course_id) ||
      !/^[1-9]\d*$/.test(file.id) ||
      file.data.locked_for_user === true ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error("Invalid Canvas download request");
    const limit = Math.min(
      maxBytes,
      this.config.maxDownloadBytes,
      8 * 1024 * 1024,
    );
    const response = await this.request({
      type: "download-file",
      courseId: file.course_id,
      fileId: file.id,
      maxBytes: limit,
    });
    const encoded = response.bytesBase64;
    // Note: no regex pre-validation here. A character-class regex over a
    // multi-megabyte base64 string overflows the V8 regex stack
    // (RangeError: Maximum call stack size exceeded) and blocks any download
    // larger than ~1.5 MiB. The length bound plus the canonical round-trip
    // below is the strictly stronger check: Buffer.from silently drops
    // non-alphabet characters, so any malformed or non-canonical input fails
    // the re-encode comparison.
    if (
      typeof encoded !== "string" ||
      encoded.length > Math.ceil(limit / 3) * 4
    )
      throw new Error("Invalid Canvas download payload");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== encoded)
      throw new Error("Invalid Canvas download payload");
    return { bytes, contentType: response.contentType };
  }
  async course(courseId: string): Promise<Entity> {
    identifier(courseId);
    try {
      const data = await this.graphql(COURSE_QUERY, { courseId });
      const enrollments = await this.collection("enrollments", courseId);
      return normalize("courses", {
        ...fromGraphql(data.course),
        enrollments: enrollments.map((item) => item.data),
      });
    } catch (error) {
      return this.fallback.detail(
        "courses",
        queryPath(`/api/v1/courses/${courseId}`, {
          "include[]": ["syllabus_body", "term", "total_scores"],
        }),
        undefined,
        this.gap(error, "courses"),
      );
    }
  }
  async assignment(courseId: string, assignmentId: string): Promise<Entity> {
    identifier(courseId, assignmentId);
    const { id: userId } = await this.authCheck();
    try {
      const data = await this.graphql(ASSIGNMENT_QUERY, {
        assignmentId,
        userId,
      });
      return normalize(
        "assignments",
        assignmentFields(data.assignment, userId),
        courseId,
      );
    } catch (error) {
      return this.contentDetail(
        "assignment",
        courseId,
        assignmentId,
        queryPath(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, {
          "include[]": ["submission"],
        }),
        this.gap(error, "assignments"),
      );
    }
  }
  async collection(kind: EntityKind, courseId: string): Promise<Entity[]> {
    if (kind === "courses") return this.courses();
    identifier(courseId);
    if (kind === "module_items")
      throw new Error(
        "module_items collection requires a module ID; use moduleItems",
      );
    if (kind === "rubrics")
      throw new Error(
        "rubrics collection requires extraction from assignment data.rubric",
      );
    if (
      !["assignments", "enrollments", "submissions", "modules"].includes(kind)
    ) {
      this.logger?.warn(
        { provider: "browser-session", kind, reason: "schema_gap" },
        "Canvas session fallback",
      );
      return new SessionFallback(this.config.baseUrl, (operation) =>
        this.request(operation),
      ).list(kind, collectionPath(kind, courseId), courseId);
    }
    const { id: userId } = await this.authCheck();
    try {
      if (kind === "modules") {
        const nodes = await this.connection(MODULES_QUERY, { courseId }, [
          "course",
          "modulesConnection",
        ]);
        return nodes.map((node) =>
          normalize(kind, moduleFields(node), courseId),
        );
      }
      if (kind === "submissions") {
        const nodes = await this.connection(
          SUBMISSIONS_QUERY,
          { courseId, userId },
          ["course", "submissionsConnection"],
        );
        if (!nodes.length)
          throw new GraphqlGap("empty_submissions_permission_check");
        if (nodes.some((node) => node.userId !== userId))
          throw new GraphqlGap("submission_identity_mismatch");
        return nodes.map((node) =>
          normalize(kind, fromGraphql(node), courseId),
        );
      }
      if (kind === "enrollments") {
        const nodes = await this.connection(
          ENROLLMENTS_QUERY,
          { courseId, userId },
          ["user", "enrollmentsConnection"],
        );
        if (
          nodes.some(
            (node) => node.userId !== userId || node.grades === undefined,
          )
        )
          throw new GraphqlGap("enrollment_field_gap");
        return nodes.map((node) =>
          normalize(kind, fromGraphql(node), courseId),
        );
      }
      const nodes = await this.connection(
        ASSIGNMENTS_QUERY,
        { courseId, userId },
        ["course", "assignmentsConnection"],
      );
      return nodes.map((node) =>
        normalize(kind, assignmentFields(node, userId), courseId),
      );
    } catch (error) {
      if (!(error instanceof GraphqlGap)) throw error;
      this.logger?.warn(
        { provider: "browser-session", kind, reason: error.reason },
        "Canvas session fallback",
      );
      return new SessionFallback(this.config.baseUrl, (operation) =>
        this.request(operation),
      ).list(kind, collectionPath(kind, courseId), courseId, error.reason);
    }
  }
  async todo(courseId?: string): Promise<Entity[]> {
    if (courseId !== undefined) identifier(courseId);
    return this.fallback.list(
      "planner",
      queryPath(
        courseId === undefined
          ? "/api/v1/users/self/todo"
          : `/api/v1/courses/${courseId}/todo`,
        { per_page: "100" },
      ),
      courseId,
    );
  }
  async courses(): Promise<Entity[]> {
    // GraphQL currentOnly includes historical active workflow enrollments.
    // Discover date-effective membership through the isolated session GET first.
    let current: Entity[];
    try {
      current = await this.fallback.list(
        "courses",
        queryPath("/api/v1/courses", {
          ...COURSE_QUERY_PARAMS,
          per_page: "100",
        }),
        undefined,
        "current_course_membership",
      );
    } catch (error) {
      if (
        !(error instanceof BridgeError) ||
        !error.status ||
        error.status === 401
      )
        throw error;
      throw new BridgeError(
        error.code,
        "Current course membership unavailable. Check your Canvas browser session and course access, then retry sync.",
        error.retryable,
        error.status,
      );
    }
    if (!current.length) return [];
    const currentIds = new Set(current.map((course) => course.id));
    const { id: userId } = await this.authCheck();
    try {
      const enrollments = await this.connection(COURSES_QUERY, { userId }, [
        "user",
        "enrollmentsConnection",
      ]);
      const courses = new Map<string, Record<string, unknown>>();
      for (const enrollment of enrollments) {
        const course = fromGraphql(enrollment.course);
        const key = canvasIdSchema.parse(course.id);
        if (!currentIds.has(key)) continue;
        const mapped = fromGraphql(enrollment);
        delete mapped.course;
        const existing = courses.get(key);
        if (existing) (existing.enrollments as unknown[]).push(mapped);
        else courses.set(key, { ...course, enrollments: [mapped] });
      }
      return current.map((course) => {
        const projection = courses.get(course.id);
        return projection
          ? normalize("courses", {
              ...projection,
              source: { transport: "graphql", membership: "canvas-get" },
            })
          : course;
      });
    } catch (error) {
      if (!(error instanceof GraphqlGap)) throw error;
      this.logger?.warn(
        { provider: "browser-session", kind: "courses", reason: error.reason },
        "Canvas session fallback",
      );
      return current.map((course) =>
        normalize("courses", {
          ...course.raw,
          source: { transport: "canvas-get", reason: error.reason },
        }),
      );
    }
  }
  async authCheck(): Promise<{ id: string; name?: string }> {
    const { body } = await this.request({
      type: "canvas-get",
      path: "/api/v1/users/self/profile",
    });
    const value = body as { id: unknown; name?: string };
    return {
      id: canvasIdSchema.parse(value.id),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
  }
}

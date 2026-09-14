import { randomUUID } from "node:crypto";
import type { CanvasDataProvider } from "../providers/types.js";
import type { Entity, EntityKind } from "../domain/types.js";
import { normalize } from "../domain/normalize.js";
import {
  Repository,
  type Change,
  type CollectionCounts,
} from "../db/repository.js";

export type SyncApi = Pick<
  CanvasDataProvider,
  "authCheck" | "courses" | "collection" | "moduleItems" | "page" | "submission"
> & { baseUrl?: string; origin?: string };
export interface SyncLogger {
  warn(metadata: Record<string, unknown>, message?: string): void;
  info?(metadata: Record<string, unknown>, message?: string): void;
}
export interface SyncOptions {
  concurrency?: number;
  logger?: SyncLogger;
  origin?: string;
}
export interface SyncWarning {
  key: string;
  status?: number;
  message: string;
}
export interface SyncSummary {
  status: "complete" | "partial";
  counts: CollectionCounts;
  changes: Change[];
  warnings: SyncWarning[];
  started_at: string;
  completed_at: string;
}
export interface Freshness {
  status: "fresh" | "stale";
  last_attempt_at: string;
  last_success_at?: string;
  warning?: SyncWarning;
}
const COLLECTIONS: readonly EntityKind[] = [
  "assignments",
  "assignment_groups",
  "modules",
  "pages",
  "files",
  "discussions",
  "announcements",
  "enrollments",
  "planner",
];

export class SyncService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repo: Repository,
    private readonly api: SyncApi,
    private readonly options: SyncOptions = {},
  ) {}

  run(options: { force?: boolean } = {}): Promise<SyncSummary> {
    const result = this.tail.then(() => this.withLease(options));
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async withLease(options: { force?: boolean }): Promise<SyncSummary> {
    const owner = randomUUID();
    if (!this.repo.acquireSyncLease(owner))
      throw new Error(
        "Canvas synchronization already in progress (cache lease held)",
      );
    let lost = false;
    const check = () => {
      if (lost || !this.repo.renewSyncLease(owner))
        throw new Error("Canvas sync cache lease lost");
    };
    const timer = setInterval(() => {
      try {
        check();
      } catch {
        lost = true;
      }
    }, 20_000);
    timer.unref();
    try {
      return await this.execute(options, check);
    } finally {
      clearInterval(timer);
      this.repo.releaseSyncLease(owner);
    }
  }
  private async execute(
    _options: { force?: boolean },
    leaseCheck: () => void,
  ): Promise<SyncSummary> {
    const summary: SyncSummary = {
      status: "complete",
      counts: { added: 0, updated: 0, unchanged: 0, removed: 0 },
      changes: [],
      warnings: [],
      started_at: new Date().toISOString(),
      completed_at: "",
    };
    this.repo.setSyncState("run", {
      status: "running",
      started_at: summary.started_at,
    });
    this.options.logger?.info?.(
      {
        event: "sync.started",
        started_at: summary.started_at,
        counts: { ...summary.counts },
      },
      "Canvas sync started",
    );
    // A retained endpoint is not fresh for this run until its full read succeeds.
    for (const [key, value] of Object.entries(this.repo.syncState())) {
      if (value && typeof value === "object" && "last_attempt_at" in value)
        this.repo.setSyncState(key, { ...value, status: "stale" });
    }
    let mandatoryKey = "auth";
    try {
      const user = await this.api.authCheck();
      leaseCheck();
      const origin = this.options.origin ?? this.api.origin ?? this.api.baseUrl;
      if (origin) this.repo.bindIdentity(origin);
      this.repo.bindUserIdentity(user.id);
      mandatoryKey = "courses";
      const courses = (await this.api.courses()).filter(
        (course) =>
          !course.data.workflow_state ||
          ["available", "active"].includes(String(course.data.workflow_state)),
      );
      leaseCheck();
      this.replace("courses", null, courses, summary);
      mandatoryKey = "";
      let failure: { error: unknown } | undefined;
      const check = () => {
        leaseCheck();
        if (failure) throw failure.error;
      };
      const syncCourse = async (course: Entity) => {
        for (const kind of COLLECTIONS) {
          check();
          const key = `${kind}:${course.id}`;
          try {
            let entities = await this.api.collection(kind, course.id);
            check();
            if (kind === "enrollments")
              entities = entities.filter(
                (entity) => String(entity.data.user_id) === user.id,
              );
            if (kind === "pages") {
              const detailed: Entity[] = [];
              for (const page of entities) {
                const cached = this.repo.get("pages", page.id, course.id);
                if (
                  !_options.force &&
                  page.updated_at &&
                  page.updated_at === cached?.updated_at &&
                  typeof cached.data.body === "string"
                ) {
                  detailed.push({
                    ...page,
                    data: {
                      ...cached.data,
                      ...page.data,
                      body: cached.data.body,
                    },
                    raw: { ...cached.raw, ...page.raw, body: cached.data.body },
                  });
                } else {
                  const detail = await this.api.page(course.id, page.id);
                  check();
                  if (
                    !detail ||
                    detail.id !== page.id ||
                    typeof detail.data.body !== "string"
                  )
                    throw new Error("Incomplete page detail");
                  detailed.push(detail);
                }
              }
              entities = detailed;
            }
            this.replace(kind, course.id, entities, summary);
            if (kind === "assignments") {
              const rubrics = entities
                .filter((entity) => Array.isArray(entity.data.rubric))
                .map((entity) =>
                  normalize(
                    "rubrics",
                    {
                      id: entity.id,
                      assignment_id: entity.id,
                      title: `${entity.title} rubric`,
                      updated_at: entity.updated_at,
                      rubric: entity.data.rubric,
                      rubric_settings: entity.data.rubric_settings ?? null,
                    },
                    course.id,
                  ),
                );
              this.replace("rubrics", course.id, rubrics, summary);
              const submissions: Entity[] = [];
              let incomplete = false;
              for (const assignment of entities) {
                try {
                  const submission = await this.api.submission(
                    course.id,
                    assignment.id,
                  );
                  check();
                  if (
                    !submission ||
                    submission.kind !== "submissions" ||
                    submission.course_id !== course.id ||
                    String(submission.data.user_id) !== user.id ||
                    String(submission.data.assignment_id) !== assignment.id
                  )
                    throw new Error("Submission identity mismatch");
                  submissions.push(submission);
                } catch (error) {
                  check();
                  incomplete = true;
                  this.failed(`submissions:${course.id}`, error, summary);
                }
              }
              const refreshed = new Set(
                submissions.map((submission) =>
                  String(submission.data.assignment_id),
                ),
              );
              const retained = incomplete
                ? this.repo
                    .list("submissions", course.id)
                    .filter(
                      (submission) =>
                        !refreshed.has(String(submission.data.assignment_id)),
                    )
                : [];
              this.replace(
                "submissions",
                course.id,
                [...retained, ...submissions],
                summary,
                !incomplete,
              );
            }
            if (kind === "modules") {
              const items: Entity[] = [];
              let incomplete = false;
              for (const module of entities) {
                try {
                  items.push(
                    ...(await this.api.moduleItems(course.id, module.id)),
                  );
                  check();
                } catch (error) {
                  check();
                  incomplete = true;
                  this.failed(`module_items:${course.id}`, error, summary);
                }
              }
              if (!incomplete)
                this.replace("module_items", course.id, items, summary);
            }
          } catch (error) {
            check();
            this.failed(key, error, summary);
          }
        }
      };
      let next = 0;
      const configured = this.options.concurrency ?? 3;
      const concurrency = Number.isFinite(configured)
        ? Math.max(1, Math.min(32, Math.floor(configured)))
        : 3;
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, courses.length) },
          async () => {
            try {
              while (next < courses.length) {
                check();
                const course = courses[next++];
                if (course) await syncCourse(course);
              }
            } catch (error) {
              failure ??= { error };
            }
          },
        ),
      );
      check();
      summary.completed_at = new Date().toISOString();
      this.repo.setSyncState("run", summary);
      this.options.logger?.info?.(
        {
          event: "sync.completed",
          status: summary.status,
          started_at: summary.started_at,
          completed_at: summary.completed_at,
          counts: { ...summary.counts },
          warning_count: summary.warnings.length,
        },
        "Canvas sync completed",
      );
      return summary;
    } catch (error) {
      leaseCheck();
      if (mandatoryKey) {
        try {
          this.failed(mandatoryKey, error, summary);
        } catch {
          /* Persist aborted run below. */
        }
      }
      const completed_at = new Date().toISOString();
      this.repo.setSyncState("run", {
        ...summary,
        status: "failed",
        completed_at,
      });
      this.options.logger?.info?.(
        {
          event: "sync.completed",
          status: "failed",
          started_at: summary.started_at,
          completed_at,
          counts: { ...summary.counts },
          warning_count: summary.warnings.length,
        },
        "Canvas sync failed",
      );
      throw error;
    }
  }
  private failed(key: string, error: unknown, summary: SyncSummary): void {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    const warning: SyncWarning = {
      key,
      ...(status === undefined ? {} : { status }),
      message: status
        ? `Canvas request failed (HTTP ${status}); cached data retained`
        : "Canvas request failed; cached data retained",
    };
    const previous = this.repo.syncState()[key] as Freshness | undefined;
    this.repo.setSyncState(key, {
      status: "stale",
      last_attempt_at: new Date().toISOString(),
      ...(previous?.last_success_at
        ? { last_success_at: previous.last_success_at }
        : {}),
      warning,
    } satisfies Freshness);
    summary.status = "partial";
    summary.warnings.push(warning);
    this.options.logger?.warn(
      { event: "cache.stale", ...warning },
      "Canvas sync collection stale",
    );
    if (status === 401) throw error;
  }
  private replace(
    kind: EntityKind,
    courseId: string | null,
    entities: Entity[],
    summary: SyncSummary,
    fresh = true,
  ): void {
    const counts = this.repo.replaceCollection(kind, courseId, entities);
    this.options.logger?.info?.(
      {
        event: "cache.updated",
        kind,
        course_id: courseId,
        counts: { ...counts },
        status: fresh ? "fresh" : "stale",
      },
      "Canvas cache updated",
    );
    for (const key of ["added", "updated", "unchanged", "removed"] as const)
      summary.counts[key] += counts[key];
    summary.changes.push(
      ...this.repo
        .recentChanges(
          undefined,
          counts.added + counts.updated + counts.removed,
        )
        .reverse(),
    );
    const now = new Date().toISOString();
    if (fresh)
      this.repo.setSyncState(courseId === null ? kind : `${kind}:${courseId}`, {
        status: "fresh",
        last_attempt_at: now,
        last_success_at: now,
      } satisfies Freshness);
  }
}

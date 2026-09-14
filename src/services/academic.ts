import type { Entity, EntityKind } from "../domain/types.js";
import type { Config } from "../config.js";
import {
  assignmentContext,
  studyContext,
  type ContextRepository,
  type ContextOptions,
  type StudyOptions,
} from "./assignment-context.js";
import {
  classifyWork,
  upcoming,
  prioritize,
  record,
  strings,
  submissionFor,
  text,
} from "./planning.js";
export interface AcademicRepository extends ContextRepository {
  recentChanges(since?: string, limit?: number): unknown[];
}
export interface ServiceOptions {
  config?: Config;
  provider?: Pick<import("../providers/types.js").CanvasDataProvider, "healthCheck">;
  downloadFetch?: typeof fetch;
  acquireFile?: import("./download.js").FileAcquirer;
  sync?: { run(options?: { force?: boolean }): Promise<unknown> };
}
export function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !["raw", "access_token", "authorization", "preview_url"].includes(
              key.toLowerCase(),
            ),
        )
        .map(([key, item]) => [key, publicData(item)]),
    );
  if (typeof value === "string")
    return value.replace(/[^\s<>"'`()]+/g, (candidate) => {
      if (!candidate.includes("?")) return candidate;
      try {
        // A base recognizes relative and query-only references; never emit the
        // resolved URL, which would rewrite paths, entities and ordinary text.
        const u = new URL(
          candidate.replace(/&amp;/gi, "&"),
          "https://public.invalid/",
        );
        if (
          [...u.searchParams.keys()].some((k) =>
            /token|verifier|signature|credential|x-amz|expires/i.test(k),
          )
        ) {
          const query = candidate.indexOf("?");
          const fragment = candidate.indexOf("#", query);
          return (
            candidate.slice(0, query) +
            (fragment < 0
              ? (candidate.match(/[.,;!:]+$/)?.[0] ?? "")
              : candidate.slice(fragment))
          );
        }
        return candidate;
      } catch {
        return candidate;
      }
    });
  return value;
}
export class AcademicService {
  constructor(
    readonly repo: AcademicRepository,
    private readonly options: ServiceOptions = {},
  ) {}
  private list(kind: EntityKind, courseId?: string) {
    const active = new Set(this.repo.list("courses").map((c) => c.id));
    return this.repo
      .list(kind, courseId)
      .filter(
        (e) =>
          kind === "courses" || e.course_id === null || active.has(e.course_id),
      );
  }
  private require(kind: EntityKind, id: string, courseId?: string): Entity {
    const result = this.repo.get(kind, id, courseId);
    if (!result)
      throw new Error(
        `${kind} ${id} not found in cache; run canvas_sync first.`,
      );
    return result;
  }
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    return publicData(await this.execute(name, args));
  }
  private async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const course = text(args.course_id) ?? undefined;
    const id = text(args.assignment_id) ?? "";
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const page = (items: unknown[]) => ({
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      has_more: offset + limit < items.length,
      freshness: this.repo.syncState(),
    });
    switch (name) {
      case "canvas_auth_status":
        if (!this.options.provider) throw new Error("Provider health is unavailable.");
        return this.options.provider.healthCheck();
      case "canvas_sync":
        if (!this.options.sync)
          throw new Error("Synchronization is unavailable.");
        return this.options.sync.run({ force: args.force === true });
      case "canvas_list_courses":
        return page(this.list("courses"));
      case "canvas_get_course":
        return {
          course: this.require("courses", course ?? ""),
          freshness: this.repo.syncState(),
        };
      case "canvas_get_assignments":
        return page(this.list("assignments", course));
      case "canvas_get_assignment":
      case "canvas_get_assignment_context": {
        const a = this.require("assignments", id, course);
        return assignmentContext(
          this.repo,
          a.course_id!,
          id,
          args as ContextOptions,
        );
      }
      case "canvas_get_modules":
        return page(this.list("modules", course));
      case "canvas_get_module": {
        const m = this.require("modules", text(args.module_id) ?? "", course);
        return {
          module: m,
          items: this.list("module_items", m.course_id!).filter(
            (i) => String(i.data.module_id) === m.id,
          ),
          freshness: this.repo.syncState(),
        };
      }
      case "canvas_get_page":
        return {
          page: this.require("pages", text(args.page_id) ?? "", course),
          freshness: this.repo.syncState(),
        };
      case "canvas_get_announcements":
        return page(this.list("announcements", course));
      case "canvas_get_files":
        return page(this.list("files", course));
      case "canvas_get_discussions":
        return page(this.list("discussions", course));
      case "canvas_get_planner":
        return page(this.list("planner", course));
      case "canvas_get_upcoming":
        return page(
          upcoming(
            this.list("assignments", course),
            this.list("submissions", course),
            typeof args.days === "number" ? args.days : 7,
            new Date(),
            this.list("assignment_groups", course),
          ),
        );
      case "canvas_get_priorities":
        return page(
          this.list("assignments", course)
            .map((a) =>
              prioritize(
                a,
                submissionFor(a, this.list("submissions", course)),
                this.list("assignment_groups", course).find(
                  (g) =>
                    g.id === String(a.data.assignment_group_id) &&
                    g.course_id === a.course_id,
                ) ?? null,
              ),
            )
            .filter((a) => a.state.needs_work)
            .sort((a, b) => b.score - a.score),
        );
      case "canvas_get_missing":
        return page(
          this.list("assignments", course)
            .map((a) => ({
              assignment: a,
              state: classifyWork(
                a,
                submissionFor(a, this.list("submissions", course)),
              ),
            }))
            .filter(
              (x) =>
                !x.state.excused &&
                (x.state.missing === true ||
                  x.state.late === true ||
                  x.state.past_due_unsubmitted ||
                  x.state.failed_or_incomplete),
            ),
        );
      case "canvas_get_recent_changes":
        return {
          changes: this.repo.recentChanges(
            typeof args.since === "string"
              ? new Date(args.since).toISOString()
              : undefined,
            limit,
          ),
          limit,
          freshness: this.repo.syncState(),
        };
      case "canvas_get_study_context":
        return studyContext(this.repo, course ?? "", args as StudyOptions);
      case "canvas_get_grade_summary":
        return {
          courses: this.list("courses")
            .filter((c) => !course || course === c.id)
            .map((c) => {
              const assignments = this.list("assignments", c.id);
              const submissions = this.list("submissions", c.id);
              const states = assignments.map((a) =>
                classifyWork(a, submissionFor(a, submissions)),
              );
              const grades = this.list("enrollments", c.id).map((e) =>
                record(e.data.grades),
              );
              return {
                course_id: c.id,
                title: c.title,
                grades,
                graded_work: submissions.filter(
                  (s) => s.data.workflow_state === "graded",
                ).length,
                ungraded_work: submissions.filter((s) =>
                  ["submitted", "pending_review"].includes(
                    String(s.data.workflow_state),
                  ),
                ).length,
                missing_work: states.filter((s) => s.missing === true).length,
                past_due_unsubmitted: states.filter(
                  (s) => s.past_due_unsubmitted,
                ).length,
                unknown_submission_state: states.filter(
                  (s) => !s.submission_known,
                ).length,
                major_upcoming: upcoming(assignments, submissions, 14).slice(
                  0,
                  5,
                ),
                risk_signals: [
                  states.some((s) => s.missing === true)
                    ? "Canvas reports missing work"
                    : null,
                  grades.length === 0 ? "Grades unavailable" : null,
                ].filter(Boolean),
              };
            }),
          warnings: [
            "Grades are Canvas-reported values, not a forecast. Ungraded work is not treated as zero. Risk signals are not a prediction of passing.",
          ],
          freshness: this.repo.syncState(),
        };
      case "canvas_prepare_workspace":
      case "canvas_validate_assignment": {
        if (!this.options.config)
          throw new Error("Workspace configuration is unavailable.");
        const a = this.require("assignments", id, course);
        const context = assignmentContext(this.repo, a.course_id!, a.id);
        if (name === "canvas_prepare_workspace") {
          const { prepareWorkspace } = await import("./workspace.js");
          return prepareWorkspace(
            context,
            this.options.config,
            { download: args.download === true },
            { fetch: this.options.downloadFetch, acquire: this.options.acquireFile },
          );
        }
        const { validateAssignment } =
          await import("./submission-validation.js");
        return validateAssignment(context, this.options.config);
      }
      default:
        throw new Error(`Unknown academic tool: ${name}`);
    }
  }
}

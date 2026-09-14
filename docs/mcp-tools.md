# MCP tools and resources

Transport: stdio, official TypeScript SDK v2. The server is local-only. Tools return JSON text and structured output with a stable envelope:

```json
{
  "ok": true,
  "data": {
    "items": [],
    "total": 0,
    "offset": 0,
    "limit": 100,
    "has_more": false,
    "freshness": {}
  }
}
```

Failures set `isError: true`; service failures include `ok: false` and an error code/message. SDK argument validation also produces a tool error. Unknown arguments are rejected. IDs are numeric strings, not arbitrary paths or SIS IDs. Dates use ISO 8601 timestamps with timezone offsets.

Most tools query the local cache. `canvas_sync` makes Canvas requests; `canvas_prepare_workspace` creates local files and can download referenced material. There is no Canvas mutation or submission tool. Read-only and side-effect annotations distinguish these tools.

`canvas_auth_status({})` reports the selected provider and session health. Browser authentication failures preserve actionable error codes and `retryable: true`; no MCP arguments contain bridge secrets, cookies or Canvas tokens. Keep the paired loopback bridge running separately from the MCP process.

## Queries

List tools accept `limit` (1–500, default 100), `offset` (default 0), and where applicable optional `course_id`. Use `has_more` and `total` to retrieve every page.

| Tool                        | Arguments beyond pagination                                      | Result                                                                                    |
| --------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `canvas_list_courses`       | none                                                             | Active cached courses                                                                     |
| `canvas_get_course`         | required `course_id`                                             | Course and freshness                                                                      |
| `canvas_get_assignments`    | optional `course_id`                                             | Assignment records                                                                        |
| `canvas_get_assignment`     | required `assignment_id`, optional `course_id` and context flags | Full context, same as context tool                                                        |
| `canvas_get_modules`        | optional `course_id`                                             | Modules                                                                                   |
| `canvas_get_module`         | required `module_id`, optional `course_id`                       | Module and all cached items                                                               |
| `canvas_get_page`           | required `page_id`, optional `course_id`                         | Page body and metadata; page_id is numeric, not a slug                                    |
| `canvas_get_announcements`  | optional `course_id`                                             | Announcements                                                                             |
| `canvas_get_files`          | optional `course_id`                                             | File metadata; signed URL credentials omitted                                             |
| `canvas_get_discussions`    | optional `course_id`                                             | Discussion topics; no activity mutations                                                  |
| `canvas_get_planner`        | optional `course_id`                                             | Available Canvas planner/to-do data                                                       |
| `canvas_get_upcoming`       | `days` (1–365, default 7), optional `course_id`                  | Incomplete work from now through the horizon, inclusive                                   |
| `canvas_get_priorities`     | optional `course_id`                                             | All incomplete cached assignments, including overdue and undated                          |
| `canvas_get_missing`        | optional `course_id`                                             | Explicit missing/late flags and separately classified past-due unsubmitted or failed work |
| `canvas_get_recent_changes` | optional `since`, `limit`; no offset                             | Capped recent events, changed fields and freshness                                        |
| `canvas_get_grade_summary`  | optional `course_id`; no pagination                              | Actual Canvas grade fields, submission counts and risk signals                            |
| `canvas_list_exams`         | optional `course_id`                                             | Auto-detected exam/quiz assignments (by name) with detection reason                      |

Single-record tools do not take pagination arguments. Omit `course_id` only when an identifier is unambiguous in the local cache. Normalized records have `id`, `course_id`, `kind`, `title`, `updated_at` and `data`. Raw payloads remain in SQLite and are not included in MCP results.

## Context and study

`canvas_get_assignment_context` requires `assignment_id` and accepts optional `course_id`. These flags default to included: `include_related_module`, `include_files`, `include_rubric`, `include_announcements`.

The result contains `assignment`, `course`, `assignment_group`, `rubric`, `modules`, `module_items`, `related_pages`, `files`, `announcements`, `discussions`, `submission`, `external_links`, `warnings`, and `freshness`. Module metadata contains prerequisite IDs and item completion requirements when Canvas supplies them. Announcements match the assignment's link or title, not a model's guessed relevance.

`canvas_get_study_context` requires `course_id` and accepts `module_ids` (up to 100), `assignment_id`, `start_date`, and `end_date`. With an assignment target and no explicit modules, it selects that assignment's containing modules. Date filters apply to assignment due dates and announcement timestamps; module readings remain included for context. The tool returns source pages, files, discussions, assignment topics and reading links. `key_concepts` is null: the server does not pretend to extract or generate concepts it has not verified.

`canvas_get_exam_study_guide` requires `assignment_id` and accepts optional `course_id`, `include_files`, and `include_rubric`. It resolves the material preceding the selected exam in two ordered views: `by_module_position` (modules and items taught before the exam's module, plus items earlier in the exam's own module) and `by_due_date` (assignments due before the exam). Selecting any assignment treats it as the exam (manual override of name detection); `detection.reason` reports `name_match` or `manual_override`. Pages and files resolve through module items and may be empty when the institution hides the Files/Pages navigation tabs. The consuming model generates the guide or cheat sheet; the server returns source material only.

Content is untrusted source data. Results above 2 MB are rejected with a narrowing instruction rather than silently clipped.

## Synchronization and local files

`canvas_sync({force?: boolean})` refreshes the cache. It returns status (`complete` or `partial`), change counts, events, warnings and run timestamps. Force refreshes page bodies even if metadata timestamps are unchanged. Optional endpoint failures remain visible in freshness metadata.

`canvas_prepare_workspace({assignment_id, course_id?, download?: boolean})` creates a new ID-derived workspace. Download defaults to false. It refuses to overwrite an existing workspace. No path or command argument is accepted.

`canvas_validate_assignment({assignment_id, course_id?})` inspects that workspace's submission directory. Results distinguish PASS, WARNING, UNKNOWN and FAIL. Qualitative rubric alignment remains UNKNOWN. `submission_enabled` is always false. Readiness is not a grade or permission to submit.

## Priority interpretation

Scores use due-date proximity, points, known assignment-group weight, explicit missing state and remaining attempts. Locked or exhausted work is non-actionable with zero score. The result explains its factors. Effort is null when unknown; the tool does not equate points with hours or claim an exact grade impact. Prerequisite metadata is available in assignment context rather than hidden inside an unexplained score.

A missing flag of false remains false even if the assignment is overdue. Past-due inference requires an explicit unsubmitted state and an online submission type. Unknown submission state is not proof of missing work. Excused work is excluded, and a graded score of zero is still graded work.

## Resources

Resources are read-only snapshots with JSON content. Course scope avoids ID collisions:

```text
canvas://courses
canvas://course/{course_id}
canvas://course/{course_id}/assignments
canvas://course/{course_id}/modules
canvas://course/{course_id}/pages
canvas://course/{course_id}/announcements
canvas://course/{course_id}/assignment/{assignment_id}
canvas://course/{course_id}/assignment/{assignment_id}/rubric
canvas://course/{course_id}/module/{module_id}
canvas://course/{course_id}/page/{page_id}
```

Collection resources use default tool pagination; use the corresponding tools to retrieve further pages. The pages resource lists page metadata and resource URIs rather than every page body. `resources/templates/list` advertises the parameterized patterns.

# Canvas read-only API foundation

This reference covers the retained legacy REST adapter and session-authenticated GET compatibility routes. Normal operation uses BrowserSessionProvider without a Canvas token. See `canvas-data-sources.md` for the source matrix. Bearer authentication and token requirements below apply only to explicit LegacyPatProvider use.

## Verified documentation

The endpoint and parameter notes below were checked against the official Canvas Markdown documentation. Direct `curl -sSL --fail <URL>.md` retrieval worked where Python urllib returned HTTP 403. Canvas's documentation service can also return HTTP 200 with a **Page Not Found** body, so HTTP success alone is not evidence that a documentation page exists.

Canvas requires HTTPS and returns JSON. Its numeric identifiers are 64-bit integers; `Accept: application/json+canvas-string-ids` requests string IDs and avoids JavaScript precision loss.[16]

## Endpoint map

All paths below are relative to the configured Canvas HTTPS origin. `CanvasApi` uses only GET; no submit, upload, grade, publish, delete, mark-read, planner-completion, or dismissal methods are provided.

| Method / collection                         | GET path                                                                 | Parameters / behavior                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `authCheck()`                               | `/api/v1/users/self/profile`                                             | Validates identity; returns only string `id` and optional `name`.[14][15]                                      |
| `courses()`                                 | `/api/v1/courses`                                                        | `enrollment_state=active`, `state[]=available`, `include[]=syllabus_body`, `term`, `total_scores`.[1]          |
| `course(courseId)`                          | `/api/v1/courses/:id`                                                    | Includes syllabus, term and score metadata.[1]                                                                 |
| `collection('assignments', courseId)`       | `/api/v1/courses/:course_id/assignments`                                 | `include[]=submission` gives the current user's submission; retains inline rubric data.[2]                     |
| `assignment(courseId, id)`                  | `/api/v1/courses/:course_id/assignments/:id`                             | Also includes current-user submission.[2]                                                                      |
| `collection('assignment_groups', courseId)` | `/api/v1/courses/:course_id/assignment_groups`                           | Retains group weight and drop rules; no redundant inline assignment expansion.[11]                             |
| `collection('modules', courseId)`           | `/api/v1/courses/:course_id/modules`                                     | Module metadata only; sync owns item traversal.[3]                                                             |
| `moduleItems(courseId, moduleId)`           | `/api/v1/courses/:course_id/modules/:module_id/items`                    | `include[]=content_details`; adds the requested module ID to normalized data, not raw data.[3]                 |
| `collection('pages', courseId)`             | `/api/v1/courses/:course_id/pages`                                       | Metadata list; sync fetches bodies separately.[4]                                                              |
| `page(courseId, slugOrId)`                  | `/api/v1/courses/:course_id/pages/:url_or_id`                            | Numeric IDs are explicitly sent as `page_id:ID`; nonnumeric slugs are encoded.[4]                              |
| `collection('files', courseId)`             | `/api/v1/courses/:course_id/files`                                       | File metadata, not file bytes.[5]                                                                              |
| `file(courseId, id)`                        | `/api/v1/courses/:course_id/files/:id`                                   | Retains URL, size, content type, lock metadata.[5]                                                             |
| `collection('discussions', courseId)`       | `/api/v1/courses/:course_id/discussion_topics`                           | Topics and their HTML message, not classmates' reply threads.[8]                                               |
| `collection('announcements', courseId)`     | `/api/v1/announcements`                                                  | `context_codes[]=course_ID`, `start_date=1970-01-01`, `end_date=2100-01-01`.[9]                                |
| `collection('submissions', courseId)`       | `/api/v1/courses/:course_id/students/submissions`                        | **Omit `student_ids[]`**: documented default is the calling user. Never send `all` or another student's ID.[6] |
| `submission(courseId, assignmentId)`        | `/api/v1/courses/:course_id/assignments/:assignment_id/submissions/self` | `include[]=submission_comments`, `rubric_assessment`.[6][15]                                                   |
| `collection('enrollments', courseId)`       | `/api/v1/courses/:course_id/enrollments`                                 | `user_id=self`; never fetch the unfiltered course roster.[7][15]                                               |
| `collection('planner', courseId)`           | `/api/v1/planner/items`                                                  | Current user; `context_codes[]=course_ID` and explicit 1970–2100 dates. Never sets `observed_user_id`.[10]     |
| `todo(courseId?)`                           | `/api/v1/courses/:course_id/todo` or `/api/v1/users/self/todo`           | Current user's todo items, normalized as planner entities.[1][14]                                              |

### Endpoint peculiarities

- Pages accept either slug or ID; a numeric slug takes precedence over the same numeric ID. `page_id:7` explicitly means ID 7. The wrapper interprets bare numeric input as an ID; use the low-level client if a literal numeric slug is needed. List responses need not contain `body`; single-page responses include content.[4]
- Canvas may omit inline module `items` even when requested because there are too many. Always traverse the paginated module-item endpoint rather than assuming the module list is complete.[3]
- Announcements default to a start date 14 days ago and an end date 28 days after the start date. Explicit broad dates prevent silently losing older announcements. Future scheduled announcements remain subject to Canvas permissions; the chosen 1970–2100 bounds are an application policy, not an unlimited-history guarantee.[9]
- Assignment-group `include[]=submission` is valid only together with `include[]=assignments`; this wrapper fetches assignments independently instead.[11]
- Student submission collection requests default to the calling user when `student_ids[]` is absent. Detail requests explicitly use `self` and request comments. The generic course assignment-submission roster endpoint is not used.[6]
- `user_id` filters on course enrollments permit checking one's own enrollments without roster-view permissions. Canvas documents `self` as a special user identifier.[7][15]
- File download URLs are data, not authorized API targets. They may point outside the Canvas origin. The separate download service must enforce its own host/size/redirect rules and must never forward the Canvas bearer token to a download URL.[5]
- Rubrics are retained under assignment `data.rubric`; sync extracts them. `collection('rubrics', ...)` deliberately throws. `collection('module_items', ...)` also throws because a module ID is required.
- `collection('courses', courseId)` delegates to the global active-course list; course ID is otherwise not used for that collection.

## Transport and security contract

- `CanvasClient(config, { fetch?, sleep?, logger?, auth?, maxPages? })` uses native fetch by default. Fetch injection is for tests and does **not** bypass HTTPS/origin validation.
- `AuthProvider.authorization()` separates authorization generation from transport. `BearerTokenAuth` stores the token in an ECMAScript private field. Credentials are never query parameters.
- The client accepts only HTTPS requests on the configured origin, beneath `/api/v1/`. It rejects credential-bearing URLs, non-API paths, cross-origin pagination, URL fragments, ambiguous encoded separators/double encoding, and query-based auth or user masquerading.
- Every request has `method: 'GET'`, `redirect: 'error'`, and `credentials: 'omit'`. Redirect destinations are never followed with authorization.
- A per-attempt abort timeout covers both receiving headers and consuming JSON. A timed-out injected fetch cannot hold the caller open indefinitely.
- HTTP 429, 5xx, timeout and network failures are retried up to `maxRetries` additional attempts. Other HTTP errors and malformed JSON are terminal. Backoff starts at 500 ms and doubles; all retry delays are capped at 60 seconds. Both numeric-seconds and HTTP-date `Retry-After` are supported.
- Error messages contain neither response bodies nor upstream exception details. `CanvasError.status` is available for permission/availability handling.
- Metadata logging contains only status, attempt, duration, retry delay and numeric quota headers. No URLs, page slugs, searches, tokens or content are logged. `createLogger()` writes exclusively to fd 2, leaving fd 1 for MCP transport, and redacts common credential fields.

### Pagination

Canvas says to treat Link targets as opaque and follow the supplied URLs; a `last` relation is not guaranteed.[12]

The client follows `rel="next"` without reconstructing parameters or adding `per_page` to later links. Commas inside URI references or quoted parameters are not separators. Every target is rechecked for API scope and origin. Repeated URLs raise an error; a default ceiling of 10,000 pages additionally stops endlessly changing cursors. Non-array collection bodies raise an error rather than appearing to be empty data. Collection wrappers request `per_page=100` initially but do not infer completion from page length.

Canvas exposes floating-point request cost and remaining quota through `X-Request-Cost` and, when applicable, `X-Rate-Limit-Remaining`.[13]

## Normalized domain contract

`src/domain/types.ts` defines the shared `entityKinds`, `EntityKind`, and `Entity` exports. `normalize(kind, raw, courseId?)` validates kind-specific Zod schemas before returning:

```ts
interface Entity {
  kind: EntityKind;
  id: string;
  course_id: string | null;
  title: string;
  updated_at: string | null;
  data: Record<string, unknown>;
  raw: Record<string, unknown>;
}
```

- `data` retains snake_case Canvas fields and nested structures. Every `id`, `*_id`, and `*_ids` value is normalized to strings, including nested submission/rubric IDs. Unsafe numeric IDs are rejected, not rounded or repaired.
- Zod validation rejects malformed known structures/fields. Unknown fields are retained for forward compatibility; they are not interpreted as trusted instructions or rendered as executable content.
- Offset-bearing ISO timestamps are converted to UTC ISO strings. Date-only values become UTC midnight. Documented local ISO values such as page `publish_at` are preserved without inventing a timezone. Invalid calendar dates are rejected; null remains null.[4]
- Raw payloads are separately cloned without transformed IDs or dates. HTML bodies/descriptions are retained as data.
- Course entities have `course_id=null`; child entities use their payload course ID or supplied course context. A contradictory course ID is rejected.
- Pages use `page_id`; an unsubmitted submission with null/missing `id` uses `assignment_id:user_id`. Planner wrappers use `plannable_type:plannable_id`; todo wrappers use `todo:type:assignment_id` to avoid collisions with planner items.
- Missing titles get kind-aware fallbacks; missing update times remain null rather than fabricated timestamps.

## Configuration

`loadConfig(env = process.env)` is pure: it does not read dotenv files or mutate environment variables. The executable owns dotenv loading.

| Environment variable        | Default / validation                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `CANVAS_BASE_URL`           | Required HTTPS origin; no credentials, path, query or fragment                      |
| `CANVAS_ACCESS_TOKEN`       | Required nonempty token without whitespace; validation errors never echo values     |
| `CANVAS_DB_PATH`            | Absolute resolution of `data/canvas.sqlite` under current working directory         |
| `CANVAS_WORKSPACE_ROOT`     | Absolute resolution of `workspaces` under current working directory                 |
| `CANVAS_TIMEZONE`           | `UTC`; validated with Intl timezone support                                         |
| `CANVAS_TIMEOUT_MS`         | `30000`; integer 1–300000                                                           |
| `CANVAS_MAX_RETRIES`        | `3`; integer 0–10                                                                   |
| `CANVAS_MAX_DOWNLOAD_BYTES` | `52428800`; positive safe integer                                                   |
| `CANVAS_DOWNLOAD_HOSTS`     | Empty list; comma-separated exact hostnames, lowercased; no wildcards/schemes/paths |
| `CANVAS_SYNC_CONCURRENCY`   | `4`; integer 1–32                                                                   |
| `LOG_LEVEL`                 | `info`; Pino level or `silent`                                                      |

## Verification scope

The foundation test files are `tests/canvas-client.test.ts`, `tests/canvas-api.test.ts`, `tests/canvas-normalize.test.ts`, `tests/config.test.ts`, and `tests/config-logger.test.ts`. Development used observed RED→GREEN cycles. Tests use real `Response`, `Headers`, streams and abort signals with injected fetch fixtures, plus a subprocess assertion that logger output stays on stderr. No authenticated live Canvas account was exercised; official documentation retrieval and local executable tests are the verified evidence.

## Sources

[1] https://developerdocs.instructure.com/services/canvas/resources/courses.md
[2] https://developerdocs.instructure.com/services/canvas/resources/assignments.md
[3] https://developerdocs.instructure.com/services/canvas/resources/modules.md
[4] https://developerdocs.instructure.com/services/canvas/resources/pages.md
[5] https://developerdocs.instructure.com/services/canvas/resources/files.md
[6] https://developerdocs.instructure.com/services/canvas/resources/submissions.md
[7] https://developerdocs.instructure.com/services/canvas/resources/enrollments.md
[8] https://developerdocs.instructure.com/services/canvas/resources/discussion_topics.md
[9] https://developerdocs.instructure.com/services/canvas/resources/announcements.md
[10] https://developerdocs.instructure.com/services/canvas/resources/planner.md
[11] https://developerdocs.instructure.com/services/canvas/resources/assignment_groups.md
[12] https://developerdocs.instructure.com/services/canvas/basics/file.pagination.md
[13] https://developerdocs.instructure.com/services/canvas/basics/file.throttling.md
[14] https://developerdocs.instructure.com/services/canvas/resources/users.md
[15] https://developerdocs.instructure.com/services/canvas/basics/file.object_ids.md
[16] https://developerdocs.instructure.com/services/canvas.md

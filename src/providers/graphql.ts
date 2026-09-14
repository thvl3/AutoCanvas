// Fields verified against instructure/canvas-lms Ruby GraphQL types; see docs/canvas-data-sources.md.
export const SCHEMA_QUERY = `query CanvasReadSchema { __schema { queryType { name } types {
  kind name description
  fields(includeDeprecated: true) { name isDeprecated deprecationReason args { name defaultValue type { ...TypeRef } } type { ...TypeRef } }
  inputFields { name defaultValue type { ...TypeRef } }
  enumValues(includeDeprecated: true) { name isDeprecated }
  interfaces { name } possibleTypes { name }
} } }
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;
export const COURSE_FIELDS = `_id name courseCode state syllabusBody updatedAt term { _id name startAt endAt }`;
export const COURSE_QUERY = `query CanvasCourse($courseId: ID!) { course(id: $courseId) { ${COURSE_FIELDS} } }`;
// Do not select progression: Canvas's resolver evaluates/persists module progression.
export const MODULES_QUERY = `query CanvasModules($courseId: ID!, $after: String) { course(id: $courseId) { modulesConnection(first: 100, after: $after) { nodes { _id name position published unlockAt updatedAt moduleItemsTotalCount requireSequentialProgress prerequisites { _id: id } } pageInfo { hasNextPage endCursor } } } }`;
export function moduleFields(value: unknown): Record<string, unknown> {
  const input = record(value);
  const output = fromGraphql(input);
  output.items_count = input.moduleItemsTotalCount;
  if (!Array.isArray(input.prerequisites))
    throw new GraphqlGap("module_field_gap");
  output.prerequisite_module_ids = (input.prerequisites as unknown[]).map(
    (item) => record(item)._id,
  );
  delete output.module_items_total_count;
  delete output.prerequisites;
  return output;
}
export const ENROLLMENT_FIELDS = `_id userId state type updatedAt enrollmentState grades(gradingPeriodId: null) { currentScore currentGrade finalScore finalGrade htmlUrl }`;
export const ENROLLMENTS_QUERY = `query CanvasEnrollments($userId: ID!, $courseId: ID!, $after: String) { user(id: $userId) { enrollmentsConnection(first: 100, after: $after, courseId: $courseId) { nodes { ${ENROLLMENT_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const COURSES_QUERY = `query CanvasCourses($userId: ID!, $after: String) {
  user(id: $userId) { enrollmentsConnection(first: 100, after: $after, currentOnly: true) {
    nodes { ${ENROLLMENT_FIELDS} course { ${COURSE_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  } }
}`;

export const SUBMISSION_FIELDS = `_id assignmentId userId state attempt score grade submittedAt gradedAt updatedAt late missing excused submissionType cachedDueDate`;
export const SUBMISSION_QUERY = `query CanvasSubmission($assignmentId: ID!, $userId: ID!) { submission(assignmentId: $assignmentId, userId: $userId) { ${SUBMISSION_FIELDS} } }`;
export const SUBMISSIONS_QUERY = `query CanvasSubmissions($courseId: ID!, $userId: ID!, $after: String) { course(id: $courseId) { submissionsConnection(first: 100, after: $after, studentIds: [$userId]) { nodes { ${SUBMISSION_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const ASSIGNMENT_FIELDS = `_id name description courseId pointsPossible assignmentGroupId updatedAt htmlUrl published state
  dueAt(applyOverrides: true) lockAt(applyOverrides: true) unlockAt(applyOverrides: true)
  lockInfo { isLocked canView lockAt unlockAt } allowedAttempts allowedExtensions submissionTypes gradingType
  rubric { _id title pointsPossible freeFormCriterionComments criteria { _id description longDescription points criterionUseRange ignoreForScoring ratings { _id description longDescription points } } }
  submissionsConnection(first: 100, filter: { userId: $userId, includeUnsubmitted: true }) { nodes { ${SUBMISSION_FIELDS} } pageInfo { hasNextPage endCursor } }`;
export const ASSIGNMENTS_QUERY = `query CanvasAssignments($courseId: ID!, $userId: ID!, $after: String) {
  course(id: $courseId) { assignmentsConnection(first: 100, after: $after, filter: { gradingPeriodId: null, userId: $userId }) {
    nodes { ${ASSIGNMENT_FIELDS} } pageInfo { hasNextPage endCursor }
  } }
}`;
export const ASSIGNMENT_QUERY = `query CanvasAssignment($assignmentId: ID!, $userId: ID!) { assignment(id: $assignmentId) { ${ASSIGNMENT_FIELDS} } }`;
export function assignmentFields(
  value: unknown,
  userId: string,
): Record<string, unknown> {
  const input = record(value);
  for (const key of [
    "allowedAttempts",
    "dueAt",
    "lockAt",
    "unlockAt",
    "rubric",
    "submissionTypes",
  ])
    if (input[key] === undefined) throw new GraphqlGap("assignment_field_gap");
  const output = fromGraphql(input);
  output.allowed_attempts =
    input.allowedAttempts === null ? -1 : input.allowedAttempts;
  output.locked_for_user = record(input.lockInfo).isLocked;
  if (typeof output.locked_for_user !== "boolean")
    throw new GraphqlGap("assignment_lock_gap");
  if (input.rubric !== null) {
    const rubric = record(output.rubric);
    if (!Array.isArray(rubric.criteria))
      throw new GraphqlGap("assignment_rubric_gap");
    output.rubric = rubric.criteria;
    const { criteria: _, ...settings } = rubric;
    output.rubric_settings = settings;
  }
  const nested = record(input.submissionsConnection);
  if (
    record(nested.pageInfo).hasNextPage !== false ||
    !Array.isArray(nested.nodes) ||
    nested.nodes.length > 1
  )
    throw new GraphqlGap("assignment_submission_gap");
  const submissions = nested.nodes;
  for (const submission of submissions)
    if (
      record(submission).userId !== userId ||
      record(submission).assignmentId !== input._id
    )
      throw new GraphqlGap("submission_identity_mismatch");
  output.submission = submissions.length ? fromGraphql(submissions[0]) : null;
  delete output.submissions_connection;
  return output;
}

export class GraphqlGap extends Error {
  constructor(readonly reason: string) {
    super("Canvas GraphQL data unavailable; session fallback required");
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GraphqlGap("incomplete_graphql_record");
  return value as Record<string, unknown>;
}
// A boundary adapter, not a new domain model. Never use Relay `id` for a Canvas identity.
export function restFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "id" && key !== "__typename")
      .map(([key, item]) => [
        key === "_id"
          ? "id"
          : key === "state"
            ? "workflow_state"
            : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        restFields(item),
      ]),
  );
}
export function fromGraphql(value: unknown): Record<string, unknown> {
  return {
    ...record(restFields(record(value))),
    source: { transport: "graphql" },
  };
}

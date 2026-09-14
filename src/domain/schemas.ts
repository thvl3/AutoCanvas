import { z } from "zod";
import type { EntityKind } from "./types.js";

// Large Canvas IDs must arrive as strings; rounded JS numbers cannot be repaired.
export const canvasIdSchema = z
  .union([
    z.string().min(1),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const optionalText = z.string().nullish();
const optionalNumber = z.number().finite().nullish();
const record = z.record(z.string(), z.unknown());
const common = z
  .object({
    id: canvasIdSchema.nullish(),
    course_id: canvasIdSchema.nullish(),
    name: optionalText,
    title: optionalText,
    description: optionalText,
    body: optionalText,
    html_url: optionalText,
    workflow_state: optionalText,
    published: z.boolean().nullish(),
    locked_for_user: z.boolean().nullish(),
  })
  .passthrough();

export const canvasSchemas: Record<
  EntityKind,
  z.ZodType<Record<string, unknown>>
> = {
  courses: common.extend({
    id: canvasIdSchema,
    syllabus_body: optionalText,
    course_code: optionalText,
  }),
  assignments: common.extend({
    id: canvasIdSchema,
    points_possible: optionalNumber,
    submission: record.nullish(),
    rubric: z.array(record).nullish(),
    submission_types: z.array(z.string()).nullish(),
    assignment_group_id: canvasIdSchema.nullish(),
  }),
  assignment_groups: common.extend({
    id: canvasIdSchema,
    group_weight: optionalNumber,
    assignments: z.array(record).nullish(),
    rules: record.nullish(),
  }),
  modules: common.extend({
    id: canvasIdSchema,
    position: optionalNumber,
    items_count: optionalNumber,
    items: z.array(record).nullish(),
  }),
  module_items: common.extend({
    id: canvasIdSchema,
    type: optionalText,
    content_id: canvasIdSchema.nullish(),
    module_id: canvasIdSchema.nullish(),
    content_details: record.nullish(),
  }),
  pages: common
    .extend({ page_id: canvasIdSchema.nullish(), url: optionalText })
    .refine((value) => value.page_id != null || value.id != null),
  files: common.extend({
    id: canvasIdSchema,
    display_name: optionalText,
    filename: optionalText,
    size: optionalNumber,
    url: optionalText,
    "content-type": optionalText,
  }),
  discussions: common.extend({
    id: canvasIdSchema,
    message: optionalText,
    assignment: record.nullish(),
  }),
  announcements: common.extend({ id: canvasIdSchema, message: optionalText }),
  submissions: common.extend({
    assignment_id: canvasIdSchema,
    user_id: canvasIdSchema,
    score: optionalNumber,
    grade: optionalText,
    submission_comments: z.array(record).nullish(),
  }),
  rubrics: common.extend({
    id: canvasIdSchema,
    points: optionalNumber,
    ratings: z.array(record).nullish(),
  }),
  enrollments: common.extend({
    id: canvasIdSchema,
    user_id: canvasIdSchema.nullish(),
    type: optionalText,
    grades: record.nullish(),
  }),
  planner: common.extend({
    plannable_id: canvasIdSchema.nullish(),
    plannable_type: optionalText,
    plannable: record.nullish(),
    assignment: record.nullish(),
    type: optionalText,
  }),
};

export const entityKinds = [
  "courses",
  "assignments",
  "assignment_groups",
  "modules",
  "module_items",
  "pages",
  "files",
  "discussions",
  "announcements",
  "submissions",
  "rubrics",
  "enrollments",
  "planner",
] as const;
export type EntityKind = (typeof entityKinds)[number];

export interface Entity {
  kind: EntityKind;
  id: string;
  course_id: string | null;
  title: string;
  updated_at: string | null;
  data: Record<string, unknown>;
  raw: Record<string, unknown>;
}

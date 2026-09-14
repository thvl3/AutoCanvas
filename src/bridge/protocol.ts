import { z } from "zod";
import {
  Kind,
  parse,
  visit,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";

function boundedJson(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= 65536;
  } catch {
    return false;
  }
}
function safeQuery(query: string): boolean {
  try {
    if (new TextEncoder().encode(query).length > 65536) return false;
    const document = parse(query, { maxTokens: 12000 });
    const fragments = new Map<string, FragmentDefinitionNode>();
    let operations = 0;
    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        if (definition.operation !== "query" || ++operations > 1) return false;
      } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragments.has(definition.name.value)) return false;
        fragments.set(definition.name.value, definition);
      } else return false;
    }
    if (operations !== 1) return false;
    let astNodes = 0;
    visit(document, {
      enter() {
        if (++astNodes > 10000) throw new Error("complexity");
      },
    });
    let complexity = 0;
    function walk(
      set: SelectionSetNode,
      depth: number,
      active: Set<string>,
    ): void {
      if (depth > 20) throw new Error("depth");
      for (const selection of set.selections) {
        if (++complexity > 1000) throw new Error("complexity");
        if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (!fragment || active.has(name)) throw new Error("fragment");
          walk(fragment.selectionSet, depth + 1, new Set([...active, name]));
        } else if (selection.selectionSet)
          walk(selection.selectionSet, depth + 1, active);
      }
    }
    // Check unused fragments too; no cyclic or undefined fragment may hide in the document.
    for (const definition of document.definitions) {
      if (
        definition.kind === Kind.OPERATION_DEFINITION ||
        definition.kind === Kind.FRAGMENT_DEFINITION
      )
        walk(definition.selectionSet, 1, new Set());
    }
    return true;
  } catch {
    return false;
  }
}

function safePath(path: string): boolean {
  if (!path.startsWith("/api/v1/") || /[\\\\#\s\u0000-\u001f\u007f]/.test(path))
    return false;
  if (path.split("?").length > 2) return false;
  const [pathname = "", search = ""] = path.split("?");
  // Decode only after rejecting encoded separators, dot traversal and double encoding.
  if (
    /%(?:2e|2f|5c|25|00)/i.test(pathname) ||
    pathname.split("/").some((p) => p === "." || p === "..")
  )
    return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (/[\\\\\s\u0000-\u001f\u007f]/.test(decoded)) return false;
  const n = "[1-9][0-9]*";
  const course = `/api/v1/courses/${n}`;
  const patterns = [
    "^/api/v1/users/self/(profile|todo)$",
    "^/api/v1/courses$",
    `^${course}$`,
    `^${course}/(assignments|assignment_groups|modules|files|discussion_topics)(/${n})?$`,
    `^${course}/modules/${n}/items(/${n})?$`,
    `^${course}/pages(/(?:page_id:${n}|[A-Za-z0-9_-]+))?$`,
    `^${course}/(enrollments|todo|students/submissions)$`,
    `^${course}/assignments/${n}/submissions/self$`,
    "^/api/v1/(announcements|planner/items)$",
    `^/api/v1/files/${n}$`,
  ];
  if (!patterns.some((p) => new RegExp(p).test(decoded))) return false;
  const params = new URLSearchParams(search);
  const allowed = new Set([
    "per_page",
    "page",
    "include[]",
    "context_codes[]",
    "start_date",
    "end_date",
    "user_id",
    "enrollment_state",
    "state[]",
  ]);
  for (const [key, value] of params) {
    if (
      !allowed.has(key) ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return false;
    if (!key.endsWith("[]") && params.getAll(key).length !== 1) return false;
    if (key === "user_id" && value !== "self") return false;
    if (
      key === "per_page" &&
      (!/^[1-9]\d*$/.test(value) || Number(value) > 100)
    )
      return false;
    if (
      key === "page" &&
      (!/^[1-9]\d*$/.test(value) || Number(value) > 1000000)
    )
      return false;
    if (key === "context_codes[]" && !/^course_[1-9]\d*$/.test(value))
      return false;
  }
  if (decoded.endsWith("/enrollments") && params.get("user_id") !== "self")
    return false;
  return true;
}

export interface BridgeSettings {
  origin: string;
  host?: string;
  port?: number;
  stateDir: string;
  timeoutMs?: number;
}
export class BridgeError extends Error {
  readonly status?: number;
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    status?: number,
  ) {
    super(message);
    this.name = "BridgeError";
    const statuses: Record<string, number> = {
      canvas_authentication_required: 401,
      canvas_permission_denied: 403,
      canvas_not_open: 503,
      extension_disconnected: 503,
      bridge_disconnected: 503,
      bridge_timeout: 504,
    };
    this.status =
      status ?? (Object.hasOwn(statuses, code) ? statuses[code] : undefined);
  }
}
const id = z
  .string()
  .regex(/^[1-9]\d*$/)
  .max(30);
export const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-health") }).strict(),
  z
    .object({
      type: z.literal("graphql-query"),
      query: z.string().min(1).max(65536).refine(safeQuery),
      variables: z
        .record(z.string(), z.unknown())
        .refine(boundedJson)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas-get"),
      path: z.string().min(1).max(8192).refine(safePath),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas-page"),
      kind: z.enum(["page", "assignment"]),
      courseId: id,
      id,
    })
    .strict(),
  z
    .object({
      type: z.literal("download-file"),
      courseId: id,
      fileId: id,
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    })
    .strict(),
]);
export type BridgeOperation = z.infer<typeof operationSchema>;
export const browserResultSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
    link: z.string().max(65536).optional(),
    contentType: z.string().max(512).optional(),
    bytesBase64: z
      .string()
      .max(12 * 1024 * 1024)
      .optional(),
  })
  .strict();
export type BrowserResult = z.infer<typeof browserResultSchema>;
const envelope = { protocolVersion: z.literal(1), requestId: z.uuid() };
export const requestSchema = z
  .object({ ...envelope, operation: operationSchema })
  .strict();
export const responseSchema = z.discriminatedUnion("ok", [
  z
    .object({ ...envelope, ok: z.literal(true), result: browserResultSchema })
    .strict(),
  z
    .object({
      ...envelope,
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1).max(100),
          message: z.string().max(1024),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
export type BridgeResponse = z.infer<typeof responseSchema>;
export function validateOperation(input: unknown): BridgeOperation {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success)
    throw new BridgeError(
      "invalid_operation",
      "Only bounded, typed Canvas read operations are permitted.",
    );
  return parsed.data;
}

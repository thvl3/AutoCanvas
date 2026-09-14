import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Config } from "../config.js";
import type { AssignmentContext } from "./assignment-context.js";
import {
  childPath,
  directoryPath,
  openSafeDirectory,
  untrustedMarkdown,
  workspacePath,
} from "./workspace.js";

export interface ValidationCheck {
  status: "PASS" | "WARNING" | "UNKNOWN" | "FAIL";
  check: string;
  message: string;
}
export interface ValidationResult {
  checks: ValidationCheck[];
  ready: boolean;
  submission_enabled: false;
}

class InspectionError extends Error {}
interface InspectedFile {
  name: string;
  size: number;
  text?: string;
}
async function inspectSubmission(
  path: string,
  config: Config,
  readText: boolean,
): Promise<InspectedFile[]> {
  const directory = await openSafeDirectory(join(path, "submission"));
  const files: InspectedFile[] = [];
  const maxBytes = Math.min(config.maxDownloadBytes, 10 * 1024 * 1024);
  let total = 0;
  try {
    const entries = await opendir(directoryPath(directory));
    for await (const entry of entries) {
      if (files.length >= 100)
        throw new InspectionError(
          "Submission file count limit exceeded (100).",
        );
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new InspectionError(
          "Unsafe submission entry: direct regular files only; no symlinks or directories.",
        );
      const handle = await open(
        childPath(directory, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new InspectionError(
            "Unsafe submission file: symlink, special file or hardlink.",
          );
        total += stat.size;
        if (total > maxBytes)
          throw new InspectionError("Submission byte limit exceeded.");
        let text: string | undefined;
        if (
          readText &&
          [".txt", ".md"].includes(extname(entry.name).toLowerCase())
        ) {
          const chunks: Buffer[] = [];
          let read = 0;
          for (;;) {
            const buffer = Buffer.alloc(Math.min(65536, stat.size - read + 1));
            const chunk = await handle.read(buffer, 0, buffer.length, null);
            if (chunk.bytesRead === 0) break;
            read += chunk.bytesRead;
            if (read > stat.size || read > maxBytes)
              throw new InspectionError(
                "Submission changed during inspection or exceeded byte limit.",
              );
            chunks.push(buffer.subarray(0, chunk.bytesRead));
          }
          const after = await handle.stat();
          if (
            read !== stat.size ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs ||
            after.nlink !== 1
          )
            throw new InspectionError("Submission changed during inspection.");
          try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
            if (!/[\u0000-\u0008\u000e-\u001f]/.test(decoded)) text = decoded;
          } catch {
            /* Binary/invalid UTF-8 is unsupported, never passed to an external parser. */
          }
        }
        files.push({ name: entry.name, size: stat.size, text });
      } finally {
        await handle.close();
      }
    }
  } finally {
    await directory.handle?.close();
  }
  if (!files.length || files.every((file) => file.size === 0))
    throw new InspectionError("No nonempty submission files found.");
  return files;
}

interface WordRequirement {
  min: number;
  max: number;
  quote: string;
}
type WordRequirementResult =
  | { kind: "absent" }
  | { kind: "unknown" }
  | ({ kind: "supported" } & WordRequirement);
function wordRequirement(description: unknown): WordRequirementResult {
  const instructions = untrustedMarkdown(description);
  const pattern =
    /\b(?:at least (\d{1,6}) words|no more than (\d{1,6}) words|between (\d{1,6}) and (\d{1,6}) words)\b/gi;
  const matches = [...instructions.matchAll(pattern)];
  // Recognize possible constraints without pretending to parse their bounds.
  // Also inspect text outside a supported phrase so another rule cannot be ignored.
  const remainder = instructions.replace(pattern, "");
  if (
    /\b(?:\d[\d,.]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)[\s–—-]+words?\b|\bword[\s-]+(?:count|limit|minimum|maximum)\b|\b(?:at least|no more than|between|minimum|maximum|exactly)\b[^.!?\n]*\bwords?\b/i.test(
      remainder,
    )
  )
    return { kind: "unknown" };
  if (!matches.length) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "unknown" };
  const match = matches[0]!;
  const min = Number(match[1] ?? match[3] ?? 0);
  const max = match[2] ?? match[4];
  if (max !== undefined && Number(max) < min) return { kind: "unknown" };
  return {
    kind: "supported",
    min,
    max: max === undefined ? Infinity : Number(max),
    quote: match[0],
  };
}
function wordCheck(
  requirement: WordRequirementResult,
  files: InspectedFile[],
): ValidationCheck {
  if (requirement.kind === "absent")
    return {
      check: "word_count",
      status: "UNKNOWN",
      message:
        "No explicit word-limit rule was detected. No word requirement has been invented; review the actual instructions.",
    };
  if (requirement.kind === "unknown")
    return {
      check: "word_count",
      status: "UNKNOWN",
      message:
        "Word-limit instructions are ambiguous, contradictory, or unsupported. Human review is required before mechanical readiness can be established.",
    };
  if (files.length !== 1 || files[0]?.text === undefined)
    return {
      check: "word_count",
      status: "UNKNOWN",
      message:
        "Explicit word limit needs human review: automatic counting supports one UTF-8 .txt or .md draft only, not PDF/Office/binary or multiple files.",
    };
  const count = files[0].text.match(/\S+/gu)?.length ?? 0;
  return {
    check: "word_count",
    status:
      count < requirement.min || count > requirement.max ? "FAIL" : "PASS",
    message: `Approximate word count: ${count} (whitespace tokens). Source phrase: "${requirement.quote}". Confirm scope and counting rules manually; this does not assess quality.`,
  };
}

function cachedDate(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}
function statusChecks(context: AssignmentContext): ValidationCheck[] {
  const data = context.assignment.data;
  const now = Date.now();
  const unlock = cachedDate(data.unlock_at);
  const lock = cachedDate(data.lock_at);
  const due = cachedDate(data.due_at);
  const checks: ValidationCheck[] = [];
  if (
    data.locked_for_user === true ||
    data.published === false ||
    (typeof unlock === "number" && unlock > now) ||
    (typeof lock === "number" && lock <= now)
  )
    checks.push({
      check: "availability",
      status: "FAIL",
      message:
        "Cached assignment is locked, unpublished, not yet open, or past its lock date.",
    });
  else if (
    data.locked_for_user !== false ||
    unlock === undefined ||
    lock === undefined
  )
    checks.push({
      check: "availability",
      status: "UNKNOWN",
      message:
        "Availability or lock dates are missing or invalid. Confirm current user-specific Canvas availability.",
    });
  else
    checks.push({
      check: "availability",
      status: "PASS",
      message:
        "Cached lock status and open/close dates indicate availability, not a live guarantee.",
    });
  if (typeof due === "number" && due < now)
    checks.push({
      check: "deadline",
      status: "WARNING",
      message:
        "Cached due date has passed; late penalties may apply. A due date is not a lock date.",
    });
  else if (due === undefined)
    checks.push({
      check: "deadline",
      status: "UNKNOWN",
      message: "Due date is missing or invalid in cached metadata.",
    });
  else
    checks.push({
      check: "deadline",
      status: "PASS",
      message:
        due === null
          ? "Cached assignment explicitly has no due date."
          : "Cached due date has not passed.",
    });
  const allowed = data.allowed_attempts;
  const attempt = context.submission?.data.attempt;
  if (allowed === -1)
    checks.push({
      check: "attempts",
      status: "PASS",
      message: "Cached assignment allows unlimited attempts.",
    });
  else if (allowed === 0)
    checks.push({
      check: "attempts",
      status: "FAIL",
      message: "Cached assignment allows no attempts.",
    });
  else if (
    typeof allowed !== "number" ||
    !Number.isSafeInteger(allowed) ||
    allowed < 0 ||
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0
  )
    checks.push({
      check: "attempts",
      status: "UNKNOWN",
      message:
        "Allowed or used attempt count is missing or invalid; missing submission data is not zero attempts.",
    });
  else
    checks.push({
      check: "attempts",
      status: attempt >= allowed ? "FAIL" : "PASS",
      message:
        attempt >= allowed
          ? "Cached attempt limit has been reached."
          : `${allowed - attempt} attempt(s) remain according to the cached snapshot.`,
    });
  return checks;
}

export async function validateAssignment(
  context: AssignmentContext,
  config: Config,
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [
    {
      check: "freshness",
      status: "WARNING",
      message:
        "Cached snapshot only. Sync and confirm current Canvas availability and attempts before relying on checks.",
    },
    {
      check: "rubric",
      status: "UNKNOWN",
      message:
        "Human review is required for rubric alignment and quality; keywords do not prove compliance.",
    },
    {
      check: "authorization",
      status: "WARNING",
      message:
        "Ready means only that evaluated local mechanical checks passed. It is not authorization to submit, not rubric approval, and not a live Canvas check. Submission remains disabled.",
    },
  ];
  const requirement = wordRequirement(context.assignment.data.description);
  checks.push(...statusChecks(context));
  const types = context.assignment.data.submission_types;
  if (!Array.isArray(types) || !types.every((item) => typeof item === "string"))
    checks.push({
      check: "submission_type",
      status: "UNKNOWN",
      message: "Submission type is missing or invalid in cached metadata.",
    });
  else if (types.includes("online_upload"))
    checks.push({
      check: "submission_type",
      status: "PASS",
      message:
        "Cached assignment accepts file uploads; no upload will be performed.",
    });
  else if (
    !types.length ||
    types.every((item) => ["none", "not_graded", "on_paper"].includes(item))
  )
    checks.push({
      check: "submission_type",
      status: "FAIL",
      message: "This assignment does not accept online file submissions.",
    });
  else
    checks.push({
      check: "submission_type",
      status: "UNKNOWN",
      message:
        "Local files cannot verify text-entry, URL, quiz, media or external-tool submission requirements.",
    });
  try {
    const path = await workspacePath(
      config.workspaceRoot,
      context.assignment.course_id ?? "",
      context.assignment.id,
    );
    await (await openSafeDirectory(path)).handle?.close();
    checks.push({
      check: "workspace",
      status: "PASS",
      message: "Workspace found.",
    });
    try {
      const files = await inspectSubmission(
        path,
        config,
        requirement.kind === "supported",
      );
      checks.push(wordCheck(requirement, files));
      checks.push({
        check: "files",
        status: "PASS",
        message: `${files.length} direct regular submission file(s), within inspection limits.`,
      });
      const extensions = context.assignment.data.allowed_extensions;
      if (
        !Array.isArray(extensions) ||
        !extensions.every(
          (item) => typeof item === "string" && /^[A-Za-z0-9]+$/.test(item),
        )
      )
        checks.push({
          check: "extensions",
          status: "UNKNOWN",
          message:
            "Allowed extensions are missing or invalid in cached metadata.",
        });
      else {
        const accepted = extensions.map((item) => item.toLowerCase());
        const rejected = files.filter(
          (file) =>
            accepted.length &&
            !accepted.includes(extname(file.name).slice(1).toLowerCase()),
        );
        checks.push({
          check: "extensions",
          status: rejected.length ? "FAIL" : "PASS",
          message: rejected.length
            ? `${rejected.length} file(s) have extensions not accepted by this assignment.`
            : "File extensions match cached restrictions. This does not certify MIME type, safety or document validity.",
        });
      }
    } catch (error) {
      checks.push({
        check: "files",
        status: "FAIL",
        message:
          error instanceof InspectionError
            ? error.message
            : "Submission directory or file is missing, unsafe, or changed during inspection.",
      });
    }
  } catch {
    checks.push({
      check: "workspace",
      status: "FAIL",
      message:
        "Workspace missing or unsafe; prepare an ID-derived workspace first.",
    });
  }
  const ready = checks.every(
    (item) =>
      item.status !== "FAIL" &&
      (item.status !== "UNKNOWN" ||
        item.check === "rubric" ||
        (item.check === "word_count" && requirement.kind === "absent")),
  );
  return { checks, ready, submission_enabled: false };
}

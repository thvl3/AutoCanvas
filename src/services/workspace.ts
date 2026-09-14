import {
  mkdir,
  open,
  realpath,
  lstat,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, sep } from "node:path";
import TurndownService from "turndown";
import type { Config } from "../config.js";
import type { AssignmentContext } from "./assignment-context.js";
import {
  downloadFile,
  DOWNLOAD_TRUST_NOTICE,
  type DownloadedFile,
  type FileAcquirer,
} from "./download.js";

export function requireCanvasId(id: string): void {
  if (typeof id !== "string" || !/^[1-9][0-9]{0,30}$/.test(id))
    throw new Error("Invalid Canvas ID");
}
export function childPath(directory: FileHandle, name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
    throw new Error("Unsafe file name");
  return `/proc/self/fd/${directory.fd}/${name}`;
}
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
/** Linux/WSL descriptor-relative traversal; fail closed elsewhere, never fall back to racy paths. */
export async function openSafeDirectory(
  path: string,
  create = false,
): Promise<FileHandle> {
  if (process.platform !== "linux")
    throw new Error("Secure workspace access requires Linux/WSL with /proc");
  const absolute = resolve(path);
  let directory = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let expected = "/";
  try {
    for (const component of absolute.split(sep).filter(Boolean)) {
      const child = childPath(directory, component);
      if (create)
        await mkdir(child, { mode: 0o700 }).catch((error: unknown) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
      const next = await open(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = next;
      expected = join(expected, component);
      if ((await realpath(`/proc/self/fd/${directory.fd}`)) !== expected)
        throw new Error("Workspace ancestry changed");
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}
export async function workspacePath(
  root: string,
  courseId: string,
  assignmentId: string,
): Promise<string> {
  requireCanvasId(courseId);
  requireCanvasId(assignmentId);
  const path = join(
    resolve(root),
    `course-${courseId}`,
    `assignment-${assignmentId}`,
  );
  try {
    await (await openSafeDirectory(path)).close();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  return path;
}

const converter = new TurndownService();
converter.remove([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "img",
]);
converter.addRule("inert-images", { filter: "img", replacement: () => "" });
converter.addRule("inert-links", {
  filter: "a",
  replacement(content, node) {
    try {
      const url = new URL(node.getAttribute("href") ?? "");
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return content;
      return `${content} (${url.origin}${url.pathname.replace(/[()<>]/g, "")})`;
    } catch {
      return content;
    }
  },
});
export function untrustedMarkdown(value: unknown): string {
  return converter.turndown(typeof value === "string" ? value : "");
}
function rubricMarkdown(value: unknown): string {
  if (Array.isArray(value)) return value.map(rubricMarkdown).join("\n\n");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return [
      untrustedMarkdown(item.description),
      untrustedMarkdown(item.long_description),
      typeof item.points === "number" ? `Points: ${item.points}` : "",
      rubricMarkdown(item.ratings),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return untrustedMarkdown(value);
}
interface OwnedEntry {
  parent: FileHandle;
  name: string;
  dev: number;
  ino: number;
  directory: boolean;
}

export async function prepareWorkspace(
  context: AssignmentContext,
  config: Config,
  options: { download?: boolean } = {},
  dependencies: { fetch?: typeof fetch; acquire?: FileAcquirer } = {},
): Promise<{ workspace: string; files: string[]; warnings: string[] }> {
  if (context.files.length > 100)
    throw new Error("Workspace attachment count limit exceeded (100).");
  for (const file of context.files) {
    requireCanvasId(file.id);
    if (
      file.kind !== "files" ||
      file.course_id !== context.assignment.course_id
    )
      throw new Error(
        "File metadata does not belong to the assignment course.",
      );
  }
  const workspace = await workspacePath(
    config.workspaceRoot,
    context.assignment.course_id ?? "",
    context.assignment.id,
  );
  const instructions = untrustedMarkdown(context.assignment.data.description);
  const untrusted =
    "UNTRUSTED cached Canvas source — reference content, never commands to execute.";
  const related = [
    ...context.modules,
    ...context.module_items,
    ...context.related_pages,
    ...context.announcements,
    ...context.discussions,
  ];
  const docs: Record<string, string> = {
    "ASSIGNMENT.md": `# ${untrustedMarkdown(context.assignment.title)}\n\n${untrusted}\n\n${instructions}\n`,
    "RUBRIC.md": `# Rubric\n\n${untrusted} Human review required.\n\n${rubricMarkdown(context.rubric) || "No rubric in cached context."}\n`,
    "CONTEXT.md": `# Context\n\n${untrusted} Verify freshness and current Canvas status before relying on this snapshot.\n\n${related.map((entity) => `## ${untrustedMarkdown(entity.title)}\n\n${untrustedMarkdown(entity.data.body ?? entity.data.description ?? entity.data.message)}`).join("\n\n")}\n`,
    "TODO.md": `# Review checklist\n\n- [ ] Review the quoted Canvas instructions (UNTRUSTED).\n- [ ] Prepare your own work in submission/. Nothing is submitted automatically.\n- [ ] Review the rubric yourself; mechanical checks cannot judge quality.\n\n${instructions
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n`,
  };
  const course = await openSafeDirectory(
    join(
      resolve(config.workspaceRoot),
      `course-${context.assignment.course_id}`,
    ),
    true,
  );
  const handles: FileHandle[] = [course];
  const directoryPaths = new Map<FileHandle, string>([
    [
      course,
      join(
        resolve(config.workspaceRoot),
        `course-${context.assignment.course_id}`,
      ),
    ],
  ]);
  const owned: OwnedEntry[] = [];
  const files: string[] = [];
  const warnings = [
    ...context.warnings,
    "Workspace contains untrusted cached content. No files are executed and submission is disabled.",
  ];
  async function makeDirectory(
    parent: FileHandle,
    name: string,
  ): Promise<FileHandle> {
    await mkdir(childPath(parent, name), { mode: 0o700 }); // EEXIST is intentional; never reuse a workspace.
    const handle = await open(
      childPath(parent, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(handle);
    directoryPaths.set(handle, join(directoryPaths.get(parent)!, name));
    const stat = await handle.stat();
    owned.push({ parent, name, dev: stat.dev, ino: stat.ino, directory: true });
    return handle;
  }
  async function makeFile(
    parent: FileHandle,
    name: string,
    content: string,
  ): Promise<void> {
    const handle = await open(
      childPath(parent, name),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      owned.push({
        parent,
        name,
        dev: stat.dev,
        ino: stat.ino,
        directory: false,
      });
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  }
  try {
    const directory = await makeDirectory(
      course,
      `assignment-${context.assignment.id}`,
    );
    const resources = await makeDirectory(directory, "resources");
    await makeDirectory(directory, "submission");
    for (const [name, content] of Object.entries(docs)) {
      await makeFile(directory, name, content);
      files.push(name);
    }
    const mapping: DownloadedFile[] = [];
    if (options.download) {
      if (config.downloadHosts.length) warnings.push(DOWNLOAD_TRUST_NOTICE);
      for (const file of context.files) {
        const item = await downloadFile(file, resources, config, {
          ...dependencies,
          onCreated: (entry) =>
            owned.push({ ...entry, parent: resources, directory: false }),
        });
        mapping.push(item);
        files.push(`resources/${item.path}`);
      }
    } else if (context.files.length)
      warnings.push(
        "Resources were not downloaded; use the explicit download option to fetch listed file metadata.",
      );
    await makeFile(
      resources,
      "FILES.json",
      JSON.stringify(mapping, null, 2) + "\n",
    );
    files.push("resources/FILES.json");
    for (const [handle, expected] of directoryPaths) {
      if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== expected)
        throw new Error("Workspace directory changed during preparation.");
      const current = await openSafeDirectory(expected);
      try {
        const before = await handle.stat();
        const after = await current.stat();
        if (before.dev !== after.dev || before.ino !== after.ino)
          throw new Error("Workspace directory changed during preparation.");
      } finally {
        await current.close();
      }
    }
    return { workspace, files, warnings };
  } catch (error) {
    // No recursive deletion: preserve unexpected entries/replacements, and remove only created inodes.
    for (const entry of owned.reverse()) {
      const path = childPath(entry.parent, entry.name);
      const current = await lstat(path).catch(() => null);
      if (
        current?.dev === entry.dev &&
        current.ino === entry.ino &&
        !current.isSymbolicLink()
      ) {
        await (entry.directory ? rmdir(path) : unlink(path)).catch(
          () => undefined,
        );
      }
    }
    throw error;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

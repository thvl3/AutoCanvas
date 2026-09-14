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
import { join, parse, resolve, sep } from "node:path";
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

/** A directory pinned against symlink replacement. `handle` is the opened
 * descriptor on POSIX and null on Windows, which has no descriptor-relative
 * open and instead relies on the documented path walk in openSafeDirectory. */
export interface PinnedDirectory {
  readonly path: string;
  readonly handle: FileHandle | null;
}

// Descriptor-relative traversal exists on POSIX through each platform's fd
// filesystem. Windows has no equivalent, so it uses the path-based walk.
const FD_PREFIX =
  process.platform === "linux"
    ? "/proc/self/fd"
    : process.platform === "darwin"
      ? "/dev/fd"
      : null;

export function childPath(directory: PinnedDirectory, name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
    throw new Error("Unsafe file name");
  if (FD_PREFIX && directory.handle)
    return `${FD_PREFIX}/${directory.handle.fd}/${name}`;
  return join(directory.path, name);
}

/** The directory's own locator: descriptor-relative on POSIX (symlink-safe for
 * opendir), the resolved path on Windows. */
export function directoryPath(directory: PinnedDirectory): string {
  if (FD_PREFIX && directory.handle)
    return `${FD_PREFIX}/${directory.handle.fd}`;
  return directory.path;
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function openSafeDirectoryWindows(
  absolute: string,
  create: boolean,
): Promise<PinnedDirectory> {
  const root = parse(absolute).root;
  if (!root) throw new Error("Workspace requires an absolute path");
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const component of components) {
    if (component === "." || component === ".." || /[/\\\0]/.test(component))
      throw new Error("Unsafe workspace path");
    const next = join(current, component);
    let info = await lstat(next).catch((error: unknown) => {
      if (create && hasCode(error, "ENOENT")) return null;
      throw error;
    });
    if (info === null) {
      await mkdir(next, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
      info = await lstat(next);
    }
    // Reject symlinks and junctions in the ancestry; compare canonically so a
    // junction redirect (which realpath resolves) is detected, not followed.
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Workspace ancestry contains a link or non-directory");
    const canonical = await realpath(next).catch(() => next);
    if (canonical.toLowerCase() !== next.toLowerCase())
      throw new Error("Workspace ancestry changed");
    current = next;
  }
  return { path: absolute, handle: null };
}

/** Linux/macOS: descriptor-relative traversal (symlink-safe). Windows: a
 * documented path walk with lstat symlink/junction rejection and canonical
 * comparison. Never falls back to racy path-only traversal on POSIX. */
export async function openSafeDirectory(
  path: string,
  create = false,
): Promise<PinnedDirectory> {
  const absolute = resolve(path);
  if (!FD_PREFIX) return openSafeDirectoryWindows(absolute, create);
  let directory = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let expected = "/";
  try {
    for (const component of absolute.split(sep).filter(Boolean)) {
      const child = `${FD_PREFIX}/${directory.fd}/${component}`;
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
      if ((await realpath(`${FD_PREFIX}/${directory.fd}`)) !== expected)
        throw new Error("Workspace ancestry changed");
    }
    return { path: expected, handle: directory };
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
    const directory = await openSafeDirectory(path);
    await directory.handle?.close();
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
  parent: PinnedDirectory;
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
  const handles: FileHandle[] = [];
  if (course.handle) handles.push(course.handle);
  const directories: Array<{
    pinned: PinnedDirectory;
    dev: number;
    ino: number;
  }> = [];
  const owned: OwnedEntry[] = [];
  const files: string[] = [];
  const warnings = [
    ...context.warnings,
    "Workspace contains untrusted cached content. No files are executed and submission is disabled.",
  ];
  async function recordDirectory(
    pinned: PinnedDirectory,
    parent: PinnedDirectory,
    name: string,
  ): Promise<void> {
    const info = pinned.handle ? await pinned.handle.stat() : await lstat(pinned.path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Workspace directory is not a real directory");
    directories.push({ pinned, dev: info.dev, ino: info.ino });
    owned.push({ parent, name, dev: info.dev, ino: info.ino, directory: true });
  }
  async function makeDirectory(
    parent: PinnedDirectory,
    name: string,
  ): Promise<PinnedDirectory> {
    const target = childPath(parent, name);
    await mkdir(target, { mode: 0o700 }); // EEXIST is intentional; never reuse a workspace.
    const handle = FD_PREFIX
      ? await open(
          target,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
      : null;
    if (handle) handles.push(handle);
    const pinned = { path: join(parent.path, name), handle };
    await recordDirectory(pinned, parent, name);
    return pinned;
  }
  async function makeFile(
    parent: PinnedDirectory,
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
    const courseInfo = course.handle
      ? await course.handle.stat()
      : await lstat(course.path);
    directories.push({ pinned: course, dev: courseInfo.dev, ino: courseInfo.ino });
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
    for (const { pinned, dev, ino } of directories) {
      const info = await lstat(pinned.path).catch(() => null);
      if (!info || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino)
        throw new Error("Workspace directory changed during preparation.");
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

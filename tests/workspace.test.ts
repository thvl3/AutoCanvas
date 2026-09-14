import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  rename,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import type { AssignmentContext } from "../src/services/assignment-context.js";
import { prepareWorkspace, workspacePath } from "../src/services/workspace.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autocanvas-workspace-"));
  roots.push(root);
  const config: Config = {
    baseUrl: "https://canvas.example",
    accessToken: "secret",
    dbPath: ":memory:",
    workspaceRoot: join(root, "workspaces"),
    timezone: "UTC",
    timeoutMs: 1000,
    maxRetries: 0,
    maxDownloadBytes: 1024,
    downloadHosts: [],
    logLevel: "silent",
    syncConcurrency: 1,
  };
  const context: AssignmentContext = {
    assignment: {
      kind: "assignments",
      id: "23",
      course_id: "7",
      title: "../../do-not-use-as-path",
      updated_at: null,
      data: {
        description:
          "<p>Write a thoughtful response.</p><script>evil()</script><style>secret-style</style>",
      },
      raw: {},
    },
    course: null,
    assignment_group: null,
    rubric: null,
    modules: [],
    module_items: [],
    related_pages: [],
    files: [],
    announcements: [],
    discussions: [],
    submission: null,
    external_links: [],
    warnings: [],
    freshness: null,
  };
  return { root, config, context };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace preparation", () => {
  it("rejects metadata for a different course before making a workspace or fetching", async () => {
    const { config, context } = await fixture();
    context.files = [
      {
        kind: "files",
        id: "42",
        course_id: "999",
        title: "Cross-course",
        updated_at: null,
        data: {
          filename: "bad.txt",
          url: "https://canvas.example/files/42/download",
        },
        raw: {},
      },
    ];
    let calls = 0;
    await expect(
      prepareWorkspace(
        context,
        config,
        { download: true },
        {
          fetch: async () => {
            calls++;
            return new Response("x");
          },
        },
      ),
    ).rejects.toThrow(/course|metadata/i);
    expect(calls).toBe(0);
    await expect(stat(config.workspaceRoot)).rejects.toThrow();
  });
  it("detects a resources directory swapped for a symlink during download, without touching its target", async () => {
    const { root, config, context } = await fixture();
    context.files = [
      {
        kind: "files",
        id: "42",
        course_id: "7",
        title: "File",
        updated_at: null,
        data: {
          filename: "source.txt",
          url: "https://canvas.example/files/42/download",
        },
        raw: {},
      },
    ];
    const workspace = join(config.workspaceRoot, "course-7", "assignment-23");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "keep.txt"), "user-owned");
    await expect(
      prepareWorkspace(
        context,
        config,
        { download: true },
        {
          fetch: async () => {
            await rename(
              join(workspace, "resources"),
              join(workspace, "moved-resources"),
            );
            await symlink(join(root, "outside"), join(workspace, "resources"));
            return new Response("download");
          },
        },
      ),
    ).rejects.toThrow();
    expect(await readdir(join(root, "outside"))).toEqual(["keep.txt"]);
    expect(await readFile(join(root, "outside", "keep.txt"), "utf8")).toBe(
      "user-owned",
    );
  });
  it("bounds hostile attachment counts before making the workspace", async () => {
    const { config, context } = await fixture();
    context.files = Array.from({ length: 101 }, (_, index) => ({
      kind: "files" as const,
      id: String(index + 1),
      course_id: "7",
      title: "File",
      updated_at: null,
      data: {},
      raw: {},
    }));
    await expect(prepareWorkspace(context, config)).rejects.toThrow(/limit/i);
    await expect(stat(config.workspaceRoot)).rejects.toThrow();
  });
  it("downloads only listed metadata on opt-in and writes a query-free resource mapping", async () => {
    const { config, context } = await fixture();
    context.files = [
      {
        kind: "files",
        id: "42",
        course_id: "7",
        title: "Attachment",
        updated_at: null,
        data: {
          filename: "../source.txt",
          url: "https://canvas.example/files/42/download?signature=private",
        },
        raw: {},
      },
    ];
    context.external_links = ["https://evil.example/never-fetch"];
    const requested: string[] = [];
    const result = await prepareWorkspace(
      context,
      config,
      { download: true },
      {
        fetch: async (input) => {
          requested.push(String(input));
          return new Response("real-resource");
        },
      },
    );
    const mapping = JSON.parse(
      await readFile(join(result.workspace, "resources", "FILES.json"), "utf8"),
    ) as Array<{ path: string }>;
    expect(mapping).toHaveLength(1);
    expect(JSON.stringify(mapping)).not.toContain("signature");
    expect(
      await readFile(
        join(result.workspace, "resources", mapping[0]!.path),
        "utf8",
      ),
    ).toBe("real-resource");
    expect(requested).toEqual([
      "https://canvas.example/files/42/download?signature=private",
    ]);
    expect(result.files).toContain(`resources/${mapping[0]!.path}`);
  });
  it("rolls back a newly created workspace after a later download fails", async () => {
    const { config, context } = await fixture();
    context.files = ["42", "43"].map((id) => ({
      kind: "files" as const,
      id,
      course_id: "7",
      title: "File",
      updated_at: null,
      data: {
        filename: "file.txt",
        url: `https://canvas.example/files/${id}/download`,
      },
      raw: {},
    }));
    let requests = 0;
    await expect(
      prepareWorkspace(
        context,
        config,
        { download: true },
        {
          fetch: async () =>
            ++requests === 1
              ? new Response("first")
              : new Response("failed", { status: 500 }),
        },
      ),
    ).rejects.toThrow(/HTTP/);
    expect(await readdir(join(config.workspaceRoot, "course-7"))).not.toContain(
      "assignment-23",
    );
  });
  it("includes real rubric and relevant context while neutralizing active HTML links", async () => {
    const { config, context } = await fixture();
    context.rubric = [{ description: "<b>Original analysis</b>", points: 10 }];
    context.related_pages = [
      {
        kind: "pages",
        id: "8",
        course_id: "7",
        title: "Reading",
        updated_at: null,
        data: {
          body: '<p>Relevant reading</p><a href="javascript:alert(1)">bad link</a><img src="https://evil.example/tracker">',
        },
        raw: {},
      },
    ];
    const result = await prepareWorkspace(context, config);
    expect(
      await readFile(join(result.workspace, "RUBRIC.md"), "utf8"),
    ).toContain("Original analysis");
    const content = await readFile(
      join(result.workspace, "CONTEXT.md"),
      "utf8",
    );
    expect(content).toContain("Relevant reading");
    expect(content).not.toMatch(/javascript:|evil.example/);
  });
  it("does not request downloads without explicit opt-in", async () => {
    const { config, context } = await fixture();
    context.files = [
      {
        kind: "files",
        id: "42",
        course_id: "7",
        title: "File",
        updated_at: null,
        data: { url: "https://canvas.example/files/42/download" },
        raw: {},
      },
    ];
    let calls = 0;
    await prepareWorkspace(
      context,
      config,
      {},
      {
        fetch: async () => {
          calls++;
          return new Response("x");
        },
      },
    );
    expect(calls).toBe(0);
  });
  it.each(["../9", "1/2", "01", "-1", "1\\0", "1%2f2", "", "9e2"])(
    "rejects malformed literal ID %j",
    async (id) => {
      const { config } = await fixture();
      await expect(
        workspacePath(config.workspaceRoot, id, "23"),
      ).rejects.toThrow(/ID/i);
      await expect(
        workspacePath(config.workspaceRoot, "7", id),
      ).rejects.toThrow(/ID/i);
    },
  );
  it("rejects symlink roots, ancestors, course directories and workspace directories", async () => {
    const { root, config } = await fixture();
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), config.workspaceRoot);
    await expect(
      workspacePath(config.workspaceRoot, "7", "23"),
    ).rejects.toThrow();
    await expect(
      workspacePath(join(config.workspaceRoot, "nested"), "7", "23"),
    ).rejects.toThrow();
    await rm(config.workspaceRoot);
    await mkdir(config.workspaceRoot);
    await symlink(
      join(root, "outside"),
      join(config.workspaceRoot, "course-7"),
    );
    await expect(
      workspacePath(config.workspaceRoot, "7", "23"),
    ).rejects.toThrow();
    await rm(join(config.workspaceRoot, "course-7"));
    await mkdir(join(config.workspaceRoot, "course-7"));
    await symlink(
      join(root, "outside"),
      join(config.workspaceRoot, "course-7", "assignment-23"),
    );
    await expect(
      workspacePath(config.workspaceRoot, "7", "23"),
    ).rejects.toThrow();
    expect(await readdir(join(root, "outside"))).toEqual([]);
  });
  it("refuses an existing workspace without overwriting user content", async () => {
    const { config, context } = await fixture();
    const first = await prepareWorkspace(context, config);
    await writeFile(join(first.workspace, "ASSIGNMENT.md"), "user-owned");
    await expect(prepareWorkspace(context, config)).rejects.toThrow(/exist/i);
    expect(await readFile(join(first.workspace, "ASSIGNMENT.md"), "utf8")).toBe(
      "user-owned",
    );
  });
  it("creates ID-only private workspace with untrusted markdown and quoted instructions", async () => {
    const { config, context } = await fixture();
    const result = await prepareWorkspace(context, config);
    expect(result.workspace).toBe(
      join(config.workspaceRoot, "course-7", "assignment-23"),
    );
    expect(await readdir(result.workspace)).toEqual(
      expect.arrayContaining([
        "ASSIGNMENT.md",
        "RUBRIC.md",
        "CONTEXT.md",
        "TODO.md",
        "resources",
        "submission",
      ]),
    );
    const assignment = await readFile(
      join(result.workspace, "ASSIGNMENT.md"),
      "utf8",
    );
    expect(assignment).toContain("UNTRUSTED");
    expect(assignment).toContain("Write a thoughtful response.");
    expect(assignment).not.toMatch(/evil\(\)|secret-style|<script/i);
    expect(await readFile(join(result.workspace, "TODO.md"), "utf8")).toContain(
      "> Write a thoughtful response.",
    );
  });
});

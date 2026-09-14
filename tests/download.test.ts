import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import type { Entity } from "../src/domain/types.js";
import { downloadFile } from "../src/services/download.js";
import { openSafeDirectory } from "../src/services/workspace.js";

const roots: string[] = [];
const servers: Server[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autocanvas-download-"));
  roots.push(root);
  const config: Config = {
    baseUrl: "https://canvas.example",
    accessToken: "private-token",
    dbPath: ":memory:",
    workspaceRoot: root,
    timezone: "UTC",
    timeoutMs: 1000,
    maxRetries: 0,
    maxDownloadBytes: 1024,
    downloadHosts: [],
    logLevel: "silent",
    syncConcurrency: 1,
  };
  const file: Entity = {
    kind: "files",
    id: "42",
    course_id: "7",
    title: "resource",
    updated_at: null,
    data: {
      filename: "../../report.bin",
      url: "https://canvas.example/files/42/download?secret=signed",
    },
    raw: {},
  };
  return { root, config, file };
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("metadata-only downloads", () => {
  it.each(["canvas", "signed-cdn"])(
    "rejects user-locked %s files before creating a destination or fetching",
    async (host) => {
      const { root, config, file } = await fixture();
      file.data.locked_for_user = true;
      if (host === "signed-cdn") {
        config.downloadHosts = ["cdn.example"];
        file.data.url = "https://cdn.example/resource?signature=signed";
      }
      let calls = 0;
      let created = 0;
      const directory = await openSafeDirectory(root);
      try {
        const result = downloadFile(file, directory, config, {
          fetch: async () => {
            calls++;
            return new Response("locked bytes");
          },
          onCreated: () => {
            created++;
          },
        });
        await expect(result).rejects.toThrow(/locked/i);
        expect(calls).toBe(0);
        expect(created).toBe(0);
        expect(await readdir(root)).toEqual([]);
      } finally {
        await directory.handle?.close();
      }
    },
  );
  it.each(["content-length", "stream", "http-error"])(
    "rejects %s failures without leaving a partial file",
    async (failure) => {
      const { root, config, file } = await fixture();
      config.maxDownloadBytes = 4;
      const directory = await openSafeDirectory(root);
      try {
        await expect(
          downloadFile(file, directory, config, {
            fetch: async () => {
              if (failure === "http-error")
                return new Response("not found", { status: 404 });
              if (failure === "content-length")
                return new Response("ok", {
                  headers: { "content-length": "99" },
                });
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("abc"));
                    controller.enqueue(new TextEncoder().encode("def"));
                    controller.close();
                  },
                }),
              );
            },
          }),
        ).rejects.toThrow(/limit|HTTP/i);
        expect(await readdir(root)).toEqual([]);
      } finally {
        await directory.handle?.close();
      }
    },
  );
  it.each(["headers", "body"])(
    "times out native fetch during %s without leaving partial files",
    async (phase) => {
      const { root, config, file } = await fixture();
      config.timeoutMs = 30;
      const server = createServer((_request, response) => {
        if (phase === "body") {
          response.writeHead(200);
          response.write("a");
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      config.baseUrl = `http://127.0.0.1:${address.port}`;
      file.data.url = `${config.baseUrl}/files/42/download?signature=do-not-leak`;
      const directory = await openSafeDirectory(root);
      try {
        await expect(downloadFile(file, directory, config)).rejects.toThrow(
          /timeout/i,
        );
        expect(await readdir(root)).toEqual([]);
      } finally {
        await directory.handle?.close();
      }
    },
    1500,
  );
  it.each(["regular", "symlink"])(
    "never overwrites an existing %s destination or requests bytes for it",
    async (kind) => {
      const { root, config, file } = await fixture();
      file.data.filename = "report.bin";
      await writeFile(join(root, "original"), "user-owned");
      if (kind === "symlink")
        await symlink(join(root, "original"), join(root, "42-report.bin"));
      else await writeFile(join(root, "42-report.bin"), "user-owned");
      let calls = 0;
      const directory = await openSafeDirectory(root);
      try {
        await expect(
          downloadFile(file, directory, config, {
            fetch: async () => {
              calls++;
              return new Response("replacement");
            },
          }),
        ).rejects.toThrow();
        expect(calls).toBe(0);
        expect(await readFile(join(root, "42-report.bin"), "utf8")).toBe(
          "user-owned",
        );
        expect(await readFile(join(root, "original"), "utf8")).toBe(
          "user-owned",
        );
      } finally {
        await directory.handle?.close();
      }
    },
  );
  it("redacts signed URL and token from transport exceptions", async () => {
    const { root, config, file } = await fixture();
    const directory = await openSafeDirectory(root);
    try {
      let message = "";
      try {
        await downloadFile(file, directory, config, {
          fetch: async () => {
            throw new Error(`transport ${file.data.url} ${config.accessToken}`);
          },
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toContain("secret=signed");
      expect(message).not.toContain(config.accessToken);
      expect(message).toContain("Download");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await directory.handle?.close();
    }
  });
  it.each([
    "https://evil.example/files/42/download",
    "http://cdn.example/resource",
    "https://localhost/resource",
    "https://127.0.0.1/resource",
    "https://2130706433/resource",
    "https://[::1]/resource",
    "https://10.0.0.1/resource",
    "https://canvas.example/api/v1/users/self",
    "https://canvas.example/files/99/download",
    "https://canvas.example/files/42/../42/download",
    "https://canvas.example/files/%34%32/download",
    "https://user:password@canvas.example/files/42/download",
  ])(
    "rejects unsafe metadata URL before issuing a request: %s",
    async (url) => {
      const { root, config, file } = await fixture();
      file.data.url = url;
      config.downloadHosts = [
        "cdn.example",
        "localhost",
        "127.0.0.1",
        "2130706433",
        "[::1]",
        "10.0.0.1",
      ];
      let calls = 0;
      const directory = await openSafeDirectory(root);
      try {
        await expect(
          downloadFile(file, directory, config, {
            fetch: async () => {
              calls++;
              return new Response("bad");
            },
          }),
        ).rejects.toThrow();
        expect(calls).toBe(0);
        expect(await readdir(root)).toEqual([]);
      } finally {
        await directory.handle?.close();
      }
    },
  );
  it("follows only revalidated redirects without forwarding bearer to an explicitly trusted HTTPS CDN", async () => {
    const { root, config, file } = await fixture();
    config.downloadHosts = ["cdn.example"];
    const seen: Array<{
      url: string;
      auth: string | null;
      redirect?: RequestRedirect;
    }> = [];
    const directory = await openSafeDirectory(root);
    try {
      const result = await downloadFile(file, directory, config, {
        fetch: async (input, init) => {
          seen.push({
            url: String(input),
            auth: new Headers(init?.headers).get("authorization"),
            redirect: init?.redirect,
          });
          return seen.length === 1
            ? new Response(null, {
                status: 302,
                headers: {
                  location: "https://cdn.example/opaque?signature=private",
                },
              })
            : new Response("fixture");
        },
      });
      expect(await readFile(join(root, result.path), "utf8")).toBe("fixture");
      expect(seen).toHaveLength(2);
      expect(seen.map((item) => item.auth)).toEqual([
        "Bearer private-token",
        null,
      ]);
      expect(seen.every((item) => item.redirect === "manual")).toBe(true);
      expect(result.source).toBe("https://cdn.example/opaque");
    } finally {
      await directory.handle?.close();
    }
  });
  it("rejects a same-origin redirect to non-file APIs", async () => {
    const { root, config, file } = await fixture();
    const directory = await openSafeDirectory(root);
    let calls = 0;
    try {
      await expect(
        downloadFile(file, directory, config, {
          fetch: async () => {
            calls++;
            return new Response(null, {
              status: 302,
              headers: { location: "/api/v1/users/self" },
            });
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await directory.handle?.close();
    }
  });
  it("downloads exact binary fixture bytes with native fetch, GET and same-origin bearer", async () => {
    const { root, config, file } = await fixture();
    const bytes = Buffer.from([0, 255, 80, 68, 70, 13, 10]);
    const requests: Array<{ method?: string; auth?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        auth: request.headers.authorization,
      });
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      });
      response.end(bytes);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    config.baseUrl = `http://127.0.0.1:${address.port}`;
    file.data.url = `${config.baseUrl}/files/42/download?secret=signed`;
    const directory = await openSafeDirectory(root);
    try {
      const result = await downloadFile(file, directory, config);
      expect(result.path).toMatch(/^42-[A-Za-z0-9._-]+$/);
      expect(await readFile(join(root, result.path))).toEqual(bytes);
      expect(result.bytes).toBe(bytes.length);
      expect(JSON.stringify(result)).not.toContain("secret=signed");
      expect(requests).toEqual([
        { method: "GET", auth: "Bearer private-token" },
      ]);
    } finally {
      await directory.handle?.close();
    }
  });
});

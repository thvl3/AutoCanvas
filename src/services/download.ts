import { isIP } from "node:net";
import { constants } from "node:fs";
import { open, lstat, unlink, type FileHandle } from "node:fs/promises";
import type { Config } from "../config.js";
import type { Entity } from "../domain/types.js";
import { childPath, requireCanvasId, type PinnedDirectory } from "./workspace.js";

export type FileAcquirer = (file: Entity, maxBytes: number) => Promise<{bytes: Uint8Array; contentType?: string}>;

export interface DownloadedFile {
  file_id: string;
  path: string;
  source: string;
  bytes: number;
}
export const DOWNLOAD_TRUST_NOTICE =
  "CANVAS_DOWNLOAD_HOSTS is an explicit trust boundary: allow only institution-controlled HTTPS CDN hostnames. Native fetch uses system DNS without address pinning; an allowed hostname or its DNS must not be attacker-controlled.";
class DownloadError extends Error {}

function checkedUrl(
  raw: string,
  file: Entity,
  config: Config,
  previous?: URL,
): URL {
  // Reject ambiguity BEFORE URL parsing can normalize traversal or backslashes.
  if (
    /[\\\u0000-\u0020\u007f]/.test(raw) ||
    /(?:^|\/)\.{1,2}(?:\/|\?|#|$)/.test(raw.split("?")[0] ?? "")
  )
    throw new DownloadError("Unsafe download URL");
  let url: URL;
  try {
    url = new URL(raw, previous);
  } catch {
    throw new DownloadError("Invalid download URL");
  }
  if (url.username || url.password || url.hash)
    throw new DownloadError("Unsafe download URL");
  const canvas = new URL(config.baseUrl);
  if (url.origin === canvas.origin) {
    const course = file.course_id ? `/courses/${file.course_id}` : "";
    if (
      url.pathname !== `/files/${file.id}/download` &&
      (!course || url.pathname !== `${course}/files/${file.id}/download`)
    )
      throw new DownloadError("Unsafe Canvas download path");
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new DownloadError("Canvas downloads require HTTPS");
  } else {
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.port ||
      isIP(host.replace(/^\[|\]$/g, "")) ||
      !host.includes(".") ||
      host === "localhost" ||
      /\.(?:localhost|local|internal|home|test|invalid)$/.test(host) ||
      host.endsWith(".")
    )
      throw new DownloadError("Unsafe external download host");
    if (!config.downloadHosts.includes(host))
      throw new DownloadError(
        "External download host is not explicitly allowed",
      );
  }
  return url;
}

/** Delete only this newly created inode, never a replacement entry or symlink target. */
export async function unlinkOwnedFile(
  directory: PinnedDirectory,
  name: string,
  file: FileHandle,
): Promise<void> {
  const own = await file.stat();
  const entry = await lstat(childPath(directory, name)).catch(() => null);
  if (entry?.isFile() && entry.ino === own.ino && entry.dev === own.dev)
    await unlink(childPath(directory, name));
}

/** Internal metadata-only primitive, never expose a caller-supplied URL/path as an MCP tool. */
export async function downloadFile(
  file: Entity,
  directory: PinnedDirectory,
  config: Config,
  dependencies: {
    fetch?: typeof fetch;
    acquire?: FileAcquirer;
    onCreated?: (entry: { name: string; dev: number; ino: number }) => void;
  } = {},
): Promise<DownloadedFile> {
  if (file.data.locked_for_user === true)
    throw new DownloadError("File is locked for the current user");
  requireCanvasId(file.id);
  const name =
    typeof file.data.filename === "string" ? file.data.filename : "resource";
  const filename = `${file.id}-${
    name
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 150) || "resource"
  }`;
  if (dependencies.acquire) {
    const destination = await open(childPath(directory, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const identity = await destination.stat();
      dependencies.onCreated?.({name: filename, dev: identity.dev, ino: identity.ino});
      const result = await Promise.race([
        dependencies.acquire(file, config.maxDownloadBytes),
        new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new DownloadError("Download timeout")),config.timeoutMs); }),
      ]);
      if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength > config.maxDownloadBytes) throw new DownloadError("Download byte limit exceeded (provider)");
      await destination.writeFile(result.bytes);
      return {file_id:file.id,path:filename,source:`canvas-file:${file.id}`,bytes:result.bytes.byteLength};
    } catch (error) {
      await unlinkOwnedFile(directory,filename,destination);
      if (error instanceof Error && "code" in error && /^(canvas_|bridge_|extension_)/.test(String(error.code))) throw error;
      throw error instanceof DownloadError ? error : new DownloadError("Download failed (provider or local write)");
    } finally { if(timer)clearTimeout(timer); await destination.close(); }
  }
  if (typeof file.data.url !== "string")
    throw new DownloadError("Missing file download metadata");
  let url = checkedUrl(file.data.url, file, config);
  const destination = await open(
    childPath(directory, filename),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const identity = await destination.stat();
    dependencies.onCreated?.({
      name: filename,
      dev: identity.dev,
      ino: identity.ino,
    });
    for (let redirects = 0; ; redirects++) {
      const headers: Record<string, string> =
        url.origin === new URL(config.baseUrl).origin
          ? { Authorization: `Bearer ${config.accessToken}` }
          : {};
      response = await (dependencies.fetch ?? fetch)(url, {
        method: "GET",
        headers,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 5)
        throw new DownloadError("Too many download redirects");
      const location = response.headers.get("location");
      if (!location)
        throw new DownloadError("Download redirect missing location");
      url = checkedUrl(location, file, config, url);
    }
    if (!response.ok)
      throw new DownloadError(`Download HTTP failure (${response.status})`);
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > config.maxDownloadBytes)
    )
      throw new DownloadError("Download byte limit exceeded (content-length)");
    let bytes = 0;
    reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted)
          throw new DownloadError("Download timeout");
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > config.maxDownloadBytes)
          throw new DownloadError("Download byte limit exceeded (stream)");
        await destination.writeFile(chunk.value);
      }
    }
    return {
      file_id: file.id,
      path: filename,
      source: `${url.origin}${url.pathname}`,
      bytes,
    };
  } catch (error) {
    await unlinkOwnedFile(directory, filename, destination);
    // Never surface transport error messages/causes containing signed URLs or bearer tokens.
    if (controller.signal.aborted) throw new DownloadError("Download timeout");
    throw error instanceof DownloadError
      ? error
      : new DownloadError("Download failed (transport or local write)");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else await response?.body?.cancel().catch(() => undefined);
    await destination.close();
  }
}

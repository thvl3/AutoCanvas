import { spawn } from "node:child_process";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { isSeaExecutable } from "../paths.js";
import { APP_VERSION } from "../version.js";

const REPO = "thvl3/AutoCanvas";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  downloadUrl?: string;
  notes?: string;
  error?: string;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

/** Release asset name for this platform, matching scripts/build-release.mjs. */
export function assetName(): string {
  const os = platform();
  const a = arch();
  if (os === "win32") return `canvas-mcp-windows-${a}.exe`;
  if (os === "darwin") return `canvas-mcp-macos-${a}`;
  return `canvas-mcp-linux-${a}`;
}

/** True when `a` is a strictly higher x.y.z version than `b`. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    available: false,
  };
  try {
    const res = await fetch(API, {
      headers: {
        "User-Agent": "autocanvas",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ...base, error: `GitHub returned ${res.status}` };
    const data = (await res.json()) as {
      tag_name?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
      body?: string;
    };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (!latest) return { ...base, error: "No release found" };
    const asset = data.assets?.find((a) => a.name === assetName());
    if (!asset) return { ...base, latestVersion: latest, available: false };
    return {
      currentVersion: APP_VERSION,
      latestVersion: latest,
      available: newer(latest, APP_VERSION),
      downloadUrl: asset.browser_download_url,
      notes: data.body,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : "Update check failed",
    };
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "autocanvas" },
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024 * 1024)
    throw new Error("Downloaded file is unexpectedly small; aborting.");
  writeFileSync(dest, buffer);
}

function spawnWindowsSwapper(exe: string, staging: string): void {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$p=${process.pid};`,
    `while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }`,
    `Start-Sleep -Milliseconds 500`,
    `Move-Item -Force ${q(staging)} ${q(exe)}`,
    `Start-Process ${q(exe)}`,
  ].join(" ");
  const child = spawn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      script,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** Download and stage the replacement for the running executable. The actual
 * swap happens either immediately (POSIX rename) or via a detached helper
 * after this process exits (Windows cannot overwrite a running exe). */
export async function applyUpdate(downloadUrl: string): Promise<ApplyResult> {
  if (!isSeaExecutable()) {
    return {
      ok: false,
      message: "Auto-update is only available for the standalone executable.",
    };
  }
  const exe = process.execPath;
  const staging = `${exe}.update`;
  try {
    await download(downloadUrl, staging);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Download failed",
    };
  }
  if (process.platform === "win32") {
    spawnWindowsSwapper(exe, staging);
    return { ok: true, message: "Update staged; restarting to install." };
  }
  try {
    chmodSync(staging, 0o755);
    renameSync(staging, exe);
    return { ok: true, message: "Updated; restart to use the new version." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Replace failed",
    };
  }
}

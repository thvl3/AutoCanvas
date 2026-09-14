import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installDir, isSeaExecutable } from "../paths.js";

export interface InstallResult {
  installedPath: string;
  addedToPath: boolean;
}

function addToPathWindows(dir: string): boolean {
  // Append the install dir to the per-user (HKCU) PATH via .NET, which handles
  // REG_SZ/REG_EXPAND_SZ transparently and needs no admin rights. Written in
  // PowerShell 5.1-compatible syntax (no `??`, which only exists in PS 7+).
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$p = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if (-not $p) { $p = '' }`,
    `if (($p -split ';') -notcontains ${q(dir)}) {`,
    `  if ($p) { $p = $p.TrimEnd(';') + ';' + ${q(dir)} } else { $p = ${q(dir)} }`,
    `  [Environment]::SetEnvironmentVariable('Path', $p, 'User')`,
    `}`,
  ].join("\n");
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function addToPathPosix(dir: string): boolean {
  const line = `export PATH="${dir}:$PATH"`;
  let added = false;
  for (const rc of [".bashrc", ".zshrc", ".profile"]) {
    const path = join(homedir(), rc);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (content.includes(dir)) continue;
    appendFileSync(path, `\n# AutoCanvas\n${line}\n`);
    added = true;
  }
  return added;
}

function addToPath(dir: string): boolean {
  return process.platform === "win32"
    ? addToPathWindows(dir)
    : addToPathPosix(dir);
}

/**
 * Copy the running executable to the stable per-user install directory and add
 * it to PATH. Only valid for the standalone SEA binary.
 */
export function selfInstall(): InstallResult {
  if (!isSeaExecutable()) {
    throw new Error(
      "install is only available from the standalone executable, not the source build.",
    );
  }
  const dir = installDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(
    dir,
    process.platform === "win32" ? "canvas-mcp.exe" : "canvas-mcp",
  );
  if (resolve(process.execPath) !== resolve(dest)) {
    copyFileSync(process.execPath, dest);
    if (process.platform !== "win32") chmodSync(dest, 0o755);
  }
  return { installedPath: dest, addedToPath: addToPath(dir) };
}

export function installLocation(): string {
  return join(
    installDir(),
    process.platform === "win32" ? "canvas-mcp.exe" : "canvas-mcp",
  );
}

export function installDirPath(): string {
  return installDir();
}

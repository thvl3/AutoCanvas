import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError, type BridgeSettings } from "./protocol.js";

const stateSchema = z
  .object({
    protocolVersion: z.literal(1),
    origin: z.string(),
    clientSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    extensionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    extensionOrigin: z.string().optional(),
  })
  .strict();
export type Credentials = z.infer<typeof stateSchema>;
export const credentialPath = (settings: BridgeSettings): string =>
  join(settings.stateDir, "bridge-credentials.json");

// Windows has no POSIX mode bits or getuid(); Node reports synthetic modes
// (0o40777 dirs, 0o100666 files) that would always trip the 0700/0600 checks.
// On Windows, per-user privacy is enforced by the profile ACLs (state lives
// under %LOCALAPPDATA%), so we only verify "real directory/file, not a
// symlink/junction" there.
export function insecurePermissions(
  info: { mode: number; uid: number },
  isWindows: boolean = process.platform === "win32",
): boolean {
  if (isWindows) return false;
  return (
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  );
}
export function checkSettings(settings: BridgeSettings): void {
  let validOrigin = false;
  try {
    const url = new URL(settings.origin);
    validOrigin =
      url.protocol === "https:" &&
      url.origin === settings.origin &&
      !url.username &&
      !url.password;
  } catch {
    /* invalid */
  }
  if (
    !validOrigin ||
    (settings.host !== undefined && settings.host !== "127.0.0.1") ||
    !settings.stateDir ||
    !Number.isInteger(settings.port ?? 47821) ||
    (settings.port ?? 47821) < 0 ||
    (settings.port ?? 47821) > 65535 ||
    !Number.isInteger(settings.timeoutMs ?? 30000) ||
    (settings.timeoutMs ?? 30000) < 1 ||
    (settings.timeoutMs ?? 30000) > 300000
  ) {
    throw new BridgeError(
      "invalid_settings",
      "Use a Canvas HTTPS origin, private state directory, and loopback host 127.0.0.1.",
    );
  }
}
async function privateDirectory(
  settings: BridgeSettings,
  create: boolean,
): Promise<void> {
  if (create) await mkdir(settings.stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(settings.stateDir);
  if (!info.isDirectory() || info.isSymbolicLink() || insecurePermissions(info))
    throw new BridgeError(
      "insecure_state",
      "Bridge state directory must be owned by you with mode 0700.",
    );
}
export async function readCredentials(
  settings: BridgeSettings,
): Promise<Credentials> {
  await privateDirectory(settings, false);
  const file = await open(
    credentialPath(settings),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || insecurePermissions(info))
      throw new BridgeError(
        "insecure_state",
        "Bridge credential file must be owned by you with mode 0600.",
      );
    let state: Credentials;
    try {
      state = stateSchema.parse(JSON.parse(await file.readFile("utf8")));
    } catch {
      throw new BridgeError(
        "invalid_state",
        "Bridge credential state is invalid; restore it or use a new private state directory.",
      );
    }
    if (state.origin !== settings.origin)
      throw new BridgeError(
        "origin_mismatch",
        "Bridge credentials belong to a different Canvas origin; use a separate state directory.",
      );
    return state;
  } finally {
    await file.close();
  }
}
export async function saveCredentials(
  settings: BridgeSettings,
  state: Credentials,
): Promise<void> {
  await privateDirectory(settings, false);
  const temporary =
    credentialPath(settings) + "." + randomBytes(8).toString("hex");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
    await file.close();
    await rename(temporary, credentialPath(settings));
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
}
export async function loadCredentials(
  settings: BridgeSettings,
): Promise<Credentials> {
  await privateDirectory(settings, true);
  try {
    return await readCredentials(settings);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const state: Credentials = {
    protocolVersion: 1,
    origin: settings.origin,
    clientSecret: randomBytes(32).toString("base64url"),
    extensionSecret: randomBytes(32).toString("base64url"),
  };
  let file;
  try {
    file = await open(credentialPath(settings), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return readCredentials(settings);
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
  } finally {
    await file.close();
  }
  return state;
}

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user config directory (survives independent of the process CWD).
 * Windows: %APPDATA%\autocanvas
 * macOS:   ~/Library/Application Support/autocanvas
 * Linux:   $XDG_CONFIG_HOME/autocanvas (defaults to ~/.config/autocanvas)
 */
export function configDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "autocanvas",
    );
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "autocanvas");
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "autocanvas",
  );
}

/**
 * Per-user data/state directory (databases, workspaces, bridge state).
 * Windows: %LOCALAPPDATA%\autocanvas
 * macOS:   ~/Library/Application Support/autocanvas
 * Linux:   $XDG_STATE_HOME/autocanvas (defaults to ~/.local/state/autocanvas)
 */
export function dataDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "autocanvas",
    );
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "autocanvas");
  }
  return join(
    process.env.XDG_STATE_HOME ?? join(home, ".local", "state"),
    "autocanvas",
  );
}

/** Location of the persisted .env config file. */
export function configFilePath(): string {
  return join(configDir(), ".env");
}

/**
 * Per-user install destination for the standalone executable.
 * Windows: %LOCALAPPDATA%\Programs\autocanvas
 * POSIX:   ~/.local/bin
 */
export function installDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "Programs",
      "autocanvas",
    );
  }
  return join(home, ".local", "bin");
}

/**
 * True when running as the standalone single-file executable (SEA), false when
 * running from source via `node dist/cli/index.js` or `tsx`.
 */
export function isSeaExecutable(): boolean {
  return !/dist[\\/]cli[\\/]index\.js$/.test(
    (process.argv[1] ?? "").replace(/\\/g, "/"),
  );
}

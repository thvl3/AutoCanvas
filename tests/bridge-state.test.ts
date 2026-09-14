import { expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeClient } from "../src/bridge/client.js";
import { startBridge } from "../src/bridge/server.js";

it("rereads changed credentials on restart and fails closed on unsafe private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const settings = {
    origin: "https://canvas.example.edu",
    stateDir: join(root, "private"),
    port: 0,
  };
  let server = await startBridge(settings);
  settings.port = server.port;
  const client = new BridgeClient(settings);
  const path = join(settings.stateDir, "bridge-credentials.json");
  try {
    await client.status();
    await server.close();
    const credentials = JSON.parse(await readFile(path, "utf8"));
    credentials.clientSecret = randomBytes(32).toString("base64url");
    await writeFile(path, JSON.stringify(credentials));
    server = await startBridge(settings);
    expect(await client.status()).toMatchObject({ connected: false });
    await server.close();
    await chmod(path, 0o644);
    await expect(startBridge(settings)).rejects.toMatchObject({
      code: "insecure_state",
    });
    await chmod(path, 0o600);
    await symlink(settings.stateDir, join(root, "symlink"));
    await expect(
      startBridge({ ...settings, stateDir: join(root, "symlink") }),
    ).rejects.toMatchObject({ code: "insecure_state" });
    await writeFile(path, "SECRET_MUST_NOT_APPEAR_IN_ERRORS");
    const error = await startBridge(settings).catch((error) => error);
    expect(error).toMatchObject({ code: "invalid_state" });
    expect(error.message).not.toContain("SECRET_MUST_NOT_APPEAR");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

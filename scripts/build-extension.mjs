import { build, context } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "browser-extension");
const manifest = JSON.parse(
  await readFile(join(source, "manifest.json"), "utf8"),
);
const watching = process.argv.includes("--watch");
const contexts = [];
for (const firefox of [true, false]) {
  const outdir = join(source, firefox ? "dist-firefox" : "dist");
  await mkdir(outdir, { recursive: true });
  const target = firefox
    ? {
        ...manifest,
        background: { scripts: ["background.js"] },
        browser_specific_settings: {
          gecko: {
            id: "autocanvas-session@local",
            strict_min_version: "128.0",
          },
        },
      }
    : {
        ...manifest,
        background: { service_worker: "background.js" },
        minimum_chrome_version: "116",
      };
  async function assets() {
    await writeFile(
      join(outdir, "manifest.json"),
      JSON.stringify(target, null, 2) + "\n",
    );
    await Promise.all(
      ["options.html", "options.css"].map((file) =>
        copyFile(join(source, file), join(outdir, file)),
      ),
    );
  }
  await assets();
  const options = {
    absWorkingDir: root,
    entryPoints: [
      "browser-extension/src/background.ts",
      "browser-extension/src/options.ts",
    ],
    outdir,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: firefox ? "firefox128" : "chrome116",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
    plugins: [
      {
        name: "extension-assets",
        setup(builder) {
          builder.onEnd(async () => {
            await assets();
          });
        },
      },
    ],
  };
  if (watching) {
    const ctx = await context(options);
    await ctx.watch();
    contexts.push(ctx);
  } else await build(options);
}
if (watching) {
  console.log(
    "Watching extension sources; reload the temporary add-on after changes.",
  );
  const stop = async () => {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

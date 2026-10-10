import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
for (const [name, entry] of [
  ["widget", "widget"],
  ["shopping-list", "shopping-list-widget"],
]) {
  const widget = await build({
    entryPoints: [`${root}src/${entry}.ts`],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const code = widget.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  await writeFile(
    `${root}dist/${name}.html`,
    (await readFile(`${root}src/${name}.html`, "utf8"))
      .replace(
        "/* WIDGET_STYLES */",
        await readFile(`${root}src/widget.css`, "utf8"),
      )
      .replace("/* WIDGET_SCRIPT */", () => code),
  );
}
await build({
  entryPoints: [`${root}src/worker.ts`],
  bundle: true,
  outfile: `${root}dist/worker.js`,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  loader: { ".html": "text", ".css": "text" },
  minify: false,
});

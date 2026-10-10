import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "app.js",
  write: false,
});
const script = result.outputFiles.find((file) =>
  file.path.endsWith(".js"),
)?.text;
if (!script) throw new Error("UI bundle missing.");
const style = await readFile("web/style.css", "utf8");
const template = await readFile("web/index.html", "utf8");
const html = template
  .replace(
    /<link\s+rel="stylesheet"\s+href="\.\/style\.css"\s*\/?>/,
    () => `<style>${style}</style>`,
  )
  .replace(
    /<script\s+type="module"\s+src="\.\/app\.ts"\s*>\s*<\/script>/,
    () =>
      `<script type="module">${script.replaceAll("</script", "<\\/script")}</script>`,
  );
await mkdir("dist/web", { recursive: true });
await writeFile("dist/web/index.html", html);
await mkdir("dist/guest", { recursive: true });
await writeFile(
  "dist/guest/index.html",
  html.replace(
    'name="basket-wise-mode" content="local"',
    'name="basket-wise-mode" content="guest"',
  ),
);
console.log(
  `Built self-contained basket view (${Buffer.byteLength(html)} bytes).`,
);

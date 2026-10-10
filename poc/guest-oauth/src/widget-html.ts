import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function buildWidget(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./widget.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const script = result.outputFiles[0]?.text;
  if (!script)
    throw new Error("Could not build the self-contained probe widget.");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guest OAuth probe</title><style>
    :root { color-scheme: light dark; font: 16px system-ui, sans-serif; }
    body { margin: 0; padding: 20px; } h1 { font-size: 1.2rem; } p { max-width: 48rem; }
    button { font: inherit; padding: 10px 14px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style></head><body><h1>Guest OAuth compatibility probe</h1><p>Synthetic identity only. No shopping data, account registration, or recovery. This is not the Basket Wise app.</p><button id="check" type="button" disabled>Check my guest identity</button><pre id="status" role="status" aria-live="polite">Connecting to the host bridge…</pre><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

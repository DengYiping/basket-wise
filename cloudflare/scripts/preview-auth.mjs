import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  authorizationPage,
  recoveryKeyPage,
  authorizationErrorPage,
  authAssetResponse,
} from "../src/auth-pages.ts";

// Presentation only: no OAuth, production settings, guest storage, or valid keys.
const styles = await readFile(
  new URL("../src/auth.css", import.meta.url),
  "utf8",
);
const context = { flow: "preview-only", csrf: "preview-only" };
const recovery =
  "PREVIEW-ONLY.NOT-A-VALID-KEY.abcdefghijklmnopqrstuvwxyz0123456789.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.preview-only";
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end("Preview only. No form actions or data are saved.");
    return;
  }
  const asset = authAssetResponse(new Request(url), styles);
  if (asset) {
    response.writeHead(asset.status, Object.fromEntries(asset.headers));
    response.end(Buffer.from(await asset.arrayBuffer()));
    return;
  }
  const html =
    url.pathname === "/saved" || url.pathname === "/recovered"
      ? recoveryKeyPage(
          { ...context, recovery, replacing: url.pathname === "/recovered" },
          true,
        )
      : url.pathname === "/error"
        ? authorizationErrorPage("invalid_request")
        : authorizationPage(context, true);
  response.writeHead(200, {
    "Content-Type": "text/html;charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
});
server.listen(0, "127.0.0.1", () => {
  console.log(
    `Local guest-access preview: http://127.0.0.1:${server.address().port}`,
  );
  console.log(
    "Use /saved and /recovered for sample key screens. No live credentials or saved data.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());

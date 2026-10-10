import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { widgetHarness } from "../tests/widget-harness.ts";

const html = widgetHarness(
  await readFile(new URL("../dist/widget.html", import.meta.url), "utf8"),
);
const server = createServer((request, response) => {
  response.writeHead(request.url === "/" ? 200 : 404, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' about:; connect-src 'none'",
  });
  response.end(request.url === "/" ? html : "Not found");
});
server.listen(0, "127.0.0.1", () => {
  console.log(
    `Local widget preview: http://127.0.0.1:${server.address().port}`,
  );
  console.log(
    "In-memory sample data only. No OAuth, persistence, or external requests.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());

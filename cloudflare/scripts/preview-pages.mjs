import { createServer } from "node:http";
import { publicPageResponse } from "../src/public-pages.ts";

// Local information-page preview only: no bindings, credentials, or guest data.
const server = createServer(async (request, response) => {
  try {
    const result = publicPageResponse(
      new Request(new URL(request.url ?? "/", "http://127.0.0.1"), {
        method: request.method,
      }),
      undefined,
      true,
    );
    if (!result) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(400);
    response.end("Invalid request");
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Local page preview: http://127.0.0.1:${server.address().port}`);
  console.log("Not published. No OAuth, guest storage, or external requests.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}

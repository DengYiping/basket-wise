import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createServer } from "./server.js";
import type { BasketStore } from "./store.js";

export function createHttpApp(
  store: BasketStore,
  options: { host: string; token?: string },
) {
  const { host, token } = options;
  if (
    !["127.0.0.1", "localhost", "::1"].includes(host) &&
    (!token || token.length < 32)
  ) {
    throw new Error(
      "A non-loopback bind requires BASKET_WISE_TOKEN with at least 32 characters. This server remains single-user; use TLS and proper OAuth before public hosting.",
    );
  }
  const app = createMcpExpressApp({ host });
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "basket-wise" });
  });
  app.use("/mcp", (req, res, next) => {
    if (token) {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    next();
  });
  app.post("/mcp", async (req, res) => {
    const server = createServer(store);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error("MCP request failed.");
      if (!res.headersSent)
        res.status(500).json({ error: "Internal server error" });
      await server.close();
    }
  });
  app.all("/mcp", (_req, res) => {
    res
      .set("Allow", "POST")
      .status(405)
      .json({ error: "Use POST for this stateless MCP endpoint." });
  });
  return app;
}

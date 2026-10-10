import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { BasketStore } from "./store.js";
import { createServer } from "./server.js";
import { createHttpApp } from "./http.js";

const store = new BasketStore(
  process.env.BASKET_WISE_DB ?? resolve("data/basket-wise.sqlite"),
);

if (process.argv.includes("--stdio")) {
  const server = createServer(store);
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await server.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.stdin.once("end", () => {
    void shutdown();
  });
} else {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  const token = process.env.BASKET_WISE_TOKEN;
  const app = createHttpApp(store, { host, ...(token ? { token } : {}) });
  const server = app.listen(port, host, () => {
    console.error(
      `Basket Wise MCP: http://${host}:${port}/mcp (single-user development server)`,
    );
  });
  server.on("error", (error) => {
    console.error(error.message);
    store.close();
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

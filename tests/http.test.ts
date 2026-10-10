import { once } from "node:events";
import { request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";
import { BasketStore } from "../src/store.js";

describe("HTTP development boundary", () => {
  let store: BasketStore;
  let server: Server | undefined;
  beforeEach(() => {
    store = new BasketStore(":memory:");
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    store.close();
  });

  async function listen(token?: string) {
    const app = createHttpApp(store, {
      host: "127.0.0.1",
      ...(token ? { token } : {}),
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("refuses unprotected non-loopback binding", () => {
    expect(() => createHttpApp(store, { host: "0.0.0.0" })).toThrow(
      "non-loopback",
    );
    expect(() =>
      createHttpApp(store, { host: "0.0.0.0", token: "short" }),
    ).toThrow("non-loopback");
  });
  it("has a health check but rejects cross-origin and rebinding requests", async () => {
    const url = await listen();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect(
      (
        await fetch(`${url}/health`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    // Use a raw request: browser-compatible fetch may replace the Host header.
    const reboundStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${url}/health`,
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(reboundStatus).toBe(403);
  });
  it("protects MCP when a development bearer token is configured", async () => {
    const url = await listen("a-test-token-that-is-longer-than-32-characters");
    expect(
      (
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/mcp`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/mcp`, {
          headers: {
            Authorization:
              "Bearer a-test-token-that-is-longer-than-32-characters",
          },
        })
      ).status,
    ).toBe(405);
  });
  it("negotiates a real MCP connection over HTTP", async () => {
    const url = await listen();
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { serverInfo: { name: "basket-wise" } },
    });
  });
});

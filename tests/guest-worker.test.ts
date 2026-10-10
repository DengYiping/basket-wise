import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import worker, { type GuestWorkerEnv } from "../src/worker.js";
import { emptyGuestState, MAX_GUEST_REQUEST_BYTES } from "../src/guest.js";

const env: GuestWorkerEnv = {
  ASSETS: {
    fetch: async () =>
      new Response(
        '<!doctype html><title>Basket Wise</title><meta name="basket-wise-mode" content="guest">',
      ),
  },
  GUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
async function connect() {
  const client = new Client({ name: "guest-worker-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://guest.example/mcp"), {
      fetch: async (input, init) => worker.fetch(new Request(input, init), env),
    }),
  );
  return client;
}

describe("Cloudflare guest Worker", () => {
  it("connects without credentials and exposes only stateless guest tools", async () => {
    const client = await connect();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "open_guest_basket",
      "guest_basket",
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool._meta?.securitySchemes).toEqual([{ type: "noauth" }]);
    }
    const opened = await client.callTool({
      name: "open_guest_basket",
      arguments: {},
    });
    expect(opened.structuredContent).toMatchObject({
      mode: "guest",
      state: emptyGuestState(),
      basket: null,
    });
    const resource = await client.readResource({
      uri: "ui://basket-wise/guest.html",
    });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
      text: expect.stringContaining('content="guest"'),
    });
  });
  it("calculates only a supplied snapshot and retains no basket between clients", async () => {
    const client = await connect();
    const started = await client.callTool({
      name: "guest_basket",
      arguments: {
        state: emptyGuestState(),
        action: {
          kind: "start_trip",
          operationId: "start-0001",
          currency: "JPY",
        },
      },
    });
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toMatchObject({
      basket: { currency: "JPY", currencyScale: 1 },
    });
    const other = await connect();
    const opened = await other.callTool({
      name: "open_guest_basket",
      arguments: {},
    });
    expect(opened.structuredContent).toMatchObject({ basket: null });
    await expect(
      other.callTool({ name: "list_trips", arguments: {} }),
    ).rejects.toThrow("not found");
  });
  it("requires the caller snapshot instead of looking up by an ID", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "guest_basket",
      arguments: {
        tripId: crypto.randomUUID(),
        action: { kind: "get_basket" },
      },
    });
    expect(result.isError).toBe(true);
  });
  it("rejects disallowed origins and supports only controlled preflight", async () => {
    expect(
      (
        await worker.fetch(
          new Request("https://guest.example/mcp", {
            method: "POST",
            headers: { Origin: "https://attacker.example" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const allowed = await worker.fetch(
      new Request("https://guest.example/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://chatgpt.com" },
      }),
      env,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://chatgpt.com",
    );
  });
  it("applies an abuse limit and fails closed when a public deployment omits it", async () => {
    const request = () =>
      new Request("https://guest.example/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    const limited = await worker.fetch(request(), {
      ...env,
      GUEST_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await worker.fetch(request(), { ASSETS: env.ASSETS })).status).toBe(
      503,
    );
  });
  it("bounds request bodies even without a Content-Length header", async () => {
    const result = await worker.fetch(
      new Request("https://guest.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ padding: "x".repeat(MAX_GUEST_REQUEST_BYTES) }),
      }),
      env,
    );
    expect(result.status).toBe(413);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
  it("does not expose other routes or stateful HTTP methods", async () => {
    for (const path of ["/data/basket-wise.sqlite", "/api/baskets", "/.env"])
      expect(
        (await worker.fetch(new Request(`https://guest.example${path}`), env))
          .status,
      ).toBe(404);
    expect(
      (await worker.fetch(new Request("https://guest.example/mcp"), env))
        .status,
    ).toBe(405);
    const health = await worker.fetch(
      new Request("https://guest.example/health"),
      env,
    );
    expect(await health.json()).toMatchObject({
      mode: "guest",
      persistence: "widget-only",
    });
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { BasketStore } from "../src/store.js";

describe("MCP plugin contract", () => {
  let store: BasketStore;
  let client: Client;
  let server: ReturnType<typeof createServer>;
  beforeEach(async () => {
    store = new BasketStore(":memory:");
    server = createServer(store, new URL("../web/index.html", import.meta.url));
    client = new Client({ name: "basket-wise-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    store.close();
  });

  it("discovers all tools with safe annotations and UI metadata", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    expect(
      tools.find((tool) => tool.name === "get_basket")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.find((tool) => tool.name === "add_item")?.annotations?.readOnlyHint,
    ).toBe(false);
    expect(
      tools.find((tool) => tool.name === "remove_item")?.annotations
        ?.destructiveHint,
    ).toBe(true);
    expect(tools.every((tool) => tool._meta?.ui)).toBe(true);
  });
  it("exposes an HTML MCP App resource", async () => {
    const resources = await client.listResources();
    expect(resources.resources[0]?.uri).toBe("ui://basket-wise/basket.html");
    const resource = await client.readResource({
      uri: "ui://basket-wise/basket.html",
    });
    expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.contents[0]).toHaveProperty(
      "text",
      expect.stringContaining("Basket Wise"),
    );
  });
  it("round-trips a shopping interaction and retains structured state", async () => {
    const started = await client.callTool({
      name: "start_trip",
      arguments: { operationId: "test-start" },
    });
    const { basket } = started.structuredContent as { basket: { id: string } };
    const result = await client.callTool({
      name: "add_item",
      arguments: {
        operationId: "test-add1",
        tripId: basket.id,
        name: "Tea",
        unitPriceCents: 1299,
        quantity: 2,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      basket: { totalCents: 2598 },
      newlyReachedThresholdsCents: [2500],
    });
  });
  it("rejects missing prices and unconfirmed dates at the protocol boundary", async () => {
    const trip = store.startTrip("test-start").basket;
    const missingPrice = await client.callTool({
      name: "add_item",
      arguments: { operationId: "test-add1", tripId: trip.id, name: "Tea" },
    });
    expect(missingPrice.isError).toBe(true);
    const unconfirmed = await client.callTool({
      name: "set_item_expiry",
      arguments: {
        operationId: "test-date1",
        tripId: trip.id,
        itemId: trip.id,
        expiry: {
          date: "2026-10-14",
          kind: "use_by",
          source: "photo",
          confirmed: false,
        },
      },
    });
    expect(unconfirmed.isError).toBe(true);
  });
});

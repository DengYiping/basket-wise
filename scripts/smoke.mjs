import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

const directory = await mkdtemp(join(tmpdir(), "basket-wise-smoke-"));
const client = new Client({ name: "basket-wise-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/main.js"), "--stdio"],
  env: {
    ...getDefaultEnvironment(),
    BASKET_WISE_DB: join(directory, "smoke.sqlite"),
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 11);
  const started = await client.callTool({
    name: "start_trip",
    arguments: {
      operationId: "smoke-start",
      store: "Any Supermarket",
      currency: "USD",
      thresholdsCents: [1500, 4200],
    },
  });
  assert.ok(!started.isError);
  assert.equal(started.structuredContent.basket.currency, "USD");
  assert.equal(started.structuredContent.basket.currencyScale, 100);
  const tripId = started.structuredContent.basket.id;
  const added = await client.callTool({
    name: "add_item",
    arguments: {
      operationId: "smoke-add-1",
      tripId,
      name: "Example item",
      unitPriceCents: 850,
      quantity: 2,
    },
  });
  assert.equal(added.structuredContent.basket.totalCents, 1700);
  assert.deepEqual(added.structuredContent.newlyReachedThresholdsCents, [1500]);
  const replay = await client.callTool({
    name: "add_item",
    arguments: {
      operationId: "smoke-add-1",
      tripId,
      name: "Example item",
      unitPriceCents: 850,
      quantity: 2,
    },
  });
  assert.equal(replay.structuredContent.basket.items.length, 1);
  const resource = await client.readResource({
    uri: "ui://basket-wise/basket.html",
  });
  assert.ok(resource.contents[0].text.includes('<script type="module">'));
  assert.ok(!resource.contents[0].text.includes('src="./app.ts"'));
  console.log(
    "Built stdio server: discovery, selected currency, custom store/milestones, totals, retry safety and bundled UI passed.",
  );
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}

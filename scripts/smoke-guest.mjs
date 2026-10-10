import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

// Exercise the actual workerd runtime, not just the Worker handler under Node.
const processHandle = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    "0",
    "--inspector-port",
    "0",
  ],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
const clients = [];
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Local Worker startup timed out.\n${output}`)),
      30_000,
    );
    const read = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    processHandle.stdout.on("data", read);
    processHandle.stderr.on("data", read);
    processHandle.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Local Worker exited (${code}).\n${output}`));
    });
  });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).persistence, "widget-only");
  const connect = async () => {
    const client = new Client({
      name: "basket-wise-workerd-smoke",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
    );
    return client;
  };
  const client = await connect();
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["open_guest_basket", "guest_basket"],
  );
  const resource = await client.readResource({
    uri: "ui://basket-wise/guest.html",
  });
  assert.ok(
    resource.contents[0].text.includes(
      'name="basket-wise-mode" content="guest"',
    ),
  );
  assert.ok(!resource.contents[0].text.includes('src="./app.ts"'));
  const opened = await client.callTool({
    name: "open_guest_basket",
    arguments: {},
  });
  const started = await client.callTool({
    name: "guest_basket",
    arguments: {
      state: opened.structuredContent.state,
      action: {
        kind: "start_trip",
        operationId: "workerd-start1",
        currency: "KWD",
        thresholdsCents: [2000, 5000],
      },
    },
  });
  assert.notEqual(started.isError, true, JSON.stringify(started.content));
  const action = {
    kind: "add_item",
    operationId: "workerd-add001",
    tripId: started.structuredContent.basket.id,
    name: "Apples",
    unitPriceCents: 3999,
    quantity: 0.5,
    unit: "kg",
  };
  const added = await client.callTool({
    name: "guest_basket",
    arguments: { state: started.structuredContent.state, action },
  });
  assert.notEqual(added.isError, true, JSON.stringify(added.content));
  assert.equal(added.structuredContent.basket.totalCents, 2000);
  assert.deepEqual(added.structuredContent.newlyReachedThresholdsCents, [2000]);
  const retry = await client.callTool({
    name: "guest_basket",
    arguments: { state: added.structuredContent.state, action },
  });
  assert.equal(retry.structuredContent.alreadyApplied, true);
  assert.equal(retry.structuredContent.basket.items.length, 1);
  const another = await connect();
  assert.equal(
    (await another.callTool({ name: "open_guest_basket", arguments: {} }))
      .structuredContent.basket,
    null,
  );
  console.log(
    "Cloudflare workerd: no-auth MCP, self-contained guest widget, chosen currency, exact rounding, retry safety and independent requests passed.",
  );
} finally {
  await Promise.all(
    clients.map((client) => client.close().catch(() => undefined)),
  );
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => {
    if (processHandle.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      resolve();
    }, 5000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

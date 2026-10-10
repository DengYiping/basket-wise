import { test } from "node:test";
import assert from "node:assert/strict";
import { BasketController, type Result } from "../src/controller.js";
test("only a real authorization challenge requests reconnect, and a valid result clears it", () => {
  const controller = new BasketController(
    {
      async callServerTool() {
        return {};
      },
    },
    () => {},
  );
  assert.equal(controller.authorizationRequired, false);
  controller.accept({
    isError: true,
    structuredContent: { error: "request_failed" },
  });
  assert.equal(controller.authorizationRequired, false);
  controller.accept({
    isError: true,
    _meta: { "mcp/www_authenticate": ["Bearer"] },
  });
  assert.equal(controller.authorizationRequired, true);
  assert.equal(controller.snapshot, undefined);
  controller.accept({
    structuredContent: {
      spaceId: "a",
      revision: 1,
      dataEpoch: "epoch-a",
      basket: null,
    },
  });
  assert.equal(controller.authorizationRequired, false);
});
test("widget never polls or stores credentials, and uncertain calls retain IDs", async () => {
  const calls: any[] = [],
    shown: string[] = [];
  let fail = false;
  const controller = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        if (fail) throw new Error("secret transport error");
        return {
          structuredContent: {
            dataEpoch: "epoch-a",
            spaceId: "a",
            revision: 0,
            basket: null,
          },
        };
      },
    },
    (text) => shown.push(text),
    () => "persistent-operation",
  );
  assert.equal(calls.length, 0);
  await controller.load();
  fail = true;
  await controller.start();
  await controller.start();
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(calls[0].name, "get_basket");
  assert.equal(calls[1].name, "start_trip");
  assert.equal(calls[1].arguments.operationId, "persistent-operation");
  assert.equal(calls[1].arguments.action, undefined);
  assert.ok(shown.every((s) => !s.includes("secret transport")));
});
test("widget ignores stale same-space results, accepts new spaces, and does not auto-retry conflicts", async () => {
  const calls: unknown[] = [];
  let response: Result = {
    isError: true,
    structuredContent: { error: "revision_conflict" },
  };
  const controller = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        return response;
      },
    },
    () => {},
  );
  controller.accept({
    structuredContent: {
      dataEpoch: "epoch-a",
      spaceId: "a",
      revision: 3,
      basket: { id: "trip-a" },
    },
  });
  controller.accept({
    structuredContent: {
      dataEpoch: "epoch-a",
      spaceId: "a",
      revision: 2,
      basket: { id: "stale" },
    },
  });
  assert.equal(controller.tripId, "trip-a");
  await controller.add("Milk", 200);
  assert.equal(calls.length, 1);
  assert.equal(controller.revision, undefined);
  response = {
    structuredContent: {
      dataEpoch: "epoch-b",
      spaceId: "b",
      revision: 0,
      basket: null,
    },
  };
  await controller.load();
  assert.equal(controller.spaceId, "b");
  assert.equal(controller.revision, 0);
});

test("cached expired and pre-generation snapshots cannot issue writes", async () => {
  const calls: unknown[] = [];
  const controller = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        return {};
      },
    },
    () => {},
  );
  controller.accept({
    structuredContent: {
      spaceId: "a",
      revision: 4,
      dataEpoch: "old",
      expiresAt: Date.now() - 1,
      basket: { id: "expired" },
    },
  });
  await controller.start();
  assert.equal(controller.snapshot, undefined);
  assert.equal(calls.length, 0);
  controller.accept({
    structuredContent: {
      spaceId: "a",
      revision: 4,
      basket: { id: "pre-upgrade" },
    },
  });
  await controller.add("Milk", 200);
  assert.equal(calls.length, 0);
});

test("widget sends the current epoch and discards pending writes after an expiry rejection", async () => {
  const calls: any[] = [];
  const controller = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        return { isError: true, structuredContent: { error: "data_expired" } };
      },
    },
    () => {},
  );
  controller.accept({
    structuredContent: {
      spaceId: "a",
      revision: 4,
      dataEpoch: "new",
      basket: { id: "trip" },
    },
  });
  await controller.add("Milk", 200);
  assert.equal(calls[0].arguments.dataEpoch, "new");
  assert.equal(controller.hasPending, false);
  assert.equal(controller.snapshot, undefined);
  await controller.add("Milk", 200);
  assert.equal(calls.length, 1);
});

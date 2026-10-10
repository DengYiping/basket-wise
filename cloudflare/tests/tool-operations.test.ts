import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup } from "./helpers.js";
import { BasketController } from "../src/controller.js";

let h: Awaited<ReturnType<typeof setup>>;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});
const value = (r: any) => {
  assert.equal(r.response.status, 200);
  assert.notEqual(r.payload.result?.isError, true, JSON.stringify(r.payload));
  return r.payload.result.structuredContent;
};

test("individual operation tools preserve revisions, receipts, and domain behavior", async () => {
  const guest = await h.connected();
  let revision = 0;
  const mutate = async (kind: string, fields: Record<string, unknown> = {}) => {
    const action = { kind, operationId: randomUUID(), ...fields };
    const originalRevision = revision;
    const result = value(
      await h.basket(guest.tokens.access_token, action, revision),
    );
    assert.equal(result.revision, ++revision);
    const retry = value(
      await h.basket(guest.tokens.access_token, action, originalRevision),
    );
    assert.equal(retry.alreadyApplied, true);
    assert.equal(retry.revision, revision);
    return result;
  };
  const started = await mutate("start_trip", {
    store: "Tool test",
    currency: "EUR",
  });
  const tripId = started.basket.id;
  const added = await mutate("add_item", {
    tripId,
    name: "Milk",
    unitPriceCents: 200,
  });
  const itemId = added.basket.items[0].id;
  const updated = await mutate("update_item", {
    tripId,
    itemId,
    patch: { unitPriceCents: 250 },
  });
  assert.equal(updated.basket.totalCents, 250);
  await mutate("set_thresholds", { tripId, thresholdsCents: [1000] });
  const extra = await mutate("add_item", {
    tripId,
    name: "Remove me",
    unitPriceCents: 100,
  });
  const removed = await mutate("remove_item", {
    tripId,
    itemId: extra.basket.items[1].id,
  });
  assert.equal(removed.basket.items.length, 1);
  const checkedOut = await mutate("checkout_trip", { tripId });
  assert.equal(checkedOut.basket.status, "checked_out");
  assert.equal(checkedOut.basket.totalCents, 250);
  for (const action of [
    { kind: "get_basket", tripId },
    { kind: "list_trips" },
  ]) {
    assert.equal(
      value(await h.basket(guest.tokens.access_token, action)).revision,
      revision,
    );
  }
});

test("all eighteen advertised tools enforce their own schemas and OAuth boundary", async () => {
  const id = randomUUID();
  const operationId = randomUUID();
  const valid: Record<string, Record<string, unknown>> = {
    get_shopping_list: { activityId: randomUUID() },
    open_shopping_list: { activityId: randomUUID() },
    add_shopping_list_item: {
      name: "Milk",
      operationId,
      expectedShoppingListRevision: 0,
    },
    update_shopping_list_item: {
      itemId: id,
      patch: { name: "Milk" },
      operationId,
      expectedShoppingListRevision: 0,
    },
    remove_shopping_list_item: {
      itemId: id,
      operationId,
      expectedShoppingListRevision: 0,
    },
    open_basket: { activityId: randomUUID() },
    get_basket: { activityId: randomUUID() },
    list_trips: { activityId: randomUUID() },
    suggest_removals: { activityId: randomUUID() },
    start_trip: { operationId, expectedRevision: 0 },
    add_item: {
      operationId,
      expectedRevision: 0,
      tripId: id,
      name: "Test",
      unitPriceCents: 1,
    },
    update_item: {
      operationId,
      expectedRevision: 0,
      tripId: id,
      itemId: id,
      patch: { name: "Test" },
    },
    remove_item: { operationId, expectedRevision: 0, tripId: id, itemId: id },
    set_thresholds: {
      operationId,
      expectedRevision: 0,
      tripId: id,
      thresholdsCents: [100],
    },
    checkout_trip: { operationId, expectedRevision: 0, tripId: id },
    delete_guest: { confirm: true },
  };
  valid.get_profile = {};
  valid.clear_baskets = {
    confirm: true,
    operationId,
    expectedRevision: 0,
    dataEpoch: id,
  };
  for (const args of Object.values(valid))
    if ("expectedRevision" in args) args.dataEpoch = id;
  for (const [name, args] of Object.entries(valid)) {
    const result = await h.rpc("tools/call", { name, arguments: args });
    assert.equal(result.payload.result.isError, true, name);
    assert.ok(result.payload.result._meta["mcp/www_authenticate"], name);
  }
  const guest = await h.connected();
  for (const [name, args] of [
    ["open_basket", {}],
    ["open_basket", { activityId: randomUUID(), tripId: id }],
    ["get_basket", {}],
    ["start_trip", { operationId }],
    [
      "get_basket",
      { activityId: randomUUID(), action: { kind: "delete_guest" } },
    ],
    ["get_basket", { activityId: randomUUID(), kind: "remove_item" }],
  ] as const) {
    const result = await h.rpc(
      "tools/call",
      { name, arguments: args },
      guest.tokens.access_token,
    );
    assert.ok(result.payload.error || result.payload.result?.isError, name);
  }
  assert.equal((await h.record(guest.locator)).revision, 0);
});

test("foreground read tools renew retention without revising baskets or extending retries", async () => {
  const guest = await h.connected();
  for (const kind of ["open_basket", "get_basket", "list_trips"]) {
    const original = await h.record(guest.locator);
    await h.setRecord(guest.locator, "meta", {
      ...original,
      expires: Date.now() + 60_000,
    });
    const args = { activityId: randomUUID() };
    value(
      await h.rpc(
        "tools/call",
        { name: kind, arguments: args },
        guest.tokens.access_token,
      ),
    );
    const renewed = await h.record(guest.locator);
    assert.ok(renewed.expires >= Date.now() + 90 * 86_400_000 - 1000, kind);
    assert.ok(renewed.basketExpires >= Date.now() + 86_399_000, kind);
    assert.equal(renewed.revision, original.revision, kind);
    value(
      await h.rpc(
        "tools/call",
        { name: kind, arguments: args },
        guest.tokens.access_token,
      ),
    );
    assert.equal(
      (await h.record(guest.locator)).expires,
      renewed.expires,
      kind,
    );
  }
});

test("explicit open returns the authorized current basket without a second widget read", async () => {
  const guest = await h.connected();
  const otherGuest = await h.connected();
  const empty = value(
    await h.rpc(
      "tools/call",
      {
        name: "open_basket",
        arguments: { activityId: randomUUID() },
      },
      guest.tokens.access_token,
    ),
  );
  assert.equal(empty.basket, null);
  assert.equal(empty.revision, 0);
  const started = value(
    await h.basket(
      guest.tokens.access_token,
      {
        kind: "start_trip",
        store: "Opened basket",
        currency: "EUR",
        operationId: randomUUID(),
      },
      0,
    ),
  );
  const added = value(
    await h.basket(
      guest.tokens.access_token,
      {
        kind: "add_item",
        tripId: started.basket.id,
        name: "Milk",
        unitPriceCents: 399,
        operationId: randomUUID(),
      },
      started.revision,
    ),
  );
  const args = { activityId: randomUUID() };
  const response = await h.rpc(
    "tools/call",
    { name: "open_basket", arguments: args },
    guest.tokens.access_token,
  );
  const opened = value(response);
  assert.equal(opened.basket.id, started.basket.id);
  assert.equal(opened.basket.totalCents, 399);
  assert.equal(opened.revision, added.revision);
  assert.equal(opened.dataEpoch, added.dataEpoch);
  const record = await h.record(guest.locator);
  const retry = value(
    await h.rpc(
      "tools/call",
      { name: "open_basket", arguments: args },
      guest.tokens.access_token,
    ),
  );
  assert.equal(opened.alreadyApplied, false);
  assert.deepEqual(retry, { ...opened, alreadyApplied: true });
  assert.equal(
    (await h.record(guest.locator)).basketExpires,
    record.basketExpires,
  );
  const calls: unknown[] = [];
  const widget = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        return {};
      },
    },
    () => {},
  );
  assert.equal(widget.accept(response.payload.result), true);
  assert.equal(widget.snapshot?.basket?.totalCents, 399);
  assert.equal(
    calls.length,
    0,
    "rendering an open result must not make another read",
  );
  const other = value(
    await h.rpc(
      "tools/call",
      { name: "open_basket", arguments: { activityId: randomUUID() } },
      otherGuest.tokens.access_token,
    ),
  );
  assert.equal(other.basket, null);
  assert.notEqual(other.spaceId, opened.spaceId);
  await h.setRecord(guest.locator, "meta", {
    ...record,
    basketExpires: Date.now() - 1000,
  });
  const expired = value(
    await h.rpc(
      "tools/call",
      { name: "open_basket", arguments: { activityId: randomUUID() } },
      guest.tokens.access_token,
    ),
  );
  assert.equal(
    expired.basket,
    null,
    "explicit open never reconstructs expired baskets",
  );
  assert.notEqual(expired.dataEpoch, opened.dataEpoch);
});

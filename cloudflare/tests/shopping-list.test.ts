import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup } from "./helpers.js";
import { DAY, PROFILE_TTL } from "../src/security.js";

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
const call = (
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) => h.rpc("tools/call", { name, arguments: args }, token);
const read = (token: string, activityId = randomUUID()) =>
  call(token, "get_shopping_list", { activityId });
const add = (token: string, revision = 0, name = "Milk") =>
  call(token, "add_shopping_list_item", {
    name,
    quantity: 2,
    unit: "each",
    expectedShoppingListRevision: revision,
    operationId: randomUUID(),
  });
const start = (token: string) =>
  h.basket(
    token,
    { kind: "start_trip", currency: "EUR", operationId: randomUUID() },
    0,
  );

test("profile list persists independently of 24-hour baskets and renews only the 90-day clock", async () => {
  const g = await h.connected();
  const trip = value(await start(g.tokens.access_token));
  const before = await h.record(g.locator);
  const list = value(await add(g.tokens.access_token));
  assert.equal(list.shoppingList.length, 1);
  assert.equal(list.shoppingListRevision, 1);
  const after = await h.record(g.locator);
  assert.equal(after.basketExpires, before.basketExpires);
  assert.equal(after.revision, trip.revision);
  assert.ok(Math.abs(after.expires - Date.now() - PROFILE_TTL) < 2000);
  await h.setRecord(g.locator, "meta", {
    ...after,
    basketExpires: Date.now() - 1,
  });
  await (await h.vault(g.locator)).collect();
  assert.equal((await h.record(g.locator)).basketExpires, null);
  await h.restart();
  assert.deepEqual(
    value(await read(g.tokens.access_token)).shoppingList,
    list.shoppingList,
  );
  assert.equal((await h.record(g.locator)).basketExpires, null);
  const empty = value(
    await h.basket(g.tokens.access_token, { kind: "get_basket" }),
  );
  assert.equal(empty.basket, null);
  value(
    await call(g.tokens.access_token, "clear_baskets", {
      confirm: true,
      operationId: randomUUID(),
      expectedRevision: empty.revision,
      dataEpoch: empty.dataEpoch,
    }),
  );
  assert.deepEqual(
    value(await read(g.tokens.access_token)).shoppingList,
    list.shoppingList,
  );
});

test("list create/edit/remove are persistent-idempotent, revision guarded and do not store duplicate snapshots", async () => {
  const g = await h.connected();
  const args = {
    name: "Milk",
    expectedShoppingListRevision: 0,
    operationId: randomUUID(),
  };
  const first = value(
    await call(g.tokens.access_token, "add_shopping_list_item", args),
  );
  const meta = await h.record(g.locator);
  await h.restart();
  assert.equal(
    value(await call(g.tokens.access_token, "add_shopping_list_item", args))
      .alreadyApplied,
    true,
  );
  assert.deepEqual(await h.record(g.locator), meta);
  assert.equal(
    (
      await call(g.tokens.access_token, "add_shopping_list_item", {
        ...args,
        name: "Changed",
      })
    ).payload.result.structuredContent.error,
    "operation_conflict",
  );
  assert.equal(
    (await add(g.tokens.access_token, 0)).payload.result.structuredContent
      .error,
    "shopping_list_conflict",
  );
  const id = first.itemId;
  const edited = value(
    await call(g.tokens.access_token, "update_shopping_list_item", {
      itemId: id,
      patch: { quantity: 0.5, unit: "kg" },
      expectedShoppingListRevision: 1,
      operationId: randomUUID(),
    }),
  );
  assert.equal(edited.shoppingList[0].name, "Milk");
  assert.equal(edited.shoppingList[0].quantity, 0.5);
  assert.equal(edited.shoppingList[0].unit, "kg");
  value(
    await call(g.tokens.access_token, "remove_shopping_list_item", {
      itemId: id,
      expectedShoppingListRevision: 2,
      operationId: randomUUID(),
    }),
  );
  const replay = value(
    await call(g.tokens.access_token, "add_shopping_list_item", args),
  );
  assert.equal(replay.shoppingList.length, 0);
  assert.equal(replay.shoppingListRevision, 3);
  const rows = await (
    await h.sql("GuestVault", g.locator)
  ).exec("SELECT key,value FROM documents WHERE key LIKE 'list-%'");
  assert.ok(
    !JSON.stringify(rows).includes("Milk"),
    "removed list content must not be retained in receipts",
  );
});

test("explicit reference consumes the list entry atomically, not matching names; removal never restores it", async () => {
  const g = await h.connected();
  const list = value(await add(g.tokens.access_token));
  let trip = value(await start(g.tokens.access_token));
  trip = value(
    await h.basket(
      g.tokens.access_token,
      {
        kind: "add_item",
        name: "Milk",
        unitPriceCents: 125,
        tripId: trip.basket.id,
        operationId: randomUUID(),
      },
      trip.revision,
    ),
  );
  assert.equal(
    value(await read(g.tokens.access_token)).shoppingList.length,
    1,
    "name match alone cannot consume",
  );
  const action = {
    kind: "add_item",
    name: "Milk",
    quantity: 2,
    unitPriceCents: 125,
    tripId: trip.basket.id,
    shoppingListItemId: list.itemId,
    expectedShoppingListRevision: list.shoppingListRevision,
    operationId: randomUUID(),
  };
  const added = value(
    await h.basket(g.tokens.access_token, action, trip.revision),
  );
  assert.equal(added.basket.totalCents, 375);
  assert.equal(added.consumedShoppingListItemId, list.itemId);
  assert.equal(added.shoppingListRevision, 2);
  assert.equal(value(await read(g.tokens.access_token)).shoppingList.length, 0);
  await h.restart();
  assert.equal(
    value(await h.basket(g.tokens.access_token, action, trip.revision))
      .alreadyApplied,
    true,
  );
  const removed = value(
    await h.basket(
      g.tokens.access_token,
      {
        kind: "remove_item",
        tripId: trip.basket.id,
        itemId: added.basket.items[1].id,
        operationId: randomUUID(),
      },
      added.revision,
    ),
  );
  assert.equal(removed.basket.items.length, 1);
  assert.equal(value(await read(g.tokens.access_token)).shoppingList.length, 0);
});

test("stale/missing references, checked-out trips and failed SQLite commits never consume entries or add items", async () => {
  const g = await h.connected();
  const list = value(await add(g.tokens.access_token));
  const trip = value(await start(g.tokens.access_token));
  const action = {
    kind: "add_item",
    name: "Milk",
    unitPriceCents: 125,
    tripId: trip.basket.id,
    shoppingListItemId: list.itemId,
    expectedShoppingListRevision: 1,
    operationId: randomUUID(),
  };
  for (const patch of [
    { expectedShoppingListRevision: 0 },
    { shoppingListItemId: randomUUID() },
  ]) {
    const result = await h.basket(
      g.tokens.access_token,
      { ...action, ...patch },
      trip.revision,
    );
    assert.equal(result.payload.result.isError, true);
  }
  const sql = await h.sql("GuestVault", g.locator);
  await sql.exec(
    "CREATE TRIGGER reject_consume BEFORE INSERT ON documents WHEN NEW.key LIKE 'operation/%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  assert.equal(
    (await h.basket(g.tokens.access_token, action, trip.revision)).payload
      .result.isError,
    true,
  );
  assert.equal(
    (await h.record(g.locator, `trip/${trip.basket.id}`)).items.length,
    0,
  );
  assert.ok(await h.record(g.locator, `list-item/${list.itemId}`));
  assert.equal((await h.record(g.locator)).shoppingListRevision, 1);
  await sql.exec("DROP TRIGGER reject_consume");
  const checked = value(
    await h.basket(
      g.tokens.access_token,
      {
        kind: "checkout_trip",
        tripId: trip.basket.id,
        operationId: randomUUID(),
      },
      trip.revision,
    ),
  );
  assert.equal(
    (await h.basket(g.tokens.access_token, action, checked.revision)).payload
      .result.isError,
    true,
  );
  assert.ok(await h.record(g.locator, `list-item/${list.itemId}`));
});

test("concurrent trip additions can consume a list entry only once", async () => {
  const g = await h.connected();
  const list = value(await add(g.tokens.access_token));
  const trip = value(await start(g.tokens.access_token));
  const action = {
    kind: "add_item",
    name: "Milk",
    unitPriceCents: 125,
    tripId: trip.basket.id,
    shoppingListItemId: list.itemId,
    expectedShoppingListRevision: 1,
  };
  const results = await Promise.all(
    [1, 2].map(() =>
      h.basket(
        g.tokens.access_token,
        { ...action, operationId: randomUUID() },
        trip.revision,
      ),
    ),
  );
  assert.equal(results.filter((r) => !r.payload.result.isError).length, 1);
  assert.equal(
    (await h.record(g.locator, `trip/${trip.basket.id}`)).items.length,
    1,
  );
  assert.equal(value(await read(g.tokens.access_token)).shoppingList.length, 0);
});

test("list activity retries do not extend retention and empty/other/expired guests cannot access it", async () => {
  const g = await h.connected(),
    other = await h.connected();
  value(await add(g.tokens.access_token));
  const activityId = randomUUID();
  value(await read(g.tokens.access_token, activityId));
  const meta = await h.record(g.locator);
  const old = { ...meta, expires: Date.now() + DAY };
  await h.setRecord(g.locator, "meta", old);
  value(await read(g.tokens.access_token, activityId));
  assert.deepEqual(await h.record(g.locator), old);
  assert.equal(
    value(await read(other.tokens.access_token)).shoppingList.length,
    0,
  );
  assert.equal((await read("")).payload.result.isError, true);
  await h.setRecord(g.locator, "meta", { ...old, expires: Date.now() - 1 });
  assert.equal((await read(g.tokens.access_token)).response.status, 401);
  await (await h.vault(g.locator)).collect();
  assert.equal(await h.record(g.locator), undefined);
});

test("recovery retains list identity and deletion erases it", async () => {
  const g = await h.connected();
  const list = value(await add(g.tokens.access_token));
  const meta = await h.record(g.locator);
  const recovered = await h.enroll(g.recovery);
  const tokens = (await (
    await h.exchange(recovered.code, recovered.verifier)
  ).json()) as any;
  assert.equal((await h.record(g.locator)).expires, meta.expires);
  const restored = value(await read(tokens.access_token));
  assert.equal(restored.spaceId, list.spaceId);
  assert.deepEqual(restored.shoppingList, list.shoppingList);
  assert.equal((await read(g.tokens.access_token)).response.status, 401);
  value(await call(tokens.access_token, "delete_guest", { confirm: true }));
  assert.equal(await h.record(g.locator), undefined);
});

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
const value = (response: any) => {
  assert.equal(response.response.status, 200);
  assert.notEqual(
    response.payload.result?.isError,
    true,
    JSON.stringify(response.payload),
  );
  return response.payload.result.structuredContent;
};
async function basket() {
  const guest = await h.connected();
  let result = value(
    await h.basket(
      guest.tokens.access_token,
      {
        kind: "start_trip",
        operationId: randomUUID(),
        thresholdConfig: { mode: "unlimited", amountCents: 2500 },
      },
      0,
    ),
  );
  for (const amount of [5000, 2500, 500])
    result = value(
      await h.basket(
        guest.tokens.access_token,
        {
          kind: "add_item",
          operationId: randomUUID(),
          tripId: result.basket.id,
          name: `Item ${amount}`,
          unitPriceCents: amount,
        },
        result.revision,
      ),
    );
  return { guest, result };
}

test("new threshold policy persists across item edits and runtime restart; receipts stay idempotent", async () => {
  const { guest, result } = await basket();
  assert.equal(result.basket.thresholdStatus.highestReachedCents, 7500);
  const action = {
    kind: "set_thresholds",
    operationId: randomUUID(),
    tripId: result.basket.id,
    thresholdConfig: {
      mode: "static",
      entries: [{ amountCents: 5000, count: 2 }],
    },
  };
  const saved = value(
    await h.basket(guest.tokens.access_token, action, result.revision),
  );
  assert.equal(saved.basket.thresholdStatus.highestReachedCents, 5000);
  assert.equal(saved.basket.thresholdStatus.nextThresholdCents, 10000);
  await h.restart();
  const retry = value(
    await h.basket(guest.tokens.access_token, action, result.revision),
  );
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.revision, saved.revision);
  assert.deepEqual(retry.basket.thresholdConfig, action.thresholdConfig);
  const changed = value(
    await h.basket(
      guest.tokens.access_token,
      {
        kind: "update_item",
        operationId: randomUUID(),
        tripId: saved.basket.id,
        itemId: saved.basket.items[0].id,
        patch: { name: "Renamed" },
      },
      saved.revision,
    ),
  );
  assert.deepEqual(changed.basket.thresholdConfig, action.thresholdConfig);
  const conflict = await h.basket(
    guest.tokens.access_token,
    {
      ...action,
      thresholdConfig: { mode: "unlimited", amountCents: 1000 },
    },
    changed.revision,
  );
  assert.equal(
    conflict.payload.result.structuredContent.error,
    "operation_conflict",
  );
});

test("removal advice is protected, read-only shopping data, and same-activity retries do not renew retention", async () => {
  const { guest, result } = await basket();
  const before = await h.record(guest.locator);
  const activity = randomUUID();
  const action = { kind: "suggest_removals", tripId: result.basket.id };
  const advice = value(
    await h.basket(guest.tokens.access_token, action, undefined, activity),
  );
  assert.equal(advice.removalSuggestion.targetCents, 7500);
  assert.equal(advice.removalSuggestion.savingsCents, 500);
  assert.equal(advice.basket.items.length, 3);
  assert.equal(advice.revision, result.revision);
  const after = await h.record(guest.locator);
  assert.ok(after.expires >= before.expires);
  assert.ok(after.basketExpires >= before.basketExpires);
  value(await h.basket(guest.tokens.access_token, action, undefined, activity));
  assert.equal((await h.record(guest.locator)).expires, after.expires);
  const other = await h.connected();
  assert.equal(
    (await h.basket(other.tokens.access_token, action)).payload.result
      .structuredContent.error,
    "trip_not_found",
  );
  const anonymous = await h.basket("", action);
  assert.ok(anonymous.payload.result._meta["mcp/www_authenticate"]);
});

test("invalid advice/configuration and failed receipt writes leave data and activity unchanged", async () => {
  const { guest, result } = await basket();
  const before = await h.record(guest.locator);
  for (const action of [
    { kind: "suggest_removals", tripId: result.basket.id, targetCents: 10000 },
    {
      kind: "suggest_removals",
      tripId: result.basket.id,
      keepItemIds: [randomUUID()],
    },
    {
      kind: "set_thresholds",
      operationId: randomUUID(),
      tripId: result.basket.id,
      thresholdsCents: [2500],
      thresholdConfig: { mode: "unlimited", amountCents: 5000 },
    },
    {
      kind: "set_thresholds",
      operationId: randomUUID(),
      tripId: result.basket.id,
      thresholdConfig: {
        mode: "static",
        entries: [{ amountCents: 5000, count: 21 }],
      },
    },
  ]) {
    const response = await h.basket(
      guest.tokens.access_token,
      action,
      result.revision,
    );
    assert.ok(response.payload.error || response.payload.result?.isError);
    assert.deepEqual(await h.record(guest.locator), before);
  }
  const sql = await h.sql("GuestVault", guest.locator);
  await sql.exec(
    "CREATE TRIGGER reject_threshold BEFORE INSERT ON documents WHEN NEW.key LIKE 'operation/%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const failed = await h.basket(
    guest.tokens.access_token,
    {
      kind: "set_thresholds",
      operationId: randomUUID(),
      tripId: result.basket.id,
      thresholdConfig: { mode: "unlimited", amountCents: 5000 },
    },
    result.revision,
  );
  assert.equal(failed.payload.result.isError, true);
  assert.deepEqual(await h.record(guest.locator), before);
  const stored = await h.record(guest.locator, `trip/${result.basket.id}`);
  assert.equal(stored.thresholdConfig.amountCents, 2500);
});

test("widget controller and chat RPC use identical authorized threshold tools", async () => {
  const { guest, result } = await basket();
  const calls: any[] = [];
  const controller = new BasketController(
    {
      async callServerTool(input) {
        calls.push(input);
        return (await h.rpc("tools/call", input, guest.tokens.access_token))
          .payload.result;
      },
    },
    () => {},
  );
  controller.accept({ structuredContent: result });
  await controller.setThresholds({
    mode: "static",
    entries: [{ amountCents: 5000, count: 1 }],
  });
  assert.equal(calls[0].arguments.dataEpoch, result.dataEpoch);
  assert.equal(calls[0].arguments.expectedRevision, result.revision);
  await controller.suggestRemovals();
  assert.equal(calls[1].name, "suggest_removals");
  assert.ok(calls[1].arguments.activityId);
  assert.equal(calls[1].arguments.expectedRevision, undefined);
  const fromWidget = controller.snapshot!.removalSuggestion;
  const fromChat = value(
    await h.basket(guest.tokens.access_token, {
      kind: "suggest_removals",
      tripId: result.basket.id,
    }),
  ).removalSuggestion;
  assert.deepEqual(fromWidget, fromChat);
  assert.equal(fromChat.savingsCents, 3000);
  assert.equal(
    value(await h.basket(guest.tokens.access_token, { kind: "get_basket" }))
      .basket.items.length,
    3,
  );
});

test("expired baskets cannot supply stale threshold advice and a profile may start fresh", async () => {
  const { guest, result } = await basket();
  const meta = await h.record(guest.locator);
  await h.setRecord(guest.locator, "meta", {
    ...meta,
    basketExpires: Date.now() - 1,
  });
  const expired = await h.basket(guest.tokens.access_token, {
    kind: "suggest_removals",
    tripId: result.basket.id,
  });
  assert.equal(
    expired.payload.result.structuredContent.error,
    "trip_not_found",
  );
  assert.equal(
    await h.record(guest.locator, `trip/${result.basket.id}`),
    undefined,
  );
  const fresh = value(
    await h.basket(guest.tokens.access_token, { kind: "get_basket" }),
  );
  assert.equal(fresh.basket, null);
  const started = value(
    await h.basket(
      guest.tokens.access_token,
      {
        kind: "start_trip",
        operationId: randomUUID(),
        thresholdConfig: { mode: "unlimited", amountCents: 5000 },
      },
      fresh.revision,
    ),
  );
  assert.equal(started.basket.thresholdConfig.amountCents, 5000);
});

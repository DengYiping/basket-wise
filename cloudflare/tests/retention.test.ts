import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, ORIGIN, secret, digest } from "./helpers.js";
import { DAY, PROFILE_TTL, LEGACY_PROFILE_CUTOFF } from "../src/security.js";

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
const start = () => ({
  kind: "start_trip",
  operationId: randomUUID(),
  store: "private-retention-sentinel",
  currency: "EUR",
});
const profile = (token: string) =>
  h.rpc("tools/call", { name: "get_profile", arguments: {} }, token);
const refresh = (token: string) =>
  h.post("/token", {
    grant_type: "refresh_token",
    refresh_token: token,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  });

test("24-hour purge keeps the authenticated profile and removes all shopping snapshots", async () => {
  const g = await h.connected();
  const created = value(await h.basket(g.tokens.access_token, start(), 0));
  const originalProfile = value(await profile(g.tokens.access_token));
  const meta = await h.record(g.locator);
  assert.ok(Math.abs(meta.expires - Date.now() - PROFILE_TTL) < 2000);
  assert.ok(Math.abs(meta.basketExpires - Date.now() - DAY) < 2000);
  await h.setRecord(g.locator, "meta", {
    ...meta,
    basketExpires: Date.now() - 1,
  });
  assert.deepEqual(
    value(await profile(g.tokens.access_token)),
    originalProfile,
  );
  const after = await h.record(g.locator);
  assert.equal(after.expires, meta.expires);
  assert.equal(after.basketExpires, null);
  assert.equal(after.revision, created.revision + 1);
  assert.notEqual(after.dataEpoch, created.dataEpoch);
  const rows = await (
    await h.sql("GuestVault", g.locator)
  ).exec("SELECT key,value FROM documents");
  assert.ok(!JSON.stringify(rows).includes("private-retention-sentinel"));
  assert.ok(
    rows.every((r: any) => !/^(trip|activity|operation)\//.test(r.key)),
  );
  assert.ok(rows.some((r: any) => r.key.startsWith("replay/")));
  const rotated = await refresh(g.tokens.refresh_token);
  assert.equal(rotated.status, 200);
  const token = ((await rotated.json()) as any).access_token;
  const empty = value(await h.basket(token, { kind: "get_basket" }));
  assert.equal(empty.basket, null);
  assert.equal(empty.spaceId, originalProfile.id);
  assert.ok(empty.lastBasketExpiredAt);
  const fresh = value(await h.basket(token, start(), empty.revision));
  assert.equal(fresh.revision, empty.revision + 1);
});

test("old mutation epoch and repeated reads cannot resurrect data or renew either deadline", async () => {
  const g = await h.connected(),
    action = start(),
    activityId = randomUUID();
  const created = value(await h.basket(g.tokens.access_token, action, 0));
  value(
    await h.basket(
      g.tokens.access_token,
      { kind: "get_basket" },
      undefined,
      activityId,
    ),
  );
  const meta = await h.record(g.locator);
  await h.setRecord(g.locator, "meta", {
    ...meta,
    basketExpires: Date.now() - 1,
  });
  await (await h.vault(g.locator)).collect();
  const cutoff = await h.record(g.locator);
  const replay = value(
    await h.basket(
      g.tokens.access_token,
      { kind: "get_basket" },
      undefined,
      activityId,
    ),
  );
  assert.equal(replay.basket, null);
  assert.equal(replay.alreadyApplied, true);
  assert.deepEqual(await h.record(g.locator), cutoff);
  for (const operationId of [action.operationId, randomUUID()]) {
    const stale = await h.rpc(
      "tools/call",
      {
        name: "start_trip",
        arguments: {
          ...action,
          kind: undefined,
          operationId,
          expectedRevision: created.revision,
          dataEpoch: created.dataEpoch,
        },
      },
      g.tokens.access_token,
    );
    assert.equal(stale.payload.result.structuredContent.error, "data_expired");
  }
  assert.deepEqual(await h.record(g.locator), cutoff);
});

test("profile lookup, OAuth refresh and recovery do not extend clocks; recovery retains empty identity", async () => {
  const g = await h.connected();
  value(await h.basket(g.tokens.access_token, start(), 0));
  const meta = await h.record(g.locator);
  await h.setRecord(g.locator, "meta", {
    ...meta,
    basketExpires: Date.now() - 1,
  });
  const id = value(await profile(g.tokens.access_token)).id;
  const before = await h.record(g.locator);
  await h.rpc("tools/list", {}, g.tokens.access_token);
  const rotated = await refresh(g.tokens.refresh_token);
  assert.equal(rotated.status, 200);
  assert.deepEqual(await h.record(g.locator), before);
  const recovered = await h.enroll(g.recovery);
  const tokens = (await (
    await h.exchange(recovered.code, recovered.verifier)
  ).json()) as any;
  assert.equal(value(await profile(tokens.access_token)).id, id);
  const after = await h.record(g.locator);
  assert.equal(after.expires, before.expires);
  assert.equal(after.basketExpires, null);
  assert.equal(
    (await h.rpc("tools/list", {}, g.tokens.access_token)).response.status,
    401,
  );
  assert.equal(
    value(await h.basket(tokens.access_token, { kind: "get_basket" })).basket,
    null,
  );
});

test("clear baskets is atomic, persistent-idempotent and does not delete profile or newer baskets", async () => {
  const g = await h.connected();
  const created = value(await h.basket(g.tokens.access_token, start(), 0));
  const args = {
    confirm: true,
    operationId: randomUUID(),
    expectedRevision: created.revision,
    dataEpoch: created.dataEpoch,
  };
  const clear = () =>
    h.rpc(
      "tools/call",
      { name: "clear_baskets", arguments: args },
      g.tokens.access_token,
    );
  const cleared = value(await clear());
  assert.equal(cleared.basket, null);
  assert.notEqual(cleared.dataEpoch, created.dataEpoch);
  assert.equal(value(await profile(g.tokens.access_token)).id, created.spaceId);
  const fresh = value(
    await h.basket(g.tokens.access_token, start(), cleared.revision),
  );
  await h.restart();
  assert.equal(value(await clear()).alreadyApplied, true);
  assert.equal(
    value(await h.basket(g.tokens.access_token, { kind: "get_basket" })).basket
      .id,
    fresh.basket.id,
  );
  const conflict = await h.rpc(
    "tools/call",
    {
      name: "clear_baskets",
      arguments: { ...args, expectedRevision: fresh.revision },
    },
    g.tokens.access_token,
  );
  assert.equal(
    conflict.payload.result.structuredContent.error,
    "operation_conflict",
  );
});

test("90-day profile boundary rejects token, refresh and recovery before GC and never resurrects", async () => {
  const g = await h.connected();
  const meta = await h.record(g.locator);
  const r = await h.record(
    g.locator,
    `refresh/${digest(g.tokens.refresh_token)}`,
  );
  assert.equal(r.expires, meta.expires);
  await h.setRecord(g.locator, "meta", { ...meta, expires: Date.now() });
  assert.equal((await profile(g.tokens.access_token)).response.status, 401);
  assert.notEqual((await refresh(g.tokens.refresh_token)).status, 200);
  const vault = await h.vault(g.locator);
  await assert.rejects(vault.checkRecovery(digest(g.recovery)));
  assert.equal(await vault.collect(), null);
  assert.equal(await h.record(g.locator), undefined);
  assert.equal((await profile(g.tokens.access_token)).response.status, 401);
  assert.equal(await h.record(g.locator), undefined);
});

test("legacy live guests migrate without extending basket expiry or changing profile identity", async () => {
  const g = await h.connected();
  const created = value(await h.basket(g.tokens.access_token, start(), 0));
  const meta = await h.record(g.locator);
  const { schemaVersion, basketExpires, dataEpoch, ...legacy } = meta;
  legacy.expires = Date.now() + 60_000;
  await h.setRecord(g.locator, "meta", legacy);
  assert.equal(value(await profile(g.tokens.access_token)).id, created.spaceId);
  const migrated = await h.record(g.locator);
  assert.equal(migrated.basketExpires, legacy.expires);
  assert.equal(migrated.expires, legacy.expires - DAY + PROFILE_TTL);
  assert.equal(migrated.revision, created.revision);
  assert.equal(
    value(await h.basket(g.tokens.access_token, { kind: "get_basket" })).basket
      .id,
    created.basket.id,
  );
});

test("legacy profiles alive at rollout survive next-day access; pre-rollout expired profiles do not", async () => {
  for (const eligible of [true, false]) {
    const g = await h.connected();
    value(await h.basket(g.tokens.access_token, start(), 0));
    const { schemaVersion, basketExpires, dataEpoch, ...legacy } =
      await h.record(g.locator);
    legacy.expires = LEGACY_PROFILE_CUTOFF + (eligible ? 1 : -1);
    await h.setRecord(g.locator, "meta", legacy);
    const result = await profile(g.tokens.access_token);
    if (eligible) {
      assert.equal(value(result).id, legacy.label);
      assert.equal((await h.record(g.locator)).basketExpires, null);
      assert.ok((await h.record(g.locator)).revision > legacy.revision);
    } else {
      assert.equal(result.response.status, 401);
      assert.equal(await (await h.vault(g.locator)).collect(), null);
      assert.equal(await h.record(g.locator), undefined);
    }
  }
});

test("profile tool publishes the authenticated stable identity contract and no private fields", async () => {
  const tools = (await h.rpc("tools/list")).payload.result.tools;
  const t = tools.find((t: any) => t.name === "get_profile");
  assert.equal(t._meta["openai/profile"], true);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.deepEqual(t.outputSchema.required, ["id"]);
  assert.equal(t.outputSchema.additionalProperties, false);
  const a = await h.connected(),
    b = await h.connected();
  const result = await profile(a.tokens.access_token);
  const p = value(result);
  assert.deepEqual(Object.keys(p), ["id"]);
  assert.deepEqual(JSON.parse(result.payload.result.content[0].text), p);
  assert.notEqual(p.id, value(await profile(b.tokens.access_token)).id);
  assert.notEqual((await profile("")).payload.result.isError, false);
});

test("a failed clear transaction keeps all baskets, revision, epoch and deadlines", async () => {
  const g = await h.connected();
  const created = value(await h.basket(g.tokens.access_token, start(), 0));
  const before = await h.record(g.locator);
  const sql = await h.sql("GuestVault", g.locator);
  await sql.exec(
    "CREATE TRIGGER reject_clear BEFORE INSERT ON documents WHEN NEW.key LIKE 'control/%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const args = {
    confirm: true,
    operationId: randomUUID(),
    expectedRevision: created.revision,
    dataEpoch: created.dataEpoch,
  };
  const result = await h.rpc(
    "tools/call",
    { name: "clear_baskets", arguments: args },
    g.tokens.access_token,
  );
  assert.equal(result.payload.result.isError, true);
  assert.deepEqual(await h.record(g.locator), before);
  assert.equal(
    (await h.record(g.locator, `trip/${created.basket.id}`)).id,
    created.basket.id,
  );
  await sql.exec("DROP TRIGGER reject_clear");
  assert.equal(
    value(
      await h.rpc(
        "tools/call",
        { name: "clear_baskets", arguments: args },
        g.tokens.access_token,
      ),
    ).basket,
    null,
  );
});

test("concurrent collection and old writes cannot restore the previous generation", async () => {
  const g = await h.connected();
  const created = value(await h.basket(g.tokens.access_token, start(), 0));
  const before = await h.record(g.locator);
  await h.setRecord(g.locator, "meta", {
    ...before,
    basketExpires: Date.now() - 1,
  });
  const stale = {
    operationId: randomUUID(),
    expectedRevision: created.revision,
    dataEpoch: created.dataEpoch,
    currency: "EUR",
  };
  const [_, a, b] = await Promise.all([
    (await h.vault(g.locator)).collect(),
    h.rpc(
      "tools/call",
      { name: "start_trip", arguments: stale },
      g.tokens.access_token,
    ),
    h.rpc(
      "tools/call",
      { name: "start_trip", arguments: stale },
      g.tokens.access_token,
    ),
  ]);
  for (const result of [a, b])
    assert.equal(result.payload.result.structuredContent.error, "data_expired");
  const after = await h.record(g.locator);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.basketExpires, null);
  assert.equal(after.expires, before.expires);
});

test("legacy refresh migrates once and remains bounded by the inactive-profile limit", async () => {
  const g = await h.connected();
  const { schemaVersion, dataEpoch, basketExpires, ...legacy } = await h.record(
    g.locator,
  );
  legacy.expires = Date.now() + DAY;
  await h.setRecord(g.locator, "meta", legacy);
  const key = `refresh/${digest(g.tokens.refresh_token)}`;
  const oldRefresh = await h.record(g.locator, key);
  await h.setRecord(g.locator, key, {
    ...oldRefresh,
    expires: Date.now() + 30 * DAY,
  });
  value(await profile(g.tokens.access_token));
  const migrated = await h.record(g.locator, key);
  assert.equal(migrated.expires, (await h.record(g.locator)).expires);
  value(await profile(g.tokens.access_token));
  assert.deepEqual(await h.record(g.locator, key), migrated);
  const next = await refresh(g.tokens.refresh_token);
  assert.equal(next.status, 200);
  const tokens = (await next.json()) as any;
  const issued = await h.record(
    g.locator,
    `refresh/${digest(tokens.refresh_token)}`,
  );
  assert.equal(issued.expires, (await h.record(g.locator)).expires);
});

test("alarm and cleanup sweep purge only basket data at its cutoff", async () => {
  for (const mechanism of ["alarm", "sweep"]) {
    const g = await h.connected();
    value(await h.basket(g.tokens.access_token, start(), 0));
    const meta = await h.record(g.locator);
    const cutoff = Date.now() + (mechanism === "alarm" ? 300 : -1);
    await h.setRecord(g.locator, "meta", { ...meta, basketExpires: cutoff });
    if (mechanism === "alarm") {
      assert.equal(await (await h.vault(g.locator)).collect(), cutoff);
      // Real workerd alarm, not a direct invocation of the reserved alarm RPC.
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await h.record(g.locator)).basketExpires === null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } else {
      const ns = (await h.mf.getDurableObjectNamespace("CLEANUP")) as any;
      const index = ns.getByName(`gc-${g.locator[0]}`);
      await index.track("vault", g.locator, Date.now() - 1);
      await index.sweep();
    }
    const after = await h.record(g.locator);
    assert.equal(after.basketExpires, null);
    assert.equal(after.expires, meta.expires);
    assert.equal(value(await profile(g.tokens.access_token)).id, meta.label);
  }
});

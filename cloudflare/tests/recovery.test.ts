import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup } from "./helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h?.close();
});

async function prepare(recovery: string) {
  const f = await h.begin();
  const response = await h.post(
    "/authorize",
    {
      flow: f.flow,
      csrf: f.csrf,
      decision: "recover",
      recovery,
    },
    f.cookie,
  );
  assert.equal(response.status, 200);
  const replacement = (await response.text()).match(/<pre>([^<]+)<\/pre>/)![1]!;
  return { ...f, replacement };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
const acknowledge = (f: Prepared) =>
  h.post(
    "/continue",
    {
      flow: f.flow,
      csrf: f.csrf,
      saved: "yes",
    },
    f.cookie,
  );
async function expireFlow(f: Prepared) {
  const locator = f.flow.split(".")[2]!;
  const sql = await h.sql("AuthorizationFlow", locator);
  const rows = await sql.exec("SELECT value FROM documents WHERE key = 'meta'");
  const state = JSON.parse(rows[0]!.value as string);
  await sql.exec(
    "UPDATE documents SET value = ? WHERE key = 'meta'",
    JSON.stringify({ ...state, expires: Date.now() - 1 }),
  );
  const namespace: any = await h.mf.getDurableObjectNamespace("FLOWS");
  assert.equal(await namespace.getByName(locator).collect(), null);
}
async function rows(locator: string) {
  return (await h.sql("GuestVault", locator)).exec(
    "SELECT key,value FROM documents ORDER BY key",
  );
}
async function access(token: string) {
  return (await h.rpc("tools/list", {}, token)).response.status;
}

test("unacknowledged recovery is read-only and preserves the original key and connection", async () => {
  const g = await h.connected();
  const original = await rows(g.locator);
  const f = await prepare(g.recovery);
  assert.deepEqual(await rows(g.locator), original);
  assert.equal(await access(g.tokens.access_token), 200);
  assert.notEqual(f.replacement, g.recovery);
  const unactivated = await h.begin();
  assert.ok(
    (
      await h.post(
        "/authorize",
        {
          flow: unactivated.flow,
          csrf: unactivated.csrf,
          decision: "recover",
          recovery: f.replacement,
        },
        unactivated.cookie,
      )
    ).status >= 400,
  );
  for (const params of [
    { flow: f.flow, csrf: f.csrf },
    { flow: f.flow, csrf: "wrong", saved: "yes" },
  ])
    assert.ok((await h.post("/continue", params, f.cookie)).status >= 400);
  assert.ok(
    (
      await h.post(
        "/continue",
        {
          flow: f.flow,
          csrf: f.csrf,
          saved: "yes",
        },
        "bw-flow=wrong",
      )
    ).status >= 400,
  );
  assert.deepEqual(await rows(g.locator), original);
});

test("lost recovery page plus flow expiry and restart cannot lock out the original guest", async () => {
  const g = await h.connected();
  await h.basket(
    g.tokens.access_token,
    {
      kind: "start_trip",
      operationId: randomUUID(),
      store: "Recovery test",
      currency: "EUR",
    },
    0,
  );
  const original = await rows(g.locator);
  const f = await prepare(g.recovery); // Discard the replacement as if its page was lost.
  await expireFlow(f);
  await h.restart();
  assert.deepEqual(await rows(g.locator), original);
  assert.equal(await access(g.tokens.access_token), 200);
  assert.ok((await acknowledge(f)).status >= 400);
  const recovered = await h.enroll(g.recovery);
  assert.equal(recovered.locator, g.locator);
  assert.equal(
    (await h.record(g.locator)).expires,
    JSON.parse(original.find((row) => row.key === "meta")!.value as string)
      .expires,
  );
  assert.equal(
    (await h.exchange(recovered.code, recovered.verifier)).status,
    200,
  );
});

test("concurrent prepared recoveries commit exactly one key rotation at acknowledgement", async () => {
  const g = await h.connected();
  const original = await h.record(g.locator);
  const prepared = await Promise.all([
    prepare(g.recovery),
    prepare(g.recovery),
  ]);
  const responses = await Promise.all(prepared.map(acknowledge));
  assert.equal(
    responses.filter((response) => response.status === 303).length,
    1,
  );
  const winningIndex = responses.findIndex(
    (response) => response.status === 303,
  );
  const winner = prepared[winningIndex]!;
  const loser = prepared[1 - winningIndex]!;
  const location = responses[winningIndex]!.headers.get("location")!;
  assert.equal(await access(g.tokens.access_token), 401);
  assert.equal((await h.record(g.locator)).expires, original.expires);
  assert.equal((await h.record(g.locator)).revision, original.revision);
  assert.equal((await acknowledge(winner)).headers.get("location"), location);
  assert.ok((await acknowledge(loser)).status >= 400);
  const exchanged = await h.exchange(
    new URL(location).searchParams.get("code")!,
    winner.verifier,
  );
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as any;
  assert.equal(await access(tokens.access_token), 200);
  assert.ok((await acknowledge(loser)).status >= 400);
  assert.equal(await access(tokens.access_token), 200);
});

test("lost acknowledgement response retries persistently and the saved key survives flow expiry", async () => {
  const g = await h.connected();
  const f = await prepare(g.recovery);
  const first = await acknowledge(f);
  assert.equal(first.status, 303);
  const original = await rows(g.locator);
  await h.restart();
  const retried = await acknowledge(f);
  assert.equal(retried.status, 303);
  assert.equal(retried.headers.get("location"), first.headers.get("location"));
  assert.deepEqual(await rows(g.locator), original);
  assert.equal(await access(g.tokens.access_token), 401);
  await expireFlow(f);
  const recovered = await h.enroll(f.replacement);
  assert.equal(recovered.locator, g.locator);
  assert.equal(
    (await h.exchange(recovered.code, recovered.verifier)).status,
    200,
  );
});

test("an expired and collected guest cannot be revived by a prepared recovery", async () => {
  const g = await h.connected();
  const f = await prepare(g.recovery);
  const meta = await h.record(g.locator);
  await h.setRecord(g.locator, "meta", { ...meta, expires: Date.now() - 1 });
  assert.equal(await (await h.vault(g.locator)).collect(), null);
  assert.ok((await acknowledge(f)).status >= 400);
  const tables = await (
    await h.sql("GuestVault", g.locator)
  ).exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
  );
  assert.deepEqual(tables, []);
});

test("an old acknowledged recovery cannot reactivate a grant after a later recovery", async () => {
  const g = await h.connected();
  const first = await prepare(g.recovery);
  assert.equal((await acknowledge(first)).status, 303);
  const next = await h.enroll(first.replacement);
  const exchanged = await h.exchange(next.code, next.verifier);
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as any;
  assert.ok((await acknowledge(first)).status >= 400);
  assert.equal(await access(tokens.access_token), 200);
});

test("failure during recovery code activation rolls back the entire takeover", async () => {
  const g = await h.connected();
  const f = await prepare(g.recovery);
  const original = await rows(g.locator);
  const sql = await h.sql("GuestVault", g.locator);
  await sql.exec(
    "CREATE TRIGGER reject_activation BEFORE INSERT ON documents WHEN NEW.key LIKE 'code/%' AND json_extract(NEW.value, '$.activated') = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  assert.ok((await acknowledge(f)).status >= 400);
  assert.deepEqual(await rows(g.locator), original);
  assert.equal(await access(g.tokens.access_token), 200);
  await sql.exec("DROP TRIGGER reject_activation");
  const response = await acknowledge(f);
  assert.equal(response.status, 303);
  assert.equal(await access(g.tokens.access_token), 401);
  const code = new URL(response.headers.get("location")!).searchParams.get(
    "code",
  )!;
  assert.equal((await h.exchange(code, f.verifier)).status, 200);
});

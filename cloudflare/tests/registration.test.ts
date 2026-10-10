import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { setup, DCR_CALLBACK, ORIGIN, digest, secret } from "./helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
before(async () => {
  h = await setup({ dcr: "true" });
});
after(async () => {
  await h.close();
});
const metadata = (method = "client_secret_post") => ({
  client_name: "ChatGPT verification",
  redirect_uris: [DCR_CALLBACK],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: method,
});
const register = (body: unknown = metadata(), key?: string, target = h) =>
  target.request("/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
async function client(method = "client_secret_post") {
  const response = await register(metadata(method));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as any;
}
const tokenParams = (c: any, enrollment: any) => ({
  client_id: c.client_id,
  client_secret: c.client_secret,
  grant_type: "authorization_code",
  code: enrollment.code,
  code_verifier: enrollment.verifier,
  redirect_uri: DCR_CALLBACK,
  resource: `${ORIGIN}/mcp`,
});

test("DCR is opt-in and discovery advertises only an enabled registration endpoint", async () => {
  const disabled = await setup();
  try {
    assert.equal((await register(metadata(), undefined, disabled)).status, 404);
    const off = (await (
      await disabled.request("/.well-known/oauth-authorization-server")
    ).json()) as any;
    assert.equal(off.registration_endpoint, undefined);
    assert.equal(
      (
        (await (
          await h.request("/.well-known/oauth-authorization-server")
        ).json()) as any
      ).registration_endpoint,
      `${ORIGIN}/register`,
    );
  } finally {
    await disabled.close();
  }
});

test("registration rejects redirect escalation, public clients, foreign scopes and unsupported metadata", async () => {
  for (const body of [
    null,
    [],
    {},
    { ...metadata(), redirect_uris: ["https://evil.example/callback"] },
    {
      ...metadata(),
      redirect_uris: [DCR_CALLBACK, "https://evil.example/callback"],
    },
    { ...metadata(), redirect_uris: [DCR_CALLBACK + "?x=1"] },
    { ...metadata(), redirect_uris: ["https://chatgpt.com/*"] },
    { ...metadata(), token_endpoint_auth_method: "none" },
    { ...metadata(), grant_types: ["client_credentials"] },
    { ...metadata(), response_types: ["token"] },
    { ...metadata(), scope: "admin" },
    { ...metadata(), client_name: "x".repeat(129) },
    { ...metadata(), jwks_uri: "https://evil.example/key" },
  ])
    assert.equal((await register(body)).status, 400, JSON.stringify(body));
  assert.equal((await h.request("/register", { method: "GET" })).status, 404);
  assert.equal(
    (
      await h.request("/register?x=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata()),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(4097),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await h.request("/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify(metadata()),
      })
    ).status,
    403,
  );
});

test("registration is confidential, persistent and idempotent with a bounded request receipt", async () => {
  const key = randomUUID();
  const [a, b] = await Promise.all([
    register(metadata(), key),
    register(metadata(), key),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const first = (await a.json()) as any;
  assert.deepEqual(await b.json(), first);
  assert.match(first.client_id, /^bw-dcr-[a-f0-9]{32}$/);
  assert.match(first.client_secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.client_secret, secret);
  assert.equal(first.client_secret_expires_at, 0);
  assert.equal(a.headers.get("cache-control"), "no-store");
  const sql = await h.sql("OAuthClients", "chatgpt");
  const stored = JSON.stringify(
    await sql.exec("SELECT key,value FROM documents"),
  );
  assert.ok(!stored.includes(first.client_secret));
  assert.ok(!stored.includes(key));
  assert.ok(stored.includes(digest(first.client_secret)));
  await h.restart();
  assert.deepEqual(await (await register(metadata(), key)).json(), first);
  assert.equal(
    (await register({ ...metadata(), client_name: "different" }, key)).status,
    409,
  );
  const independent = await client();
  assert.notEqual(independent.client_id, first.client_id);
  assert.notEqual(independent.client_secret, first.client_secret);
});

test("code and refresh exchange bind to the authenticated client before consumption or replay revocation", async () => {
  const a = await client(),
    b = await client();
  const enrolled = await h.enroll(undefined, a.client_id, DCR_CALLBACK);
  const params = tokenParams(a, enrolled);
  assert.equal(
    (
      await h.post("/token", {
        ...params,
        client_id: b.client_id,
        client_secret: b.client_secret,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.post("/token", {
        ...params,
        client_id: "basket-test",
        client_secret: secret,
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.post("/token", { ...params, client_secret: b.client_secret }))
      .status,
    401,
  );
  assert.equal(
    (await h.record(enrolled.locator, `code/${digest(enrolled.code)}`)).used,
    false,
  );
  const response = await h.post("/token", params);
  assert.equal(response.status, 200);
  const tokens = (await response.json()) as any;
  const deadline = (await h.record(enrolled.locator)).expires;
  const refresh = {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    resource: `${ORIGIN}/mcp`,
  };
  assert.equal(
    (
      await h.post("/token", {
        ...refresh,
        client_id: b.client_id,
        client_secret: b.client_secret,
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.basket(tokens.access_token, { kind: "get_basket" })).response
      .status,
    200,
  );
  const beforeRefresh = (await h.record(enrolled.locator)).expires;
  assert.equal(
    (
      await h.post("/token", {
        ...refresh,
        client_id: a.client_id,
        client_secret: a.client_secret,
      })
    ).status,
    200,
  );
  assert.equal((await h.record(enrolled.locator)).expires, beforeRefresh);
  assert.ok(beforeRefresh >= deadline);
  // Even replay of an already-used code by another client cannot revoke A.
  assert.equal(
    (
      await h.post("/token", {
        ...params,
        client_id: b.client_id,
        client_secret: b.client_secret,
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.rpc("tools/list", {}, tokens.access_token)).response.status,
    200,
  );
});

test("Basic clients must use their registered auth method, never a mixed-secret request", async () => {
  const a = await client("client_secret_basic");
  const g = await h.enroll(undefined, a.client_id, DCR_CALLBACK);
  const params = tokenParams(a, g);
  assert.equal((await h.post("/token", params)).status, 401);
  const { client_secret: _, ...withoutSecret } = params;
  const request = (form: Record<string, string>) =>
    h.request("/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${a.client_id}:${a.client_secret}`).toString("base64")}`,
      },
      body: new URLSearchParams(form).toString(),
    });
  assert.equal(
    (await request({ ...withoutSecret, client_secret: "" })).status,
    401,
  );
  assert.equal((await request(withoutSecret)).status, 200);
});

test("recovery into a different registered client preserves trips and expiry and revokes old grants", async () => {
  const a = await client(),
    b = await client();
  const g = await h.enroll(undefined, a.client_id, DCR_CALLBACK);
  const old = (await (await h.post("/token", tokenParams(a, g))).json()) as any;
  const started = await h.basket(
    old.access_token,
    {
      kind: "start_trip",
      operationId: randomUUID(),
      store: "DCR test",
      currency: "EUR",
    },
    0,
  );
  assert.equal(started.payload.result.isError, undefined);
  const before = await h.record(g.locator);
  const next = await h.enroll(g.recovery, b.client_id, DCR_CALLBACK);
  assert.equal((await h.record(g.locator)).expires, before.expires);
  assert.equal(
    (await h.rpc("tools/list", {}, old.access_token)).response.status,
    401,
  );
  const tokens = (await (
    await h.post("/token", tokenParams(b, next))
  ).json()) as any;
  const read = await h.basket(tokens.access_token, { kind: "get_basket" });
  assert.equal(read.payload.result.structuredContent.basket.store, "DCR test");
  await h.setRecord(g.locator, "meta", {
    ...(await h.record(g.locator)),
    expires: Date.now() - 1,
  });
  assert.equal(
    (await h.basket(tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
  );
});

test("legacy client deadlines no longer break existing ChatGPT connections", async () => {
  const a = await client();
  const g = await h.enroll(undefined, a.client_id, DCR_CALLBACK);
  const tokens = (await (
    await h.post("/token", tokenParams(a, g))
  ).json()) as any;
  const registry = await h.sql("OAuthClients", "chatgpt");
  const rows = await registry.exec(
    "SELECT value FROM documents WHERE key=?",
    `client/${a.client_id}`,
  );
  const record = JSON.parse(rows[0]!.value as string);
  await registry.exec(
    "UPDATE documents SET value=? WHERE key=?",
    JSON.stringify({ ...record, expires: Date.now() - 1 }),
    `client/${a.client_id}`,
  );
  assert.equal(
    (
      await h.post("/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: `${ORIGIN}/mcp`,
        client_id: a.client_id,
        client_secret: a.client_secret,
      })
    ).status,
    200,
  );
  const params = new URLSearchParams({
    client_id: a.client_id,
    response_type: "code",
    redirect_uri: DCR_CALLBACK,
    state: "test",
    code_challenge: digest("verifier"),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
    scope: "basket:manage",
  });
  assert.equal((await h.request(`/authorize?${params}`)).status, 200);
  // Legacy copied client deadlines must not revoke a still-valid profile.
  const access = await h.record(
    g.locator,
    `access/${digest(tokens.access_token)}`,
  );
  const grantKey = `grant/${access.grant}`;
  await h.setRecord(g.locator, grantKey, {
    ...(await h.record(g.locator, grantKey)),
    clientExpiresAt: Date.now() - 1,
  });
  assert.equal(
    (await h.rpc("tools/list", {}, tokens.access_token)).response.status,
    200,
  );
  const ns = (await h.mf.getDurableObjectNamespace("CLIENTS")) as any;
  await ns.getByName("chatgpt").collect();
  assert.equal(
    (
      await registry.exec(
        "SELECT key FROM documents WHERE key=?",
        `client/${a.client_id}`,
      )
    ).length,
    1,
  );
});

test("global registration capacity is atomic and quota cannot be bypassed with concurrency", async () => {
  const bounded = await setup({ dcr: "true" });
  try {
    const replies = await Promise.all(
      Array.from({ length: 34 }, () =>
        register(metadata(), undefined, bounded),
      ),
    );
    assert.equal(replies.filter((r) => r.status === 201).length, 32);
    assert.equal(replies.filter((r) => r.status === 429).length, 2);
    const sql = await bounded.sql("OAuthClients", "chatgpt");
    assert.equal(
      (await sql.exec("SELECT key FROM documents WHERE key LIKE 'client/%'"))
        .length,
      32,
    );
  } finally {
    await bounded.close();
  }
});

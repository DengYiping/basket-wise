import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { setup, ORIGIN, CALLBACK, secret, digest } from "./helpers.js";
let h: Awaited<ReturnType<typeof setup>>;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});
const start = () => ({
  kind: "start_trip",
  operationId: randomUUID(),
  store: "Dunnes",
  currency: "EUR",
});
const value = (r: any) => {
  assert.equal(r.response.status, 200);
  assert.notEqual(r.payload.result?.isError, true, JSON.stringify(r.payload));
  return r.payload.result.structuredContent;
};

test("the real MCP SDK initializes and invokes the same OAuth-protected tools", async () => {
  const g = await h.connected();
  const client = new Client({
    name: "local-production-adapter-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${ORIGIN}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${g.tokens.access_token}` },
      },
      fetch: async (input, init) =>
        h.request(
          new URL(input instanceof Request ? input.url : String(input))
            .pathname,
          init,
        ),
    },
  );
  try {
    await client.connect(transport);
    assert.ok(
      (await client.listTools()).tools.some((t) => t.name === "start_trip"),
    );
    const created = await client.callTool({
      name: "start_trip",
      arguments: {
        operationId: randomUUID(),
        store: "Dunnes",
        currency: "EUR",
        expectedRevision: 0,
        dataEpoch: (await h.record(g.locator)).dataEpoch,
      },
    });
    assert.notEqual(created.isError, true);
    const read = await client.callTool({
      name: "get_basket",
      arguments: { activityId: randomUUID() },
    });
    assert.equal(
      (read.structuredContent as any).basket.id,
      (created.structuredContent as any).basket.id,
    );
  } finally {
    await client.close();
  }
});

test("real workerd discovery, top-level OAuth schemes and self-contained widget", async () => {
  const health = (await (await h.request("/health")).json()) as any;
  assert.equal(health.enrollmentEnabled, true);
  assert.equal(health.version, "0.5.0");
  const meta = (await (
    await h.request("/.well-known/oauth-authorization-server")
  ).json()) as any;
  assert.equal(meta.issuer, ORIGIN);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const tools = (await h.rpc("tools/list")).payload.result.tools;
  assert.deepEqual(
    tools.find((t: any) => t.name === "get_basket").securitySchemes,
    [{ type: "oauth2", scopes: ["basket:manage"] }],
  );
  assert.equal(
    tools.find((t: any) => t.name === "delete_guest").annotations
      .destructiveHint,
    true,
  );
  const denied = await h.basket("", { kind: "get_basket" });
  assert.ok(denied.payload.result._meta["mcp/www_authenticate"]);
  const html = (
    await h.rpc("resources/read", {
      uri: "ui://basket-wise-durable/v0.4.2/basket.html",
    })
  ).payload.result.contents[0].text;
  assert.match(html, /24 hours/);
  assert.match(html, /callServerTool/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|setInterval\(/);
});

test("current and cached widget resource pointers resolve to the same protected-tool UI", async () => {
  const canonical = "ui://basket-wise-durable/v0.5.0/basket.html";
  const tools = (await h.rpc("tools/list")).payload.result.tools;
  for (const tool of tools) {
    if (
      ["get_profile", "get_basket", "list_trips", "get_shopping_list"].includes(
        tool.name,
      )
    ) {
      assert.equal(
        tool._meta.ui,
        undefined,
        "identity lookup must not spawn an empty basket widget",
      );
      if (tool.name === "get_profile")
        assert.equal(tool._meta["openai/profile"], true);
    } else
      assert.equal(
        tool._meta.ui.resourceUri,
        tool.name.includes("shopping_list")
          ? "ui://basket-wise-durable/v0.5.0/shopping-list.html"
          : canonical,
      );
  }
  let currentHtml: string | undefined;
  for (const version of [
    "0.5.0",
    "0.4.2",
    "0.4.1",
    "0.4.0",
    "0.3.0",
    "0.2.0",
    "0.1.8",
    "0.1.6",
    "0.1.5",
  ]) {
    const uri = `ui://basket-wise-durable/v${version}/basket.html`;
    const response = await h.rpc("resources/read", { uri });
    assert.equal(response.payload.error, undefined);
    const content = response.payload.result.contents[0];
    assert.equal(content.uri, uri);
    assert.match(content.mimeType, /^text\/html/);
    assert.deepEqual(content._meta.ui.csp, {
      connectDomains: [],
      resourceDomains: [],
    });
    assert.match(content.text, /class="brand"/);
    assert.match(content.text, /--bw-bg: #f7f7f0/);
    if (currentHtml) assert.equal(content.text, currentHtml);
    currentHtml = content.text;
  }
  const unknown = await h.rpc("resources/read", {
    uri: "ui://basket-wise-durable/v0.0.0/basket.html",
  });
  assert.equal(unknown.payload.error.code, -32602);
});

test("each operation is discoverable with a flat strict schema and accurate annotations", async () => {
  const tools = (await h.rpc("tools/list")).payload.result.tools;
  const reads = [
    "open_basket",
    "get_basket",
    "list_trips",
    "suggest_removals",
    "open_shopping_list",
    "get_shopping_list",
  ];
  const additions = ["start_trip", "add_item"];
  const edits = [
    "update_item",
    "remove_item",
    "set_thresholds",

    "checkout_trip",
  ];
  assert.deepEqual(
    tools.map((t: any) => t.name).sort(),
    [
      "get_profile",
      "clear_baskets",
      ...reads,
      ...additions,
      ...edits,
      "delete_guest",
      "add_shopping_list_item",
      "update_shopping_list_item",
      "remove_shopping_list_item",
    ].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.inputSchema.properties.action, undefined, tool.name);
    assert.equal(tool.inputSchema.properties.kind, undefined, tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
    assert.equal(tool.annotations.idempotentHint, true, tool.name);
    assert.equal(
      tool.annotations.readOnlyHint,
      tool.name === "get_profile",
      tool.name,
    );
    assert.equal(
      tool.annotations.destructiveHint,
      [
        "delete_guest",
        "clear_baskets",
        "add_item",
        "update_shopping_list_item",
        "remove_shopping_list_item",
      ].includes(tool.name) || edits.includes(tool.name),
      tool.name,
    );
    assert.deepEqual(
      tool.securitySchemes,
      [{ type: "oauth2", scopes: ["basket:manage"] }],
      tool.name,
    );
    if (reads.includes(tool.name)) {
      assert.ok(tool.inputSchema.required.includes("activityId"), tool.name);
      assert.equal(tool.inputSchema.properties.expectedRevision, undefined);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
    if (additions.includes(tool.name) || edits.includes(tool.name)) {
      assert.ok(tool.inputSchema.required.includes("operationId"), tool.name);
      assert.ok(
        tool.inputSchema.required.includes("expectedRevision"),
        tool.name,
      );
    }
  }
  const legacy = await h.rpc("tools/call", {
    name: "basket",
    arguments: { action: { kind: "get_basket" } },
  });
  assert.ok(legacy.payload.error || legacy.payload.result?.isError);
});

test("consent binds CSRF/browser, requires saving recovery and preserves OAuth state", async () => {
  const f = await h.begin();
  assert.equal(
    (
      await h.post(
        "/authorize",
        { flow: f.flow, csrf: "wrong", decision: "new" },
        f.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.post(
        "/authorize",
        { flow: f.flow, csrf: f.csrf, decision: "new" },
        "bw-flow=wrong",
      )
    ).status,
    400,
  );
  const approved = await h.post(
    "/authorize",
    { flow: f.flow, csrf: f.csrf, decision: "new" },
    f.cookie,
  );
  assert.equal(approved.status, 200);
  assert.equal(
    (await h.post("/continue", { flow: f.flow, csrf: f.csrf }, f.cookie))
      .status,
    400,
  );
  assert.equal(
    (
      await h.post(
        "/continue",
        { flow: f.flow, csrf: f.csrf, saved: "yes" },
        f.cookie,
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await h.post(
        "/authorize",
        { flow: f.flow, csrf: f.csrf, decision: "deny" },
        f.cookie,
      )
    ).status,
    400,
  );
});

test("OAuth CSP permits its registered callback without relaxing other responses", async () => {
  const strict =
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  const callbackPolicy = strict.replace(
    "form-action 'self'",
    `form-action 'self' ${new URL(CALLBACK).origin}`,
  );
  const params = new URLSearchParams({
    client_id: "basket-test",
    response_type: "code",
    redirect_uri: CALLBACK,
    state: randomUUID(),
    code_challenge: digest(randomUUID()),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
    scope: "basket:manage",
  });
  const consent = await h.request(`/authorize?${params}`);
  const pagePolicy = `${callbackPolicy}; style-src 'self'; img-src 'self'`;
  assert.equal(consent.headers.get("content-security-policy"), pagePolicy);
  assert.equal(consent.headers.get("referrer-policy"), "same-origin");
  const f = await h.begin();
  const approved = await h.post(
    "/authorize",
    { flow: f.flow, csrf: f.csrf, decision: "new" },
    f.cookie,
  );
  assert.equal(approved.headers.get("content-security-policy"), pagePolicy);
  assert.equal(approved.headers.get("referrer-policy"), "same-origin");
  const continued = await h.post(
    "/continue",
    { flow: f.flow, csrf: f.csrf, saved: "yes" },
    f.cookie,
  );
  assert.equal(
    continued.headers.get("content-security-policy"),
    callbackPolicy,
  );
  assert.equal(continued.headers.get("referrer-policy"), "same-origin");
  const deniedFlow = await h.begin();
  const denied = await h.post(
    "/authorize",
    { flow: deniedFlow.flow, csrf: deniedFlow.csrf, decision: "deny" },
    deniedFlow.cookie,
  );
  assert.equal(denied.headers.get("content-security-policy"), callbackPolicy);
  assert.equal(denied.headers.get("referrer-policy"), "same-origin");
  for (const path of [
    "/",
    "/health",
    "/.well-known/oauth-authorization-server",
  ]) {
    assert.equal(
      (await h.request(path)).headers.get("content-security-policy"),
      strict,
    );
    assert.equal(
      (await h.request(path)).headers.get("referrer-policy"),
      "no-referrer",
    );
  }
  params.set("redirect_uri", "https://unregistered.example/callback");
  const rejected = await h.request(`/authorize?${params}`);
  assert.notEqual(rejected.status, 200);
  assert.equal(rejected.headers.get("content-security-policy"), strict);
});

test("code exchange requires PKCE, exact resource/client/redirect and consumes once", async () => {
  const g = await h.enroll();
  assert.equal((await h.exchange(g.code, digest("wrong"))).status, 400);
  const common = {
    grant_type: "authorization_code",
    code: g.code,
    code_verifier: g.verifier,
    redirect_uri: CALLBACK,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  };
  for (const change of [
    { client_secret: "bad" },
    { resource: "https://evil.example/mcp" },
    { redirect_uri: "https://evil.example/callback" },
  ])
    assert.notEqual(
      (await h.post("/token", { ...common, ...change })).status,
      200,
    );
  const good = await h.exchange(g.code, g.verifier);
  assert.equal(good.status, 200);
  const tokens = (await good.json()) as any;
  assert.equal((await h.exchange(g.code, g.verifier)).status, 400);
  assert.equal(
    (await h.basket(tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
    "code reuse revokes the grant",
  );
});

test("guest isolation, multiple trips, exact rounding and both call paths", async () => {
  const a = await h.connected(),
    b = await h.connected();
  const created = value(await h.basket(a.tokens.access_token, start(), 0));
  const action = {
    kind: "add_item",
    operationId: randomUUID(),
    tripId: created.basket.id,
    name: "Apples",
    unitPriceCents: 3999,
    quantity: 0.5,
    unit: "kg",
  };
  // Identical RPC surface used by model tools/call and the widget's host bridge.
  const added = value(
    await h.rpc(
      "tools/call",
      {
        name: "add_item",
        arguments: {
          operationId: action.operationId,
          tripId: action.tripId,
          name: action.name,
          unitPriceCents: action.unitPriceCents,
          quantity: action.quantity,
          unit: action.unit,
          expectedRevision: 1,
          dataEpoch: created.dataEpoch,
        },
      },
      a.tokens.access_token,
    ),
  );
  assert.equal(added.basket.totalCents, 2000);
  const read = value(
    await h.basket(a.tokens.access_token, {
      kind: "get_basket",
      tripId: created.basket.id,
    }),
  );
  assert.equal(read.basket.totalCents, 2000);
  assert.equal(
    (
      await h.basket(b.tokens.access_token, {
        kind: "get_basket",
        tripId: created.basket.id,
      })
    ).payload.result.isError,
    true,
  );
  assert.equal(
    (await h.basket(b.tokens.access_token, action, 0)).payload.result.isError,
    true,
  );
  value(await h.basket(a.tokens.access_token, start(), 2));
  assert.equal(
    value(await h.basket(a.tokens.access_token, { kind: "list_trips" })).trips
      .length,
    2,
  );
  assert.equal(
    value(await h.basket(b.tokens.access_token, { kind: "list_trips" })).trips
      .length,
    0,
  );
  const injected = await h.rpc(
    "tools/call",
    {
      name: "get_basket",
      arguments: {
        ownerId: a.locator,
        activityId: randomUUID(),
      },
    },
    b.tokens.access_token,
  );
  assert.ok(injected.payload.error || injected.payload.result?.isError);
});

test("persistent receipts survive restart and concurrent requests commit once", async () => {
  const g = await h.connected(),
    action = start();
  const [a, b] = await Promise.all([
    h.basket(g.tokens.access_token, action, 0),
    h.basket(g.tokens.access_token, action, 0),
  ]);
  assert.equal(value(a).basket.id, value(b).basket.id);
  assert.equal((await h.record(g.locator)).revision, 1);
  await h.restart();
  assert.equal(
    value(await h.basket(g.tokens.access_token, action, 0)).alreadyApplied,
    true,
  );
  const c = await h.basket(
    g.tokens.access_token,
    { ...action, store: "Changed" },
    1,
  );
  assert.equal(c.payload.result.isError, true);
  const [d, e] = await Promise.all([
    h.basket(g.tokens.access_token, start(), 1),
    h.basket(g.tokens.access_token, start(), 1),
  ]);
  assert.equal([d, e].filter((r) => r.payload.result?.isError).length, 1);
  assert.equal((await h.record(g.locator)).revision, 2);
});

test("24-hour inactivity resets only on new successful foreground actions", async () => {
  const g = await h.connected(),
    before = await h.record(g.locator);
  assert.ok(Math.abs(before.expires - before.created - 90 * 86400000) < 100);
  const shrunk = Date.now() + 60_000;
  await h.setRecord(g.locator, "meta", { ...before, expires: shrunk });
  await h.rpc("tools/list", {}, g.tokens.access_token);
  assert.equal((await h.record(g.locator)).expires, shrunk);
  const refresh = await h.post("/token", {
    grant_type: "refresh_token",
    refresh_token: g.tokens.refresh_token,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  });
  assert.equal(refresh.status, 200);
  assert.equal((await h.record(g.locator)).expires, shrunk);
  const readId = randomUUID();
  value(
    await h.basket(
      g.tokens.access_token,
      { kind: "get_basket" },
      undefined,
      readId,
    ),
  );
  const extended = (await h.record(g.locator)).expires;
  assert.ok(extended >= Date.now() + 90 * 86400000 - 1000);
  assert.ok((await h.record(g.locator)).basketExpires >= Date.now() + 86399000);
  value(
    await h.basket(
      g.tokens.access_token,
      { kind: "get_basket" },
      undefined,
      readId,
    ),
  );
  assert.equal((await h.record(g.locator)).expires, extended);
  const action = start();
  value(await h.basket(g.tokens.access_token, action, 0));
  const after = (await h.record(g.locator)).expires;
  value(await h.basket(g.tokens.access_token, action, 0));
  assert.equal((await h.record(g.locator)).expires, after);
  assert.equal(
    (await h.basket(g.tokens.access_token, start(), 0)).payload.result.isError,
    true,
  );
  assert.equal((await h.record(g.locator)).expires, after);
});

test("recovery rotates key, revokes old connections and keeps trips without extending retention", async () => {
  const g = await h.connected();
  const trip = value(await h.basket(g.tokens.access_token, start(), 0)).basket;
  const expires = (await h.record(g.locator)).expires;
  const recovered = await h.enroll(g.recovery);
  assert.equal(recovered.locator, g.locator);
  assert.notEqual(recovered.recovery, g.recovery);
  assert.equal((await h.record(g.locator)).expires, expires);
  assert.equal(
    (await h.basket(g.tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
  );
  const current = (await (
    await h.exchange(recovered.code, recovered.verifier)
  ).json()) as any;
  assert.equal(
    value(await h.basket(current.access_token, { kind: "get_basket" })).basket
      .id,
    trip.id,
  );
  const f = await h.begin();
  assert.notEqual(
    (
      await h.post(
        "/authorize",
        {
          flow: f.flow,
          csrf: f.csrf,
          decision: "recover",
          recovery: g.recovery,
        },
        f.cookie,
      )
    ).status,
    200,
  );
});

test("refresh rotation is persistent; replay revokes only its guest", async () => {
  const a = await h.connected(),
    b = await h.connected();
  const params = {
    grant_type: "refresh_token",
    refresh_token: a.tokens.refresh_token,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  };
  const rotated = await h.post("/token", params);
  assert.equal(rotated.status, 200);
  const tokens = (await rotated.json()) as any;
  await h.restart();
  assert.notEqual((await h.post("/token", params)).status, 200);
  assert.equal(
    (await h.basket(tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
  );
  value(await h.basket(b.tokens.access_token, { kind: "get_basket" }));
});

test("expiry denies before GC; collection removes tables and stale tokens cannot resurrect", async () => {
  const g = await h.connected(),
    meta = await h.record(g.locator);
  await h.setRecord(g.locator, "meta", { ...meta, expires: Date.now() - 1 });
  assert.equal(
    (await h.basket(g.tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
  );
  assert.notEqual(
    (
      await h.post("/token", {
        grant_type: "refresh_token",
        refresh_token: g.tokens.refresh_token,
        resource: `${ORIGIN}/mcp`,
        client_id: "basket-test",
        client_secret: secret,
      })
    ).status,
    200,
  );
  const f = await h.begin();
  assert.notEqual(
    (
      await h.post(
        "/authorize",
        {
          flow: f.flow,
          csrf: f.csrf,
          decision: "recover",
          recovery: g.recovery,
        },
        f.cookie,
      )
    ).status,
    200,
  );
  const vault = await h.vault(g.locator);
  assert.equal(await vault.collect(), null);
  assert.equal(await vault.collect(), null);
  await h.basket(g.tokens.access_token, { kind: "get_basket" });
  const tables = await (
    await h.sql("GuestVault", g.locator)
  ).exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
  );
  assert.deepEqual(tables, []);
});

test("cleanup rechecks extended deadlines, cleans expired flows and sweep catches missed alarms", async () => {
  const g = await h.connected(),
    vault = await h.vault(g.locator);
  const expires = (await h.record(g.locator)).expires;
  const nextCollection = await vault.collect();
  assert.ok(nextCollection <= expires);
  assert.ok(Math.abs(nextCollection - Date.now() - 86400000) < 1000);
  const f = await h.begin(),
    locator = f.flow.split(".")[2]!;
  const flowStore = await h.sql("AuthorizationFlow", locator);
  const rows = await flowStore.exec(
    "SELECT value FROM documents WHERE key='meta'",
  );
  const flow = JSON.parse(rows[0]!.value as string);
  await flowStore.exec(
    "UPDATE documents SET value=? WHERE key='meta'",
    JSON.stringify({ ...flow, expires: Date.now() - 1 }),
  );
  const indexes: any = await h.mf.getDurableObjectNamespace("CLEANUP");
  await indexes
    .getByName(`gc-${locator[0]}`)
    .track("flow", locator, Date.now() - 1);
  await indexes.getByName(`gc-${locator[0]}`).sweep();
  assert.deepEqual(
    await flowStore.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    ),
    [],
  );
  assert.notEqual(
    (
      await h.post(
        "/authorize",
        { flow: f.flow, csrf: f.csrf, decision: "new" },
        f.cookie,
      )
    ).status,
    200,
  );
});

test("explicit deletion erases the vault; retry is harmless and old consent cannot recreate it", async () => {
  const g = await h.connected();
  value(await h.basket(g.tokens.access_token, start(), 0));
  const deletion = await h.rpc(
    "tools/call",
    { name: "delete_guest", arguments: { confirm: true } },
    g.tokens.access_token,
  );
  assert.equal(value(deletion).deleted, true);
  assert.deepEqual(
    await (
      await h.sql("GuestVault", g.locator)
    ).exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    ),
    [],
  );
  assert.notEqual(
    (
      await h.post(
        "/continue",
        { flow: g.flow, csrf: g.csrf, saved: "yes" },
        g.cookie,
      )
    ).status,
    303,
  );
  const retried = await h.post(
    "/authorize",
    { flow: g.flow, csrf: g.csrf, decision: "new" },
    g.cookie,
  );
  assert.equal(retried.status, 200);
  assert.deepEqual(
    await (
      await h.sql("GuestVault", g.locator)
    ).exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    ),
    [],
  );
  assert.equal(
    (await h.basket(g.tokens.access_token, { kind: "get_basket" })).response
      .status,
    401,
  );
});

test("atomic failure rolls back both basket and receipt", async () => {
  const g = await h.connected(),
    sql = await h.sql("GuestVault", g.locator),
    action = start();
  await sql.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON documents WHEN NEW.key LIKE 'operation/%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  assert.equal(
    (await h.basket(g.tokens.access_token, action, 0)).payload.result.isError,
    true,
  );
  assert.equal((await h.record(g.locator)).revision, 0);
  assert.deepEqual(
    await sql.exec("SELECT key FROM documents WHERE key LIKE 'trip/%'"),
    [],
  );
  await sql.exec("DROP TRIGGER reject_receipt");
  assert.equal(
    value(await h.basket(g.tokens.access_token, action, 0)).revision,
    1,
  );
});

test("security boundary rejects unsafe host/origin, duplicate parameters, over-size and unsigned locators", async () => {
  assert.equal(
    (await h.mf.dispatchFetch("http://evil.example/health")).status,
    403,
  );
  assert.equal(
    (
      await h.request("/authorize", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "decision=new",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=a&grant_type=b",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(100000),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await h.basket(
        "v1.access.00000000000000000000000000000000." + "x".repeat(43) + ".bad",
        { kind: "get_basket" },
      )
    ).response.status,
    401,
  );
});

test("pending codes survive collection but cannot be redeemed before Continue", async () => {
  const f = await h.begin();
  const approved = await h.post(
    "/authorize",
    { flow: f.flow, csrf: f.csrf, decision: "new" },
    f.cookie,
  );
  const html = await approved.text(),
    recovery = html.match(/<pre>([^<]+)<\/pre>/)![1]!;
  const locator = recovery.split(".")[2]!;
  const sql = await h.sql("GuestVault", locator);
  const pending = await sql.exec(
    "SELECT key,value FROM documents WHERE key LIKE 'code/%'",
  );
  assert.equal(JSON.parse(pending[0]!.value as string).activated, false);
  await (await h.vault(locator)).collect();
  assert.equal(
    (await sql.exec("SELECT key FROM documents WHERE key LIKE 'code/%'"))
      .length,
    1,
  );
  const continued = await h.post(
    "/continue",
    { flow: f.flow, csrf: f.csrf, saved: "yes" },
    f.cookie,
  );
  const code = new URL(continued.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const record = JSON.parse(
    (await sql.exec("SELECT value FROM documents WHERE key LIKE 'code/%'"))[0]!
      .value as string,
  );
  assert.equal(record.activated, true);
  assert.ok(record.expires <= Date.now() + 60000);
  assert.equal((await h.exchange(code, f.verifier)).status, 200);
});

test("failed token issuance rolls back code consumption", async () => {
  const g = await h.enroll(),
    sql = await h.sql("GuestVault", g.locator);
  await sql.exec(
    "CREATE TRIGGER reject_token BEFORE INSERT ON documents WHEN NEW.key LIKE 'access/%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  assert.notEqual((await h.exchange(g.code, g.verifier)).status, 200);
  assert.equal(
    (await h.record(g.locator, `code/${digest(g.code)}`)).used,
    false,
  );
  assert.deepEqual(
    await sql.exec(
      "SELECT key FROM documents WHERE key LIKE 'access/%' OR key LIKE 'refresh/%'",
    ),
    [],
  );
  await sql.exec("DROP TRIGGER reject_token");
  assert.equal((await h.exchange(g.code, g.verifier)).status, 200);
});

test("recovery rollback preserves the original recovery key and connection", async () => {
  const g = await h.connected(),
    sql = await h.sql("GuestVault", g.locator);
  const original = await h.record(g.locator);
  await sql.exec(
    "CREATE TRIGGER reject_recovery BEFORE UPDATE ON documents WHEN NEW.key='meta' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const f = await h.begin(),
    form = {
      flow: f.flow,
      csrf: f.csrf,
      decision: "recover",
      recovery: g.recovery,
    };
  assert.equal((await h.post("/authorize", form, f.cookie)).status, 200);
  const acknowledge = { flow: f.flow, csrf: f.csrf, saved: "yes" };
  assert.notEqual(
    (await h.post("/continue", acknowledge, f.cookie)).status,
    303,
  );
  assert.equal((await h.record(g.locator)).recovery, original.recovery);
  assert.equal(
    (await h.rpc("tools/list", {}, g.tokens.access_token)).response.status,
    200,
  );
  await sql.exec("DROP TRIGGER reject_recovery");
  assert.equal((await h.post("/continue", acknowledge, f.cookie)).status, 303);
  assert.equal(
    (await h.rpc("tools/list", {}, g.tokens.access_token)).response.status,
    401,
  );
});

test("credential material is hashed, client/resource/scope are bound, and access expiry allows refresh", async () => {
  const g = await h.connected(),
    sql = await h.sql("GuestVault", g.locator);
  const stored = JSON.stringify(
    await sql.exec("SELECT key,value FROM documents"),
  );
  for (const raw of [
    g.tokens.access_token,
    g.tokens.refresh_token,
    g.code,
    g.recovery,
  ])
    assert.ok(!stored.includes(raw));
  const token = await h.record(
    g.locator,
    `access/${digest(g.tokens.access_token)}`,
  );
  await h.setRecord(g.locator, `access/${digest(g.tokens.access_token)}`, {
    ...token,
    expires: Date.now(),
  });
  assert.equal(
    (await h.rpc("tools/list", {}, g.tokens.access_token)).response.status,
    401,
  );
  const response = await h.post("/token", {
    grant_type: "refresh_token",
    refresh_token: g.tokens.refresh_token,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  });
  assert.equal(response.status, 200);
  const current = (await response.json()) as any;
  const grantKey = `grant/${token.grant}`,
    grant = await h.record(g.locator, grantKey);
  for (const changed of [
    { client: "other" },
    { resource: "https://other.example/mcp" },
    { scope: "other" },
  ]) {
    await h.setRecord(g.locator, grantKey, { ...grant, ...changed });
    assert.equal(
      (await h.rpc("tools/list", {}, current.access_token)).response.status,
      401,
    );
  }
});

test("concurrent refresh reuse revokes its family without issuing two valid connections", async () => {
  const g = await h.connected();
  const params = {
    grant_type: "refresh_token",
    refresh_token: g.tokens.refresh_token,
    resource: `${ORIGIN}/mcp`,
    client_id: "basket-test",
    client_secret: secret,
  };
  const replies = await Promise.all([
    h.post("/token", params),
    h.post("/token", params),
  ]);
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  const success = (await replies.find((r) => r.status === 200)!.json()) as any;
  assert.equal(
    (await h.rpc("tools/list", {}, success.access_token)).response.status,
    401,
  );
});

test("a real workerd alarm deletes an expired vault without a request or sweep", async () => {
  const g = await h.connected(),
    meta = await h.record(g.locator);
  const expires = Date.now() + 300;
  await h.setRecord(g.locator, "meta", { ...meta, expires });
  assert.equal(
    await (await h.vault(g.locator)).collect(),
    expires,
    "arm the real alarm, do not delete immediately",
  );
  const sql = await h.sql("GuestVault", g.locator);
  let removed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tables = await sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    );
    if (tables.length === 0) {
      removed = true;
      break;
    }
  }
  assert.equal(
    removed,
    true,
    "alarm did not clear storage within the local test deadline",
  );
});

test("retired food tools reject calls without changing basket data or retention", async () => {
  const g = await h.connected();
  const first = value(await h.basket(g.tokens.access_token, start(), 0));
  const added = value(
    await h.basket(
      g.tokens.access_token,
      {
        kind: "add_item",
        operationId: randomUUID(),
        tripId: first.basket.id,
        name: "Milk",
        unitPriceCents: 199,
      },
      1,
    ),
  );
  const before = await h.record(g.locator);
  for (const kind of [
    "set_item_expiry",
    "mark_item_consumed",
    "list_expiring_items",
  ]) {
    const retired = await h.basket(
      g.tokens.access_token,
      {
        kind,
        operationId: randomUUID(),
        tripId: first.basket.id,
        itemId: added.basket.items[0].id,
        consumed: true,
        expiry: {
          date: "2026-10-20",
          kind: "use_by",
          source: "user",
          confirmed: true,
        },
      },
      2,
    );
    assert.ok(retired.payload.error || retired.payload.result?.isError, kind);
    await assert.rejects(
      (await h.vault(g.locator)).basket(
        await digest(g.tokens.access_token),
        { kind },
        2,
        randomUUID(),
        before.dataEpoch,
      ),
    );
  }
  for (const patch of [
    { name: "Changed", expiry: null },
    { name: "Changed", consumed: true },
  ]) {
    const rejected = await h.basket(
      g.tokens.access_token,
      {
        kind: "update_item",
        operationId: randomUUID(),
        tripId: first.basket.id,
        itemId: added.basket.items[0].id,
        patch,
      },
      2,
    );
    assert.ok(rejected.payload.error || rejected.payload.result?.isError);
  }
  assert.deepEqual(await h.record(g.locator), before);
  assert.equal(
    (await h.record(g.locator, `trip/${first.basket.id}`)).items[0].name,
    "Milk",
  );
});

test("legacy food fields stay hidden in reads and persisted mutation receipt retries", async () => {
  const g = await h.connected();
  const first = value(await h.basket(g.tokens.access_token, start(), 0));
  const action = {
    kind: "add_item",
    operationId: randomUUID(),
    tripId: first.basket.id,
    name: "Legacy milk",
    unitPriceCents: 199,
  };
  const added = value(await h.basket(g.tokens.access_token, action, 1));
  const legacy = {
    expiry: {
      date: "2026-10-20",
      kind: "use_by",
      source: "user",
      confirmed: true,
    },
    consumed: true,
  };
  const trip = await h.record(g.locator, `trip/${first.basket.id}`);
  Object.assign(trip.items[0], legacy);
  await h.setRecord(g.locator, `trip/${trip.id}`, trip);
  const receiptKey = `operation/${action.operationId}`;
  const receipt = await h.record(g.locator, receiptKey);
  Object.assign(receipt.result.basket.items[0], legacy);
  await h.setRecord(g.locator, receiptKey, receipt);
  const retried = await h.basket(g.tokens.access_token, action, 1);
  const replay = value(retried);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.revision, added.revision);
  const read = await h.basket(g.tokens.access_token, { kind: "get_basket" });
  for (const response of [retried, read]) {
    const basket = value(response).basket;
    assert.equal(basket.totalCents, 199);
    assert.equal(basket.items[0].name, "Legacy milk");
    assert.equal("expiry" in basket.items[0], false);
    assert.equal("consumed" in basket.items[0], false);
    for (const block of response.payload.result.content) {
      if (block.type === "text")
        assert.doesNotMatch(block.text, /"expiry"|"consumed"|2026-10-20/);
    }
  }
});

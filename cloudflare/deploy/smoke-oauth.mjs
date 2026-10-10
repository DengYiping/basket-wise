import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// Explicitly opt in: this creates and deletes only its own synthetic test guest.
assert.ok(
  process.argv.includes("--allow-test-guest"),
  "Pass --allow-test-guest",
);
const origin = "https://basketwise.loudcoder.com";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const useDcr = process.argv.includes("--dcr");
let oauthClient;
if (!useDcr) {
  const { CLIENT_SECRET } = JSON.parse(
    await readFile(
      new URL(".secrets.production.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(typeof CLIENT_SECRET === "string" && CLIENT_SECRET.length >= 32);
  oauthClient = {
    client_id: "basket-wise-chatgpt",
    client_secret: CLIENT_SECRET,
  };
}
const recoveries = [];
const tokensForCleanup = [];
let guestCreated = false;
async function request(path, init = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
}
const post = (path, params, cookie) =>
  request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(params),
  });
async function registerClient() {
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      client_name: "Basket Wise bounded deployment smoke",
      redirect_uris: [callback],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "basket:manage",
    }),
  };
  const response = await request("/register", options);
  assert.equal(response.status, 201, "DCR registration failed");
  const first = await response.json();
  assert.equal(
    first.client_secret_expires_at,
    0,
    "Registered client must survive basket/profile expiry",
  );
  const repeated = await request("/register", options);
  assert.equal(repeated.status, 201, "DCR retry failed");
  assert.ok(
    JSON.stringify(await repeated.json()) === JSON.stringify(first),
    "DCR retry changed credentials",
  );
  assert.ok(typeof first.client_secret === "string", "Missing DCR secret");
  return first;
}
async function prepare(recovery) {
  const client = oauthClient;
  const verifier = randomBytes(32).toString("base64url"),
    state = randomUUID();
  const params = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
    scope: "basket:manage",
  });
  const response = await request(`/authorize?${params}`);
  assert.equal(response.status, 200, "Consent page unavailable");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const html = await response.text();
  const flow = html.match(/name="flow" value="([^"]+)"/)[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const approved = await post(
    "/authorize",
    {
      flow,
      csrf,
      decision: recovery ? "recover" : "new",
      ...(recovery ? { recovery } : {}),
    },
    cookie,
  );
  const approvedHtml = await approved.text();
  if (approved.status !== 200) return null;
  const replacement = approvedHtml.match(/<pre>([^<]+)<\/pre>/)?.[1];
  assert.ok(replacement, "Missing private recovery page");
  if (!recovery) guestCreated = true;
  recoveries.push(replacement);
  return { flow, csrf, cookie, verifier, state, recovery: replacement, client };
}
async function acknowledge(flow) {
  const response = await post(
    "/continue",
    { flow: flow.flow, csrf: flow.csrf, saved: "yes" },
    flow.cookie,
  );
  await response.arrayBuffer();
  assert.equal(response.status, 303, "Acknowledgement failed");
  const location = new URL(response.headers.get("location"));
  assert.ok(
    location.origin + location.pathname === callback,
    "Unexpected callback",
  );
  assert.ok(
    location.searchParams.get("state") === flow.state,
    "State mismatch",
  );
  assert.ok(location.searchParams.get("iss") === origin, "Issuer mismatch");
  return location.searchParams.get("code"); // Never navigate to the callback or log the code.
}
async function exchange(flow, code) {
  const response = await post("/token", {
    client_id: flow.client.client_id,
    client_secret: flow.client.client_secret,
    grant_type: "authorization_code",
    code,
    code_verifier: flow.verifier,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
  });
  assert.equal(response.status, 200, "Token exchange failed");
  const tokens = await response.json();
  assert.ok(typeof tokens.access_token === "string", "Missing access token");
  tokensForCleanup.push(tokens.access_token);
  return tokens.access_token;
}
async function rpc(token, method, params = {}) {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return { status: response.status, payload: await response.json() };
}
async function basket(token, action, extra = {}) {
  const { kind, ...parameters } = action;
  const result = await rpc(token, "tools/call", {
    name: kind,
    arguments: { ...parameters, ...extra },
  });
  assert.equal(result.status, 200, "Authenticated tool request failed");
  assert.ok(
    result.payload.result && !result.payload.result.isError,
    "Basket tool returned an error",
  );
  return result.payload.result.structuredContent;
}
async function deleteTestGuest(token) {
  const result = await rpc(token, "tools/call", {
    name: "delete_guest",
    arguments: { confirm: true },
  });
  return (
    result.status === 200 &&
    result.payload.result?.structuredContent?.deleted === true
  );
}
try {
  if (useDcr) oauthClient = await registerClient();
  const guest = await prepare();
  assert.ok(guest, "Enrollment is not enabled");
  const token = await exchange(guest, await acknowledge(guest));
  const initial = await basket(
    token,
    { kind: "get_basket" },
    { activityId: randomUUID() },
  );
  const originalProfile = await basket(token, { kind: "get_profile" });
  const list = await basket(token, {
    kind: "add_shopping_list_item",
    name: "Synthetic list item",
    quantity: 2,
    operationId: randomUUID(),
    expectedShoppingListRevision: 0,
  });
  await basket(
    token,
    {
      kind: "start_trip",
      operationId: randomUUID(),
      store: "Deployment smoke test",
      currency: "EUR",
    },
    { expectedRevision: initial.revision, dataEpoch: initial.dataEpoch },
  );
  const activityId = randomUUID();
  const before = await basket(token, { kind: "get_basket" }, { activityId });
  assert.ok(
    Math.abs(before.expiresAt - Date.now() - 86400000) < 60000,
    "Expected 24-hour basket deadline",
  );
  assert.ok(
    Math.abs(before.profileExpiresAt - Date.now() - 90 * 86400000) < 60000,
    "Expected 90-day profile deadline",
  );
  if (useDcr) oauthClient = await registerClient();
  const recovery = await prepare(guest.recovery);
  assert.ok(recovery, "Recovery preparation failed");
  assert.equal(
    (await rpc(token, "tools/list")).status,
    200,
    "Preparation revoked the old connection",
  );
  assert.ok(
    await prepare(guest.recovery),
    "Preparation invalidated the original key",
  );
  assert.ok(
    (await prepare(recovery.recovery)) === null,
    "Replacement activated before acknowledgement",
  );
  const code = await acknowledge(recovery);
  assert.ok(
    (await acknowledge(recovery)) === code,
    "Acknowledgement retry changed the code",
  );
  const recoveredToken = await exchange(recovery, code);
  assert.equal(
    (await rpc(token, "tools/list")).status,
    401,
    "Recovery did not revoke the old connection",
  );
  assert.ok(
    (await prepare(guest.recovery)) === null,
    "Recovery did not rotate the original key",
  );
  const after = await basket(
    recoveredToken,
    { kind: "get_basket" },
    { activityId },
  );
  assert.ok(
    after.basket.id === before.basket.id,
    "Recovery lost the test trip",
  );
  assert.ok(
    after.revision === before.revision,
    "Recovery changed the revision",
  );
  assert.ok(
    after.expiresAt === before.expiresAt,
    "Recovery extended the inactivity deadline",
  );
  assert.ok(
    await prepare(recovery.recovery),
    "Saved replacement cannot recover the guest",
  );
  assert.equal((await rpc(recoveredToken, "tools/list")).status, 200);
  const stableProfile = await basket(recoveredToken, { kind: "get_profile" });
  assert.equal(
    stableProfile.id,
    originalProfile.id,
    "Recovery changed profile ID",
  );
  const restoredList = await basket(recoveredToken, {
    kind: "get_shopping_list",
    activityId: randomUUID(),
  });
  assert.deepEqual(
    restoredList.shoppingList,
    list.shoppingList,
    "Recovery lost shopping list",
  );
  const transfer = {
    kind: "add_item",
    operationId: randomUUID(),
    tripId: after.basket.id,
    name: "Synthetic list item",
    quantity: 2,
    unitPriceCents: 125,
    shoppingListItemId: list.itemId,
    expectedShoppingListRevision: list.shoppingListRevision,
    expectedRevision: after.revision,
    dataEpoch: after.dataEpoch,
  };
  const purchased = await basket(recoveredToken, transfer);
  assert.equal(purchased.basket.totalCents, 250);
  assert.equal((await basket(recoveredToken, transfer)).alreadyApplied, true);
  const removed = await basket(recoveredToken, {
    kind: "remove_item",
    tripId: after.basket.id,
    itemId: purchased.basket.items[0].id,
    operationId: randomUUID(),
    expectedRevision: purchased.revision,
    dataEpoch: purchased.dataEpoch,
  });
  assert.equal(
    (
      await basket(recoveredToken, {
        kind: "get_shopping_list",
        activityId: randomUUID(),
      })
    ).shoppingList.length,
    0,
    "Trip removal restored consumed entry",
  );
  const kept = await basket(recoveredToken, {
    kind: "add_shopping_list_item",
    name: "Keep through basket clear",
    operationId: randomUUID(),
    expectedShoppingListRevision: purchased.shoppingListRevision,
  });
  const clearArgs = {
    confirm: true,
    operationId: randomUUID(),
    expectedRevision: removed.revision,
    dataEpoch: after.dataEpoch,
  };
  const empty = await basket(recoveredToken, {
    kind: "clear_baskets",
    ...clearArgs,
  });
  assert.equal(empty.basket, null);
  assert.equal(empty.spaceId, originalProfile.id);
  assert.notEqual(empty.dataEpoch, after.dataEpoch);
  assert.deepEqual(
    (
      await basket(recoveredToken, {
        kind: "get_shopping_list",
        activityId: randomUUID(),
      })
    ).shoppingList,
    kept.shoppingList,
  );
  const stale = await rpc(recoveredToken, "tools/call", {
    name: "start_trip",
    arguments: {
      operationId: randomUUID(),
      expectedRevision: after.revision,
      dataEpoch: after.dataEpoch,
      currency: "EUR",
    },
  });
  assert.equal(
    stale.payload.result.structuredContent.error,
    "data_expired",
    "Old widget generation must fail closed",
  );
  assert.equal(
    (await basket(recoveredToken, { kind: "clear_baskets", ...clearArgs }))
      .alreadyApplied,
    true,
  );
  assert.equal(
    (await basket(recoveredToken, { kind: "get_profile" })).id,
    originalProfile.id,
  );
  const reconnected = await prepare(recovery.recovery);
  assert.ok(reconnected, "Empty profile could not be recovered");
  const emptyToken = await exchange(
    reconnected,
    await acknowledge(reconnected),
  );
  assert.equal(
    (await basket(emptyToken, { kind: "get_profile" })).id,
    originalProfile.id,
  );
  assert.equal(
    (
      await basket(
        emptyToken,
        { kind: "get_basket" },
        { activityId: randomUUID() },
      )
    ).basket,
    null,
  );
  console.log(
    "PASS: live enrollment, PKCE/token exchange, shopping-list recovery, atomic trip transfer/retry, no restoration on removal, list preservation during basket clearing, deferred recovery rotation and stable profile.",
  );
} finally {
  if (guestCreated) {
    let deleted = false;
    for (const token of tokensForCleanup.toReversed()) {
      if (await deleteTestGuest(token)) {
        deleted = true;
        break;
      }
    }
    // If a response was lost after takeover, use only this test's saved keys.
    if (!deleted)
      for (const recovery of recoveries.toReversed()) {
        const flow = await prepare(recovery);
        if (!flow) continue;
        const token = await exchange(flow, await acknowledge(flow));
        if (await deleteTestGuest(token)) {
          deleted = true;
          break;
        }
      }
    assert.ok(
      deleted,
      "Test guest cleanup failed; 24-hour basket and 90-day profile inactivity expiry still apply",
    );
    for (const token of tokensForCleanup)
      assert.equal((await rpc(token, "tools/list")).status, 401);
    console.log(
      "PASS: synthetic guest deleted and its credentials rejected. Secrets were not printed or persisted by this test.",
    );
  }
}
console.log(
  "Not tested: actual ChatGPT host enrollment, widget bridge, or model-initiated tool calls.",
);

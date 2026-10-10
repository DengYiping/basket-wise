import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

// Public checks only: never load production secrets or create a guest basket.
const origin = "https://basketwise.loudcoder.com";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
async function request(path, init = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
}
async function rpc(method, params = {}) {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const health = await request("/health");
assert.equal(health.status, 200);
assert.equal(health.headers.get("cache-control"), "no-store");
const healthData = await health.json();
assert.equal(healthData.inactivityHours, 24);
assert.equal(healthData.version, "0.5.0");
assert.equal(healthData.registrationEnabled, true);
assert.equal(
  healthData.enrollmentEnabled,
  !process.argv.includes("--expect-enrollment-disabled"),
);
for (const [path, title] of [
  ["/", "Your basket."],
  ["/support", "Help with Basket Wise"],
  ["/privacy", "Privacy policy"],
  ["/terms", "Terms of service"],
]) {
  const page = await request(path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(
    page.headers.get("content-security-policy"),
    /form-action 'none'/,
  );
  const body = await page.text();
  assert.ok(body.includes(title));
  assert.match(body, /Developed by Yiping Deng/);
  assert.doesNotMatch(
    body,
    /Local preview|contact awaiting|awaiting confirmation/i,
  );
  for (const href of ["/", "/support", "/privacy", "/terms"])
    assert.ok(body.includes(`href="${href}"`));
  if (path !== "/")
    assert.match(body, /href="mailto:yiping\.deng\.98@gmail\.com"/);
  const head = await request(path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
}
for (const [path, type] of [
  ["/site.css", /^text\/css/],
  ["/site-icon.svg", /^image\/svg\+xml/],
]) {
  const asset = await request(path);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), type);
  assert.ok((await asset.text()).length > 100);
}
const meta = await (
  await request("/.well-known/oauth-authorization-server")
).json();
assert.equal(meta.issuer, origin);
assert.equal(meta.authorization_response_iss_parameter_supported, true);
assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
assert.equal(meta.registration_endpoint, `${origin}/register`);
const resource = await (
  await request("/.well-known/oauth-protected-resource/mcp")
).json();
assert.equal(resource.resource, `${origin}/mcp`);

const tools = (await rpc("tools/list")).result.tools;
assert.equal(
  tools.some((tool) => tool.name === "basket"),
  false,
);
assert.equal(tools.length, 18);
for (const name of [
  "set_item_expiry",
  "list_expiring_items",
  "mark_item_consumed",
])
  assert.equal(
    tools.some((tool) => tool.name === name),
    false,
  );
for (const tool of tools) {
  assert.equal(tool.annotations.readOnlyHint, tool.name === "get_profile");
}
for (const name of ["get_basket", "list_trips", "suggest_removals"]) {
  assert.equal(
    tools.find((tool) => tool.name === name).annotations.destructiveHint,
    false,
  );
}
assert.deepEqual(
  tools.find((tool) => tool.name === "get_basket").securitySchemes,
  [{ type: "oauth2", scopes: ["basket:manage"] }],
);
const denied = await rpc("tools/call", {
  name: "get_basket",
  arguments: { activityId: randomUUID() },
});
assert.equal(denied.result.isError, true);
assert.ok(denied.result._meta["mcp/www_authenticate"]);
const deniedOpen = await rpc("tools/call", {
  name: "open_basket",
  arguments: { activityId: randomUUID() },
});
assert.equal(deniedOpen.result.isError, true);
assert.ok(deniedOpen.result._meta["mcp/www_authenticate"]);
const canonical = "ui://basket-wise-durable/v0.5.0/basket.html";
for (const tool of tools) {
  if (
    ["get_profile", "get_basket", "list_trips", "get_shopping_list"].includes(
      tool.name,
    )
  )
    assert.equal(tool._meta.ui, undefined);
  else
    assert.equal(
      tool._meta.ui.resourceUri,
      tool.name.includes("shopping_list")
        ? "ui://basket-wise-durable/v0.5.0/shopping-list.html"
        : canonical,
    );
}
const localWidget = await readFile(
  new URL("../dist/widget.html", import.meta.url),
  "utf8",
);
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
  const content = (await rpc("resources/read", { uri })).result.contents[0];
  assert.equal(content.uri, uri);
  assert.equal(
    content.text,
    localWidget,
    `${version}: live bundle byte-matches tested build`,
  );
  assert.deepEqual(content._meta.ui.csp, {
    connectDomains: [],
    resourceDomains: [],
  });
}
const listUri = "ui://basket-wise-durable/v0.5.0/shopping-list.html";
const listResource = (await rpc("resources/read", { uri: listUri })).result
  .contents[0];
assert.equal(
  listResource.text,
  await readFile(
    new URL("../dist/shopping-list.html", import.meta.url),
    "utf8",
  ),
);
assert.match(listResource.text, /shopping-items/);
assert.deepEqual(listResource._meta.ui.csp, {
  connectDomains: [],
  resourceDomains: [],
});
const widget = localWidget;
assert.match(widget, /callServerTool/);
assert.match(widget, /class="brand"/);
assert.doesNotMatch(widget, /<script[^>]+src=/);
assert.match(widget, /id="items"[^>]*hidden/);
assert.match(widget, /id="milestone-progress"/);
assert.match(widget, /role="progressbar"/);
assert.match(widget, /Show basket items/);

const verifier = randomBytes(32).toString("base64url");
const params = new URLSearchParams({
  client_id: "basket-wise-chatgpt",
  response_type: "code",
  redirect_uri: callback,
  state: randomUUID(),
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  resource: `${origin}/mcp`,
  scope: "basket:manage",
});
const consent = await request(`/authorize?${params}`);
assert.equal(consent.status, 200);
assert.match(
  consent.headers.get("content-security-policy"),
  /https:\/\/chatgpt\.com/,
);
assert.equal(consent.headers.get("referrer-policy"), "same-origin");
const html = await consent.text();
assert.match(html, /href="\/auth.css"/);
assert.match(html, /Have a recovery key/);
assert.match(
  consent.headers.get("content-security-policy"),
  /style-src 'self'/,
);
assert.doesNotMatch(
  consent.headers.get("content-security-policy"),
  /unsafe-inline|script-src/,
);
const authCss = await request("/auth.css");
assert.equal(authCss.status, 200);
assert.match(authCss.headers.get("content-type"), /^text\/css/);
assert.match(await authCss.text(), /\.access-card/);
const flow = html.match(/name="flow" value="([^"]+)"/)[1];
const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
if (process.argv.includes("--expect-enrollment-disabled")) {
  const blocked = await request("/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Cookie: consent.headers.get("set-cookie").split(";")[0],
    },
    body: new URLSearchParams({ flow, csrf, decision: "new" }),
  });
  assert.ok(blocked.status >= 400);
  assert.equal(blocked.headers.get("location"), null);
  assert.doesNotMatch(await blocked.text(), /Save your recovery key/);
}
params.set("redirect_uri", "https://unregistered.invalid/callback");
const unsafeRedirect = await request(`/authorize?${params}`);
assert.equal(unsafeRedirect.status, 400);
await unsafeRedirect.arrayBuffer();
const unsafeOrigin = await request("/health", {
  headers: { Origin: "https://unregistered.invalid" },
});
assert.equal(unsafeOrigin.status, 403);
await unsafeOrigin.arrayBuffer();

console.log(
  "PASS: four public pages/contact/assets, HTTPS, health/24h policy, OAuth discovery, protected MCP tools, live/current/cached widget byte match, consent headers, and origin/redirect rejection.",
);
console.log(
  "Not tested: real ChatGPT OAuth enrollment or authenticated widget/chat calls.",
);

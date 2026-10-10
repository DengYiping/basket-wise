import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { once } from "node:events";
import { request, type Server } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createProbeApp } from "../src/http.js";
import { GuestAuthStore, type Tokens } from "../src/store.js";
import { SCOPE } from "../src/config.js";
import { WIDGET_URI } from "../src/mcp.js";
import { buildWidget } from "../src/widget-html.js";
import { ProbeController } from "../src/widget-controller.js";
import { testConfig, authorization } from "./helpers.js";

describe("real loopback HTTP, OAuth, MCP, and simulated host bridge", () => {
  const config = testConfig();
  let server: Server,
    store: GuestAuthStore,
    base: string,
    widget: string,
    now: number;
  let clients: Client[] = [];
  before(async () => {
    widget = await buildWidget();
  });
  beforeEach(async () => {
    now = 1_800_000_000_000;
    store = new GuestAuthStore(":memory:", config, () => now);
    server = createProbeApp(store, widget).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients = [];
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    store?.close();
  });

  function authorizationUrl(overrides: Record<string, string> = {}) {
    const { auth, verifier } = authorization(config);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: auth.clientId,
      redirect_uri: auth.redirectUri,
      state: auth.state,
      code_challenge: auth.challenge,
      code_challenge_method: "S256",
      resource: auth.resource,
      scope: auth.scope,
      ...overrides,
    });
    return { url: `${base}/authorize?${params}`, verifier, auth };
  }

  async function begin(overrides: Record<string, string> = {}) {
    const flow = authorizationUrl(overrides),
      response = await fetch(flow.url, { redirect: "manual" });
    const text = await response.text();
    const interaction = text.match(/name="interaction" value="([^"]+)"/)?.[1];
    const csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1];
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.equal(response.status, 200);
    assert.ok(interaction && csrf && cookie);
    return { ...flow, interaction, csrf, cookie, text, response };
  }

  async function decision(
    flow: Awaited<ReturnType<typeof begin>>,
    approve = true,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: config.origin,
        Cookie: flow.cookie,
        ...headers,
      },
      body: new URLSearchParams({
        interaction: flow.interaction,
        csrf: flow.csrf,
        decision: approve ? "approve" : "deny",
      }),
    });
  }

  async function token(
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...fields,
      }),
    });
  }

  async function enroll(): Promise<Tokens> {
    const flow = await begin(),
      response = await decision(flow);
    assert.equal(response.status, 303);
    const callback = new URL(response.headers.get("location")!);
    assert.equal(callback.origin + callback.pathname, flow.auth.redirectUri);
    assert.equal(callback.searchParams.get("state"), flow.auth.state);
    assert.equal(callback.searchParams.get("iss"), config.origin);
    const exchanged = await token({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      code_verifier: flow.verifier,
      redirect_uri: flow.auth.redirectUri,
      resource: flow.auth.resource,
    });
    assert.equal(exchanged.status, 200);
    return (await exchanged.json()) as Tokens;
  }

  async function connect(credentials: { access?: string } = {}) {
    const client = new Client({
      name: "local-poc-test-host",
      version: "0.1.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          if (credentials.access)
            headers.set("Authorization", `Bearer ${credentials.access}`);
          return fetch(input, { ...init, headers });
        },
      }),
    );
    return client;
  }

  async function rawMcp(
    method: string,
    params: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  it("publishes exact metadata and an explicit no-account consent form", async () => {
    const metadata = await fetch(
      `${base}/.well-known/oauth-authorization-server`,
    );
    assert.equal(metadata.headers.get("cache-control"), "no-store");
    assert.deepEqual(await metadata.json(), {
      issuer: config.origin,
      authorization_endpoint: `${config.origin}/authorize`,
      token_endpoint: `${config.origin}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      scopes_supported: [SCOPE],
    });
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      assert.deepEqual(await (await fetch(base + path)).json(), {
        resource: `${config.origin}/mcp`,
        authorization_servers: [config.origin],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
      });
    }
    const flow = await begin();
    assert.match(flow.text, /Continue as guest/);
    assert.match(flow.text, /No Basket Wise account, email, or password/);
    assert.match(flow.response.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(flow.response.headers.get("set-cookie")!, /Secure/);
    assert.match(flow.response.headers.get("set-cookie")!, /SameSite=Lax/);
    assert.equal(flow.response.headers.get("referrer-policy"), "no-referrer");
    assert.ok(!flow.text.includes('name="password"'));
  });

  it("rejects bad authorization requests without redirecting to an attacker", async () => {
    for (const changed of [
      { redirect_uri: "https://evil.invalid/callback" },
      { client_id: "unknown" },
      { state: "" },
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
      { response_type: "token" },
      { resource: "https://wrong.invalid/mcp" },
      { scope: "admin" },
    ]) {
      const response = await fetch(authorizationUrl(changed).url, {
        redirect: "manual",
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
    }
    const duplicate = await fetch(authorizationUrl().url + "&client_id=evil");
    assert.equal(duplicate.status, 400);
  });

  it("requires origin, browser cookie and CSRF; cancel and replay create no guest", async () => {
    const flow = await begin();
    assert.equal(
      (await decision(flow, true, { Origin: "https://evil.invalid" })).status,
      403,
    );
    assert.equal((await decision(flow, true, { Cookie: "" })).status, 400);
    assert.equal((await decision({ ...flow, csrf: "wrong" })).status, 400);
    const cancelled = await decision(flow, false);
    assert.equal(cancelled.status, 303);
    const url = new URL(cancelled.headers.get("location")!);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("code"), null);
    assert.equal((await decision(flow)).status, 400);
  });

  it("requires authenticated clients, PKCE and the exact resource at token exchange", async () => {
    const flow = await begin(),
      consent = await decision(flow);
    const fields = {
      grant_type: "authorization_code",
      code: new URL(consent.headers.get("location")!).searchParams.get("code")!,
      code_verifier: flow.verifier,
      redirect_uri: flow.auth.redirectUri,
      resource: flow.auth.resource,
    };
    assert.equal(
      (await token({ ...fields, client_secret: "wrong" })).status,
      401,
    );
    assert.equal(
      (await token({ ...fields, code_verifier: "wrong" })).status,
      400,
    );
    assert.equal(
      (await token({ ...fields, resource: "https://wrong.invalid" })).status,
      400,
    );
    assert.equal((await token({ ...fields, scope: "admin" })).status, 400);
    const response = await token(fields);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "access_token",
      "expires_in",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    assert.ok(!JSON.stringify(body).includes("guest-"));
  });

  it("accepts client_secret_basic and rejects credential conflicts", async () => {
    const flow = await begin(),
      consent = await decision(flow);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(consent.headers.get("location")!).searchParams.get("code")!,
      code_verifier: flow.verifier,
      redirect_uri: flow.auth.redirectUri,
      resource: flow.auth.resource,
    });
    const basic =
      "Basic " +
      Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
        "base64",
      );
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basic,
    };
    const conflict = await fetch(`${base}/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        ...Object.fromEntries(body),
        client_secret: config.clientSecret,
      }),
    });
    assert.equal(conflict.status, 400);
    const response = await fetch(`${base}/token`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(response.status, 200);
  });

  it("discovers only the probe tools and challenges unauthenticated calls", async () => {
    const client = await connect(),
      listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["open_guest_probe", "guest_probe"],
    );
    const tools = (await (await rawMcp("tools/list", {})).json()).result.tools;
    assert.deepEqual(tools[1].securitySchemes, [
      { type: "oauth2", scopes: [SCOPE] },
    ]);
    assert.deepEqual(tools[1]._meta.securitySchemes, tools[1].securitySchemes);
    const publicResult = await client.callTool({
      name: "open_guest_probe",
      arguments: {},
    });
    assert.notEqual(publicResult.isError, true);
    assert.ok(!JSON.stringify(publicResult).includes("guestTag"));
    const denied = await client.callTool({
      name: "guest_probe",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent, undefined);
    assert.match(JSON.stringify(denied._meta), /mcp\/www_authenticate/);
    const resource = await client.readResource({ uri: WIDGET_URI });
    const content = resource.contents[0];
    assert.ok(content && "text" in content);
    assert.match(content.text, /Check my guest identity/);
    assert.match(content.text, /standalone preview cannot verify host OAuth/);
  });

  it("proves chat and simulated widget-host calls use the same server-validated guest", async () => {
    const tokens = await enroll();
    const chat = await connect({ access: tokens.access_token }),
      widgetHost = await connect({ access: tokens.access_token });
    const chatResult = await chat.callTool({
      name: "guest_probe",
      arguments: {},
    });
    const identity = chatResult.structuredContent as Record<string, unknown>;
    assert.equal(chatResult.isError, undefined);
    assert.match(String(identity.guestTag), /^guest-/);
    let visible = "",
      observed: unknown;
    const controller = new ProbeController(
      {
        callServerTool: async (input) => {
          observed = input;
          return widgetHost.callTool(input);
        },
      },
      (message) => {
        visible = message;
      },
    );
    await controller.check();
    assert.deepEqual(observed, { name: "guest_probe", arguments: {} });
    assert.ok(visible.includes(String(identity.guestTag)));
    assert.ok(!visible.includes(String(identity.requestId))); // fresh server invocation
    for (const credential of [
      tokens.access_token,
      tokens.refresh_token,
      config.clientSecret,
    ]) {
      assert.ok(!JSON.stringify(chatResult).includes(credential));
      assert.ok(!visible.includes(credential));
      assert.ok(!widget.includes(credential));
    }
    const otherTokens = await enroll(),
      other = await connect({ access: otherTokens.access_token });
    const otherResult = await other.callTool({
      name: "guest_probe",
      arguments: {},
    });
    assert.notEqual(
      (otherResult.structuredContent as Record<string, unknown>).guestTag,
      identity.guestTag,
    );
  });

  it("never uses supplied guest IDs, cookies or request metadata as authorization", async () => {
    const tokens = await enroll(),
      tag = store.authenticate(tokens.access_token)!.guestTag;
    const response = await rawMcp(
      "tools/call",
      {
        name: "guest_probe",
        arguments: { guestTag: tag, token: tokens.access_token },
      },
      { Cookie: `access_token=${tokens.access_token}`, "X-Guest-Id": tag },
    );
    const body = await response.json();
    assert.ok(body.result?.isError || body.error);
    assert.equal(body.result?.structuredContent, undefined);
    const noArgs = await rawMcp(
      "tools/call",
      { name: "guest_probe", arguments: {} },
      { Cookie: `access_token=${tokens.access_token}`, "X-Guest-Id": tag },
    );
    assert.equal((await noArgs.json()).result.isError, true);
  });

  it("returns a discovery challenge for invalid, expired and revoked bearer tokens", async () => {
    const tokens = await enroll();
    for (const authorization of [
      "Bearer wrong",
      "Basic abc",
      `Bearer ${"a".repeat(43)}`,
    ]) {
      const response = await rawMcp(
        "tools/call",
        { name: "guest_probe", arguments: {} },
        { Authorization: authorization },
      );
      assert.equal(response.status, 401);
      assert.match(
        response.headers.get("www-authenticate")!,
        /resource_metadata=.*oauth-protected-resource\/mcp/,
      );
      assert.ok(!JSON.stringify(await response.json()).includes("guest-"));
    }
    now += 11_000;
    assert.equal(
      (
        await rawMcp(
          "tools/call",
          { name: "guest_probe", arguments: {} },
          { Authorization: `Bearer ${tokens.access_token}` },
        )
      ).status,
      401,
    );
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource: `${config.origin}/mcp`,
    });
    assert.equal(refreshed.status, 200);
    const next = (await refreshed.json()) as Tokens;
    const tag = store.authenticate(next.access_token)!.guestTag;
    store.revokeGuest(tag);
    assert.equal(
      (
        await rawMcp(
          "tools/call",
          { name: "guest_probe", arguments: {} },
          { Authorization: `Bearer ${next.access_token}` },
        )
      ).status,
      401,
    );
  });

  it("refreshes both simulated paths without changing the guest identity", async () => {
    const first = await enroll(),
      credentials = { access: first.access_token };
    const client = await connect(credentials),
      widgetHost = await connect(credentials),
      original = await client.callTool({ name: "guest_probe", arguments: {} });
    now += 11_000;
    const renewed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      resource: `${config.origin}/mcp`,
    });
    assert.equal(renewed.status, 200);
    credentials.access = ((await renewed.json()) as Tokens).access_token;
    const result = await client.callTool({
      name: "guest_probe",
      arguments: {},
    });
    assert.equal(
      (result.structuredContent as Record<string, unknown>).guestTag,
      (original.structuredContent as Record<string, unknown>).guestTag,
    );
    let visible = "";
    await new ProbeController(
      { callServerTool: (input) => widgetHost.callTool(input) },
      (message) => {
        visible = message;
      },
    ).check();
    assert.ok(
      visible.includes(
        String(
          (original.structuredContent as Record<string, unknown>).guestTag,
        ),
      ),
    );
    const replay = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      resource: `${config.origin}/mcp`,
    });
    assert.equal(replay.status, 400);
    assert.equal(store.authenticate(credentials.access), undefined);
  });

  it("rejects unsafe origins, host headers, large bodies and query-string credentials", async () => {
    assert.equal(
      (
        await fetch(`${base}/health`, {
          headers: { Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    // Fetch can replace Host; a raw HTTP request tests DNS-rebinding protection.
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${base}/health`,
        { headers: { Host: "evil.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebound, 403);
    assert.equal(
      (
        await fetch(`${base}/mcp?access_token=anything`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    );
    const huge = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(30_000) }),
    });
    assert.ok(huge.status >= 400 && huge.status < 500);
    for (const path of [
      "/data/oauth.sqlite",
      "/.env",
      "/register",
      "/widget.html",
    ])
      assert.equal((await fetch(base + path)).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await fetch(`${base}/token`)).status, 405);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.hostCompatibility, "not-verified");
  });
});

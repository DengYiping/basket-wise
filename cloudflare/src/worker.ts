import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  GuestVault,
  AuthorizationFlow,
  CleanupIndex,
  OAuthClients,
  track,
} from "./objects.js";
import {
  capability,
  parseCapability,
  id,
  random,
  hash,
  config,
  authorization,
  distinct,
  redirect,
  requireValue,
  Failure,
  FLOW_TTL,
  SCOPE,
  VERSION,
  canonical,
  clientSecret,
  isDynamicClient,
} from "./security.js";
import { registration } from "./registration.js";
import { createServer, challenge } from "./mcp.js";
import { publicPageResponse } from "./public-pages.js";
import authStyles from "./auth.css";
import {
  authAssetResponse,
  authorizationPage,
  recoveryKeyPage,
  authorizationErrorPage,
} from "./auth-pages.js";
import type { Env } from "./types.js";
export { GuestVault, AuthorizationFlow, CleanupIndex, OAuthClients };
const page = (body: string) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Basket Wise guest access</title><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html;charset=utf-8" } },
  );
const contentSecurityPolicy = (callback?: string) =>
  `default-src 'none'; form-action 'self'${callback ? ` ${new URL(callback).origin}` : ""}; frame-ancestors 'none'; base-uri 'none'`;
function oauthResponse(response: Response, registeredCallback: string) {
  // Chrome checks form-action across redirects. Only the callback already
  // validated for this flow is allowed; unrelated pages stay same-origin-only.
  response.headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(registeredCallback) +
      (response.headers.get("Content-Type")?.startsWith("text/html")
        ? "; style-src 'self'; img-src 'self'"
        : ""),
  );
  // no-referrer makes browser form POSTs send Origin: null. Preserve the
  // same-origin CSRF check without sending a referrer to the external callback.
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}
async function body(request: Request, maximum = 98304) {
  const declaredTooLarge =
    Number(request.headers.get("content-length") ?? 0) > maximum;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Failure("request_too_large", 413);
    }
    chunks.push(value);
  }
  requireValue(!declaredTooLarge, "request_too_large", 413);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
async function form(request: Request) {
  requireValue(
    request.headers.get("content-type")?.split(";")[0] ===
      "application/x-www-form-urlencoded",
  );
  return distinct(new URLSearchParams(await body(request, 12288)));
}
function only(form: URLSearchParams, allowed: string[]) {
  requireValue([...form.keys()].every((k) => allowed.includes(k)));
}
function cookie(request: Request, name: string) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${name}=`));
  requireValue(values.length === 1, "invalid_flow", 403);
  return values[0]!.slice(name.length + 1);
}
function cookieName(env: Env) {
  return env.PUBLIC_ORIGIN.startsWith("https:") ? "__Host-bw-flow" : "bw-flow";
}
async function handle(request: Request, env: Env): Promise<Response> {
  config(env);
  const url = new URL(request.url),
    origin = request.headers.get("origin");
  requireValue(
    url.origin === env.PUBLIC_ORIGIN && request.url.length <= 8192,
    "invalid_origin",
    403,
  );
  requireValue(
    !origin ||
      origin === env.PUBLIC_ORIGIN ||
      (url.pathname === "/mcp" &&
        ["https://chatgpt.com", "https://chat.openai.com"].includes(origin)),
    "invalid_origin",
    403,
  );
  if (request.method === "OPTIONS" && url.pathname === "/mcp")
    return new Response(null, { status: 204 });
  requireValue(
    await env.RATE_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") ?? "unknown",
    }).then((r) => r.success),
    "rate_limited",
    429,
  );
  const authAsset = authAssetResponse(request, authStyles);
  if (authAsset) return authAsset;
  if (env.PUBLIC_PAGES_ENABLED === "true") {
    const response = publicPageResponse(request, env.PUBLIC_CONTACT);
    if (response) return response;
  }
  if (request.method === "GET") {
    if (url.pathname === "/.well-known/openai-apps-challenge") {
      const token = env.OPENAI_DOMAIN_VERIFICATION_TOKEN;
      requireValue(
        !url.search && token && /^[A-Za-z0-9_-]{32,256}$/.test(token),
        "not_found",
        404,
      );
      return new Response(token, {
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      });
    }
    if (url.pathname === "/health")
      return Response.json({
        status: "ok",
        service: "basket-wise-durable",
        version: VERSION,
        enrollmentEnabled: env.ENROLLMENT_ENABLED === "true",
        inactivityHours: 24,
        registrationEnabled: env.DCR_ENABLED === "true",
        chatgptVerification: "not-run",
      });
    if (url.pathname === "/")
      return page(
        "<h1>Basket Wise</h1><p>Private guest baskets expire after 24 hours without a new foreground basket action. Anonymous profiles expire after 90 inactive days. Connect through ChatGPT to start or recover a guest space. Never paste recovery keys into chat.</p>",
      );
    if (
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(url.pathname)
    )
      return Response.json({
        resource: `${env.PUBLIC_ORIGIN}/mcp`,
        authorization_servers: [env.PUBLIC_ORIGIN],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: env.PUBLIC_ORIGIN,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: `${env.PUBLIC_ORIGIN}/authorize`,
        token_endpoint: `${env.PUBLIC_ORIGIN}/token`,
        ...(env.DCR_ENABLED === "true"
          ? { registration_endpoint: `${env.PUBLIC_ORIGIN}/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [SCOPE],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
        ],
      });
    if (url.pathname === "/authorize") {
      const a = await authorization(env, distinct(url.searchParams)),
        locator = id(),
        csrf = random(),
        browser = random();
      const routing = await capability(env, "flow", locator);
      const expires = Date.now() + FLOW_TTL;
      await track(env, "flow", locator, expires);
      await env.FLOWS.getByName(locator).initialize({
        expires,
        authorization: a,
        browser: await hash(browser),
        csrf: await hash(csrf),
        vault: id(),
      });
      const response = new Response(
        authorizationPage({ flow: routing, csrf }),
        {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        },
      );
      response.headers.set(
        "Set-Cookie",
        `${cookieName(env)}=${browser}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${env.PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : ""}`,
      );
      return oauthResponse(response, a.redirectUri);
    }
  }
  requireValue(request.method === "POST", "not_found", 404);
  requireValue(!url.search, "invalid_request");
  if (url.pathname === "/register") {
    requireValue(env.DCR_ENABLED === "true", "not_found", 404);
    requireValue(
      !request.headers.has("authorization") &&
        request.headers.get("content-type")?.split(";")[0] ===
          "application/json",
      "invalid_client_metadata",
    );
    let raw: unknown;
    try {
      raw = JSON.parse(await body(request, 4096));
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure("invalid_client_metadata");
    }
    const metadata = registration(env, raw);
    const operationId = request.headers.get("idempotency-key");
    requireValue(
      operationId === null || /^[A-Za-z0-9_-]{16,128}$/.test(operationId),
      "invalid_request",
    );
    const clientId = `bw-dcr-${id()}`;
    const client = await env.CLIENTS.getByName("chatgpt").register({
      clientId,
      metadata,
      secretHash: await hash(await clientSecret(env, clientId)),
      fingerprint: await hash(canonical(metadata)),
      ...(operationId ? { requestHash: await hash(operationId) } : {}),
    });
    if ("error" in client) throw new Failure(client.error, client.status);
    return Response.json(
      {
        ...client.metadata,
        client_id: client.clientId,
        client_secret: await clientSecret(env, client.clientId),
        client_id_issued_at: Math.floor(client.created / 1000),
        client_secret_expires_at: 0,
      },
      { status: 201 },
    );
  }
  if (url.pathname === "/authorize" || url.pathname === "/continue") {
    requireValue(origin === env.PUBLIC_ORIGIN, "invalid_origin", 403);
    const f = await form(request);
    only(
      f,
      url.pathname === "/continue"
        ? ["flow", "csrf", "saved"]
        : ["flow", "csrf", "decision", "recovery"],
    );
    const flowId = await parseCapability(env, f.get("flow") ?? "", "flow"),
      csrf = f.get("csrf") ?? "";
    const flow = env.FLOWS.getByName(flowId),
      browserHash = await hash(cookie(request, cookieName(env))),
      csrfHash = await hash(csrf);
    if (url.pathname === "/continue") {
      requireValue(f.get("saved") === "yes");
      const result = await flow.continuation(flowId, browserHash, csrfHash);
      return oauthResponse(
        new Response(null, {
          status: 303,
          headers: {
            Location: redirect(result.authorization, result.code),
            "Set-Cookie": `${cookieName(env)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${env.PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : ""}`,
          },
        }),
        result.authorization.redirectUri,
      );
    }
    const choice = f.get("decision");
    requireValue(choice === "new" || choice === "recover" || choice === "deny");
    const recovery = f.get("recovery") ?? "";
    const target =
      choice === "recover"
        ? {
            locator: await parseCapability(env, recovery, "recovery"),
            recoveryHash: await hash(recovery),
          }
        : undefined;
    const result = await flow.finish(
      flowId,
      browserHash,
      csrfHash,
      choice,
      target,
    );
    if (result.denied)
      return oauthResponse(
        new Response(null, {
          status: 303,
          headers: { Location: redirect(result.authorization) },
        }),
        result.authorization.redirectUri,
      );
    return oauthResponse(
      new Response(
        recoveryKeyPage({
          flow: f.get("flow")!,
          csrf,
          recovery: result.recovery,
          replacing: choice === "recover",
        }),
        { headers: { "Content-Type": "text/html;charset=utf-8" } },
      ),
      result.authorization.redirectUri,
    );
  }
  if (url.pathname === "/token") {
    const f = await form(request);
    only(f, [
      "client_id",
      "client_secret",
      "grant_type",
      "code",
      "code_verifier",
      "redirect_uri",
      "refresh_token",
      "resource",
      "scope",
    ]);
    let client = f.get("client_id"),
      secret = f.get("client_secret");
    const auth = request.headers.get("authorization");
    if (auth) {
      requireValue(
        !f.has("client_secret") && /^Basic [A-Za-z0-9+/]+=*$/.test(auth),
        "invalid_client",
        401,
      );
      const decoded = atob(auth.slice(6)),
        i = decoded.indexOf(":");
      requireValue(i >= 0, "invalid_client", 401);
      const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, " "));
      const basicId = decode(decoded.slice(0, i));
      requireValue(
        client === null || client === basicId,
        "invalid_client",
        401,
      );
      client = basicId;
      secret = decode(decoded.slice(i + 1));
    }
    requireValue(client && secret, "invalid_client", 401);
    if (client === env.CLIENT_ID) {
      requireValue(
        (await hash(secret)) === (await hash(env.CLIENT_SECRET)),
        "invalid_client",
        401,
      );
    } else {
      requireValue(
        env.DCR_ENABLED === "true" && isDynamicClient(client),
        "invalid_client",
        401,
      );
      const registered = await env.CLIENTS.getByName("chatgpt").lookup(client);
      requireValue(
        registered &&
          registered.secretHash === (await hash(secret)) &&
          registered.metadata.token_endpoint_auth_method ===
            (auth ? "client_secret_basic" : "client_secret_post"),
        "invalid_client",
        401,
      );
    }
    requireValue(
      f.get("resource") === `${env.PUBLIC_ORIGIN}/mcp` &&
        (!f.has("scope") || f.get("scope") === SCOPE),
    );
    const kind =
      f.get("grant_type") === "authorization_code"
        ? "code"
        : f.get("grant_type") === "refresh_token"
          ? "refresh"
          : undefined;
    requireValue(kind, "unsupported_grant_type");
    const credential = f.get(kind === "code" ? "code" : "refresh_token") ?? "";
    const locator = await parseCapability(env, credential, kind);
    const access = await capability(env, "access", locator),
      refresh = await capability(env, "refresh", locator);
    const verifier = f.get("code_verifier") ?? "";
    if (kind === "code")
      requireValue(/^[A-Za-z0-9._~-]{43,128}$/.test(verifier), "invalid_grant");
    const result = await env.VAULTS.getByName(locator).exchange({
      clientId: client,
      kind,
      digest: await hash(credential),
      accessHash: await hash(access),
      refreshHash: await hash(refresh),
      ...(kind === "code"
        ? {
            challenge: await hash(verifier),
            redirectUri: f.get("redirect_uri") ?? "",
          }
        : {}),
    });
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      scope: SCOPE,
    });
  }
  if (url.pathname === "/mcp") {
    requireValue(
      request.headers.get("content-type")?.split(";")[0] === "application/json",
    );
    const text = await body(request);
    const auth = request.headers.get("authorization");
    let identity: { locator: string; digest: string } | undefined;
    if (auth) {
      try {
        requireValue(auth.startsWith("Bearer "), "invalid_token", 401);
        const credential = auth.slice(7);
        identity = {
          locator: await parseCapability(env, credential, "access"),
          digest: await hash(credential),
        };
        await env.VAULTS.getByName(identity.locator).check(identity.digest);
      } catch {
        return Response.json(
          { error: "invalid_token" },
          { status: 401, headers: { "WWW-Authenticate": challenge(env) } },
        );
      }
    }
    const server = createServer(env, identity),
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: 98304,
      });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: text,
        }),
      );
      const bytes = await response.arrayBuffer();
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      await server.close();
    }
  }
  throw new Failure("not_found", 404);
}
export default {
  async fetch(request: Request, env: Env) {
    let response: Response;
    try {
      response = await handle(request, env);
    } catch (e) {
      const code = e instanceof Failure ? e.code : "request_failed";
      const status = e instanceof Failure ? e.status : 400;
      // Human-facing OAuth errors get the same accessible shell; API clients
      // keep their existing JSON status/error contract. Never reflect input.
      const browserPage =
        ["/authorize", "/continue"].includes(new URL(request.url).pathname) &&
        request.headers.get("accept")?.includes("text/html");
      response = browserPage
        ? new Response(authorizationErrorPage(code), {
            status,
            headers: {
              "Content-Type": "text/html;charset=utf-8",
              "Content-Security-Policy": `${contentSecurityPolicy()}; style-src 'self'; img-src 'self'`,
            },
          })
        : Response.json({ error: code }, { status });
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Pragma", "no-cache");
    if (!headers.has("Referrer-Policy"))
      headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    if (!headers.has("Content-Security-Policy"))
      headers.set("Content-Security-Policy", contentSecurityPolicy());
    const origin = request.headers.get("origin");
    if (
      new URL(request.url).pathname === "/mcp" &&
      origin &&
      [
        env.PUBLIC_ORIGIN,
        "https://chatgpt.com",
        "https://chat.openai.com",
      ].includes(origin)
    ) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id",
      );
      headers.set(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
    }
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: unknown, env: Env) {
    await Promise.all(
      "0123456789abcdef"
        .split("")
        .map((shard) => env.CLEANUP.getByName(`gc-${shard}`).sweep()),
    );
    await env.CLIENTS.getByName("chatgpt").collect();
  },
};

import express, { type Request, type Response } from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { equalSecret, SCOPE } from "./config.js";
import { challenge, createProbeServer } from "./mcp.js";
import { type Authorization, GuestAuthStore } from "./store.js";

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guest OAuth PoC</title><body>${body}</body></html>`;

function field(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.length <= 4096 ? value : undefined;
}

function cookie(req: Request, name: string): string | undefined {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
}

function bearer(req: Request): string | undefined {
  const value = req.headers.authorization;
  return value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
}

export function createProbeApp(store: GuestAuthStore, widgetHtml: string) {
  const app = express();
  const config = store.config;
  const cookieName = config.origin.startsWith("https:")
    ? "__Host-poc_authorize"
    : "poc_authorize";
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    const host = req.headers.host ?? "";
    const allowedHost =
      host === new URL(config.origin).host ||
      /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
    if (!allowedHost) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== config.origin &&
      !(
        req.path === "/mcp" &&
        ["https://chatgpt.com", "https://chat.openai.com"].includes(origin)
      )
    ) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    const authHeaders = req.rawHeaders.filter(
      (_value, index) =>
        index % 2 === 0 &&
        req.rawHeaders[index]!.toLowerCase() === "authorization",
    );
    if (authHeaders.length > 1) {
      res.status(400).json({ error: "Duplicate authorization header" });
      return;
    }
    next();
  });
  app.use(
    express.urlencoded({ extended: false, limit: "12kb", parameterLimit: 24 }),
  );
  app.use(express.json({ limit: "24kb", strict: true }));
  app.get("/", (_req, res) =>
    res
      .type("html")
      .send(
        page(
          "<h1>Isolated guest OAuth compatibility probe</h1><p>Synthetic identities only. This is not Basket Wise and contains no shopping data.</p><p>Add this origin’s /mcp endpoint to an OAuth-enabled test connection only after separately authorizing public exposure.</p>",
        ),
      ),
  );
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      service: "guest-oauth-poc",
      hostCompatibility: "not-verified",
    }),
  );
  app.get(
    [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ],
    (_req, res) =>
      res.json({
        resource: `${config.origin}/mcp`,
        authorization_servers: [config.origin],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
      }),
  );
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
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
    }),
  );
  app.get("/authorize", (req, res) => {
    const get = (name: string) => field(req.query, name);
    const authorization: Authorization = {
      clientId: get("client_id") ?? "",
      redirectUri: get("redirect_uri") ?? "",
      state: get("state") ?? "",
      challenge: get("code_challenge") ?? "",
      resource: get("resource") ?? "",
      scope: get("scope") ?? "",
    };
    if (
      get("response_type") !== "code" ||
      authorization.clientId !== config.clientId ||
      !config.redirectUris.includes(authorization.redirectUri) ||
      !authorization.state ||
      get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(authorization.challenge) ||
      authorization.resource !== `${config.origin}/mcp` ||
      authorization.scope !== SCOPE
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let intent;
    try {
      intent = store.beginAuthorization(authorization);
    } catch {
      res.status(429).json({ error: "temporarily_unavailable" });
      return;
    }
    res.cookie(cookieName, intent.browser, {
      httpOnly: true,
      secure: config.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 300_000,
    });
    res
      .type("html")
      .send(
        page(
          `<h1>Continue as a temporary guest</h1><p>No Basket Wise account, email, or password is needed. This isolated test may read your synthetic guest identifier, not shopping data.</p><p>The guest expires after at most ${config.guestTtlSeconds} seconds. There is no recovery.</p><form method="post" action="/authorize"><input type="hidden" name="interaction" value="${html(intent.interaction)}"><input type="hidden" name="csrf" value="${html(intent.csrf)}"><button name="decision" value="approve">Continue as guest</button> <button name="decision" value="deny">Cancel</button></form>`,
        ),
      );
  });
  app.post("/authorize", (req, res) => {
    if (
      req.headers.origin !== config.origin ||
      !req.is("application/x-www-form-urlencoded")
    ) {
      res.status(403).json({ error: "invalid_request" });
      return;
    }
    const interaction = field(req.body, "interaction"),
      csrf = field(req.body, "csrf"),
      browser = cookie(req, cookieName),
      decision = field(req.body, "decision");
    if (
      !interaction ||
      !csrf ||
      !browser ||
      !["approve", "deny"].includes(decision ?? "")
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = store.finishAuthorization({
      interaction,
      csrf,
      browser,
      approve: decision === "approve",
    });
    if ("error" in result) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: config.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
    });
    res.redirect(303, result.redirect);
  });
  app.post("/token", (req, res) => {
    if (
      !req.is("application/x-www-form-urlencoded") ||
      Object.keys(req.query).length
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let clientId = field(req.body, "client_id"),
      clientSecret = field(req.body, "client_secret");
    if (req.headers.authorization) {
      if (clientSecret !== undefined) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      try {
        const encoded = req.headers.authorization.match(
          /^Basic ([A-Za-z0-9+/]+={0,2})$/i,
        )?.[1];
        if (!encoded) throw new Error("Invalid basic auth");
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon < 0) throw new Error("Invalid basic auth");
        const decode = (part: string) =>
          decodeURIComponent(part.replace(/\+/g, " "));
        const basicId = decode(decoded.slice(0, colon));
        if (clientId !== undefined && clientId !== basicId)
          throw new Error("Conflicting client");
        clientId = basicId;
        clientSecret = decode(decoded.slice(colon + 1));
      } catch {
        res
          .status(401)
          .set("WWW-Authenticate", 'Basic realm="guest-oauth-poc"')
          .json({ error: "invalid_client" });
        return;
      }
    }
    if (
      clientId !== config.clientId ||
      !clientSecret ||
      !equalSecret(clientSecret, config.clientSecret)
    ) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Basic realm="guest-oauth-poc"')
        .json({ error: "invalid_client" });
      return;
    }
    const grantType = field(req.body, "grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const credential = field(
      req.body,
      grantType === "authorization_code" ? "code" : "refresh_token",
    );
    const resource = field(req.body, "resource");
    if (!credential) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (resource !== `${config.origin}/mcp`) {
      res.status(400).json({ error: "invalid_target" });
      return;
    }
    const result = store.exchange({
      kind: grantType === "authorization_code" ? "code" : "refresh",
      credential,
      clientId,
      resource,
      ...(field(req.body, "redirect_uri") !== undefined
        ? { redirectUri: field(req.body, "redirect_uri")! }
        : {}),
      ...(field(req.body, "code_verifier") !== undefined
        ? { verifier: field(req.body, "code_verifier")! }
        : {}),
      ...(field(req.body, "scope") !== undefined
        ? { scope: field(req.body, "scope")! }
        : {}),
    });
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result.tokens);
  });
  app.post("/mcp", async (req, res) => {
    if (!req.is("application/json") || Object.keys(req.query).length) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const access = bearer(req);
    if (
      req.headers.authorization !== undefined &&
      (!access || !store.authenticate(access))
    ) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge(config, true))
        .json({ error: "invalid_token" });
      return;
    }
    const server = createProbeServer(store, widgetHtml, access);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
      await server.close();
    }
  });
  app.all(["/mcp", "/token", "/authorize"], (_req, res) =>
    res.status(405).json({ error: "method_not_allowed" }),
  );
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(
    (
      _error: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent) res.status(400).json({ error: "invalid_request" });
    },
  );
  return app;
}

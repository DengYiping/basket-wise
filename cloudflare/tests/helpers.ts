import {
  Miniflare,
  convertV4MiniflareOptions,
  type V4MiniflareOptions,
} from "miniflare";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
export const ORIGIN = "http://127.0.0.1";
export const CALLBACK = "https://chatgpt.com/connector/oauth/test-callback";
export const DCR_CALLBACK =
  "https://chatgpt.com/connector_platform_oauth_redirect";
export const secret = "local-test-client-secret-not-for-production";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("base64url");
export async function setup(
  optionsOverride: {
    enrollment?: string;
    domainVerificationToken?: string;
    dcr?: string;
    publicPages?: string;
    publicContact?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "bw-cloudflare-"));
  const options: V4MiniflareOptions = {
    name: "basket-wise-durable",
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-10-10",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 0,
    inspectorPort: 0,
    cf: false,
    bindings: {
      PUBLIC_ORIGIN: ORIGIN,
      CLIENT_ID: "basket-test",
      CLIENT_SECRET: secret,
      ROOT_KEY: "local-test-root-key-only-01234567890123456789012",
      REDIRECT_URIS: JSON.stringify([CALLBACK, DCR_CALLBACK]),
      ENROLLMENT_ENABLED: optionsOverride.enrollment ?? "true",
      DCR_ENABLED: optionsOverride.dcr ?? "false",
      PUBLIC_PAGES_ENABLED: optionsOverride.publicPages ?? "false",
      ...(optionsOverride.publicContact !== undefined
        ? { PUBLIC_CONTACT: optionsOverride.publicContact }
        : {}),
      ...(optionsOverride.domainVerificationToken !== undefined
        ? {
            OPENAI_DOMAIN_VERIFICATION_TOKEN:
              optionsOverride.domainVerificationToken,
          }
        : {}),
    },
    durableObjects: {
      VAULTS: { className: "GuestVault", useSQLite: true },
      FLOWS: { className: "AuthorizationFlow", useSQLite: true },
      CLEANUP: { className: "CleanupIndex", useSQLite: true },
      CLIENTS: { className: "OAuthClients", useSQLite: true },
    },
    durableObjectsPersist: directory,
    ratelimits: {
      RATE_LIMITER: {
        namespace_id: "2001",
        simple: { limit: 10000, period: 60 },
      },
    },
    outboundService: () => {
      throw new Error("Tests prohibit outbound network access");
    },
  };
  const converted = convertV4MiniflareOptions(options);
  converted.telemetry = { enabled: false };
  converted.resourcePersistencePath = directory;
  converted.unsafeInspectDurableObjects = true;
  let mf = new Miniflare(converted);
  await mf.ready;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await mf.dispatchFetch(
      `${ORIGIN}${path}`,
      init as Parameters<typeof mf.dispatchFetch>[1],
    );
    // Drain every response, including assertions that inspect only its status.
    const bytes = await response.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, {
      status: response.status,
      headers: [...response.headers],
    });
  };
  const post = (
    path: string,
    params: Record<string, string>,
    cookie?: string,
  ) =>
    request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(params).toString(),
      redirect: "manual",
    });
  async function begin(clientId = "basket-test", callback = CALLBACK) {
    const verifier = digest(randomUUID()),
      params = {
        client_id: clientId,
        response_type: "code",
        redirect_uri: callback,
        state: randomUUID(),
        code_challenge: digest(verifier),
        code_challenge_method: "S256",
        resource: `${ORIGIN}/mcp`,
        scope: "basket:manage",
      };
    const response = await request(`/authorize?${new URLSearchParams(params)}`);
    assert.equal(response.status, 200);
    const html = await response.text(),
      flow = html.match(/name="flow" value="([^"]+)"/)![1]!,
      csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    return {
      verifier,
      flow,
      csrf,
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      state: params.state,
    };
  }
  async function enroll(
    recover?: string,
    clientId = "basket-test",
    callback = CALLBACK,
  ) {
    const flow = await begin(clientId, callback);
    const response = await post(
      "/authorize",
      {
        flow: flow.flow,
        csrf: flow.csrf,
        decision: recover ? "recover" : "new",
        ...(recover ? { recovery: recover } : {}),
      },
      flow.cookie,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text(),
      recovery = html.match(/<pre>([^<]+)<\/pre>/)![1]!;
    const continued = await post(
      "/continue",
      { flow: flow.flow, csrf: flow.csrf, saved: "yes" },
      flow.cookie,
    );
    assert.equal(continued.status, 303, await continued.clone().text());
    const returned = new URL(continued.headers.get("location")!);
    assert.equal(returned.searchParams.get("state"), flow.state);
    assert.equal(returned.searchParams.get("iss"), ORIGIN);
    return {
      ...flow,
      code: returned.searchParams.get("code")!,
      recovery,
      locator: recovery.split(".")[2]!,
    };
  }
  async function exchange(
    code: string,
    verifier: string,
    clientId = "basket-test",
    clientSecret = secret,
    callback = CALLBACK,
  ) {
    return post("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: `${ORIGIN}/mcp`,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }
  async function connected() {
    const enrollment = await enroll();
    const response = await exchange(enrollment.code, enrollment.verifier);
    assert.equal(response.status, 200, await response.clone().text());
    return { ...enrollment, tokens: (await response.json()) as any };
  }
  async function rpc(method: string, params: unknown = {}, token?: string) {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
    });
    return { response, payload: (await response.json()) as any };
  }
  async function basket(
    token: string,
    action: unknown,
    revision?: number,
    activityId = randomUUID(),
  ) {
    const { kind, ...parameters } = action as Record<string, unknown>;
    const read = ["get_basket", "list_trips", "suggest_removals"].includes(
      String(kind),
    );
    return rpc(
      "tools/call",
      {
        name: kind,
        arguments: {
          ...parameters,
          ...(read ? { activityId } : {}),
          ...(revision === undefined ? {} : { expectedRevision: revision }),
          ...(!read
            ? { dataEpoch: (await record(token.split(".")[2]!))?.dataEpoch }
            : {}),
        },
      },
      token,
    );
  }
  async function sql(className: string, locator: string) {
    return mf.unsafeGetDurableObjectStorage("basket-wise-durable", className, {
      name: locator,
    });
  }
  async function record(locator: string, key = "meta") {
    const storage = await sql("GuestVault", locator);
    const tables = await storage.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
    );
    if (!tables.length) return undefined;
    const rows = await storage.exec(
      "SELECT value FROM documents WHERE key = ?",
      key,
    );
    return rows[0] ? JSON.parse(rows[0].value as string) : undefined;
  }
  async function setRecord(locator: string, key: string, value: unknown) {
    await (
      await sql("GuestVault", locator)
    ).exec(
      "UPDATE documents SET value = ? WHERE key = ?",
      JSON.stringify(value),
      key,
    );
  }
  async function vault(locator: string): Promise<any> {
    return ((await mf.getDurableObjectNamespace("VAULTS")) as any).getByName(
      locator,
    );
  }
  return {
    request,
    post,
    begin,
    enroll,
    exchange,
    connected,
    rpc,
    basket,
    sql,
    record,
    setRecord,
    vault,
    get mf() {
      return mf;
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(converted);
      await mf.ready;
    },
    async close() {
      await mf.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

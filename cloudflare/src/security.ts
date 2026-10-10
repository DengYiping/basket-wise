import type { Env, Authorization } from "./types.js";
export const DAY = 86_400_000;
export const FLOW_TTL = 600_000;
export const ACCESS_TTL = 600_000;
export const CODE_TTL = 60_000;
export const SCOPE = "basket:manage";
export const VERSION = "0.5.0";
export const PROFILE_TTL = 90 * DAY;
// Fixed policy-change boundary: never revive a legacy guest already expired
// before this migration. Do not move this cutoff in subsequent releases.
export const LEGACY_PROFILE_CUTOFF = Date.parse("2026-10-10T17:17:26Z");
export const CHATGPT_CALLBACK =
  "https://chatgpt.com/connector_platform_oauth_redirect";
export const isDynamicClient = (clientId: string) =>
  /^bw-dcr-[a-f0-9]{32}$/.test(clientId);
export class Failure extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function requireValue(
  ok: unknown,
  code = "invalid_request",
  status = 400,
): asserts ok {
  if (!ok) throw new Failure(code, status);
}
export const base64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
export const hash = async (value: string) =>
  base64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
async function mac(env: Env, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ROOT_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}
// Recover an idempotent registration response without storing its raw secret.
export const clientSecret = (env: Env, clientId: string) =>
  mac(env, `oauth-client-secret:${clientId}`);
// Opaque credentials carry a signed locator; neither the locator nor signature alone authorizes access.
export async function capability(
  env: Env,
  kind: string,
  id: string,
  seed = random(),
) {
  const body = `v1.${kind}.${id}.${seed}`;
  return `${body}.${await mac(env, `route:${body}`)}`;
}
export async function parseCapability(
  env: Env,
  value: string,
  kind: string,
): Promise<string> {
  const parts = value.split(".");
  requireValue(
    parts.length === 5 &&
      parts[0] === "v1" &&
      parts[1] === kind &&
      /^[a-f0-9]{32}$/.test(parts[2]!) &&
      /^[A-Za-z0-9_-]{43}$/.test(parts[3]!),
    "invalid_credential",
    401,
  );
  requireValue(
    (await hash(parts[4]!)) ===
      (await hash(await mac(env, `route:${parts.slice(0, 4).join(".")}`))),
    "invalid_credential",
    401,
  );
  return parts[2]!;
}
export const id = () => crypto.randomUUID().replace(/-/g, "");
export async function issuance(env: Env, flow: string, vault: string) {
  return {
    code: await capability(env, "code", vault, await mac(env, `code:${flow}`)),
    recovery: await capability(
      env,
      "recovery",
      vault,
      await mac(env, `recovery:${flow}`),
    ),
  };
}
export function config(env: Env) {
  const url = new URL(env.PUBLIC_ORIGIN);
  requireValue(
    url.origin === env.PUBLIC_ORIGIN &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))),
    "configuration_error",
    503,
  );
  requireValue(
    env.ROOT_KEY?.length >= 43 &&
      env.CLIENT_SECRET?.length >= 32 &&
      /^[\w-]{1,100}$/.test(env.CLIENT_ID),
    "configuration_error",
    503,
  );
  const redirects: unknown = JSON.parse(env.REDIRECT_URIS);
  requireValue(
    Array.isArray(redirects) &&
      redirects.length > 0 &&
      redirects.every((x) => {
        if (typeof x !== "string") return false;
        const r = new URL(x);
        return !r.hash && !r.username && !r.password && r.protocol === "https:";
      }),
    "configuration_error",
    503,
  );
  return redirects as string[];
}
export async function authorization(
  env: Env,
  params: URLSearchParams,
): Promise<Authorization> {
  const redirects = config(env);
  const a = {
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    challenge: params.get("code_challenge") ?? "",
    resource: params.get("resource") ?? "",
    scope: params.get("scope") ?? "",
  };
  requireValue(
    params.get("response_type") === "code" &&
      params.get("code_challenge_method") === "S256" &&
      (a.clientId === env.CLIENT_ID ||
        (env.DCR_ENABLED === "true" && isDynamicClient(a.clientId))) &&
      redirects.includes(a.redirectUri) &&
      a.state.length > 0 &&
      a.state.length <= 2048 &&
      /^[\w-]{43}$/.test(a.challenge) &&
      a.resource === `${env.PUBLIC_ORIGIN}/mcp` &&
      a.scope === SCOPE,
  );
  if (a.clientId !== env.CLIENT_ID) {
    const client = await env.CLIENTS.getByName("chatgpt").lookup(a.clientId);
    requireValue(
      client && client.metadata.redirect_uris.includes(a.redirectUri),
    );
    return a;
  }
  return a;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function distinct(params: URLSearchParams) {
  const keys = [...params.keys()];
  requireValue(new Set(keys).size === keys.length);
  return params;
}
export function redirect(a: Authorization, code?: string) {
  const u = new URL(a.redirectUri);
  u.searchParams.set("state", a.state);
  u.searchParams.set("iss", new URL(a.resource).origin);
  u.searchParams.set(code ? "code" : "error", code ?? "access_denied");
  return u.toString();
}

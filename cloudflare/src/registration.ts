import type { ClientMetadata, Env } from "./types.js";
import { CHATGPT_CALLBACK, SCOPE, config, requireValue } from "./security.js";

// Deliberately narrower than general RFC 7591: one known ChatGPT callback,
// confidential clients, one resource/scope, code+PKCE, and no remote URL fetches.
export function registration(env: Env, raw: unknown): ClientMetadata {
  requireValue(env.DCR_ENABLED === "true", "not_found", 404);
  requireValue(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "invalid_client_metadata",
  );
  const m = raw as Record<string, unknown>;
  requireValue(
    Object.keys(m).every((k) =>
      [
        "redirect_uris",
        "client_name",
        "token_endpoint_auth_method",
        "grant_types",
        "response_types",
        "scope",
      ].includes(k),
    ),
    "invalid_client_metadata",
  );
  requireValue(
    config(env).includes(CHATGPT_CALLBACK) &&
      Array.isArray(m.redirect_uris) &&
      m.redirect_uris.length === 1 &&
      m.redirect_uris[0] === CHATGPT_CALLBACK,
    "invalid_redirect_uri",
  );
  const method = m.token_endpoint_auth_method ?? "client_secret_basic";
  requireValue(
    method === "client_secret_basic" || method === "client_secret_post",
    "invalid_client_metadata",
  );
  const grants = m.grant_types ?? ["authorization_code", "refresh_token"];
  requireValue(
    Array.isArray(grants) &&
      grants.length === 2 &&
      grants.includes("authorization_code") &&
      grants.includes("refresh_token"),
    "invalid_client_metadata",
  );
  const responses = m.response_types ?? ["code"];
  requireValue(
    Array.isArray(responses) &&
      responses.length === 1 &&
      responses[0] === "code",
    "invalid_client_metadata",
  );
  requireValue(
    m.scope === undefined || m.scope === SCOPE,
    "invalid_client_metadata",
  );
  requireValue(
    m.client_name === undefined ||
      (typeof m.client_name === "string" &&
        m.client_name.trim().length > 0 &&
        m.client_name.length <= 128 &&
        !/[\x00-\x1f\x7f]/.test(m.client_name)),
    "invalid_client_metadata",
  );
  return {
    redirect_uris: [CHATGPT_CALLBACK],
    ...(m.client_name === undefined
      ? {}
      : { client_name: m.client_name as string }),
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
  };
}

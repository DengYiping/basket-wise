import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { validateConfig, SCOPE, type Config } from "../src/config.js";
import {
  digest,
  GuestAuthStore,
  type Authorization,
  type Tokens,
} from "../src/store.js";

export const testConfig = (overrides: Partial<Config> = {}): Config =>
  validateConfig({
    origin: "https://poc.invalid",
    clientId: "test-client",
    clientSecret: "local-test-only-" + "x".repeat(32),
    redirectUris: ["http://127.0.0.1:7331/callback"],
    accessTtlSeconds: 10,
    guestTtlSeconds: 300,
    ...overrides,
  });

export function authorization(
  config: Config,
  overrides: Partial<Authorization> = {},
) {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    auth: {
      clientId: config.clientId,
      redirectUri: config.redirectUris[0]!,
      state: "test-state-opaque",
      challenge: digest(verifier),
      resource: `${config.origin}/mcp`,
      scope: SCOPE,
      ...overrides,
    },
  };
}

export function authorize(
  store: GuestAuthStore,
  overrides: Partial<Authorization> = {},
) {
  const { verifier, auth } = authorization(store.config, overrides);
  const interaction = store.beginAuthorization(auth);
  const approved = store.finishAuthorization({ ...interaction, approve: true });
  assert.ok("redirect" in approved);
  const code = new URL(approved.redirect).searchParams.get("code");
  assert.ok(code);
  return { verifier, auth, interaction, code };
}

export function issue(store: GuestAuthStore): Tokens {
  const { verifier, auth, code } = authorize(store);
  const result = store.exchange({
    kind: "code",
    credential: code,
    clientId: auth.clientId,
    resource: auth.resource,
    redirectUri: auth.redirectUri,
    verifier,
  });
  assert.ok("tokens" in result);
  return result.tokens;
}

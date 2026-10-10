import { timingSafeEqual, createHash } from "node:crypto";

export { SCOPE, VERSION } from "./constants.js";

export interface Config {
  origin: string;
  clientId: string;
  clientSecret: string;
  redirectUris: readonly string[];
  accessTtlSeconds: number;
  guestTtlSeconds: number;
}

export function equalSecret(actual: string, expected: string): boolean {
  // Hash first so timingSafeEqual never has a variable-length comparison.
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}

export function validateConfig(config: Config): Config {
  const origin = new URL(config.origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    origin.origin !== config.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))
  ) {
    throw new Error(
      "POC_PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback is local-test only).",
    );
  }
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(config.clientId) ||
    config.clientSecret.length < 32
  ) {
    throw new Error(
      "Provide a simple POC_CLIENT_ID and a POC_CLIENT_SECRET of at least 32 characters.",
    );
  }
  if (config.redirectUris.length === 0)
    throw new Error("At least one exact redirect URI is required.");
  for (const redirect of config.redirectUris) {
    const url = new URL(redirect);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    )
      throw new Error(
        "Redirect URIs must use HTTPS (HTTP loopback is local-test only), without credentials or fragments.",
      );
  }
  if (
    !Number.isSafeInteger(config.accessTtlSeconds) ||
    config.accessTtlSeconds < 5 ||
    config.accessTtlSeconds > 300 ||
    !Number.isSafeInteger(config.guestTtlSeconds) ||
    config.guestTtlSeconds <= config.accessTtlSeconds ||
    config.guestTtlSeconds > 3600
  )
    throw new Error(
      "Access lifetime must be 5–300 seconds; guest lifetime must be longer and at most 3600 seconds.",
    );
  return Object.freeze({
    ...config,
    redirectUris: Object.freeze([...config.redirectUris]),
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  return validateConfig({
    origin: env.POC_PUBLIC_ORIGIN ?? "http://127.0.0.1:3417",
    clientId: env.POC_CLIENT_ID ?? "guest-oauth-poc",
    clientSecret: env.POC_CLIENT_SECRET ?? "",
    redirectUris: env.POC_REDIRECT_URIS
      ? (JSON.parse(env.POC_REDIRECT_URIS) as string[])
      : [],
    accessTtlSeconds: Number(env.POC_ACCESS_TTL_SECONDS ?? 90),
    guestTtlSeconds: Number(env.POC_GUEST_TTL_SECONDS ?? 1800),
  });
}

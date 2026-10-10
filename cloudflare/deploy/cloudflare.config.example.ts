import { bindings, defineConfig, exports, triggers } from "cf/config";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before loading deployment config.`);
  return value;
}

const origin = new URL(requiredEnvironment("PUBLIC_ORIGIN"));
if (origin.protocol !== "https:" || origin.username || origin.password) {
  throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without credentials.");
}

// Copy to ignored cloudflare.config.ts and configure your own account.
export default defineConfig({
  accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
  worker: {
    name: "basket-wise-durable",
    entrypoint: "../dist/worker.js",
    compatibilityDate: "2026-10-10",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    domains: [origin.hostname],
    observability: { enabled: false },
    exports: {
      GuestVault: exports.durableObject({ storage: "sqlite" }),
      AuthorizationFlow: exports.durableObject({ storage: "sqlite" }),
      CleanupIndex: exports.durableObject({ storage: "sqlite" }),
      OAuthClients: exports.durableObject({ storage: "sqlite" }),
    },
    triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
    env: {
      PUBLIC_ORIGIN: bindings.text(origin.origin),
      CLIENT_ID: bindings.text("basket-wise-chatgpt"),
      REDIRECT_URIS: bindings.text(
        JSON.stringify([
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ]),
      ),
      ENROLLMENT_ENABLED: bindings.text("true"),
      DCR_ENABLED: bindings.text("true"),
      PUBLIC_PAGES_ENABLED: bindings.text("true"),
      PUBLIC_CONTACT: bindings.text(requiredEnvironment("PUBLIC_CONTACT")),
      OPENAI_DOMAIN_VERIFICATION_TOKEN: bindings.text(
        process.env.OPENAI_DOMAIN_VERIFICATION_TOKEN ?? "",
      ),
      CLIENT_SECRET: bindings.secret(),
      ROOT_KEY: bindings.secret(),
      VAULTS: bindings.durableObject({
        worker: "basket-wise-durable",
        exportName: "GuestVault",
      }),
      FLOWS: bindings.durableObject({
        worker: "basket-wise-durable",
        exportName: "AuthorizationFlow",
      }),
      CLEANUP: bindings.durableObject({
        worker: "basket-wise-durable",
        exportName: "CleanupIndex",
      }),
      CLIENTS: bindings.durableObject({
        worker: "basket-wise-durable",
        exportName: "OAuthClients",
      }),
      RATE_LIMITER: bindings.rateLimit({
        namespace: "2001",
        simple: { limit: 120, period: 60 },
      }),
    },
  },
});

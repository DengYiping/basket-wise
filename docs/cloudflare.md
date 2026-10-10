# Cloudflare guest deployment

Version 0.4.0 adds a separate **no-sign-in, one-trip guest app**. The existing
local SQLite/stdio application is unchanged and must never be publicly exposed.

## Components and data flow

1. Cloudflare Workers Static Assets serves the self-contained guest widget.
2. The widget restores `{ basketWiseGuest: ... }` using ChatGPT `widgetState`
   and writes updated snapshots using `setWidgetState`. If unavailable, the UI
   explicitly says the basket is only in memory. There is no localStorage or
   cookie fallback, account identifier, or cross-widget lookup.
3. The widget sends its full snapshot and the requested action to the Worker
   through the host's MCP bridge. A new request-scoped MCP server validates and
   calculates the replacement snapshot; it does not retain the basket.
4. The widget saves the response and updates the model's context so chat actions
   can use the latest complete state. Older/conflicting responses are rejected.

Workers and Static Assets are the only hosting/storage components; a native
Workers rate-limit binding supplies abuse protection. **No D1, Durable Object,
KV, R2, Auth0, Clerk, OpenAI API key, or database binding is used.**

Guest updates are stateless transformations, not server database mutations.
The private local store still uses atomic SQLite transactions and persistent
idempotency. Guest snapshots retain only 32 retry receipts; that is a bounded
session aid, not a durable or tamper-proof transaction ledger. Reusing the same
base snapshot and operation ID cannot append two lines; item IDs are stable.

Limits: 50 lines, 64 KiB validated state, 96 KiB request body, 120 MCP requests
per minute per source IP (shared-network users may share this allowance).
Cloudflare's distributed limiter is approximate, not a billing ceiling.
The public Worker fails closed if the rate-limit binding is missing. There are
no custom request-body logs; Workers observability is disabled in the manifest.
Cloudflare still processes requests and may retain platform/security metadata;
ChatGPT may retain the conversation. This is not anonymous internet browsing.

## Build and test locally

```sh
npm ci
npm run check
npm run check:guest
npm run dev:guest
```

`check:guest` bundles the real Worker with Wrangler's dry run; it does not deploy.
The local Worker exposes `/mcp` and `/health`. Opening `/` in a normal browser is
an explicitly labeled, in-memory guest preview, not real ChatGPT persistence.
The unit/protocol tests exercise the same handler without deploying a service.

## Publish to your Cloudflare account

Publishing requires a Cloudflare account you control. No account, billed plan,
domain or authentication provider is created automatically. Review Cloudflare's
current plan limits before deployment; upgrading a plan requires your approval.

```sh
npm exec wrangler login
npm exec wrangler whoami
npm run check:guest
npm run deploy:guest
```

Keep credentials in Wrangler's managed local credential store, not Git. Retain
the **actual HTTPS URL** returned by deployment. Its `/mcp` path is the endpoint
for a ChatGPT development connection configured with **no authentication**.
Do not point ChatGPT at the local `src/http.ts` server. Do not invent a URL or
replace `mcp.json` with an unverified endpoint; it remains the local stdio setup.
For a public release, make a separate submission copy with the verified remote
endpoint after completing `submission/README.md`.

## Required real-host checks

- Open in ChatGPT without a Basket Wise login; start an empty guest basket.
- Add/edit/remove items, change currency in a new trip, and hit custom targets.
- Reload the same widget and check what the host actually restores. This is a
  best-effort behavior, not a durability guarantee.
- Start another independent widget: no other basket is fetched from the server.
- Make an edit in the UI, then another in chat; the latter must use the updated
  full snapshot. Do not accept silent resets or missing items.
- Reject missing/ambiguous photo years. Confirm a complete date before adding it.
- Check starting another trip requires confirmation and replaces the old one.
- Test on the intended phone. A browser preview or local test is not proof of
  ChatGPT mobile compatibility or real `setWidgetState` restoration.

## Retention and scope

There is intentionally no server-side delete/export API because no basket is
stored there. Starting a new guest trip replaces the current widget snapshot;
it does **not** delete ChatGPT messages or tool results. No history, shared
baskets, cross-device recovery, permanent expiry list, push notification, or
scheduled reminder is promised. Finished baskets and date records remain
temporary. A future authenticated mode needs a separate security design.

# Isolated guest OAuth compatibility PoC

This is **not the Basket Wise app**, a production OAuth provider, or evidence that
ChatGPT accepts guest enrollment. It is a local test harness plus a small MCP App
for a later, separately authorized host-compatibility experiment. Nothing here
starts a tunnel, deploys, registers a plugin, or creates cloud resources.

Everything is under this directory. It does not import the Basket Wise domain,
HTTP server, guest snapshot code, or database. Root package files, manifests,
Wrangler configuration, and app source remain unchanged. It uses the already
installed workspace dependencies; do not run a separate install in this directory.
Node.js 24+ is required for `node:sqlite`.

## Run local verification

From the repository root:

```sh
npm --prefix poc/guest-oauth run check
npm run check
```

The PoC tests use ephemeral **127.0.0.1** ports and temporary SQLite databases.
The HTTP test runner needs permission to bind loopback; do not substitute an
external listener. Tests close their servers and delete only their own temporary
directories. Widget tests simulate the host bridge and are explicitly not live
ChatGPT tests. The widget bundle is built in memory, with no CDN or output files.

## What it implements

- One pre-registered confidential OAuth client; no DCR, CIMD, OpenID Connect,
  profile lookup, registered user account, or external identity provider.
- A browser consent page offering **Continue as guest** or **Cancel**. A new
  consent creates a new synthetic guest; it does not recover an earlier guest.
- Authorization code + PKCE S256, exact client/redirect/resource/scope binding,
  `state` round-trip, and `iss` on authorization redirects.
- Client authentication using `client_secret_basic` or `client_secret_post`.
  The client secret identifies the OAuth client, not the guest, and is not a
  shared bearer token accepted by MCP tools.
- Opaque short-lived access tokens, rotating refresh tokens, and a maximum
  one-hour guest lifetime. Tokens contain no caller-readable identity claims.
- Browser-bound, HttpOnly/SameSite consent cookies; CSRF tokens and Origin
  validation for consent POSTs. Cookies never authorize MCP requests.
- Durable single-use records and `BEGIN IMMEDIATE` SQLite transactions for
  consent, code exchange, refresh rotation, revocation, and cleanup.
- Hashed code/token/cookie/CSRF verifiers in the database, not their raw secrets.
- No raw-request logging, telemetry, model API calls, photos, or shopping data.

Security operations deliberately use **replay rejection**, not replay of secret
responses. An already-approved consent cannot allocate another guest. A reused
code or rotated refresh token returns `invalid_grant` and revokes its token
family. A response lost after commit may therefore require reconnecting. This
strict PoC policy should not be mistaken for production-ready retry UX.

Expiry rejects access immediately; physical cleanup is lazy on the next
authorization request or explicit local `purge`. It is not a hard data-erasure
SLA. One active consent cookie per browser is supported; concurrent authorization
tabs can invalidate the earlier tab's consent attempt. There is a small total
state cap, not a production internet-facing abuse/rate-limiting system.

## Routes and tools

| Surface                                     | Purpose                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` | Protected-resource metadata; root alias also supported                        |
| `/.well-known/oauth-authorization-server`   | Issuer, endpoints, scope and supported methods                                |
| `GET /authorize`                            | Validate request, create bounded pending consent, render form                 |
| `POST /authorize`                           | Approve/cancel exactly once, bound to the browser and CSRF token              |
| `POST /token`                               | Code exchange or refresh; requires client authentication and exact `resource` |
| `POST /mcp`                                 | Stateless MCP transport; public discovery/widget, protected identity probe    |
| `GET /health`                               | Always reports `hostCompatibility: "not-verified"`                            |

`open_guest_probe` is public and contains no private identity. `guest_probe` is
OAuth-protected and returns only `guestTag`, `scope`, `guestExpiresAt`, and a fresh
`requestId`. Both tools are visible to the model and app. The widget only invokes
`app.callServerTool({ name: "guest_probe", arguments: {} })` through the host. It
does not read credentials, fetch a separate API, or use widget/browser storage.
Top-level `securitySchemes` and `_meta.securitySchemes` are both published; the
installed server SDK needs an explicit `tools/list` descriptor to include the
top-level extension. Missing authorization on a protected tool returns the
documented `_meta["mcp/www_authenticate"]` challenge. A supplied but invalid bearer
token returns HTTP 401 with protected-resource discovery metadata.

Local tests cover a simulated chat client and a simulated widget host using the
same bearer grant, another independent guest, PKCE/resource/scope/client failures,
consent cancellation/replay, refresh/replay/revocation, restart persistence,
transaction rollback, and rejection of an unrelated database. They do **not**
establish actual ChatGPT token forwarding, automatic linking, refresh, or retry.

## Optional local manual server — not started automatically

Use a new secret for this isolated test. Generate it locally and keep it out of
chat, Git, screenshots, and shell history; for example, assign it without printing:

```sh
export POC_CLIENT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export POC_CLIENT_ID='guest-oauth-poc'
export POC_PUBLIC_ORIGIN='http://127.0.0.1:3417'
export POC_REDIRECT_URIS='["http://127.0.0.1:7331/callback"]'
npm --prefix poc/guest-oauth start
```

The callback above is only a local-test placeholder, **not a ChatGPT callback**.
The process binds only `127.0.0.1`; it ignores generic `HOST` settings and will not
start a tunnel. Stop with Ctrl-C. Environment files are not loaded automatically.

| Variable                 | Default / requirement                                               |
| ------------------------ | ------------------------------------------------------------------- |
| `POC_PUBLIC_ORIGIN`      | `http://127.0.0.1:3417`; non-loopback origins must use HTTPS        |
| `POC_CLIENT_ID`          | `guest-oauth-poc`                                                   |
| `POC_CLIENT_SECRET`      | Required, at least 32 characters                                    |
| `POC_REDIRECT_URIS`      | Required JSON array of exact approved callbacks                     |
| `POC_PORT`               | `3417`, always bound on `127.0.0.1`                                 |
| `POC_DB`                 | `poc/guest-oauth/data/oauth.sqlite`, never the Basket Wise database |
| `POC_ACCESS_TTL_SECONDS` | `90`; allowed 5–300                                                 |
| `POC_GUEST_TTL_SECONDS`  | `1800`; longer than access lifetime and at most 3600                |

The database and its directory are private on creation. Existing unrelated
databases are rejected before schema changes. SQLite files are already ignored
by the root `.gitignore`; no production credentials or database belongs in Git.

With the same configuration, local operator commands (not public endpoints):

```sh
npm --prefix poc/guest-oauth start -- revoke guest-REPLACE-WITH-THE-ACTUAL-TAG
npm --prefix poc/guest-oauth start -- purge
```

`revoke` immediately prevents access and refresh for that guest, durably.
`purge` deletes expired PoC records; it does not touch live guests or app data.

## Future live ChatGPT gate — requires separate approval

Do not expose this harness until public exposure and its limitations are reviewed.
After explicit approval, a single temporary HTTPS origin could forward **all**
these routes, not just `/mcp`. Configure that origin as `POC_PUBLIC_ORIGIN`, use a
fresh database for the experiment, restart the local listener, and use the exact
callback URI and predefined OAuth client settings shown by ChatGPT. Do not guess
the callback or select the existing app's `noauth` connection mode. No tunnel,
cloud or account creation commands are supplied or run here.

Record the exact client surface/date and sanitized guest tags/request IDs:

1. Clean connection: consent completes with no Basket Wise registration.
2. Chat invokes `guest_probe`; record guest tag A and request ID.
3. Widget button invokes the same tool; guest is A, request ID is different.
4. Independent tester/connection receives guest B, not A.
5. After access expiry, verify actual host refresh preserves A for both paths.
6. Revoke A locally: neither access nor refresh succeeds.
7. Cancel linking: no protected result is shown.
8. Test widget-first linking separately: automatic retry, manual retry, or
   connect-first are distinct UX results, not interchangeable claims.

Never record raw access/refresh tokens, authorization codes, cookies, client
secrets, complete callback URLs, or full request headers. This harness does not
collect a diagnostic telemetry stream. Do not reuse test credentials elsewhere.

A local pass proves local protocol and isolation properties only. A live pass
would establish compatibility for the tested host, not recovery, mobile clients
not tested, production OAuth readiness, or public plugin approval.

## References used for this PoC

- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI MCP App UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Installed `@modelcontextprotocol/*` types and implementation for the exact SDK APIs.

# Constrained ChatGPT client registration

The separate durable adapter's v0.1.2 adds `POST /register`, enabled only by
`DCR_ENABLED=true`. It does not change the local Basket Wise plugin, accept public
clients, or grant access to guest data merely because a client has registered.
Guest consent, S256 PKCE, recovery acknowledgment, and bearer authorization still
apply. The pre-existing confidential client remains supported.

## Limits and storage

- Exactly one redirect URI is accepted:
  `https://chatgpt.com/connector_platform_oauth_redirect`. It must also appear in
  the service's registered callback configuration. No prefix or wildcard match.
- Only authorization-code plus refresh-token grants, response type `code`, scope
  `basket:manage`, and HTTP Basic/body client-secret authentication are supported.
  No implicit, public, client-credentials, JWT, dynamic redirect, or remote key
  lookup is enabled. Unknown metadata is rejected rather than fetched or trusted.
- Bodies are limited to 4 KiB. Existing edge per-IP throttling applies, plus an
  atomic registry limit of 32 new registrations/hour and 256 retained clients.
  Anonymous attackers can still exhaust this bounded quota; DCR is not proof
  that the caller is OpenAI. Disabling registration fails closed and hides the
  discovery endpoint.
- The new SQLite `OAuthClients` Durable Object has one service-owned instance,
  `chatgpt`. It holds client metadata, secret hashes, and optional request-key
  receipts, but no guest baskets or raw secrets. The Worker derives each random
  client's distinct secret using a domain-separated HMAC with the existing root
  key. The root key and static client secret are never returned.
- As of v0.2.0 registrations remain valid for the ChatGPT connection. The response
  reports `client_secret_expires_at: 0`. The host can reuse its client for refresh
  and reconnection; profile or basket expiry must not delete that registration.
  Optional registration retry receipts expire after 24 hours and are collected
  separately. The 256-client cap remains; exhaustion fails closed and requires
  an operator decision, not automatic deletion of existing connections.
- An optional unguessable `Idempotency-Key` makes registration retries return the
  original credentials persistently. Reusing it with different accepted metadata
  fails. Without the header, RFC-style repeated registration requests create
  separate clients; they are not deduplicated by shared metadata or IP, which
  would expose one client's secret to another caller. Guest mutations retain
  their existing mandatory persistent idempotency.

## Token and guest boundaries

Authorization looks up the registered client and exact redirect before creating
the short-lived OAuth flow. Code and refresh exchanges authenticate the registered
method and secret and recheck the grant's exact client ID **before** consumption
or replay handling. A different valid client cannot exchange or revoke another
client's credentials. Legacy registration and copied grant deadlines are ignored;
the profile's independent 90-day inactivity deadline controls guest access.

Recovery can intentionally move a guest to a newly registered client, but only
with the guest's saved recovery capability and acknowledgment of its replacement.
Old grants are revoked atomically, as before. Registration, token exchange,
refresh, and recovery do not extend the 24-hour basket or 90-day profile deadlines.

## Verification and rollback

Run `npm run check --prefix cloudflare`, root `npm run check`, and the draft
validator. Deploy using the existing `cf` configuration, then run public smoke
and `npm run smoke:dcr --prefix cloudflare/deploy`. The latter uses only synthetic
guest data and in-memory credentials, recovers across two registered clients,
and deletes its own test guest. Its app registrations remain retained, count
toward the bounded registry capacity, and are not ChatGPT host-flow evidence.

The uploaded draft switches only `auth.client.mode` to `dcr` and adds the
registration endpoint. The plugin identity, MCP URL, scope, and domain proof stay
unchanged. Do not submit or publish during verification.

To stop dynamic authorization, set `DCR_ENABLED=false` and redeploy using `cf`.
Existing static-client connections remain valid; dynamic-client requests fail
closed, including issued access credentials. Keep the new Durable Object export
and binding when rolling back so deployed namespace migrations are preserved.

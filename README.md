# Basket Wise

A personal shopping companion for ChatGPT: keep track of what goes into your
basket at **any supermarket**, see the running total in your chosen currency, and save confirmed
expiry dates. Dunnes is one example, not a requirement.

This repository contains a **Cloudflare guest MCP app and a private local-first
mode**, not a published ChatGPT app. Version 0.4.0 contains an MCP server,
an interactive basket view, listing and review-case drafts, workflow
instructions, persistent storage, and automated tests. The intended public
release is free, no-sign-in guest tracking, published by Yiping Deng, in all supported countries.
Choose a supported ISO currency per trip; date checks still use **Europe/Dublin dates**. See
[`submission/README.md`](./submission/README.md) for the remaining release gates.

## Guest mode: one shopping trip, no sign-in

The Cloudflare Worker is a **separate stateless app**. Its guest basket lives in
ChatGPT's `widgetState`, saved with `setWidgetState`, not a database. Each request
sends the current snapshot to Cloudflare for validation/calculation and receives
an updated one. No Auth0, Clerk, D1, KV, R2, Durable Object or model API is used.
Workers Static Assets hosts the widget; a Workers rate-limit binding limits abuse.

The widget supports the same money/currency rules, quantity controls, milestones,
and confirmed dates for **up to 50 lines**. It keeps only the current trip and 32
retry receipts, with a 64 KiB snapshot limit. Starting another shop requires
confirmation and replaces the current guest basket. Finished summaries and
expiry records are temporary too: no saved history, cross-device recovery,
permanent pantry, or reminders. Restoration in the same widget is best effort.
If widget storage is unavailable, a visible warning says the basket is in memory.

```sh
npm ci
npm run check
npm run check:guest   # Wrangler dry run; does not publish
npm run dev:guest    # local Workers runtime
```

See [docs/cloudflare.md](./docs/cloudflare.md) for publishing and real ChatGPT
checks. Opening the hosted page directly is a clearly labeled in-memory preview;
it does not emulate ChatGPT's storage. The guest Worker never imports or exposes
the private SQLite store. `mcp.json` remains the local stdio configuration until
a separate public package can use a verified deployed endpoint.

## What's included in private local mode

- Named shopping trips with quantities, editable prices, and a durable history.
- Exact integer-minor-unit totals, including weighted goods up to three quantity decimals.
- Choose a store, currency, and your own milestones when starting each shop.
  €25 / €50 are editable starting values, not fixed requirements. Lines can be excluded
  from the milestone subtotal without disappearing from the payable total.
- Retry-safe mutations: a repeated operation ID cannot add an item twice.
- A mobile-friendly in-chat basket, quantity controls, removal, and checkout.
- Confirmed use-by / best-before dates, including dates read by ChatGPT from a
  user-supplied photo. No image upload or additional model API is needed here.
- On-demand upcoming-date checks in Europe/Dublin, and a used-item flag.
- SQLite persistence, account-scoped storage groundwork, local stdio and
  Streamable HTTP transports, and CI checks.

This is not affiliated with Dunnes Stores. The milestones are personal spending
targets, **not verified voucher eligibility**. There is no live catalogue, account
integration, payment, automatic voucher calculation or redemption.

## Run locally

Requires **Node.js 24 or later** (uses built-in `node:sqlite`) and npm.

```sh
npm ci
npm run check
npm start
```

The single-user HTTP MCP endpoint is `http://127.0.0.1:3001/mcp`. A health check
is available at `/health`. HTTP defaults to loopback and has DNS-rebinding and
cross-origin protections. The basket is stored in `data/basket-wise.sqlite`,
which is ignored by Git. Stop the process with Ctrl-C.

`npm run dev` watches server source; run `npm run build:ui` after editing the
view. `npm run preview` starts a Vite browser preview; open the localhost URL it
prints. `npm run preview:built` previews the self-contained production bundle.
Browser preview data is explicitly labeled **Preview · not saved** and
stays in memory. It is not connected to the real database.

### Local plugin host / stdio

The portable [`mcp.json`](./mcp.json) launches the compiled server over stdio.
Build first with `npm run build`, then install the repository using your host's
supported local plugin flow. The `${PLUGIN_ROOT}` placeholder is resolved by
that host, not by your shell. To test the process directly:

```sh
npm run start:stdio
```

Protocol messages go to stdout; diagnostics go to stderr. The repo has not
been installed into an account or local plugin marketplace automatically.

### Private local mode is not a public deployment

ChatGPT's remote app connection cannot reach a laptop's stdio process or
loopback URL. Use the separate Cloudflare guest endpoint on your phone once it
is deployed and connected. The local HTTP process uses a single local profile. Do **not**
expose it as a public multi-user service. The shared development bearer token
is not OAuth.

`BasketStore(path, verifiedOwnerId)` isolates trips, expiry queries, and retry
keys by account. Existing databases migrate atomically into the `local`
profile; they are never assigned to the first signed-in user. This is a storage
boundary, **not authentication**: the production host must supply a verified
identity, never a tool argument or an untrusted client header. The local HTTP
entrypoint does not perform that integration.

The selected public hosting path is now Cloudflare Workers with temporary guest
widget storage, explicitly chosen instead of authenticated durable storage.
Production authentication is not needed for these stateless guest tools. This
does not remove the authentication requirement for any future public database
service. Cloud deployment, real ChatGPT testing and public submission still need
their own verification; source and local tests do not establish those results.

Official references:

- [OpenAI Apps SDK](https://developers.openai.com/apps-sdk/)
- [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Agent Plugins manifest](https://agent-plugins.org/)

## Example chat flow

> Start a Dunnes shop. Tell me when I reach €25 and €50.
>
> Add two cartons of milk at €2.35 each and bread at €3.25.
>
> I put one milk back. What's the total now?
>
> [Attach a photo] Read the use-by date on this milk.
>
> Yes, I confirm 14 October 2026. Save that date.
>
> I'm finished shopping.
>
> What should I use in the next three days?

Read [`skills/shopping-tracker/SKILL.md`](./skills/shopping-tracker/SKILL.md) for
the exact assistant workflow and photo-confirmation rules. ChatGPT handles
image understanding; the server only stores the date and original label text.
Unclear days, months, or years must be clarified. The date is a record, not a
food-safety determination. No background reminder is scheduled by this version.

## MCP tools

The public guest Worker exposes only `open_guest_basket` and `guest_basket`.
The latter accepts the complete current `state` and an `action` (operation kinds
below). It returns a replacement state, not a server-side saved basket. Both are
annotated `noauth` and read-only with respect to external/server data. See the
guest section of the skill for safe chat use and bounded retry semantics.

The following tools are for the **private local SQLite mode**:

| Tool                                       | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `start_trip`                               | Create a shop with configurable spending milestones |
| `get_basket` / `list_trips`                | Current basket or shopping history                  |
| `add_item` / `update_item` / `remove_item` | Maintain the active basket                          |
| `set_thresholds`                           | Replace milestone amounts in cents                  |
| `set_item_expiry`                          | Save a confirmed date or clear it with null         |
| `checkout_trip`                            | Lock purchased amounts without making a payment     |
| `list_expiring_items`                      | Query upcoming/past dates on demand                 |
| `mark_item_consumed`                       | Hide a purchased item from date checks              |

All mutation tools require a unique `operationId`. Retry the identical call
with the same ID if the connection drops. A reused ID with different arguments
is an error. Intentional duplicate purchases need different operation IDs.

Prices are integer minor units of each trip's currency; quantities are positive
and at most 1000. A line is rounded once to the nearest minor unit, half-up.
Use separate lines for packs with different expiry dates. Updates and removals
use item IDs, not names.

### Currency choice

The new-shop form and `start_trip.currency` accept ISO 4217 currencies with
defined minor units, using the pinned SIX List One data dated 17 September 2026.
The same precision table is bundled in the server and browser (not inferred
from locale formatting defaults). Metals/test/no-currency codes without a
defined minor unit and cryptocurrencies are not offered. The selector shows
both ISO code and currency name. EUR is the fallback when unspecified.
The next new-shop form starts with the current trip's currency.

Every trip keeps one currency. Start a separate trip to use a different one;
existing amounts and history are never relabeled, mixed, or exchange-rate
converted. Date/timezone selection is separate and still uses Europe/Dublin.

For compatibility, stored/tool fields named `unitPriceCents`, `totalCents`,
`thresholdsCents`, and related fields retain their names but represent that
currency's **minor units**. Tool results include `currency`,
`currencyFractionDigits`, and `currencyScale` (minor units per whole unit).
USD 3.49 is `349`, JPY 349 is `349`, and KWD 3.490 is `3490`. Omitted milestones
default to 25 and 50 whole units of the chosen currency. Price entry uses a
decimal point and rejects excess precision instead of silently rounding it.
Existing EUR records and their persistent retry fingerprints stay compatible.

## Configuration

Copy the values you need from `.env.example` into your shell environment; the
app does **not** automatically read a `.env` file.

| Variable            | Default                   | Purpose                                   |
| ------------------- | ------------------------- | ----------------------------------------- |
| `PORT`              | `3001`                    | HTTP development port                     |
| `HOST`              | `127.0.0.1`               | Bind address                              |
| `BASKET_WISE_DB`    | `data/basket-wise.sqlite` | Path to private SQLite data               |
| `BASKET_WISE_TOKEN` | unset                     | Optional private-development bearer token |

A non-loopback bind requires a token of at least 32 characters. This is a guard
against accidental unauthenticated exposure, not a secure multi-user deployment
recipe. Keep bearer tokens out of source control and use TLS off-machine.

Back up the private data directory when the process is stopped. Photos and API
keys are not stored. Shopping data is not encrypted at rest by this application;
use an appropriately protected disk and restrict access to the database.

## Repository layout

```text
plugin.json                     Portable plugin metadata
mcp.json                        Local stdio connection
skills/shopping-tracker/         Assistant workflow
src/domain.ts                   Validation, money and date rules
src/store.ts                    SQLite persistence and idempotency
src/server.ts                   MCP tools and app resource
src/http.ts                     Private HTTP transport
src/main.ts                     HTTP / stdio entrypoint
src/guest.ts                    Stateless snapshot validation and calculations
src/guest-server.ts             No-auth guest MCP tools and widget resource
src/worker.ts                   Cloudflare Worker (no SQLite imports)
web/guest-state.ts              Per-widget restore/save and stale-response guards
wrangler.jsonc                  Guest Worker, assets and abuse limit
web/                            Interactive basket and isolated preview
scripts/build-ui.mjs            Self-contained HTML bundle
tests/                          Domain, persistence, MCP and HTTP tests
.github/workflows/ci.yml        Typecheck, tests, build and dependency audit
```

## Development checks

```sh
npm run typecheck
npm test
npm run build
npm run smoke
npm audit
npm run check:public
```

Tests cover exact totals, threshold crossings, excluded lines, weighted goods,
idempotency, invalid input rollback, checkout locks, SQLite reopen, leap dates,
Dublin calendar boundaries, confirmation requirements, MCP discovery/resource
loading, account isolation, atomic legacy migration, and private HTTP/auth/host/origin controls. HTTP tests bind only to an
ephemeral loopback port. The smoke test launches the actual compiled stdio
process with a temporary database and reads the bundled app resource.

`check:public` is a separate static release preflight. It deliberately exits
with failure while the real endpoint, policy/support pages, icons, commerce
declaration, and demo recording are missing. Passing it later will not prove
authentication, mobile compatibility, or platform approval. `private: true` in
`package.json` prevents accidental npm publication; it does not control the
ChatGPT listing's audience.

## Next milestones

1. Deploy the no-sign-in Cloudflare guest endpoint and verify real ChatGPT mobile use.
2. Test image-assisted expiry confirmation in the actual ChatGPT host.
3. Receipt reconciliation and explicit discount/deposit modelling.
4. Opt-in scheduled reminders and data retention/export controls.

Voucher terms should only be integrated from a verified source and with the
user's actual eligibility; spending milestones deliberately remain separate.

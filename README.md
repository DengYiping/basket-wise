# Basket Wise

A personal shopping companion for ChatGPT: keep track of what goes into your
basket at **any supermarket**, see the running euro total, and save confirmed
expiry dates. Dunnes is one example, not a requirement.

This repository is a working **local-first MCP plugin scaffold**, not a published
ChatGPT app. It contains an MCP server, an interactive basket view, plugin
metadata, workflow instructions, persistent storage, and automated tests.

## What's included

- Named shopping trips with quantities, editable prices, and a durable history.
- Integer-cent totals, including weighted goods up to three quantity decimals.
- Choose a store name and your own euro milestones when starting each shop.
  €25 / €50 are editable starting values, not fixed requirements. Lines can be excluded
  from the milestone subtotal without disappearing from the payable total.
- Retry-safe mutations: a repeated operation ID cannot add an item twice.
- A mobile-friendly in-chat basket, quantity controls, removal, and checkout.
- Confirmed use-by / best-before dates, including dates read by ChatGPT from a
  user-supplied photo. No image upload or additional model API is needed here.
- On-demand upcoming-date checks in Europe/Dublin, and a used-item flag.
- SQLite persistence, stdio and Streamable HTTP transports, and CI checks.

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

### ChatGPT web/mobile connection is a separate deployment step

ChatGPT's remote app connection cannot reach a laptop's stdio process or
loopback URL. To use this on your phone while shopping, the next step is an
authenticated, HTTPS-hosted MCP endpoint and a supported developer app
connection. Do **not** expose this unpartitioned personal database as a public
multi-user service. The current shared development bearer token is not OAuth.

For remote production, implement identity-bound storage and proper MCP OAuth,
TLS, rate limits, backups, and deployment configuration, then test the actual
ChatGPT host. This scaffold has not been deployed, published, or tested inside
a live ChatGPT app session.

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

Prices are integer EUR cents, quantities are positive and at most 1000. A line
is rounded once to the nearest cent, half-up. Use separate lines for packs with
different expiry dates. Updates and removals use item IDs, not names.

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
```

Tests cover exact totals, threshold crossings, excluded lines, weighted goods,
idempotency, invalid input rollback, checkout locks, SQLite reopen, leap dates,
Dublin calendar boundaries, confirmation requirements, MCP discovery/resource
loading, and private HTTP/auth/host/origin controls. HTTP tests bind only to an
ephemeral loopback port. The smoke test launches the actual compiled stdio
process with a temporary database and reads the bundled app resource.

## Next milestones

1. Authenticated HTTPS deployment for real ChatGPT web/mobile use.
2. Test image-assisted expiry confirmation in the actual ChatGPT host.
3. Receipt reconciliation and explicit discount/deposit modelling.
4. Opt-in scheduled reminders and data retention/export controls.

Voucher terms should only be integrated from a verified source and with the
user's actual eligibility; spending milestones deliberately remain separate.

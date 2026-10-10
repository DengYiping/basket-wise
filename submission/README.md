# Basket Wise public-release preparation

Version: **0.4.0**. Last locally checked: **10 October 2026**.

This is a preparation record, not a submitted or approved listing. No public
ZIP, remote deployment, ChatGPT installation, or real demo recording has been
created. Keep the working local `mcp.json`; build a separate public submission
copy only after a real HTTPS guest endpoint exists and is verified in ChatGPT.

## Confirmed release choices

- Intended publisher: **Yiping Deng**, using the user's verified personal name.
  Verification and the saved publisher name still need checking in the portal.
- Availability: **all supported countries**. The manifest explicitly uses an
  empty country restriction list. Each trip can use an ISO currency with defined
  minor units from the bundled SIX List One data; no exchange-rate conversion is provided.
- Free tracking only: no payments, purchases, subscriptions, or affiliate links.
- No-sign-in guest mode: the current trip lives in temporary ChatGPT widget
  state. Starting another trip replaces it. No server-side basket storage,
  durable shopping history, cross-device recovery or background reminder.
- Cloudflare Workers + Static Assets + a rate-limit binding. No Auth0, Clerk,
  D1, KV, R2 or Durable Object is required for this release.
- Any supermarket and user-defined milestones; no Dunnes affiliation, live
  prices, loyalty-account access, voucher calculation, or redemption.
- Current language/calendar: English, Europe/Dublin. Currency is selected per
  trip, respecting zero-, two-, three-, and four-decimal minor units. Existing
  EUR records remain unchanged. Do not claim language or timezone localization.
- ChatGPT interprets a packaging photo. The app receives only the confirmed
  date and optional label text, not the photo. Full year confirmation is required.

## What is ready locally

- Draft listing, three starter prompts, and release notes in `plugin.json`.
- Five positive and three negative review cases based on implemented tools.
- Account-scoped SQLite trips, expiry queries, and persistent retry keys.
  Legacy data migrates transactionally into the local profile only.
- A currency selector, currency-aware price/total/milestone display, exact minor
  units, and persistence/retry tests across currencies.
- Local UI, stdio/HTTP transport, tests, and a built-server smoke check.
- Separate stateless guest MCP tools, bounded widget snapshots, stale-response
  protection, request limits, retry receipts and a Cloudflare Worker configuration.

These are source/local-test results. They do not establish production auth,
hosted storage, phone compatibility, or review-case success in ChatGPT.

## Hosting and verification

The selected path is Cloudflare guest hosting; see `docs/cloudflare.md`.
`wrangler whoami` reports that this environment is not authenticated. No
temporary account was created, and no deployment has been made. Sign in to the
publisher's Cloudflare account before deployment; do not commit credentials or
purchase a plan without approval. Keep the actual returned deployment URL.

Never expose `src/http.ts` or its local SQLite store. Only the guest Worker is
public: it operates exclusively on the snapshot supplied in each request.
Verify that a second widget starts independently, that no basket can be looked
up by ID/email, and that button edits are visible to subsequent chat actions.
Test snapshot restore on the actual ChatGPT phone client, with clear limits;
local mock-bridge tests are not proof of host restoration guarantees.

## Incomplete public submission gates

- Real HTTPS guest MCP URL, working noauth connection, abuse protection and
  verified absence of server-side basket persistence.
- Public website, support, privacy, and terms HTTPS URLs with verified content.
  The publisher must first confirm a support contact, storage/provider choices,
  guest snapshot limitations, ChatGPT retention boundaries, and any operational logs. Do not
  invent commitments or imply that local data practices describe a future host.
- Actual square PNG logo and composer icon, inspected at small sizes. Optional
  dark-mode assets/colors are not required; use the current green/cream design
  as a starting point unless the publisher chooses otherwise.
- Portal-compatible no-commerce declaration. The user's answer is recorded
  above; no guessed `review.commerce` enum is placed in the manifest.
- Real ChatGPT review-case execution and reviewer-accessible demo recording.
- A working guest reviewer flow without a publisher login or private network.
- Publisher verification, final country targeting, and legal/policy attestations
  checked by the publisher in the portal.

Run `npm run check:public` to see static gaps. It does not upload anything and
is expected to fail until the missing artifacts exist. Its success will not
replace the manual checks above.

## Review-case evidence

The exact prompts, expected tools, important arguments, and observable outcomes
are in `extensions.com.openai.review.test_cases` in `plugin.json`. Execute them
in a dedicated sample account. Retain returned IDs instead of inventing IDs.
Dates in fixtures are explicit; passed dates are still returned by date checks.

| Case | Coverage                                                   | ChatGPT result                         |
| ---- | ---------------------------------------------------------- | -------------------------------------- |
| P1   | Custom USD store/targets, two USD 8.50 items, USD 17 total | Not run: hosted connection unavailable |
| P2   | Three-decimal KWD weighted rounding and excluded deposit   | Not run: hosted connection unavailable |
| P3   | Full confirmed use-by date after checkout                  | Not run: hosted connection unavailable |
| P4   | Confirm replacement; do not promise saved history          | Not run: hosted connection unavailable |
| P5   | Used item hidden, purchase total retained                  | Not run: hosted connection unavailable |
| N1   | No live prices, loyalty access, or voucher redemption      | Not run: hosted connection unavailable |
| N2   | Missing year requires clarification, no write              | Not run: hosted connection unavailable |
| N3   | No other-shopper lookup by email                           | Not run: hosted connection unavailable |

The local automated suite is separate evidence, not a substitute for these
model-mediated cases. Review tool annotations with the actual deployed tool
discovery response before submission.

## Demo walkthrough to rehearse and record

Use a dedicated sample account in the real ChatGPT host, with no private chats,
tokens, passwords, or production shopping records on screen.

1. Show the connected Basket Wise version and start P1. Select USD. Show the
   USD 17 basket, reached USD 15 milestone, and USD 25 remaining to USD 42.
2. Put one olive oil back. Show the real updated USD 8.50 total. Demonstrate a
   separate JPY or KWD trip only after confirming replacement. Explain that
   guest mode has no history; do not imply the USD basket was saved.
3. Attach a sample packaging image with a legible full use-by date. Show
   ChatGPT asking for confirmation; explicitly confirm day, month, and year.
   Show the saved date and correct label type in the real basket.
4. Finish the shop, mark the item used, and show it absent from date checks
   while the temporary current-trip total remains unchanged.
5. Ask N2 with no year and show clarification with no expiry write. Explain
   that spending milestones are not vouchers and checks are on demand.
6. Repeat key steps on the intended phone. Record any unavailable UI or tools
   as a limitation, not a successful compatibility check.

Computer control/screenshots alone are not video recording. When hosting is
available, check recording tooling; otherwise the publisher starts and stops a
screen recorder during the walkthrough. Play back the saved video, check
legibility and absence of secrets, host it at a reviewer-accessible destination,
verify playback without a private login, and only then set
`review.demo_recording_url`. This script is not a completed demo.

## Packaging and publication sequence

1. Finish the gates, validate current versions, and run `npm run check`.
2. Prepare a clean public copy with real remote `mcp.json`; include only needed
   plugin assets/instructions. Exclude data, credentials, dependencies, generated
   local builds, `.app.json`, and author-supplied `apps` declarations.
3. Validate the ZIP inventory and all endpoint/page/video destinations, then
   upload a draft through the supported public-submission portal.
4. Inspect imported metadata and country targeting. Enter secure reviewer
   access. The publisher completes final attestations and review submission.
5. Wait for review; publish only after approval through the supported flow.

Prepared, uploaded, submitted, approved, and publicly published are distinct
states. Do not report a later state from an earlier one's evidence.

# Thresholds and removal suggestions — v0.4.0

Implemented in the isolated Cloudflare adapter, released with the v0.4.0 removal
of food expiry tracking. See the deployment record for live verification and
the developer-draft record for upload status. The root local app is unchanged;
the plugin is not submitted or published.

## Two threshold modes, plus an advisory tool

All amounts below are integer minor units of the trip currency. For EUR, 2500
means EUR 25.00. The qualifying subtotal includes only items whose
`thresholdEligible` flag is true; the payable total includes every item. This
flag and these targets do not establish a supermarket's voucher eligibility.

Use either `thresholdConfig` or the old `thresholdsCents` field with
`start_trip`/`set_thresholds`, never both. Setting a policy is an ordinary
authenticated, revision-checked, persistent-idempotent basket mutation.

| Configuration             | Reachable targets              | EUR 80 qualifying subtotal        |
| ------------------------- | ------------------------------ | --------------------------------- |
| Unlimited amount 25       | 25, 50, 75, 100, 125, 150, ... | Highest met 75; next 100          |
| Static one 50             | 50 only                        | Highest met 50; no further target |
| Static two 50s            | 50, 100                        | Highest met 50; next 100          |
| Static one 30 plus one 50 | 30, 50, 80                     | Highest met 80; no further target |

Unlimited configuration:

```json
{ "mode": "unlimited", "amountCents": 2500 }
```

Finite configuration:

```json
{
  "mode": "static",
  "entries": [
    { "amountCents": 3000, "count": 1 },
    { "amountCents": 5000, "count": 1 }
  ]
}
```

Each finite copy may be used at most once in a combination. This is not a
redemption ledger: checkout does not claim to redeem or validate vouchers.
The finite policy allows up to 10 entries, 20 total copies, and positive integer
amounts up to 1,000,000 minor units per copy. Finite combinations are computed
exactly by meet-in-the-middle; an unbounded target list is never stored.

Legacy `thresholdsCents: [2500, 5000]` remains two independent milestones,
not unlimited EUR 25 multiples and not EUR 75 of finite capacity. Stored trips
are not silently reinterpreted. Existing clients can still use this field.

The basket response contains `thresholdConfig` when a new mode is configured,
plus `thresholdStatus` with the highest target met, next target, finite maximum
if applicable, and the copies used by the highest qualifying combination.

## `suggest_removals`

Inputs: optional `tripId`, optional `targetCents`, optional `keepItemIds`, and a
fresh `activityId` for a new intentional foreground read. No item removal occurs.
The default target is the highest configured target already reached. A user can
choose a lower reachable target explicitly. A higher or unconfigured target is
rejected: removing items cannot help reach an unmet higher threshold.

For an EUR 80 basket containing EUR 50, EUR 25 and EUR 5 lines:

- Unlimited EUR 25: suggest removing the EUR 5 line, retaining EUR 75.
- A single static EUR 50: suggest removing EUR 25 and EUR 5, retaining EUR 50.
- Static EUR 30 plus EUR 50: the EUR 80 target is already met exactly; no eligible
  whole line can be removed while preserving it.

The planner maximizes saved payable value while preserving the target subtotal
and every `keepItemIds` line. It removes only whole lines, including the entire
quantity. Existing half-up line rounding is retained; item names never execute
as HTML. Excluded lines can be removed without reducing the qualifying subtotal.

Subset search is bounded to 100,000 search nodes for the existing 50-line basket
limit. Results always preserve the target. `optimal: false` explicitly means a
better combination may exist; it must not be presented as the best possible
answer. No-threshold, checked-out, and no-fitting-line states are distinguished.

Suggestions include exact savings, resulting total, resulting qualifying
subtotal, item IDs/names/quantities and whether optimality was established.
They are tied to the surrounding response's `revision` and `dataEpoch`. The
widget clears an old proposal when it accepts a newer basket. The user must
confirm actual removals; the caller re-reads and performs ordinary `remove_item`
operations with current revisions and epochs. No automatic batch deletion is
added.

Like existing foreground reads, a new successful suggestion request renews
24-hour basket and 90-day profile inactivity. Retrying the same `activityId`
does not. Rejected suggestions do not renew either clock. OAuth, ownership,
expiry, receipt limits and epoch protections are unchanged.

## Local verification

Tests cover finite combinations against exhaustive oracles, repeated targets,
whole-line rounding, protected/excluded items, bounded-search reporting,
persistent configuration/receipts, atomic rollback, cross-guest denial, expiry,
and widget/chat calls through the same local OAuth-protected MCP endpoint.
The phone widget test checks a narrow viewport, inert untrusted item text,
configuration inputs, proposal rendering, and absence of automatic removals.

These are local workerd/Chromium results, not real ChatGPT host verification.
The deployed server and developer-platform draft remain on the previous release
until a separate authorized deployment/upload and tool rescan.

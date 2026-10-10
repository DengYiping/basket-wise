# Profile-wide shopping list

The 0.5.2 package shortens the listing description without changing behavior.
The 0.5.1 package updated the skill and listing only; the deployed runtime remains
0.5.0. Before an ordinary trip addition, the skill reads the shopping list and
includes a single unambiguous matching entry's ID and revision in `add_item`.
Ambiguous matches and partial purchases require clarification. The server still
does not match names itself or perform a separate list deletion.

The list belongs to the existing OAuth-selected `GuestVault`. No account login,
new cloud service, object namespace or credential is added. Existing guests start
with an empty list and list revision 0; no destructive migration runs.

- `list-item/<uuid>` holds name, quantity, unit and notes. No price/currency:
  prices belong to trips. There are at most 500 active list entries.
- `meta.shoppingListRevision` is independent of the basket revision and epoch.
- `list-receipt/{operation|activity}/<id>` holds fingerprints and optional item
  IDs, never copies of item content. Receipts survive basket cleanup and are
  bounded to 32,768 per profile. Exact retries do not renew retention or repeat
  mutations; conflicting reuse is rejected.
- All list mutations, receipts, revisions and profile renewal commit together
  in one SQLite transaction. `add_item` with `shoppingListItemId` and
  `expectedShoppingListRevision` checks and removes the entry in the same
  transaction as the trip item and trip receipt. Missing/stale references,
  checkout, errors and rollbacks cannot consume an entry. No automatic name
  matching, partial consumption or restoration on trip removal occurs.
- Foreground list activity renews only the 90-day profile inactivity deadline.
  The 24-hour basket purge and `clear_baskets` leave the list and its receipts
  intact. Profile expiry, alarm/GC or explicit `delete_guest` erase everything.
  OAuth refresh, recovery, profile lookup and retries renew neither deadline.

Tools: `open_shopping_list`, `get_shopping_list`, `add_shopping_list_item`,
`update_shopping_list_item`, `remove_shopping_list_item`. Every tool requires the
same OAuth scope as the existing basket tools. List writes require
`expectedShoppingListRevision`; trip writes still require `expectedRevision`
and `dataEpoch`. An explicit reference requires both revisions.

`open_shopping_list` and list mutations use a separate, self-contained list
widget. It has add/edit/remove and explicit price-based transfer to the current
active trip, narrow-screen styling, no storage, no external assets and no
background reads. Data-only `get_basket`, `list_trips`, `get_shopping_list` and
`get_profile` do not advertise a widget. Open tools and successful mutations
return their corresponding widget; the skill instructs action first.

The deployed adapter and widget resource version are 0.5.0. The source/package
version is 0.5.2 for the metadata-only patch. Old basket
resource URIs remain aliases. Refresh both hosts' tool catalogs after deployment.
Local protocol/Chromium tests do not establish actual ChatGPT host compatibility.

Commit summary: Add profile-wide shopping list and atomic trip transfer

## Deployed and verified October 10, 2026

- Worker version: `62c55329-d8b7-4b9d-90bb-f3a32feb8501`, deployed with `cf`.
- All 103 Cloudflare tests and 103 root-app tests pass. Public smoke passes;
  live synthetic OAuth smoke exercised recovery, list transfer, retry safety,
  no auto-restoration and basket clearing, then deleted the test guest.
- Existing OpenAI developer draft: v0.5.0, 18 scanned tools, no MCP findings.
- Existing personal plugin: 18 actions refreshed through its existing OAuth
  connection. Standalone companion skill updated; direct package-overlay upload
  blocked by OpenAI blob HTTP 403. Existing wrapper ID/release retained.
- Neither plugin submitted or publicly published. Phone-host execution and a
  real 90-day elapsed interval are not claimed as verified.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

test("closed enrollment gate exposes discovery but creates no guest vault", async () => {
  const h = await setup({ enrollment: "false" });
  try {
    const health = await h.request("/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).enrollmentEnabled, false);
    const flow = await h.begin();
    const response = await h.post(
      "/authorize",
      { flow: flow.flow, csrf: flow.csrf, decision: "new" },
      flow.cookie,
    );
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /Save your recovery key/);
    const rows = await (
      await h.sql("AuthorizationFlow", flow.flow.split(".")[2]!)
    ).exec("SELECT value FROM documents WHERE key = 'meta'");
    const state = JSON.parse(rows[0]!.value as string);
    const tables = await (
      await h.sql("GuestVault", state.vault)
    ).exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    );
    assert.equal(tables.length, 0);
    assert.notEqual(
      (
        await h.post(
          "/continue",
          { flow: flow.flow, csrf: flow.csrf, saved: "yes" },
          flow.cookie,
        )
      ).status,
      303,
    );
  } finally {
    await h.close();
  }
});

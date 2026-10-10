import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

const path = "/.well-known/openai-apps-challenge";
const token = "local-domain-proof-012345678901234567890123456";

test("domain verification is disabled unless a valid public token is configured", async () => {
  for (const domainVerificationToken of [undefined, "", "invalid\nproof"]) {
    const h = await setup(
      domainVerificationToken === undefined ? {} : { domainVerificationToken },
    );
    try {
      const response = await h.request(path);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    } finally {
      await h.close();
    }
  }
});

test("domain proof returns only the exact configured token at the exact GET path", async () => {
  const h = await setup({ domainVerificationToken: token });
  try {
    const response = await h.request(path);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/plain;charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), token);
    for (const requestPath of [`${path}/`, `${path}?token=reflected`]) {
      assert.equal((await h.request(requestPath)).status, 404);
    }
    assert.equal((await h.request(path, { method: "POST" })).status, 404);
    assert.equal(
      (await h.request(path, { headers: { Origin: "https://other.invalid" } }))
        .status,
      403,
    );
    const health = (await (await h.request("/health")).json()) as {
      enrollmentEnabled: boolean;
      inactivityHours: number;
    };
    assert.equal(health.enrollmentEnabled, true);
    assert.equal(health.inactivityHours, 24);
  } finally {
    await h.close();
  }
});

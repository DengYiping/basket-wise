import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GuestAuthStore } from "../src/store.js";
import { configFromEnv } from "../src/config.js";
import { testConfig, authorization, authorize, issue } from "./helpers.js";

describe("isolated persistent guest OAuth state", () => {
  let directory: string, path: string, store: GuestAuthStore, now: number;
  const config = testConfig();
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "guest-oauth-poc-"));
    path = join(directory, "oauth.sqlite");
    now = 1_800_000_000_000;
    store = new GuestAuthStore(path, config, () => now);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("issues different guests and preserves identity across restart and refresh", () => {
    const first = issue(store),
      second = issue(store);
    const a = store.authenticate(first.access_token),
      b = store.authenticate(second.access_token);
    assert.ok(a && b);
    assert.notEqual(a.guestTag, b.guestTag);
    store.close();
    store = new GuestAuthStore(path, config, () => now);
    assert.deepEqual(store.authenticate(first.access_token), a);
    now += 11_000;
    assert.equal(store.authenticate(first.access_token), undefined);
    const renewed = store.exchange({
      kind: "refresh",
      credential: first.refresh_token,
      clientId: config.clientId,
      resource: `${config.origin}/mcp`,
    });
    assert.ok("tokens" in renewed);
    assert.equal(
      store.authenticate(renewed.tokens.access_token)?.guestTag,
      a.guestTag,
    );
    assert.notEqual(renewed.tokens.refresh_token, first.refresh_token);
  });

  it("stores verifiers, not raw authorization codes, tokens, cookies, or CSRF secrets", () => {
    const flow = authorize(store);
    const exchanged = store.exchange({
      kind: "code",
      credential: flow.code,
      clientId: config.clientId,
      redirectUri: flow.auth.redirectUri,
      verifier: flow.verifier,
    });
    assert.ok("tokens" in exchanged);
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = JSON.stringify([
      db.prepare("SELECT * FROM credentials").all(),
      db.prepare("SELECT * FROM interactions").all(),
    ]);
    db.close();
    for (const value of [
      flow.code,
      flow.interaction.browser,
      flow.interaction.csrf,
      exchanged.tokens.access_token,
      exchanged.tokens.refresh_token,
    ])
      assert.ok(!rows.includes(value));
  });

  it("binds authorization consent to the browser, CSRF value, expiry, and one decision", () => {
    const { auth } = authorization(config);
    const intent = store.beginAuthorization(auth);
    assert.ok(
      "error" in
        store.finishAuthorization({
          ...intent,
          browser: "wrong",
          approve: true,
        }),
    );
    assert.ok(
      "error" in
        store.finishAuthorization({ ...intent, csrf: "wrong", approve: true }),
    );
    const denied = store.finishAuthorization({ ...intent, approve: false });
    assert.ok("redirect" in denied);
    assert.equal(
      new URL(denied.redirect).searchParams.get("error"),
      "access_denied",
    );
    assert.equal(
      new URL(denied.redirect).searchParams.get("state"),
      auth.state,
    );
    assert.ok(
      "error" in store.finishAuthorization({ ...intent, approve: true }),
    );
    const expiring = store.beginAuthorization(auth);
    now += 300_001;
    assert.ok(
      "error" in store.finishAuthorization({ ...expiring, approve: true }),
    );
  });

  it("persists the single-use decision across restart without allocating a second guest", () => {
    const flow = authorize(store);
    store.close();
    store = new GuestAuthStore(path, config, () => now);
    assert.ok(
      "error" in
        store.finishAuthorization({ ...flow.interaction, approve: true }),
    );
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n,
      1,
    );
    db.close();
  });

  it("validates client, redirect, PKCE, scope and resource before consuming a code", () => {
    const flow = authorize(store);
    const base = {
      kind: "code" as const,
      credential: flow.code,
      clientId: config.clientId,
      redirectUri: flow.auth.redirectUri,
      verifier: flow.verifier,
      resource: flow.auth.resource,
    };
    for (const changed of [
      { clientId: "other" },
      { redirectUri: "https://evil.invalid" },
      { verifier: "a".repeat(43) },
      { scope: "admin" },
      { resource: "https://other.invalid/mcp" },
    ]) {
      assert.ok("error" in store.exchange({ ...base, ...changed }));
    }
    assert.ok("tokens" in store.exchange(base));
  });

  it("rejects code replay durably and revokes the affected token family", () => {
    const flow = authorize(store);
    const request = {
      kind: "code" as const,
      credential: flow.code,
      clientId: config.clientId,
      redirectUri: flow.auth.redirectUri,
      verifier: flow.verifier,
    };
    const result = store.exchange(request);
    assert.ok("tokens" in result);
    store.close();
    store = new GuestAuthStore(path, config, () => now);
    assert.deepEqual(store.exchange(request), { error: "invalid_grant" });
    assert.equal(store.authenticate(result.tokens.access_token), undefined);
  });

  it("enforces single-use across separate SQLite connections", () => {
    const flow = authorize(store);
    const request = {
      kind: "code" as const,
      credential: flow.code,
      clientId: config.clientId,
      redirectUri: flow.auth.redirectUri,
      verifier: flow.verifier,
    };
    const secondConnection = new GuestAuthStore(path, config, () => now);
    try {
      const first = store.exchange(request);
      assert.ok("tokens" in first);
      assert.deepEqual(secondConnection.exchange(request), {
        error: "invalid_grant",
      });
      assert.equal(store.authenticate(first.tokens.access_token), undefined);
    } finally {
      secondConnection.close();
    }
  });

  it("does not issue an already-expired token at the subsecond guest-expiry boundary", () => {
    const tokens = issue(store);
    now += config.guestTtlSeconds * 1000 - 999;
    assert.deepEqual(
      store.exchange({
        kind: "refresh",
        credential: tokens.refresh_token,
        clientId: config.clientId,
      }),
      { error: "invalid_grant" },
    );
  });

  it("rotates refresh tokens; reuse revokes the whole family, not a different guest", () => {
    const initial = issue(store),
      other = issue(store);
    const request = {
      kind: "refresh" as const,
      credential: initial.refresh_token,
      clientId: config.clientId,
    };
    const refreshed = store.exchange(request);
    assert.ok("tokens" in refreshed);
    store.close();
    store = new GuestAuthStore(path, config, () => now);
    assert.deepEqual(store.exchange(request), { error: "invalid_grant" });
    assert.equal(store.authenticate(initial.access_token), undefined);
    assert.equal(store.authenticate(refreshed.tokens.access_token), undefined);
    assert.ok(store.authenticate(other.access_token));
  });

  it("caps access and refresh at guest expiry and never resurrects a guest", () => {
    const tokens = issue(store);
    now += config.guestTtlSeconds * 1000 - 1500;
    const last = store.exchange({
      kind: "refresh",
      credential: tokens.refresh_token,
      clientId: config.clientId,
    });
    assert.ok("tokens" in last);
    assert.equal(last.tokens.expires_in, 1);
    now += 1501;
    assert.equal(store.authenticate(last.tokens.access_token), undefined);
    assert.deepEqual(
      store.exchange({
        kind: "refresh",
        credential: last.tokens.refresh_token,
        clientId: config.clientId,
      }),
      { error: "invalid_grant" },
    );
    store.purge();
    assert.equal(store.authenticate(tokens.access_token), undefined);
  });

  it("expires codes and applies durable, idempotent operator revocation", () => {
    const flow = authorize(store);
    now += 60_001;
    assert.deepEqual(
      store.exchange({
        kind: "code",
        credential: flow.code,
        clientId: config.clientId,
        redirectUri: flow.auth.redirectUri,
        verifier: flow.verifier,
      }),
      { error: "invalid_grant" },
    );
    const tokens = issue(store),
      tag = store.authenticate(tokens.access_token)!.guestTag;
    assert.equal(store.revokeGuest(tag), true);
    assert.equal(store.revokeGuest(tag), false);
    store.close();
    store = new GuestAuthStore(path, config, () => now);
    assert.equal(store.authenticate(tokens.access_token), undefined);
    assert.deepEqual(
      store.exchange({
        kind: "refresh",
        credential: tokens.refresh_token,
        clientId: config.clientId,
      }),
      { error: "invalid_grant" },
    );
  });

  it("rolls back guest creation and intent consumption when the code insert fails", () => {
    const { auth } = authorization(config),
      intent = store.beginAuthorization(auth);
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER fail_code BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    assert.throws(
      () => store.finishAuthorization({ ...intent, approve: true }),
      /injected/,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n,
      0,
    );
    db.exec("DROP TRIGGER fail_code");
    db.close();
    assert.ok(
      "redirect" in store.finishAuthorization({ ...intent, approve: true }),
    );
  });

  it("rolls back code consumption if token issuance fails", () => {
    const flow = authorize(store),
      db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER fail_token BEFORE INSERT ON credentials WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const request = {
      kind: "code" as const,
      credential: flow.code,
      clientId: config.clientId,
      redirectUri: flow.auth.redirectUri,
      verifier: flow.verifier,
    };
    assert.throws(() => store.exchange(request), /injected/);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM credentials WHERE kind = 'access'",
          )
          .get() as { n: number }
      ).n,
      0,
    );
    db.exec("DROP TRIGGER fail_token");
    db.close();
    assert.ok("tokens" in store.exchange(request));
  });

  it("will not open the existing application's or any unrelated database", () => {
    const unrelated = join(directory, "other.sqlite"),
      db = new DatabaseSync(unrelated);
    db.exec(
      "CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('preserve')",
    );
    db.close();
    assert.throws(() => new GuestAuthStore(unrelated, config), /Refusing/);
    const check = new DatabaseSync(unrelated, { readOnly: true });
    assert.equal(
      check.prepare("SELECT value FROM private_data").get()?.value,
      "preserve",
    );
    check.close();
  });

  it("rejects malformed or unexpected token formats and a changed resource origin", () => {
    const tokens = issue(store);
    for (const invalid of [
      "",
      "abc",
      tokens.refresh_token,
      `${tokens.access_token}=`,
      "x".repeat(43),
    ])
      assert.equal(store.authenticate(invalid), undefined);
    store.close();
    store = new GuestAuthStore(
      path,
      testConfig({ origin: "https://different.invalid" }),
      () => now,
    );
    assert.equal(store.authenticate(tokens.access_token), undefined);
  });
});

describe("PoC configuration boundaries", () => {
  it("requires credentials, exact safe origins/redirects, and short lifetimes", () => {
    assert.throws(() => configFromEnv({}), /CLIENT_SECRET/);
    for (const origin of [
      "http://internet.invalid",
      "https://poc.invalid/",
      "https://poc.invalid/path",
      "https://user:pass@poc.invalid",
    ])
      assert.throws(() => testConfig({ origin }));
    for (const redirect of [
      "http://internet.invalid/callback",
      "https://client.invalid/#fragment",
      "javascript:alert(1)",
    ])
      assert.throws(() => testConfig({ redirectUris: [redirect] }));
    assert.throws(() => testConfig({ redirectUris: [] }));
    assert.throws(() => testConfig({ accessTtlSeconds: 3600 }));
    assert.throws(() => testConfig({ guestTtlSeconds: 3601 }));
    assert.equal(
      testConfig({ origin: "http://127.0.0.1:3417" }).origin,
      "http://127.0.0.1:3417",
    );
  });
});

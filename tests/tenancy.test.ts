import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemInputSchema } from "../src/domain.js";
import { BasketStore } from "../src/store.js";

describe("account-scoped storage", () => {
  let directory: string;
  let path: string;
  let alice: BasketStore;
  let bob: BasketStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "basket-wise-tenancy-"));
    path = join(directory, "shared.sqlite");
    alice = new BasketStore(path, "verified-alice");
    bob = new BasketStore(path, "verified-bob");
  });
  afterEach(() => {
    alice.close();
    bob.close();
    rmSync(directory, { recursive: true });
  });

  it("isolates current baskets, history and expiry searches", () => {
    const trip = alice.startTrip("same-operation", "Aldi").basket;
    const id = alice.addItem(
      "add-milk-1",
      trip.id,
      itemInputSchema.parse({ name: "Milk", unitPriceCents: 199 }),
    ).basket.items[0]!.id;
    alice.setExpiry("expiry-01", trip.id, id, {
      date: "2026-10-11",
      kind: "use_by",
      source: "user",
      confirmed: true,
    });
    expect(bob.getBasket()).toBeNull();
    expect(bob.listTrips()).toEqual([]);
    expect(bob.listExpiring(3, "2026-10-10").items).toEqual([]);
    expect(() => bob.getBasket(trip.id)).toThrow("not found");
    expect(alice.listTrips()).toHaveLength(1);
    expect(alice.listExpiring(3, "2026-10-10").items).toHaveLength(1);
  });

  it("scopes idempotency keys to an account", () => {
    const a = alice.startTrip("same-operation", "Aldi").basket;
    const b = bob.startTrip("same-operation", "Tesco").basket;
    expect(a.id).not.toBe(b.id);
    expect(alice.startTrip("same-operation", "Aldi").alreadyApplied).toBe(true);
    expect(bob.startTrip("same-operation", "Tesco").alreadyApplied).toBe(true);
    expect(alice.getBasket()?.store).toBe("Aldi");
    expect(bob.getBasket()?.store).toBe("Tesco");
  });

  it("preserves account-scoped data and retry keys after reopening", () => {
    const trip = alice.startTrip("persistent-start", "Aldi").basket;
    const reopened = new BasketStore(path, "verified-alice");
    const other = new BasketStore(path, "verified-charlie");
    try {
      const retry = reopened.startTrip("persistent-start", "Aldi");
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.basket.id).toBe(trip.id);
      expect(reopened.listTrips()).toHaveLength(1);
      expect(other.listTrips()).toEqual([]);
      expect(other.startTrip("persistent-start", "Aldi").alreadyApplied).toBe(
        false,
      );
    } finally {
      reopened.close();
      other.close();
    }
  });

  it("rejects every cross-account item and trip mutation without revealing ownership", () => {
    const trip = alice.startTrip("start-alice").basket;
    const id = alice.addItem(
      "add-milk-1",
      trip.id,
      itemInputSchema.parse({ name: "Milk", unitPriceCents: 199 }),
    ).basket.items[0]!.id;
    const attacks = [
      () =>
        bob.addItem(
          "attack-01",
          trip.id,
          itemInputSchema.parse({ name: "Injected", unitPriceCents: 1 }),
        ),
      () => bob.updateItem("attack-02", trip.id, id, { unitPriceCents: 0 }),
      () => bob.removeItem("attack-03", trip.id, id),
      () => bob.setThresholds("attack-04", trip.id, [1]),
      () => bob.setExpiry("attack-05", trip.id, id, null),
      () => bob.checkout("attack-06", trip.id),
      () => bob.markConsumed("attack-07", trip.id, id, true),
    ];
    for (const attack of attacks)
      expect(attack).toThrow("Shopping trip not found.");
    expect(alice.getBasket(trip.id)?.totalCents).toBe(199);
    expect(alice.getBasket(trip.id)?.status).toBe("active");
  });

  it("preserves legacy local data and retry IDs without assigning them to a signed-in account", () => {
    const fixture = new BasketStore(":memory:");
    const trip = fixture.startTrip("legacy-start").basket;
    fixture.close();
    const legacyPath = join(directory, "legacy.sqlite");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE trips (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, trip_id TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO trips VALUES (?, ?, ?)").run(
      trip.id,
      trip.createdAt,
      JSON.stringify(trip),
    );
    db.prepare("INSERT INTO operations VALUES (?, ?, ?)").run(
      "legacy-op",
      "original-fingerprint",
      trip.id,
    );
    db.close();
    const local = new BasketStore(legacyPath);
    const remote = new BasketStore(legacyPath, "verified-alice");
    try {
      expect(local.getBasket()?.id).toBe(trip.id);
      expect(remote.getBasket()).toBeNull();
      expect(() => remote.getBasket(trip.id)).toThrow("not found");
      const check = new DatabaseSync(legacyPath);
      expect(
        check
          .prepare(
            "SELECT fingerprint FROM operations WHERE owner_id = 'local' AND id = 'legacy-op'",
          )
          .get()?.fingerprint,
      ).toBe("original-fingerprint");
      check.close();
    } finally {
      local.close();
      remote.close();
    }
  });

  it("rejects absent or oversized account identities", () => {
    expect(() => new BasketStore(path, " ")).toThrow("identity");
    expect(() => new BasketStore(path, "x".repeat(257))).toThrow("identity");
  });
});

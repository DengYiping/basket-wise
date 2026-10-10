import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemInputSchema } from "../src/domain.js";
import { BasketStore } from "../src/store.js";

describe("durable personal baskets", () => {
  let store: BasketStore;
  let tripId: string;
  beforeEach(() => {
    store = new BasketStore(":memory:");
    tripId = store.startTrip("start-0001").basket.id;
  });
  afterEach(() => store.close());
  const item = (
    unitPriceCents: number,
    quantity = 1,
    thresholdEligible = true,
  ) =>
    itemInputSchema.parse({
      name: "Milk",
      unitPriceCents,
      quantity,
      thresholdEligible,
    });

  it("tracks exact totals and returns both milestone crossings on a large addition", () => {
    store.addItem("add-00001", tripId, item(2499));
    const result = store.addItem("add-00002", tripId, item(2501));
    expect(result.basket.totalCents).toBe(5000);
    expect(result.newlyReachedThresholdsCents).toEqual([2500, 5000]);
    expect(result.basket.nextThresholdCents).toBeNull();
  });
  it("keeps excluded lines in the payable total but not milestones", () => {
    store.addItem("add-00001", tripId, item(2400));
    const result = store.addItem("add-00002", tripId, item(150, 1, false));
    expect(result.basket.totalCents).toBe(2550);
    expect(result.basket.thresholdSubtotalCents).toBe(2400);
    expect(result.basket.thresholds[0]?.remainingCents).toBe(100);
    expect(result.newlyReachedThresholdsCents).toEqual([]);
  });
  it("retries an addition exactly once and returns current state rather than stale state", () => {
    store.addItem("add-00001", tripId, item(100));
    store.addItem("add-00002", tripId, item(200));
    const replay = store.addItem("add-00001", tripId, item(100));
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.basket.items).toHaveLength(2);
    expect(replay.basket.totalCents).toBe(300);
    expect(replay.newlyReachedThresholdsCents).toEqual([]);
  });
  it("deduplicates trip creation but preserves explicitly new trips", () => {
    expect(store.startTrip("start-0001").basket.id).toBe(tripId);
    expect(store.startTrip("start-0002").basket.id).not.toBe(tripId);
    expect(store.listTrips()).toHaveLength(2);
  });
  it("accepts any store with independent, customisable spending milestones", () => {
    const trip = store.startTrip("start-lidl", "Lidl", [1500, 4200]).basket;
    expect(trip.store).toBe("Lidl");
    expect(trip.thresholdsCents).toEqual([1500, 4200]);
    expect(
      store.addItem("add-lidl1", trip.id, item(1700))
        .newlyReachedThresholdsCents,
    ).toEqual([1500]);
    expect(
      store.setThresholds("limit-new", trip.id, [2000, 6000]).basket
        .nextThresholdCents,
    ).toBe(2000);
    expect(store.getBasket(tripId)?.thresholdsCents).toEqual([2500, 5000]);
  });
  it("refuses to reuse a mutation ID with a different payload", () => {
    store.addItem("add-00001", tripId, item(100));
    expect(() => store.addItem("add-00001", tripId, item(200))).toThrow(
      "different change",
    );
    expect(store.getBasket(tripId)?.totalCents).toBe(100);
  });
  it("does not merge distinct items just because their names match", () => {
    store.addItem("add-00001", tripId, item(100));
    store.addItem("add-00002", tripId, item(100));
    expect(store.getBasket(tripId)?.items).toHaveLength(2);
  });
  it("corrects quantity without resetting other fields", () => {
    const added = store.addItem("add-00001", tripId, item(325, 2, false));
    const id = added.basket.items[0]!.id;
    const result = store.updateItem("update-01", tripId, id, {
      quantity: 3,
      notes: undefined,
    });
    expect(result.basket.totalCents).toBe(975);
    expect(result.basket.items[0]?.thresholdEligible).toBe(false);
    expect(result.basket.items[0]?.notes).toBe("");
  });
  it("rolls back invalid updates atomically", () => {
    const added = store.addItem("add-00001", tripId, item(325));
    expect(() =>
      store.updateItem("update-01", tripId, added.basket.items[0]!.id, {
        quantity: -1,
      }),
    ).toThrow();
    expect(store.getBasket(tripId)?.totalCents).toBe(325);
    expect(
      store.updateItem("update-01", tripId, added.basket.items[0]!.id, {
        quantity: 2,
      }).basket.totalCents,
    ).toBe(650);
  });
  it("recalculates milestones when an item is put back", () => {
    const added = store.addItem("add-00001", tripId, item(2500));
    const result = store.removeItem(
      "remove-01",
      tripId,
      added.basket.items[0]!.id,
    );
    expect(result.basket.totalCents).toBe(0);
    expect(result.basket.thresholds[0]?.reached).toBe(false);
    expect(
      store.removeItem("remove-01", tripId, added.basket.items[0]!.id)
        .alreadyApplied,
    ).toBe(true);
  });
  it("locks purchased amounts but allows expiry recording afterwards", () => {
    const added = store.addItem("add-00001", tripId, item(325));
    const id = added.basket.items[0]!.id;
    store.checkout("checkout1", tripId);
    expect(() => store.addItem("add-00002", tripId, item(100))).toThrow(
      "checked out",
    );
    expect(() =>
      store.updateItem("update-01", tripId, id, { quantity: 2 }),
    ).toThrow("checked out");
    expect(() => store.removeItem("remove-01", tripId, id)).toThrow(
      "checked out",
    );
    expect(
      store.setExpiry("expiry-01", tripId, id, {
        date: "2026-10-14",
        kind: "use_by",
        source: "photo",
        confirmed: true,
      }).basket.items[0]?.expiry?.date,
    ).toBe("2026-10-14");
  });
  it("lists past and upcoming dates, excludes consumed items, and preserves purchase totals", () => {
    const id = store.addItem("add-00001", tripId, item(325)).basket.items[0]!
      .id;
    store.setExpiry("expiry-01", tripId, id, {
      date: "2026-10-09",
      kind: "best_before",
      source: "user",
      confirmed: true,
    });
    expect(store.listExpiring(3, "2026-10-10").items[0]?.dateStatus).toBe(
      "past_date",
    );
    store.checkout("checkout1", tripId);
    store.markConsumed("consume01", tripId, id, true);
    expect(store.listExpiring(3, "2026-10-10").items).toHaveLength(0);
    expect(store.getBasket(tripId)?.totalCents).toBe(325);
    store.markConsumed("consume02", tripId, id, false);
    expect(store.listExpiring(3, "2026-10-10").items).toHaveLength(1);
  });
  it("does not include dates beyond the inclusive horizon", () => {
    const id = store.addItem("add-00001", tripId, item(325)).basket.items[0]!
      .id;
    store.setExpiry("expiry-01", tripId, id, {
      date: "2026-10-13",
      kind: "use_by",
      source: "user",
      confirmed: true,
    });
    expect(store.listExpiring(3, "2026-10-10").items).toHaveLength(1);
    expect(store.listExpiring(2, "2026-10-10").items).toHaveLength(0);
  });
  it("prefers an active trip, even after another trip is checked out", () => {
    store.startTrip("start-0002");
    const newer = store.getBasket()!;
    store.checkout("checkout1", newer.id);
    expect(store.getBasket()?.id).toBe(tripId);
  });
  it("survives closing and reopening the database, including retry IDs", () => {
    const directory = mkdtempSync(join(tmpdir(), "basket-wise-test-"));
    const path = join(directory, "basket.sqlite");
    let fileStore = new BasketStore(path);
    try {
      const id = fileStore.startTrip("start-file").basket.id;
      fileStore.addItem("add-file1", id, item(325));
      fileStore.close();
      fileStore = new BasketStore(path);
      expect(fileStore.getBasket(id)?.totalCents).toBe(325);
      expect(fileStore.addItem("add-file1", id, item(325)).alreadyApplied).toBe(
        true,
      );
    } finally {
      fileStore.close();
      rmSync(directory, { recursive: true });
    }
  });
});

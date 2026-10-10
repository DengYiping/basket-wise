import { describe, expect, it } from "vitest";
import {
  calculateGuest,
  emptyGuestState,
  MAX_GUEST_ITEMS,
  parseGuestState,
} from "../src/guest.js";
import { GuestSession, type WidgetStorage } from "../web/guest-state.js";

const now = new Date("2026-10-10T12:00:00.000Z");
async function start(currency = "EUR") {
  return calculateGuest(
    {
      state: emptyGuestState(),
      action: { kind: "start_trip", operationId: "start-0001", currency },
    },
    now,
  );
}
async function withItem(currency = "EUR") {
  const first = await start(currency);
  return calculateGuest(
    {
      state: first.state,
      action: {
        kind: "add_item",
        operationId: "add-item1",
        tripId: first.basket!.id,
        name: "Apples",
        unitPriceCents: 3999,
        quantity: 0.5,
        unit: "kg",
      },
    },
    now,
  );
}

describe("stateless guest calculations", () => {
  it("starts one chosen-currency trip without changing its input", async () => {
    const state = emptyGuestState();
    const original = structuredClone(state);
    const result = await calculateGuest(
      {
        state,
        action: {
          kind: "start_trip",
          operationId: "start-0001",
          currency: "KWD",
        },
      },
      now,
    );
    expect(state).toEqual(original);
    expect(result.basket).toMatchObject({
      currency: "KWD",
      currencyScale: 1000,
      thresholdsCents: [25000, 50000],
      items: [],
    });
    expect(result.state.revision).toBe(1);
  });
  it.each(["EUR", "JPY", "KWD", "CLF"])(
    "keeps half-up integer arithmetic for %s",
    async (currency) => {
      const result = await withItem(currency);
      expect(result.basket!.totalCents).toBe(2000);
      expect(result.basket!.items[0]!.lineTotalCents).toBe(2000);
    },
  );
  it("has no global basket, even on consecutive requests", async () => {
    await withItem();
    const result = await calculateGuest({
      state: emptyGuestState(),
      action: { kind: "get_basket" },
    });
    expect(result.basket).toBeNull();
  });
  it("retries from the same base do not add a second line and use stable IDs", async () => {
    const first = await start();
    const request = {
      state: first.state,
      action: {
        kind: "add_item",
        operationId: "add-item1",
        tripId: first.basket!.id,
        name: "Milk",
        unitPriceCents: 220,
      },
    };
    const a = await calculateGuest(request, now);
    const b = await calculateGuest(request, now);
    expect(a).toEqual(b);
    const retry = await calculateGuest({ ...request, state: a.state }, now);
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.state.revision).toBe(2);
    expect(retry.basket!.items).toHaveLength(1);
  });
  it("rejects changing a receipted operation without changing the snapshot", async () => {
    const first = await withItem();
    const saved = structuredClone(first.state);
    await expect(
      calculateGuest({
        state: first.state,
        action: {
          kind: "add_item",
          operationId: "add-item1",
          tripId: first.basket!.id,
          name: "Different",
          unitPriceCents: 1,
        },
      }),
    ).rejects.toThrow("different change");
    expect(first.state).toEqual(saved);
  });
  it("only addresses the supplied basket and its item IDs", async () => {
    const first = await withItem();
    await expect(
      calculateGuest({
        state: first.state,
        action: { kind: "get_basket", tripId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("current guest basket");
    await expect(
      calculateGuest({
        state: first.state,
        action: {
          kind: "remove_item",
          operationId: "remove01",
          tripId: first.basket!.id,
          itemId: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow("Item not found");
  });
  it("supports corrections, exclusions, milestones and removal", async () => {
    let result = await withItem("KWD");
    const tripId = result.basket!.id;
    const itemId = result.basket!.items[0]!.id;
    result = await calculateGuest({
      state: result.state,
      action: {
        kind: "set_thresholds",
        operationId: "targets1",
        tripId,
        thresholdsCents: [2000, 5000],
      },
    });
    expect(result.newlyReachedThresholdsCents).toEqual([]);
    result = await calculateGuest({
      state: result.state,
      action: {
        kind: "update_item",
        operationId: "update01",
        tripId,
        itemId,
        patch: { quantity: 0.25, thresholdEligible: false },
      },
    });
    expect(result.basket).toMatchObject({
      totalCents: 1000,
      thresholdSubtotalCents: 0,
    });
    result = await calculateGuest({
      state: result.state,
      action: { kind: "remove_item", operationId: "remove01", tripId, itemId },
    });
    expect(result.basket!.totalCents).toBe(0);
  });
  it("reports crossed thresholds once", async () => {
    const first = await start();
    const result = await calculateGuest({
      state: first.state,
      action: {
        kind: "add_item",
        operationId: "add-item1",
        tripId: first.basket!.id,
        name: "Groceries",
        unitPriceCents: 2600,
      },
    });
    expect(result.newlyReachedThresholdsCents).toEqual([2500]);
  });
  it("finishes without a saved history and prevents price edits afterwards", async () => {
    const first = await withItem();
    const done = await calculateGuest(
      {
        state: first.state,
        action: {
          kind: "checkout_trip",
          operationId: "checkout1",
          tripId: first.basket!.id,
        },
      },
      now,
    );
    expect(done.basket).toMatchObject({
      status: "checked_out",
      checkedOutAt: now.toISOString(),
    });
    await expect(
      calculateGuest({
        state: done.state,
        action: {
          kind: "add_item",
          operationId: "add-item2",
          tripId: done.basket!.id,
          name: "Tea",
          unitPriceCents: 100,
        },
      }),
    ).rejects.toThrow("finished");
    const next = await calculateGuest({
      state: done.state,
      action: {
        kind: "start_trip",
        operationId: "start-0002",
        currency: "JPY",
      },
    });
    const listed = await calculateGuest({
      state: next.state,
      action: { kind: "list_trips" },
    });
    expect(listed.trips).toHaveLength(1);
    expect(listed.trips![0]!.id).not.toBe(done.basket!.id);
    expect(next.basket!.items).toEqual([]);
  });
  it("requires the full confirmed photo date and distinguishes label kinds", async () => {
    const first = await withItem();
    const base = {
      kind: "set_item_expiry",
      operationId: "expiry01",
      tripId: first.basket!.id,
      itemId: first.basket!.items[0]!.id,
    };
    for (const expiry of [
      { date: "10-14", kind: "use_by", source: "photo", confirmed: true },
      { date: "2026-10-14", kind: "use_by", source: "photo", confirmed: false },
      { date: "2026-02-30", kind: "use_by", source: "photo", confirmed: true },
    ])
      await expect(
        calculateGuest({ state: first.state, action: { ...base, expiry } }),
      ).rejects.toThrow();
    const dated = await calculateGuest({
      state: first.state,
      action: {
        ...base,
        expiry: {
          date: "2026-10-14",
          kind: "best_before",
          source: "photo",
          confirmed: true,
        },
      },
    });
    expect(dated.basket!.items[0]!.expiry!.kind).toBe("best_before");
    const dates = await calculateGuest(
      {
        state: dated.state,
        action: { kind: "list_expiring_items", daysAhead: 7 },
      },
      now,
    );
    expect(dates.items).toHaveLength(1);
  });
  it("rejects oversized, duplicate-ID, invalid-currency and wrong-version snapshots", async () => {
    const first = await withItem();
    expect(() => parseGuestState({ ...first.state, version: 2 })).toThrow();
    expect(() =>
      parseGuestState({
        ...first.state,
        trip: { ...first.state.trip, currency: "ZZZ" },
      }),
    ).toThrow();
    expect(() =>
      parseGuestState({
        ...first.state,
        trip: {
          ...first.state.trip,
          items: [first.basket!.items[0], first.basket!.items[0]],
        },
      }),
    ).toThrow("unique");
    expect(() =>
      parseGuestState({ ...first.state, padding: "x".repeat(65_536) }),
    ).toThrow("too large");
    expect(() =>
      parseGuestState({
        ...first.state,
        trip: {
          ...first.state.trip,
          items: Array.from({ length: MAX_GUEST_ITEMS + 1 }, () => ({
            ...first.basket!.items[0],
            id: crypto.randomUUID(),
          })),
        },
      }),
    ).toThrow();
  });
});

describe("per-widget guest snapshot lifecycle", () => {
  it("serializes slow host saves so an older snapshot cannot overwrite a newer one", async () => {
    const first = await start();
    const second = await withItem();
    let release: (() => void) | undefined;
    let savedRevision = 0;
    const session = new GuestSession(() => ({
      setWidgetState: async (value) => {
        const revision = (value as { basketWiseGuest: { revision: number } })
          .basketWiseGuest.revision;
        if (revision === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        savedRevision = revision;
      },
    }));
    const oldSave = session.accept(first);
    await Promise.resolve();
    const newSave = session.accept(second);
    release!();
    await Promise.all([oldSave, newSave]);
    expect(savedRevision).toBe(2);
    expect(session.state.trip!.items).toHaveLength(1);
  });
  it("restores only the namespaced, validated widget snapshot", async () => {
    const result = await withItem();
    const session = new GuestSession(() => ({
      widgetState: { basketWiseGuest: result.state },
    }));
    expect(session.restore()).toBe(true);
    expect(session.state).toEqual(result.state);
  });
  it("writes through setWidgetState and restores after a simulated reload", async () => {
    let saved: unknown;
    const storage: WidgetStorage = {
      setWidgetState: (value) => {
        saved = value;
        storage.widgetState = value;
      },
    };
    const session = new GuestSession(() => storage);
    await session.invoke(
      "start_trip",
      { operationId: "start-0001" },
      (state, action) => calculateGuest({ state, action }, now),
    );
    expect(saved).toEqual({ basketWiseGuest: session.state });
    const reloaded = new GuestSession(() => storage);
    expect(reloaded.restore()).toBe(true);
    expect(reloaded.state).toEqual(session.state);
  });
  it("does not replace newer local state with a stale or conflicting result", async () => {
    const session = new GuestSession(() => ({
      setWidgetState: () => undefined,
    }));
    const first = await start();
    await session.accept(first);
    await session.accept(await withItem());
    await expect(session.accept(first)).rejects.toThrow("older or conflicting");
    const conflict = await start("JPY");
    conflict.state.revision = session.state.revision;
    await expect(session.accept(conflict)).rejects.toThrow(
      "older or conflicting",
    );
    expect(session.state.trip!.items).toHaveLength(1);
  });
  it("keeps data in memory and warns if the host cannot persist", async () => {
    const session = new GuestSession(() => undefined);
    await session.accept(await withItem());
    expect(session.state.trip!.items).toHaveLength(1);
    expect(session.storageWarning).toContain("only in memory");
  });
  it("does not overwrite malformed or newer unknown-version host state during restore", () => {
    const saved = { basketWiseGuest: { version: 99 } };
    let written = false;
    const session = new GuestSession(() => ({
      widgetState: saved,
      setWidgetState: () => {
        written = true;
      },
    }));
    expect(session.restore()).toBe(false);
    expect(written).toBe(false);
    expect(session.storageWarning).toContain("not been overwritten");
  });
  it("rejects an in-flight result when newer state arrived", async () => {
    const session = new GuestSession(() => ({
      setWidgetState: () => undefined,
    }));
    const first = await start();
    await session.accept(first);
    const pending = await calculateGuest({
      state: first.state,
      action: {
        kind: "set_thresholds",
        operationId: "targets1",
        tripId: first.basket!.id,
        thresholdsCents: [100],
      },
    });
    await session.accept(await withItem());
    await expect(session.accept(pending, 1)).rejects.toThrow("changed while");
    expect(session.state.trip!.items).toHaveLength(1);
  });
});

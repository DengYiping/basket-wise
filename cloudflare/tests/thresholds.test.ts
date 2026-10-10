import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  calculateThresholdAction,
  summarizeThresholds,
  suggestRemovals,
  thresholdActionSchema,
  thresholdConfigSchema,
  thresholdStatus,
  type ThresholdConfig,
  type ThresholdTrip,
} from "../src/thresholds.js";

function trip(
  amounts: number[],
  thresholdConfig?: ThresholdConfig,
): ThresholdTrip {
  return {
    id: randomUUID(),
    store: "Test",
    currency: "EUR",
    timezone: "Europe/Dublin",
    createdAt: "2026-10-10T12:00:00Z",
    checkedOutAt: null,
    status: "active",
    thresholdsCents: [2500, 5000],
    ...(thresholdConfig ? { thresholdConfig } : {}),
    items: amounts.map((unitPriceCents) => ({
      id: randomUUID(),
      name: `Item ${unitPriceCents}`,
      unitPriceCents,
      quantity: 1,
      unit: "each",
      thresholdEligible: true,
      consumed: false,
      expiry: null,
      notes: "",
    })),
  };
}
const unlimited: ThresholdConfig = { mode: "unlimited", amountCents: 2500 };
const finite = (...amounts: number[]): ThresholdConfig => ({
  mode: "static",
  entries: amounts.map((amountCents) => ({ amountCents, count: 1 })),
});

test("unlimited 25 repeats past the original milestones without an upper cap", () => {
  const t = trip([], unlimited);
  for (const amount of [2500, 5000, 7500, 12500, 15000, 5_000_000_000]) {
    const status = thresholdStatus(t, amount);
    assert.equal(status.highestReachedCents, amount);
    assert.equal(status.nextThresholdCents, amount + 2500);
    assert.equal(status.maximumThresholdCents, null);
  }
  assert.equal(thresholdStatus(t, 2499).highestReachedCents, null);
  assert.equal(thresholdStatus(t, 8000).highestReachedCents, 7500);
  assert.equal(thresholdStatus(t, 8000).nextThresholdCents, 10000);
});

test("finite thresholds count each available copy once and support combinations", () => {
  const t = trip([], finite(3000, 5000));
  for (const [subtotal, highest, next] of [
    [2999, null, 3000],
    [3000, 3000, 5000],
    [5000, 5000, 8000],
    [7999, 5000, 8000],
    [8000, 8000, null],
    [15000, 8000, null],
  ]) {
    const status = thresholdStatus(t, subtotal!);
    assert.equal(status.highestReachedCents, highest);
    assert.equal(status.nextThresholdCents, next);
  }
  const twice = trip([], {
    mode: "static",
    entries: [{ amountCents: 5000, count: 2 }],
  });
  assert.equal(thresholdStatus(twice, 7500).highestReachedCents, 5000);
  assert.equal(thresholdStatus(twice, 7500).nextThresholdCents, 10000);
  assert.deepEqual(thresholdStatus(twice, 15000).usedThresholds, [
    { amountCents: 5000, count: 2 },
  ]);
  const twenty = trip([], {
    mode: "static",
    entries: [{ amountCents: 1_000_000, count: 20 }],
  });
  assert.equal(
    thresholdStatus(twenty, 19_999_999).highestReachedCents,
    19_000_000,
  );
});

test("old stored milestones preserve their independent-list meaning", () => {
  const t = trip([8000]);
  assert.equal(thresholdStatus(t, 8000).highestReachedCents, 5000);
  assert.equal(thresholdStatus(t, 8000).nextThresholdCents, null);
  assert.equal(summarizeThresholds(t).thresholdConfig, undefined);
});

test("schema rejects ambiguous, zero, fractional, oversized, and excessive configurations", () => {
  for (const thresholdConfig of [
    { mode: "unlimited", amountCents: 0 },
    { mode: "unlimited", amountCents: 25.5 },
    { mode: "unlimited", amountCents: 1_000_001 },
    { mode: "static", entries: [] },
    { mode: "static", entries: [{ amountCents: 5000, count: 21 }] },
    {
      mode: "static",
      entries: [
        { amountCents: 5000, count: 11 },
        { amountCents: 3000, count: 10 },
      ],
    },
  ])
    assert.equal(
      thresholdConfigSchema.safeParse(thresholdConfig).success,
      false,
    );
  assert.equal(
    thresholdActionSchema.safeParse({
      kind: "set_thresholds",
      operationId: randomUUID(),
      tripId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    thresholdActionSchema.safeParse({
      kind: "start_trip",
      operationId: randomUUID(),
      thresholdConfig: unlimited,
      thresholdsCents: [2500],
    }).success,
    false,
  );
  assert.equal(
    thresholdActionSchema.safeParse({
      kind: "suggest_removals",
      targetCents: 2_000_000,
    }).success,
    true,
    "combined targets may exceed one threshold's per-amount limit",
  );
});

test("threshold configuration survives every legacy item mutation but legacy set explicitly replaces it", async () => {
  let t = (
    await calculateThresholdAction(null, {
      kind: "start_trip",
      operationId: randomUUID(),
      store: "Test",
      currency: "EUR",
      thresholdConfig: unlimited,
    })
  ).trip;
  t = (
    await calculateThresholdAction(t, {
      kind: "add_item",
      operationId: randomUUID(),
      tripId: t.id,
      name: "Milk",
      unitPriceCents: 8000,
      quantity: 1,
      unit: "each",
      thresholdEligible: true,
      notes: "",
    })
  ).trip;
  assert.deepEqual(t.thresholdConfig, unlimited);
  assert.equal(
    summarizeThresholds(t).thresholdStatus.highestReachedCents,
    7500,
  );
  t = (
    await calculateThresholdAction(t, {
      kind: "update_item",
      operationId: randomUUID(),
      tripId: t.id,
      itemId: t.items[0]!.id,
      patch: { unitPriceCents: 15000 },
    })
  ).trip;
  assert.deepEqual(t.thresholdConfig, unlimited);
  t = (
    await calculateThresholdAction(t, {
      kind: "set_thresholds",
      operationId: randomUUID(),
      tripId: t.id,
      thresholdsCents: [3000],
    })
  ).trip;
  assert.equal(t.thresholdConfig, undefined);
  assert.equal(
    summarizeThresholds(t).thresholdStatus.highestReachedCents,
    3000,
  );
});

test("80-euro basket preserves 75 in unlimited mode, or 50 with a single static threshold", () => {
  const t = trip([5000, 2500, 500], unlimited);
  const plan = suggestRemovals(t, {
    kind: "suggest_removals",
    keepItemIds: [],
  });
  assert.equal(plan.status, "suggested");
  if (plan.status !== "suggested") return;
  assert.equal(plan.targetCents, 7500);
  assert.equal(plan.savingsCents, 500);
  assert.equal(plan.resultingThresholdSubtotalCents, 7500);
  t.thresholdConfig = finite(5000);
  const second = suggestRemovals(t, {
    kind: "suggest_removals",
    keepItemIds: [],
  });
  assert.equal(second.status, "suggested");
  if (second.status !== "suggested") return;
  assert.equal(second.targetCents, 5000);
  assert.equal(second.savingsCents, 3000);
  assert.equal(second.resultingTotalCents, 5000);
  assert.equal(second.optimal, true);
  assert.equal(t.items.length, 3, "advice never mutates the basket");
});

test("optimizer uses combinations, whole-line rounding, eligibility and protected items", () => {
  // Greedily removing 25 would lose to removing 16 + 14 at a 30 budget.
  const t = trip([5000, 2500, 1600, 1400], finite(7500));
  const plan = suggestRemovals(t, {
    kind: "suggest_removals",
    keepItemIds: [t.items[0]!.id],
  });
  assert.equal(plan.status, "suggested");
  if (plan.status !== "suggested") return;
  assert.equal(plan.savingsCents, 3000);
  assert.deepEqual(
    plan.removals.map((item) => item.lineTotalCents),
    [1600, 1400],
  );
  const weighted = trip([33, 1000, 100], {
    mode: "unlimited",
    amountCents: 100,
  });
  weighted.items[0]!.quantity = 0.5; // rounds half-up to 17 cents once
  weighted.items[1]!.thresholdEligible = false;
  const rounded = suggestRemovals(weighted, {
    kind: "suggest_removals",
    keepItemIds: [],
  });
  assert.equal(rounded.status, "suggested");
  if (rounded.status !== "suggested") return;
  assert.equal(rounded.savingsCents, 1017);
  assert.equal(rounded.resultingTotalCents, 100);
  assert.equal(rounded.resultingThresholdSubtotalCents, 100);
  assert.equal(rounded.removals[1]!.quantity, 0.5);
});

test("optimizer never promises removal can reach a higher target and handles no-fit/checked-out cases", () => {
  const t = trip([8000], unlimited);
  assert.throws(
    () =>
      suggestRemovals(t, {
        kind: "suggest_removals",
        keepItemIds: [],
        targetCents: 10000,
      }),
    /invalid_request/,
  );
  assert.throws(
    () =>
      suggestRemovals(t, {
        kind: "suggest_removals",
        keepItemIds: [],
        targetCents: 7400,
      }),
    /invalid_request/,
  );
  assert.throws(
    () =>
      suggestRemovals(t, {
        kind: "suggest_removals",
        keepItemIds: [randomUUID()],
      }),
    /invalid_request/,
  );
  const plan = suggestRemovals(t, {
    kind: "suggest_removals",
    keepItemIds: [],
  });
  assert.equal(plan.status, "suggested");
  if (plan.status === "suggested") assert.deepEqual(plan.removals, []);
  const low = trip([2400], unlimited);
  assert.equal(
    suggestRemovals(low, { kind: "suggest_removals", keepItemIds: [] }).status,
    "no_threshold_reached",
  );
  t.status = "checked_out";
  assert.equal(
    suggestRemovals(t, { kind: "suggest_removals", keepItemIds: [] }).status,
    "trip_checked_out",
  );
});

test("bounded optimizer labels incomplete search honestly and always preserves the target", () => {
  const t = trip([5100, 2600, 1700, 1300], finite(7500));
  const result = suggestRemovals(
    t,
    { kind: "suggest_removals", keepItemIds: [] },
    1,
  );
  assert.equal(result.status, "suggested");
  if (result.status !== "suggested") return;
  assert.equal(result.optimal, false);
  assert.ok(result.resultingThresholdSubtotalCents >= result.targetCents!);
});

test("small finite policies and removal plans match exhaustive integer-cent oracles", () => {
  let seed = 73;
  const random = (max: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };
  for (let run = 0; run < 80; run++) {
    const amounts = Array.from({ length: 8 }, () => 1 + random(70));
    const subtotal = random(400);
    const all = choicesForTest(amounts);
    const status = thresholdStatus(trip([], finite(...amounts)), subtotal);
    assert.equal(
      status.highestReachedCents,
      Math.max(0, ...all.filter((n) => n <= subtotal)) || null,
    );
    assert.equal(
      status.nextThresholdCents,
      all.filter((n) => n > subtotal).sort((a, b) => a - b)[0] ?? null,
    );
    const t = trip(amounts, { mode: "unlimited", amountCents: 70 });
    const total = amounts.reduce((a, b) => a + b, 0);
    const budget = total % 70;
    const plan = suggestRemovals(t, {
      kind: "suggest_removals",
      keepItemIds: [],
    });
    if (plan.status === "suggested") {
      assert.equal(
        plan.savingsCents,
        Math.max(...all.filter((n) => n <= budget)),
      );
      assert.equal(plan.optimal, true);
    }
  }
});
function choicesForTest(amounts: number[]) {
  let values = [0];
  for (const amount of amounts)
    values = [...values, ...values.map((value) => value + amount)];
  return values;
}

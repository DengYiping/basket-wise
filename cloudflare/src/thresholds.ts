import { z } from "zod";
import {
  currencySchema,
  idSchema,
  itemInputSchema,
  moneySchema,
  operationSchema,
  summarize,
  thresholdsSchema,
  type Trip,
} from "../../src/domain.js";
import {
  calculateGuest,
  guestActionSchema as legacyActionSchema,
  type GuestAction as LegacyAction,
} from "../../src/guest.js";

const positiveMoney = moneySchema.refine((amount) => amount > 0);
export const thresholdConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("unlimited"),
    amountCents: positiveMoney.describe(
      "Repeat this amount without a quantity limit: 2500 EUR minor units gives 25, 50, 75, 100, etc.",
    ),
  }),
  z.strictObject({
    mode: z.literal("static"),
    entries: z
      .array(
        z.strictObject({
          amountCents: positiveMoney,
          count: z.number().int().min(1).max(20),
        }),
      )
      .min(1)
      .max(10)
      .refine(
        (entries) => entries.reduce((sum, entry) => sum + entry.count, 0) <= 20,
        "At most 20 available thresholds per trip.",
      ),
  }),
]);
export type ThresholdConfig = z.infer<typeof thresholdConfigSchema>;
export type ThresholdTrip = Trip & { thresholdConfig?: ThresholdConfig };

const startSchema = z
  .object({
    kind: z.literal("start_trip"),
    operationId: operationSchema,
    store: z.string().trim().min(1).max(120).default("Supermarket"),
    currency: currencySchema.default("EUR"),
    thresholdsCents: thresholdsSchema.optional(),
    thresholdConfig: thresholdConfigSchema.optional(),
  })
  .refine(
    (a) => !(a.thresholdsCents && a.thresholdConfig),
    "Use thresholdConfig or legacy thresholdsCents, not both.",
  );
const setSchema = z
  .object({
    kind: z.literal("set_thresholds"),
    operationId: operationSchema,
    tripId: idSchema,
    thresholdsCents: thresholdsSchema.optional(),
    thresholdConfig: thresholdConfigSchema.optional(),
  })
  .refine(
    (a) => Boolean(a.thresholdsCents) !== Boolean(a.thresholdConfig),
    "Provide exactly one of thresholdConfig and legacy thresholdsCents.",
  );
const suggestionSchema = z.object({
  kind: z.literal("suggest_removals"),
  tripId: idSchema.optional(),
  targetCents: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Optional configured threshold to preserve. Defaults to the highest threshold already met; removal cannot reach a higher threshold.",
    ),
  keepItemIds: z
    .array(idSchema)
    .max(50)
    .default([])
    .describe(
      "Never suggest removing these items. Suggestions remove whole lines, including their full quantity.",
    ),
});
const updateSchema = z.object({
  kind: z.literal("update_item"),
  operationId: operationSchema,
  tripId: idSchema,
  itemId: idSchema,
  patch: itemInputSchema
    .partial()
    .strict()
    .refine((patch) => Object.keys(patch).length > 0),
});
const addSchema = itemInputSchema
  .extend({
    kind: z.literal("add_item"),
    operationId: operationSchema,
    tripId: idSchema,
    shoppingListItemId: idSchema
      .optional()
      .describe(
        "Explicit shopping-list entry to consume only if this trip addition succeeds. Never match by name.",
      ),
    expectedShoppingListRevision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Latest shopping-list revision; required with shoppingListItemId. The entire referenced entry is removed, even when the trip quantity differs.",
      ),
  })
  .refine(
    (a) =>
      (a.shoppingListItemId !== undefined) ===
      (a.expectedShoppingListRevision !== undefined),
    "Supply shoppingListItemId and expectedShoppingListRevision together.",
  );
export const thresholdActionSchema = z.discriminatedUnion("kind", [
  startSchema,
  setSchema,
  suggestionSchema,
  updateSchema,
  addSchema,
  ...legacyActionSchema.options.filter(
    (
      s,
    ): s is Extract<
      typeof s,
      {
        shape: {
          kind: z.ZodLiteral<
            "get_basket" | "list_trips" | "remove_item" | "checkout_trip"
          >;
        };
      }
    > =>
      ["get_basket", "list_trips", "remove_item", "checkout_trip"].includes(
        s.shape.kind.value,
      ),
  ),
]);
export type ThresholdAction =
  | Exclude<
      LegacyAction,
      {
        kind:
          | "start_trip"
          | "set_thresholds"
          | "update_item"
          | "add_item"
          | "set_item_expiry"
          | "list_expiring_items"
          | "mark_item_consumed";
      }
    >
  | z.infer<typeof startSchema>
  | z.infer<typeof setSchema>
  | z.infer<typeof updateSchema>
  | z.infer<typeof addSchema>
  | z.infer<typeof suggestionSchema>;

type Choice = { sum: number; mask: number };
function choices(amounts: number[], offset: number): Choice[] {
  const result: Choice[] = [{ sum: 0, mask: 0 }];
  amounts.forEach((amount, index) => {
    const size = result.length;
    for (let i = 0; i < size; i++)
      result.push({
        sum: result[i]!.sum + amount,
        mask: result[i]!.mask | (1 << (offset + index)),
      });
  });
  return result;
}

/** Exact finite combinations, bounded to two lists of at most 2^10 entries. */
function staticStatus(
  config: Extract<ThresholdConfig, { mode: "static" }>,
  subtotal: number,
) {
  const amounts = config.entries.flatMap((entry) =>
    Array<number>(entry.count).fill(entry.amountCents),
  );
  const midpoint = Math.floor(amounts.length / 2);
  const left = choices(amounts.slice(0, midpoint), 0);
  const right = choices(amounts.slice(midpoint), midpoint).sort(
    (a, b) => a.sum - b.sum || a.mask - b.mask,
  );
  let highest = 0,
    mask = 0,
    next = Infinity;
  for (const a of left) {
    let low = 0,
      high = right.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (a.sum + right[middle]!.sum <= subtotal) low = middle + 1;
      else high = middle;
    }
    const below = right[low - 1];
    if (below && a.sum + below.sum > highest) {
      highest = a.sum + below.sum;
      mask = a.mask | below.mask;
    }
    if (right[low]) next = Math.min(next, a.sum + right[low]!.sum);
  }
  const used = new Map<number, number>();
  amounts.forEach((amount, index) => {
    if (mask & (1 << index)) used.set(amount, (used.get(amount) ?? 0) + 1);
  });
  return {
    highestReachedCents: highest || null,
    nextThresholdCents: Number.isFinite(next) ? next : null,
    maximumThresholdCents: amounts.reduce((a, b) => a + b, 0),
    usedThresholds: [...used].map(([amountCents, count]) => ({
      amountCents,
      count,
    })),
  };
}

export function thresholdStatus(trip: ThresholdTrip, subtotal: number) {
  const config = trip.thresholdConfig;
  if (config?.mode === "static")
    return { mode: config.mode, ...staticStatus(config, subtotal) };
  if (config?.mode === "unlimited") {
    const count = Math.floor(subtotal / config.amountCents);
    return {
      mode: config.mode,
      highestReachedCents: count ? count * config.amountCents : null,
      nextThresholdCents: (count + 1) * config.amountCents,
      maximumThresholdCents: null,
      usedThresholds: count ? [{ amountCents: config.amountCents, count }] : [],
    };
  }
  return {
    mode: "milestones" as const,
    highestReachedCents:
      trip.thresholdsCents.filter((amount) => amount <= subtotal).at(-1) ??
      null,
    nextThresholdCents:
      trip.thresholdsCents.find((amount) => amount > subtotal) ?? null,
    maximumThresholdCents: trip.thresholdsCents.at(-1) ?? null,
    usedThresholds: [],
  };
}

export function summarizeThresholds(trip: ThresholdTrip) {
  const basket = summarize(trip);
  const status = thresholdStatus(trip, basket.thresholdSubtotalCents);
  return {
    ...basket,
    items: basket.items.map(withoutFoodTracking),
    ...(trip.thresholdConfig ? { thresholdConfig: trip.thresholdConfig } : {}),
    thresholdStatus: status,
    nextThresholdCents: status.nextThresholdCents,
    // Recurring/finite-combination policies need not materialize an unbounded list.
    thresholds: !trip.thresholdConfig
      ? basket.thresholds
      : [status.highestReachedCents, status.nextThresholdCents]
          .filter((amount): amount is number => amount !== null)
          .map((amountCents) => ({
            amountCents,
            reached: basket.thresholdSubtotalCents >= amountCents,
            remainingCents: Math.max(
              0,
              amountCents - basket.thresholdSubtotalCents,
            ),
          })),
  };
}
export type ThresholdBasket = ReturnType<typeof summarizeThresholds>;

function withoutFoodTracking<
  T extends { expiry?: unknown; consumed?: unknown },
>(item: T) {
  const { expiry: _expiry, consumed: _consumed, ...shoppingItem } = item;
  return shoppingItem;
}

/** Also project receipts written by older releases, without altering idempotency. */
export function publicBasketResult(result: Record<string, unknown>) {
  const basket = result.basket as
    { items?: Record<string, unknown>[] } | null | undefined;
  return basket && Array.isArray(basket.items)
    ? {
        ...result,
        basket: { ...basket, items: basket.items.map(withoutFoodTracking) },
      }
    : result;
}

/** Keep the deployed adapter isolated from the unchanged local application. */
export async function calculateThresholdAction(
  trip: ThresholdTrip | null,
  action: ThresholdAction,
) {
  if (!("operationId" in action)) throw new Error("invalid_request");
  const configured =
    "thresholdConfig" in action ? action.thresholdConfig : undefined;
  const legacyAction = { ...action } as Record<string, unknown>;
  delete legacyAction.thresholdConfig;
  delete legacyAction.shoppingListItemId;
  delete legacyAction.expectedShoppingListRevision;
  if (configured)
    legacyAction.thresholdsCents =
      configured.mode === "unlimited"
        ? [configured.amountCents]
        : [...new Set(configured.entries.map((e) => e.amountCents))];
  const calculated = await calculateGuest({
    state: { version: 1, revision: 0, trip, receipts: [] },
    action: legacyAction,
  });
  const next: ThresholdTrip = calculated.state.trip!;
  if (configured) next.thresholdConfig = configured;
  else if (
    action.kind !== "set_thresholds" &&
    action.kind !== "start_trip" &&
    trip?.thresholdConfig
  )
    next.thresholdConfig = trip.thresholdConfig;
  const previous = trip ? summarizeThresholds(trip).thresholdSubtotalCents : 0;
  const basket = summarizeThresholds(next);
  return {
    trip: next,
    newlyReachedThresholdsCents: basket.thresholds
      .filter(
        (threshold) => threshold.reached && previous < threshold.amountCents,
      )
      .map((threshold) => threshold.amountCents),
  };
}

/** Advisory only. A bounded whole-line subset search never mutates the basket. */
export function suggestRemovals(
  trip: ThresholdTrip,
  action: z.infer<typeof suggestionSchema>,
  nodeLimit = 100_000,
) {
  const basket = summarizeThresholds(trip);
  const target =
    action.targetCents ?? basket.thresholdStatus.highestReachedCents;
  const base = {
    currency: basket.currency,
    currentTotalCents: basket.totalCents,
    currentThresholdSubtotalCents: basket.thresholdSubtotalCents,
    targetCents: target,
    nextThresholdCents: basket.nextThresholdCents,
    wholeLinesOnly: true,
    advisoryOnly: true,
  };
  if (trip.status !== "active")
    return { ...base, status: "trip_checked_out" as const };
  const known = new Set(trip.items.map((item) => item.id));
  if (action.keepItemIds.some((id) => !known.has(id)))
    throw new Error("invalid_request");
  if (target === null)
    return { ...base, status: "no_threshold_reached" as const };
  if (
    target > basket.thresholdSubtotalCents ||
    thresholdStatus(trip, target).highestReachedCents !== target
  )
    throw new Error("invalid_request");
  const keep = new Set(action.keepItemIds);
  const candidates = basket.items.filter(
    (item) => !keep.has(item.id) && item.lineTotalCents > 0,
  );
  const free = candidates.filter((item) => !item.thresholdEligible);
  const eligible = candidates
    .filter((item) => item.thresholdEligible)
    .sort(
      (a, b) => b.lineTotalCents - a.lineTotalCents || a.id.localeCompare(b.id),
    );
  const capacity = basket.thresholdSubtotalCents - target;
  const suffix = Array<number>(eligible.length + 1).fill(0);
  for (let i = eligible.length - 1; i >= 0; i--)
    suffix[i] = suffix[i + 1]! + eligible[i]!.lineTotalCents;
  let best = 0,
    nodes = 0,
    exhausted = false,
    selected: number[] = [];
  const path: number[] = [];
  const seen = new Set<string>();
  function search(index: number, removed: number) {
    if (removed > best) {
      best = removed;
      selected = [...path];
    }
    if (
      best === capacity ||
      index === eligible.length ||
      removed + Math.min(capacity - removed, suffix[index]!) <= best
    )
      return;
    if (++nodes > nodeLimit) {
      exhausted = true;
      return;
    }
    const key = `${index}/${removed}`;
    if (seen.has(key)) return;
    seen.add(key);
    const value = eligible[index]!.lineTotalCents;
    if (removed + value <= capacity) {
      path.push(index);
      search(index + 1, removed + value);
      path.pop();
    }
    if (!exhausted) search(index + 1, removed);
  }
  search(0, 0);
  const removals = [...free, ...selected.map((index) => eligible[index]!)];
  const savings = removals.reduce((sum, item) => sum + item.lineTotalCents, 0);
  return {
    ...base,
    status: "suggested" as const,
    optimal: !exhausted || best === capacity,
    savingsCents: savings,
    resultingTotalCents: basket.totalCents - savings,
    resultingThresholdSubtotalCents: basket.thresholdSubtotalCents - best,
    remainingAboveTargetCents: capacity - best,
    removals: removals.map(
      ({ id, name, quantity, unit, lineTotalCents, thresholdEligible }) => ({
        itemId: id,
        name,
        quantity,
        unit,
        lineTotalCents,
        thresholdEligible,
      }),
    ),
  };
}

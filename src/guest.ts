import { z } from "zod";
import {
  addDays,
  currencySchema,
  defaultThresholds,
  dublinToday,
  expirySchema,
  idSchema,
  itemInputSchema,
  operationSchema,
  summarize,
  thresholdsSchema,
  tripSchema,
  type Trip,
} from "./domain.js";

// Guest state is owned by one widget, never by a server session or database.
export const MAX_GUEST_ITEMS = 50;
export const MAX_GUEST_STATE_BYTES = 64 * 1024;
export const MAX_GUEST_REQUEST_BYTES = 96 * 1024;
const MAX_RECEIPTS = 32;
const guestTripSchema = tripSchema
  .extend({
    items: tripSchema.shape.items.max(MAX_GUEST_ITEMS),
  })
  .refine(
    (trip) =>
      new Set(trip.items.map((item) => item.id)).size === trip.items.length,
    "Item IDs must be unique within this basket.",
  );
export const guestStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0).max(1_000_000),
  trip: guestTripSchema.nullable(),
  receipts: z
    .array(
      z.object({
        id: operationSchema,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(MAX_RECEIPTS),
});
export type GuestState = z.infer<typeof guestStateSchema>;
export const emptyGuestState = (): GuestState => ({
  version: 1,
  revision: 0,
  trip: null,
  receipts: [],
});

const mutation = { operationId: operationSchema, tripId: idSchema };
const itemMutation = { ...mutation, itemId: idSchema };
export const guestActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get_basket"), tripId: idSchema.optional() }),
  z.object({ kind: z.literal("list_trips") }),
  z.object({
    kind: z.literal("list_expiring_items"),
    daysAhead: z.number().int().min(0).max(365).default(3),
  }),
  z.object({
    kind: z.literal("start_trip"),
    operationId: operationSchema,
    store: z.string().trim().min(1).max(120).default("Supermarket"),
    currency: currencySchema.default("EUR"),
    thresholdsCents: thresholdsSchema.optional(),
  }),
  z.object({
    kind: z.literal("add_item"),
    ...mutation,
    ...itemInputSchema.shape,
  }),
  z.object({
    kind: z.literal("update_item"),
    ...itemMutation,
    patch: itemInputSchema
      .partial()
      .refine(
        (value) => Object.keys(value).length > 0,
        "Specify at least one field.",
      ),
  }),
  z.object({ kind: z.literal("remove_item"), ...itemMutation }),
  z.object({
    kind: z.literal("set_thresholds"),
    ...mutation,
    thresholdsCents: thresholdsSchema,
  }),
  z.object({
    kind: z.literal("set_item_expiry"),
    ...itemMutation,
    expiry: expirySchema.nullable(),
  }),
  z.object({ kind: z.literal("checkout_trip"), ...mutation }),
  z.object({
    kind: z.literal("mark_item_consumed"),
    ...itemMutation,
    consumed: z.boolean(),
  }),
]);
export type GuestAction = z.infer<typeof guestActionSchema>;
export const guestRequestSchema = z.object({
  state: guestStateSchema,
  action: guestActionSchema,
});

export function parseGuestState(value: unknown): GuestState {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_GUEST_STATE_BYTES
  )
    throw new Error("This guest basket is too large for widget storage.");
  return guestStateSchema.parse(value);
}

export function guestView(state: GuestState) {
  return {
    mode: "guest" as const,
    state,
    basket: state.trip ? summarize(state.trip) : null,
    newlyReachedThresholdsCents: [] as number[],
    alreadyApplied: false,
  };
}
export type GuestResult = ReturnType<typeof guestView> & {
  trips?: { id: string; store: string; createdAt: string; currency: string }[];
  items?: (Trip["items"][number] & { tripId: string; tripStatus: string })[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function operationUuid(operationId: string): Promise<string> {
  const hash = await digest(`basket-wise-guest:${operationId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Pure snapshot transformation. No database, global basket, cookies or user IDs. */
export async function calculateGuest(
  input: unknown,
  now = new Date(),
): Promise<GuestResult> {
  const parsed = guestRequestSchema.parse(input);
  const state = parseGuestState(parsed.state);
  const action = parsed.action;
  const trip = state.trip;
  if (!("operationId" in action)) {
    const result: GuestResult = guestView(state);
    if (
      action.kind === "get_basket" &&
      action.tripId &&
      action.tripId !== trip?.id
    )
      throw new Error("Only this widget's current guest basket is available.");
    if (action.kind === "list_trips") result.trips = trip ? [trip] : [];
    if (action.kind === "list_expiring_items") {
      const through = addDays(dublinToday(now), action.daysAhead);
      result.items = trip
        ? trip.items
            .filter(
              (item) =>
                !item.consumed && item.expiry && item.expiry.date <= through,
            )
            .map((item) => ({
              ...item,
              tripId: trip.id,
              tripStatus: trip.status,
            }))
        : [];
    }
    return result;
  }

  const fingerprint = await digest(canonical(action));
  const receipt = state.receipts.find(
    (entry) => entry.id === action.operationId,
  );
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new Error(
        "Operation ID already used for a different change. Use a fresh ID.",
      );
    return { ...guestView(state), alreadyApplied: true };
  }
  const previous = trip ? summarize(trip).thresholdSubtotalCents : 0;
  if (action.kind === "start_trip") {
    state.trip = {
      id: await operationUuid(action.operationId),
      store: action.store,
      currency: action.currency,
      timezone: "Europe/Dublin",
      createdAt: now.toISOString(),
      checkedOutAt: null,
      status: "active",
      thresholdsCents:
        action.thresholdsCents ?? defaultThresholds(action.currency),
      items: [],
    };
  } else {
    if (!trip || trip.id !== action.tripId)
      throw new Error("Only this widget's current guest basket is available.");
    const requiresActive = [
      "add_item",
      "update_item",
      "remove_item",
      "set_thresholds",
      "checkout_trip",
    ].includes(action.kind);
    if (requiresActive && trip.status !== "active")
      throw new Error(
        "This trip is finished. Start a new trip to change prices or quantities.",
      );
    switch (action.kind) {
      case "add_item": {
        if (trip.items.length >= MAX_GUEST_ITEMS)
          throw new Error(
            `Guest baskets support at most ${MAX_GUEST_ITEMS} lines.`,
          );
        trip.items.push({
          ...itemInputSchema.parse(action),
          id: await operationUuid(action.operationId),
          expiry: null,
          consumed: false,
        });
        break;
      }
      case "set_thresholds":
        trip.thresholdsCents = action.thresholdsCents;
        break;
      case "checkout_trip":
        trip.status = "checked_out";
        trip.checkedOutAt = now.toISOString();
        break;
      default: {
        const index = trip.items.findIndex((item) => item.id === action.itemId);
        const item = trip.items[index];
        if (!item) throw new Error("Item not found in this guest basket.");
        if (action.kind === "update_item") Object.assign(item, action.patch);
        if (action.kind === "remove_item") trip.items.splice(index, 1);
        if (action.kind === "set_item_expiry") item.expiry = action.expiry;
        if (action.kind === "mark_item_consumed") {
          if (trip.status !== "checked_out")
            throw new Error("Finish shopping before marking items used.");
          item.consumed = action.consumed;
        }
      }
    }
  }
  state.revision += 1;
  state.receipts = [
    ...state.receipts,
    { id: action.operationId, fingerprint },
  ].slice(-MAX_RECEIPTS);
  const result = guestView(parseGuestState(state));
  result.newlyReachedThresholdsCents = result
    .basket!.thresholds.filter(
      (threshold) =>
        threshold.reached &&
        (action.kind === "start_trip" ? 0 : previous) < threshold.amountCents,
    )
    .map((threshold) => threshold.amountCents);
  return result;
}

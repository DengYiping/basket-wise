import { randomUUID } from "./utils.js";
import {
  addDays,
  dublinToday,
  summarize,
  type Expiry,
  type Trip,
} from "../src/domain.js";

/** In-memory design preview only; never touches real shopping data. */
export function createDemo() {
  const trips: Trip[] = [
    {
      id: randomUUID(),
      store: "Dunnes Stores",
      currency: "EUR",
      timezone: "Europe/Dublin",
      createdAt: new Date().toISOString(),
      checkedOutAt: null,
      status: "active",
      thresholdsCents: [2500, 5000],
      items: [
        {
          id: randomUUID(),
          name: "Sourdough loaf",
          unitPriceCents: 325,
          quantity: 1,
          unit: "each",
          thresholdEligible: true,
          notes: "",
          expiry: null,
          consumed: false,
        },
        {
          id: randomUUID(),
          name: "Irish whole milk",
          unitPriceCents: 235,
          quantity: 2,
          unit: "each",
          thresholdEligible: true,
          notes: "",
          expiry: {
            date: addDays(dublinToday(), 2),
            kind: "use_by",
            source: "user",
            confirmed: true,
          },
          consumed: false,
        },
        {
          id: randomUUID(),
          name: "Free-range eggs",
          unitPriceCents: 379,
          quantity: 1,
          unit: "each",
          thresholdEligible: true,
          notes: "",
          expiry: null,
          consumed: false,
        },
        {
          id: randomUUID(),
          name: "Strawberries",
          unitPriceCents: 350,
          quantity: 1,
          unit: "each",
          thresholdEligible: true,
          notes: "",
          expiry: null,
          consumed: false,
        },
        {
          id: randomUUID(),
          name: "Coffee beans",
          unitPriceCents: 650,
          quantity: 1,
          unit: "each",
          thresholdEligible: true,
          notes: "",
          expiry: null,
          consumed: false,
        },
      ],
    },
  ];
  return async (name: string, args: Record<string, unknown>) => {
    if (name === "list_trips") return { trips: trips.map(summarize) };
    if (name === "list_expiring_items")
      return {
        items: trips.flatMap((trip) =>
          trip.items
            .filter(
              (item) =>
                !item.consumed &&
                item.expiry &&
                item.expiry.date <= addDays(dublinToday(), 3),
            )
            .map((item) => ({ ...item, tripId: trip.id })),
        ),
      };
    let trip = trips.find((value) => value.id === args.tripId) ?? trips[0]!;
    if (name === "start_trip") {
      trip = {
        ...trip,
        id: randomUUID(),
        store: String(args.store ?? "Supermarket"),
        thresholdsCents: (args.thresholdsCents as number[]) ?? [2500, 5000],
        createdAt: new Date().toISOString(),
        checkedOutAt: null,
        status: "active",
        items: [],
      };
      trips.unshift(trip);
    }
    const previous = summarize(trip).thresholdSubtotalCents;
    const item = trip.items.find((value) => value.id === args.itemId);
    if (name === "add_item")
      trip.items.push({
        id: randomUUID(),
        name: String(args.name),
        unitPriceCents: Number(args.unitPriceCents),
        quantity: Number(args.quantity),
        unit: args.unit as "each" | "kg" | "litre",
        thresholdEligible: true,
        notes: "",
        expiry: null,
        consumed: false,
      });
    if (name === "remove_item")
      trip.items = trip.items.filter((value) => value.id !== args.itemId);
    if (name === "update_item" && item) Object.assign(item, args.patch);
    if (name === "set_item_expiry" && item) item.expiry = args.expiry as Expiry;
    if (name === "mark_item_consumed" && item)
      item.consumed = Boolean(args.consumed);
    if (name === "set_thresholds")
      trip.thresholdsCents = args.thresholdsCents as number[];
    if (name === "checkout_trip") {
      trip.status = "checked_out";
      trip.checkedOutAt = new Date().toISOString();
    }
    const basket = summarize(trip);
    return {
      basket,
      newlyReachedThresholdsCents: basket.thresholds
        .filter((value) => value.reached && previous < value.amountCents)
        .map((value) => value.amountCents),
    };
  };
}

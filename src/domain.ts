import { z } from "zod";

export const MAX_ITEMS = 500;
export const moneySchema = z.number().int().min(0).max(1_000_000);
export const operationSchema = z
  .string()
  .min(8)
  .max(128)
  .describe(
    "Unique ID for this intended change. Reuse it only when retrying the exact same call.",
  );
export const idSchema = z.uuid();
export const quantitySchema = z
  .number()
  .positive()
  .max(1000)
  .refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    "Use at most three decimal places for quantity.",
  );
export const dateSchema = z.iso.date();
export const thresholdsSchema = z
  .array(moneySchema.refine((v) => v > 0))
  .min(1)
  .max(10)
  .transform((values) => [...new Set(values)].sort((a, b) => a - b));

export const expirySchema = z.object({
  date: dateSchema.describe(
    "Confirmed calendar date, YYYY-MM-DD. Never infer an uncertain year.",
  ),
  kind: z.enum(["use_by", "best_before", "unknown"]),
  source: z.enum(["user", "photo"]),
  labelText: z.string().trim().min(1).max(250).optional(),
  confirmed: z
    .literal(true)
    .describe("The user has confirmed the exact interpreted date."),
});

export const itemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unitPriceCents: moneySchema.describe(
    "EUR cents per unit, e.g. €3.49 is 349. Include VAT; never estimate a missing price.",
  ),
  quantity: quantitySchema.default(1),
  unit: z.enum(["each", "kg", "litre"]).default("each"),
  thresholdEligible: z
    .boolean()
    .default(true)
    .describe(
      "Whether to include this line in the user-defined milestone subtotal, not verified voucher eligibility.",
    ),
  notes: z.string().trim().max(500).default(""),
});

export const tripSchema = z.object({
  id: idSchema,
  store: z.string().trim().min(1).max(120),
  currency: z.literal("EUR"),
  timezone: z.literal("Europe/Dublin"),
  createdAt: z.iso.datetime(),
  checkedOutAt: z.iso.datetime().nullable(),
  status: z.enum(["active", "checked_out"]),
  thresholdsCents: thresholdsSchema,
  items: z
    .array(
      itemInputSchema.extend({
        id: idSchema,
        expiry: expirySchema.nullable(),
        consumed: z.boolean(),
      }),
    )
    .max(MAX_ITEMS),
});

export type Trip = z.infer<typeof tripSchema>;
export type Item = Trip["items"][number];
export type ItemInput = z.infer<typeof itemInputSchema>;
export type Expiry = z.infer<typeof expirySchema>;

/** Round each line once in integer minor units, including weighted goods. */
export function lineTotalCents(
  item: Pick<Item, "quantity" | "unitPriceCents">,
): number {
  const milliUnits = Math.round(item.quantity * 1000);
  return Math.floor((item.unitPriceCents * milliUnits + 500) / 1000);
}

export function summarize(trip: Trip) {
  const items = trip.items.map((item) => ({
    ...item,
    lineTotalCents: lineTotalCents(item),
  }));
  const totalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const thresholdSubtotalCents = items.reduce(
    (sum, item) => sum + (item.thresholdEligible ? item.lineTotalCents : 0),
    0,
  );
  return {
    ...trip,
    items,
    totalCents,
    thresholdSubtotalCents,
    thresholds: trip.thresholdsCents.map((amountCents) => ({
      amountCents,
      reached: thresholdSubtotalCents >= amountCents,
      remainingCents: Math.max(0, amountCents - thresholdSubtotalCents),
    })),
    nextThresholdCents:
      trip.thresholdsCents.find((amount) => amount > thresholdSubtotalCents) ??
      null,
  };
}

export type Basket = ReturnType<typeof summarize>;
export type BasketResult = {
  basket: Basket;
  newlyReachedThresholdsCents: number[];
  alreadyApplied: boolean;
};

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

export function parseEuro(input: string): number {
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(input.trim()))
    throw new Error("Enter a price such as 3.49.");
  const [whole = "0", fraction = ""] = input.trim().split(".");
  return moneySchema.parse(
    Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
  );
}

export function dublinToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

import { describe, expect, it } from "vitest";
import {
  addDays,
  dateSchema,
  dublinToday,
  expirySchema,
  itemInputSchema,
  lineTotalCents,
  parseEuro,
  quantitySchema,
  thresholdsSchema,
} from "../src/domain.js";

describe("money and quantities", () => {
  it.each([
    [[10, 1], 10],
    [[10, 3], 30],
    [[399, 0.5], 200],
    [[123, 0.25], 31],
    [[999, 1.125], 1124],
  ])(
    "rounds line totals once using integer arithmetic: %j",
    ([unitPriceCents, quantity], expected) => {
      expect(
        lineTotalCents({
          unitPriceCents: unitPriceCents!,
          quantity: quantity!,
        }),
      ).toBe(expected);
    },
  );
  it.each([
    ["0.10", 10],
    ["25", 2500],
    ["3.49", 349],
    [" 4.5 ", 450],
  ])("parses %s into cents", (input, cents) => {
    expect(parseEuro(input)).toBe(cents);
  });
  it.each(["", "-1", "1e3", "0.005", "1,20", "Infinity", "3.00eur"])(
    "rejects ambiguous or invalid price %s",
    (input) => {
      expect(() => parseEuro(input)).toThrow();
    },
  );
  it("validates weighted quantities and price bounds", () => {
    expect(quantitySchema.parse(0.125)).toBe(0.125);
    for (const value of [0, -1, 1001, 1.0001, Infinity])
      expect(quantitySchema.safeParse(value).success).toBe(false);
    expect(
      itemInputSchema.safeParse({ name: "Milk", unitPriceCents: -1 }).success,
    ).toBe(false);
    expect(
      itemInputSchema.safeParse({ name: "Milk", unitPriceCents: 0.5 }).success,
    ).toBe(false);
    expect(
      itemInputSchema.safeParse({ name: " ", unitPriceCents: 99 }).success,
    ).toBe(false);
  });
  it("sorts and deduplicates milestones", () => {
    expect(thresholdsSchema.parse([5000, 2500, 2500])).toEqual([2500, 5000]);
    expect(thresholdsSchema.safeParse([]).success).toBe(false);
    expect(thresholdsSchema.safeParse([0]).success).toBe(false);
  });
});

describe("dates", () => {
  it("rejects impossible calendar dates", () => {
    expect(dateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(dateSchema.safeParse("2026-04-31").success).toBe(false);
    expect(dateSchema.parse("2028-02-29")).toBe("2028-02-29");
  });
  it("requires explicit confirmation even for photo-extracted dates", () => {
    const expiry = { date: "2026-10-14", kind: "use_by", source: "photo" };
    expect(expirySchema.safeParse(expiry).success).toBe(false);
    expect(
      expirySchema.safeParse({ ...expiry, confirmed: false }).success,
    ).toBe(false);
    expect(expirySchema.safeParse({ ...expiry, confirmed: true }).success).toBe(
      true,
    );
  });
  it("uses the Dublin date across UTC midnight and daylight-saving transitions", () => {
    expect(dublinToday(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(dublinToday(new Date("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
    expect(addDays("2026-03-28", 3)).toBe("2026-03-31");
  });
});

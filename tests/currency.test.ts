import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_CURRENCIES,
  currencyDigits,
  currencySchema,
  defaultThresholds,
  formatMoney,
  itemInputSchema,
  moneyInputValue,
  parseMoney,
} from "../src/domain.js";
import { BasketStore } from "../src/store.js";

describe("currency precision and entry", () => {
  it.each([
    ["EUR", "3.49", 349, 2],
    ["USD", "3.49", 349, 2],
    ["GBP", "3.49", 349, 2],
    ["JPY", "349", 349, 0],
    ["KRW", "349", 349, 0],
    ["KWD", "3.490", 3490, 3],
    ["BHD", "0.001", 1, 3],
    ["CLF", "0.0001", 1, 4],
    ["AFN", "3.49", 349, 2],
    ["IQD", "0.001", 1, 3],
  ])("parses exact %s minor units", (currency, input, units, digits) => {
    expect(currencyDigits(currency)).toBe(digits);
    expect(parseMoney(input, currency)).toBe(units);
    expect(parseMoney(moneyInputValue(units, currency), currency)).toBe(units);
  });

  it.each([
    ["JPY", "1.1"],
    ["EUR", "1.001"],
    ["KWD", "1.0001"],
    ["CLF", "0.00001"],
    ["USD", "1,000"],
    ["USD", "1e3"],
    ["USD", "-1"],
    ["USD", "10000.01"],
  ])("rejects invalid or over-precise %s entry %s", (currency, input) => {
    expect(() => parseMoney(input, currency)).toThrow();
  });

  it("round-trips editable values for every offered currency", () => {
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(100);
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(parseMoney(moneyInputValue(123456, currency), currency)).toBe(
        123456,
      );
      expect(formatMoney(123456, currency)).toContain(currency);
      expect(defaultThresholds(currency)).toEqual([
        parseMoney("25", currency),
        parseMoney("50", currency),
      ]);
    }
  });

  it("uses unambiguous currency codes and the correct decimal places", () => {
    expect(formatMoney(1234, "USD")).toMatch(/USD\s+12\.34/);
    expect(formatMoney(1234, "JPY")).toMatch(/JPY\s+1,234$/);
    expect(formatMoney(1234, "KWD")).toMatch(/KWD\s+1\.234$/);
    expect(formatMoney(349, "AFN")).toMatch(/AFN\s+3\.49$/);
    expect(formatMoney(1, "CLF")).toMatch(/CLF\s+0\.0001$/);
    expect(currencySchema.parse(" usd ")).toBe("USD");
    for (const invalid of ["", "US", "USDD", "ZZZ", "BTC", "💶"])
      expect(currencySchema.safeParse(invalid).success).toBe(false);
  });
});

describe("currency-bound baskets", () => {
  it("scales default milestones and rounds weighted lines once in minor units", () => {
    const store = new BasketStore(":memory:");
    try {
      const yen = store.startTrip(
        "yen-start",
        "Tokyo Market",
        undefined,
        "JPY",
      ).basket;
      expect(yen).toMatchObject({
        currency: "JPY",
        currencyScale: 1,
        currencyFractionDigits: 0,
        thresholdsCents: [25, 50],
      });
      const result = store.addItem(
        "yen-add-1",
        yen.id,
        itemInputSchema.parse({
          name: "Apples",
          unitPriceCents: 399,
          quantity: 0.5,
          unit: "kg",
        }),
      );
      expect(result.basket.totalCents).toBe(200);
      expect(result.newlyReachedThresholdsCents).toEqual([25, 50]);
      const dinar = store.startTrip(
        "kwd-start",
        "Kuwait Market",
        [2000],
        "KWD",
      ).basket;
      const bought = store.addItem(
        "kwd-add-1",
        dinar.id,
        itemInputSchema.parse({
          name: "Apples",
          unitPriceCents: 3999,
          quantity: 0.5,
          unit: "kg",
        }),
      );
      expect(bought.basket).toMatchObject({
        currency: "KWD",
        currencyScale: 1000,
        totalCents: 2000,
      });
      expect(bought.newlyReachedThresholdsCents).toEqual([2000]);
      expect(store.getBasket(yen.id)?.totalCents).toBe(200);
    } finally {
      store.close();
    }
  });

  it("rejects a currency change on replay and keeps currencies separate on disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "basket-wise-currency-"));
    const path = join(directory, "test.sqlite");
    let store = new BasketStore(path);
    try {
      const usd = store.startTrip("start-usd", "US Shop", [2500], "USD").basket;
      store.addItem(
        "add-usd-1",
        usd.id,
        itemInputSchema.parse({ name: "Bread", unitPriceCents: 125 }),
      );
      const kwd = store.startTrip(
        "start-kwd",
        "Kuwait Shop",
        undefined,
        "KWD",
      ).basket;
      expect(kwd.thresholdsCents).toEqual([25000, 50000]);
      expect(() =>
        store.startTrip("start-usd", "US Shop", [2500], "JPY"),
      ).toThrow("different change");
      store.close();
      store = new BasketStore(path);
      expect(
        store.startTrip("start-usd", "US Shop", [2500], "USD").alreadyApplied,
      ).toBe(true);
      expect(store.getBasket(usd.id)).toMatchObject({
        currency: "USD",
        totalCents: 125,
      });
      expect(store.getBasket(kwd.id)?.currency).toBe("KWD");
      expect(
        store
          .listTrips()
          .map((trip) => trip.currency)
          .sort(),
      ).toEqual(["KWD", "USD"]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("retains the original EUR operation fingerprint for old saved trips", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "basket-wise-legacy-currency-"),
    );
    const path = join(directory, "test.sqlite");
    const initial = new BasketStore(path);
    const original = initial.startTrip("old-start", "Legacy shop").basket;
    initial.close();
    const db = new DatabaseSync(path);
    const oldFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          action: "start_trip",
          input: { store: "Legacy shop", thresholdsCents: [2500, 5000] },
        }),
      )
      .digest("hex");
    db.prepare("UPDATE operations SET fingerprint = ? WHERE id = ?").run(
      oldFingerprint,
      "old-start",
    );
    db.close();
    const reopened = new BasketStore(path);
    try {
      const retry = reopened.startTrip(
        "old-start",
        "Legacy shop",
        undefined,
        "EUR",
      );
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.basket.id).toBe(original.id);
      expect(retry.basket.currency).toBe("EUR");
      expect(reopened.listTrips()).toHaveLength(1);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects unknown currency before writing or consuming the operation ID", () => {
    const store = new BasketStore(":memory:");
    try {
      expect(() =>
        store.startTrip("bad-start", "Shop", undefined, "ZZZ"),
      ).toThrow();
      expect(store.listTrips()).toEqual([]);
      expect(
        store.startTrip("bad-start", "Shop", undefined, "USD").basket.currency,
      ).toBe("USD");
    } finally {
      store.close();
    }
  });
});

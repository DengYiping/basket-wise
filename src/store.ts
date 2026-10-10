import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_ITEMS,
  addDays,
  currencySchema,
  defaultThresholds,
  dublinToday,
  summarize,
  tripSchema,
  type BasketResult,
  type Expiry,
  type ItemInput,
  type Trip,
} from "./domain.js";

/**
 * One account-scoped view of the database. The hosting boundary must supply a
 * verified owner ID; callers must never choose it in MCP tool arguments.
 * The default owner preserves the existing, private local-only experience.
 */
export class BasketStore {
  private readonly db: DatabaseSync;
  private readonly ownerId: string;

  constructor(path: string, ownerId = "local") {
    if (!ownerId.trim() || ownerId.length > 256) {
      throw new Error("A nonempty, bounded account identity is required.");
    }
    this.ownerId = ownerId;
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(trips)").all();
      const legacy =
        columns.length > 0 &&
        !columns.some((column) => column.name === "owner_id");
      if (legacy) {
        this.db.exec(`
          ALTER TABLE trips RENAME TO legacy_trips;
          ALTER TABLE operations RENAME TO legacy_operations;
        `);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trips (
          owner_id TEXT NOT NULL, id TEXT NOT NULL,
          created_at TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (owner_id, id)
        );
        CREATE TABLE IF NOT EXISTS operations (
          owner_id TEXT NOT NULL, id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, trip_id TEXT NOT NULL,
          PRIMARY KEY (owner_id, id)
        );
        CREATE INDEX IF NOT EXISTS trips_owner_created ON trips (owner_id, created_at DESC);
      `);
      if (legacy) {
        // The entire migration is atomic. Existing data belongs only to the
        // local profile; it is never assigned to the first signed-in account.
        this.db.exec(`
          INSERT INTO trips SELECT 'local', id, created_at, payload FROM legacy_trips;
          INSERT INTO operations SELECT 'local', id, fingerprint, trip_id FROM legacy_operations;
          DROP TABLE legacy_operations;
          DROP TABLE legacy_trips;
        `);
      }
      this.db.exec("PRAGMA user_version = 1; COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private load(id: string): Trip {
    const row = this.db
      .prepare("SELECT payload FROM trips WHERE owner_id = ? AND id = ?")
      .get(this.ownerId, id);
    if (!row) throw new Error("Shopping trip not found.");
    return tripSchema.parse(JSON.parse(row.payload as string));
  }

  private save(trip: Trip): void {
    const validated = tripSchema.parse(trip);
    this.db
      .prepare(
        `INSERT INTO trips (owner_id, id, created_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(
        this.ownerId,
        validated.id,
        validated.createdAt,
        JSON.stringify(validated),
      );
  }

  private change(
    operationId: string,
    action: string,
    input: unknown,
    update: () => Trip,
  ): BasketResult {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ action, input }))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT fingerprint, trip_id FROM operations WHERE owner_id = ? AND id = ?",
        )
        .get(this.ownerId, operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error(
            "Operation ID already used for a different change. Use a fresh ID.",
          );
        const result = {
          basket: summarize(this.load(prior.trip_id as string)),
          newlyReachedThresholdsCents: [],
          alreadyApplied: true,
        };
        this.db.exec("COMMIT");
        return result;
      }
      const trip = update();
      const previousRow = this.db
        .prepare("SELECT payload FROM trips WHERE owner_id = ? AND id = ?")
        .get(this.ownerId, trip.id);
      const previous = previousRow
        ? summarize(tripSchema.parse(JSON.parse(previousRow.payload as string)))
        : null;
      this.save(trip);
      this.db
        .prepare(
          "INSERT INTO operations (owner_id, id, fingerprint, trip_id) VALUES (?, ?, ?, ?)",
        )
        .run(this.ownerId, operationId, fingerprint, trip.id);
      const basket = summarize(trip);
      const newlyReachedThresholdsCents = basket.thresholds
        .filter(
          (threshold) =>
            threshold.reached &&
            (previous?.thresholdSubtotalCents ?? 0) < threshold.amountCents,
        )
        .map((threshold) => threshold.amountCents);
      this.db.exec("COMMIT");
      return { basket, newlyReachedThresholdsCents, alreadyApplied: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private active(id: string): Trip {
    const trip = this.load(id);
    if (trip.status !== "active")
      throw new Error(
        "This trip is checked out. Start a new trip to change your basket.",
      );
    return trip;
  }

  startTrip(
    operationId: string,
    store = "Supermarket",
    thresholdsCents?: number[],
    currency = "EUR",
  ): BasketResult {
    currency = currencySchema.parse(currency);
    thresholdsCents ??= defaultThresholds(currency);
    // Preserve fingerprints for pre-currency EUR trip retries.
    const input =
      currency === "EUR"
        ? { store, thresholdsCents }
        : { store, thresholdsCents, currency };
    return this.change(operationId, "start_trip", input, () => ({
      id: randomUUID(),
      store,
      thresholdsCents: thresholdsCents!,
      currency,
      timezone: "Europe/Dublin",
      status: "active",
      createdAt: new Date().toISOString(),
      checkedOutAt: null,
      items: [],
    }));
  }

  getBasket(id?: string) {
    if (id) return summarize(this.load(id));
    const row = this.db
      .prepare(
        `SELECT id FROM trips WHERE owner_id = ? ORDER BY
      CASE WHEN json_extract(payload, '$.status') = 'active' THEN 0 ELSE 1 END,
      created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(this.ownerId);
    return row ? summarize(this.load(row.id as string)) : null;
  }

  listTrips(limit = 20) {
    return this.db
      .prepare(
        "SELECT payload FROM trips WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(this.ownerId, limit)
      .map((row) =>
        summarize(tripSchema.parse(JSON.parse(row.payload as string))),
      )
      .map(({ items, ...trip }) => ({ ...trip, itemCount: items.length }));
  }

  addItem(operationId: string, tripId: string, input: ItemInput): BasketResult {
    return this.change(operationId, "add_item", { tripId, input }, () => {
      const trip = this.active(tripId);
      if (trip.items.length >= MAX_ITEMS)
        throw new Error(`A basket can hold at most ${MAX_ITEMS} lines.`);
      trip.items.push({
        ...input,
        id: randomUUID(),
        expiry: null,
        consumed: false,
      });
      return trip;
    });
  }

  updateItem(
    operationId: string,
    tripId: string,
    itemId: string,
    patch: { [K in keyof ItemInput]?: ItemInput[K] | undefined },
  ): BasketResult {
    return this.change(
      operationId,
      "update_item",
      { tripId, itemId, patch },
      () => {
        const trip = this.active(tripId);
        const item = trip.items.find((value) => value.id === itemId);
        if (!item) throw new Error("Item not found in this trip.");
        Object.assign(
          item,
          Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ),
        );
        return trip;
      },
    );
  }

  removeItem(
    operationId: string,
    tripId: string,
    itemId: string,
  ): BasketResult {
    return this.change(operationId, "remove_item", { tripId, itemId }, () => {
      const trip = this.active(tripId);
      const index = trip.items.findIndex((item) => item.id === itemId);
      if (index < 0) throw new Error("Item not found in this trip.");
      trip.items.splice(index, 1);
      return trip;
    });
  }

  setThresholds(
    operationId: string,
    tripId: string,
    thresholdsCents: number[],
  ): BasketResult {
    return this.change(
      operationId,
      "set_thresholds",
      { tripId, thresholdsCents },
      () => ({
        ...this.active(tripId),
        thresholdsCents,
      }),
    );
  }

  setExpiry(
    operationId: string,
    tripId: string,
    itemId: string,
    expiry: Expiry | null,
  ): BasketResult {
    return this.change(
      operationId,
      "set_item_expiry",
      { tripId, itemId, expiry },
      () => {
        const trip = this.load(tripId);
        const item = trip.items.find((value) => value.id === itemId);
        if (!item) throw new Error("Item not found in this trip.");
        item.expiry = expiry;
        return trip;
      },
    );
  }

  markConsumed(
    operationId: string,
    tripId: string,
    itemId: string,
    consumed: boolean,
  ): BasketResult {
    return this.change(
      operationId,
      "mark_item_consumed",
      { tripId, itemId, consumed },
      () => {
        const trip = this.load(tripId);
        if (trip.status !== "checked_out")
          throw new Error(
            "Check out this trip before marking pantry items as used.",
          );
        const item = trip.items.find((value) => value.id === itemId);
        if (!item) throw new Error("Item not found in this trip.");
        item.consumed = consumed;
        return trip;
      },
    );
  }

  checkout(operationId: string, tripId: string): BasketResult {
    return this.change(operationId, "checkout_trip", { tripId }, () => ({
      ...this.active(tripId),
      status: "checked_out",
      checkedOutAt: new Date().toISOString(),
    }));
  }

  listExpiring(daysAhead = 3, today = dublinToday()) {
    const through = addDays(today, daysAhead);
    const items = this.db
      .prepare("SELECT payload FROM trips WHERE owner_id = ?")
      .all(this.ownerId)
      .flatMap((row) => {
        const trip = tripSchema.parse(JSON.parse(row.payload as string));
        return trip.items
          .filter(
            (item) =>
              !item.consumed && item.expiry && item.expiry.date <= through,
          )
          .map((item) => ({
            ...item,
            tripId: trip.id,
            store: trip.store,
            tripStatus: trip.status,
            currency: trip.currency,
            dateStatus:
              item.expiry!.date < today
                ? "past_date"
                : item.expiry!.date === today
                  ? "today"
                  : "upcoming",
          }));
      })
      .sort((a, b) => a.expiry!.date.localeCompare(b.expiry!.date));
    return { today, through, timezone: "Europe/Dublin", items };
  }
}

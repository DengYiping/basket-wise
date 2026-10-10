import type { Bridge, Result } from "./controller.js";
import type {
  ShoppingListItem,
  ShoppingListSnapshot,
} from "./shopping-list.js";

type Call = { name: string; arguments: Record<string, unknown> };
export class ShoppingListController {
  snapshot: ShoppingListSnapshot | undefined;
  busy = false;
  authorizationRequired = false;
  private pending: Call | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  get hasPending() {
    return this.pending !== undefined;
  }
  private armExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.snapshot) return;
    this.expiryTimer = setTimeout(
      () => {
        this.fresh();
        this.changed();
        if (this.snapshot) this.armExpiry();
      },
      Math.min(
        Math.max(1, this.snapshot.profileExpiresAt - Date.now() + 1),
        2_147_483_647,
      ),
    );
    (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
  }
  constructor(
    private bridge: Bridge,
    private show: (text: string) => void,
    private changed: () => void = () => {},
    private newId: () => string = () => crypto.randomUUID(),
  ) {}
  accept(result: Result) {
    const data = result.structuredContent as
      | (Partial<ShoppingListSnapshot> & {
          error?: string;
          consumedShoppingListItemId?: string;
        })
      | undefined;
    if (result.isError) {
      if (result._meta?.["mcp/www_authenticate"]) {
        this.snapshot = undefined;
        this.pending = undefined;
        this.authorizationRequired = true;
        this.show(
          "Authorization expired. Reconnect through ChatGPT; never paste a key here.",
        );
      } else if (
        [
          "shopping_list_conflict",
          "shopping_list_item_not_found",
          "revision_conflict",
          "data_expired",
          "trip_not_found",
          "invalid_request",
          "operation_conflict",
          "guest_limit",
        ].includes(data?.error ?? "")
      ) {
        this.pending = undefined;
        this.snapshot = undefined;
        this.show(
          "The list or trip changed. Refresh and reconcile; nothing will be retried automatically.",
        );
      } else
        this.show(
          "The result is uncertain. Retry keeps the same operation ID.",
        );
      this.changed();
      return false;
    }
    if (
      data &&
      typeof data.spaceId === "string" &&
      typeof data.shoppingListRevision === "number" &&
      Array.isArray(data.shoppingList) &&
      typeof data.profileExpiresAt === "number"
    ) {
      if (data.profileExpiresAt <= Date.now()) {
        this.snapshot = undefined;
        this.show(
          "This saved list is out of date. Refresh your connected space.",
        );
      } else if (
        !this.snapshot ||
        data.spaceId !== this.snapshot.spaceId ||
        data.shoppingListRevision >= this.snapshot.shoppingListRevision
      ) {
        this.snapshot = data as ShoppingListSnapshot;
        this.authorizationRequired = false;
        this.show("");
        this.armExpiry();
      }
      this.changed();
      return true;
    }
    // A successful trip addition supplies the consumed ID and new list revision.
    // Only apply that delta to its exact predecessor; never overwrite newer data.
    if (
      this.snapshot &&
      data?.spaceId === this.snapshot.spaceId &&
      data.consumedShoppingListItemId &&
      typeof data.shoppingListRevision === "number"
    ) {
      if (
        data.shoppingListRevision ===
        this.snapshot.shoppingListRevision + 1
      ) {
        this.snapshot = {
          ...this.snapshot,
          shoppingList: this.snapshot.shoppingList.filter(
            (item) => item.id !== data.consumedShoppingListItemId,
          ),
          shoppingListRevision: data.shoppingListRevision,
          profileExpiresAt:
            data.profileExpiresAt ?? this.snapshot.profileExpiresAt,
        };
      } else if (data.shoppingListRevision > this.snapshot.shoppingListRevision)
        this.snapshot = undefined;
      this.show("Added to the trip and removed from the shopping list.");
      this.armExpiry();
      this.changed();
      return true;
    }
    return false;
  }
  private fresh() {
    if (this.snapshot && this.snapshot.profileExpiresAt <= Date.now()) {
      this.snapshot = undefined;
      this.pending = undefined;
    }
    if (!this.snapshot) this.show("Refresh the shopping list first.");
    return Boolean(this.snapshot);
  }
  private async run(call: Call) {
    if (this.busy) return;
    this.busy = true;
    this.pending = call;
    this.changed();
    try {
      if (this.accept(await this.bridge.callServerTool(call)))
        this.pending = undefined;
    } catch {
      this.show(
        "Host call did not complete. Retry preserves the same operation ID.",
      );
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async load() {
    await this.run(
      this.pending ?? {
        name: "get_shopping_list",
        arguments: { activityId: this.newId() },
      },
    );
  }
  async save(fields: Omit<ShoppingListItem, "id">, itemId?: string) {
    if (this.pending) return this.run(this.pending);
    if (!this.fresh()) return;
    await this.run({
      name: itemId ? "update_shopping_list_item" : "add_shopping_list_item",
      arguments: {
        ...(itemId ? { itemId, patch: fields } : fields),
        expectedShoppingListRevision: this.snapshot!.shoppingListRevision,
        operationId: this.newId(),
      },
    });
  }
  async remove(itemId: string) {
    if (this.pending) return this.run(this.pending);
    if (!this.fresh()) return;
    await this.run({
      name: "remove_shopping_list_item",
      arguments: {
        itemId,
        expectedShoppingListRevision: this.snapshot!.shoppingListRevision,
        operationId: this.newId(),
      },
    });
  }
  async addToTrip(
    itemId: string,
    priceText: string,
    parsePrice: (text: string, digits: number) => number | undefined,
  ) {
    if (this.pending) return this.run(this.pending);
    if (!this.fresh() || this.busy) return;
    const snapshot = this.snapshot!;
    const item = snapshot.shoppingList.find((entry) => entry.id === itemId);
    if (!item) return;
    this.busy = true;
    this.changed();
    let call: Call | undefined;
    try {
      const result = await this.bridge.callServerTool({
        name: "get_basket",
        arguments: { activityId: this.newId() },
      });
      if (result.isError) {
        this.accept(result);
        return;
      }
      const data = result.structuredContent as {
        spaceId: string;
        revision: number;
        dataEpoch: string;
        basket?: { id: string; status: string; currencyFractionDigits: number };
      };
      if (data.spaceId !== snapshot.spaceId) {
        this.snapshot = undefined;
        this.show("The connection changed. Refresh first.");
        return;
      }
      if (!data.basket || data.basket.status !== "active") {
        this.show("Start an active trip in chat or the basket widget first.");
        return;
      }
      const price = parsePrice(priceText, data.basket.currencyFractionDigits);
      if (price === undefined) {
        this.show("Enter a valid unit price in the current trip's currency.");
        return;
      }
      call = {
        name: "add_item",
        arguments: {
          tripId: data.basket.id,
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          notes: item.notes,
          unitPriceCents: price,
          shoppingListItemId: item.id,
          expectedShoppingListRevision: snapshot.shoppingListRevision,
          expectedRevision: data.revision,
          dataEpoch: data.dataEpoch,
          operationId: this.newId(),
        },
      };
    } catch {
      this.show(
        "Could not read the current trip. No item was added; try again.",
      );
    } finally {
      this.busy = false;
      this.changed();
    }
    if (call) await this.run(call);
  }
}

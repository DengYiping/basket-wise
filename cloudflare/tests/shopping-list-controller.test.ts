import { test } from "node:test";
import assert from "node:assert/strict";
import { ShoppingListController } from "../src/shopping-list-controller.js";
import { parsePrice } from "../src/widget-money.js";

const item = {
  id: "item",
  name: "Milk",
  quantity: 2,
  unit: "each" as const,
  notes: "",
};
const snapshot = () => ({
  spaceId: "guest",
  shoppingListRevision: 1,
  shoppingList: [item],
  profileExpiresAt: Date.now() + 90000,
  alreadyApplied: false,
});
test("shopping list initial render is passive and stale results do not overwrite current state", () => {
  const calls: unknown[] = [];
  const c = new ShoppingListController(
    {
      async callServerTool(input) {
        calls.push(input);
        return {};
      },
    },
    () => {},
  );
  c.accept({ structuredContent: snapshot() });
  c.accept({
    structuredContent: {
      ...snapshot(),
      shoppingListRevision: 0,
      shoppingList: [],
    },
  });
  assert.equal(c.snapshot?.shoppingList.length, 1);
  assert.deepEqual(calls, []);
});
test("purchase reads without opening a widget, preserves retry identity, and consumes only after success", async () => {
  const calls: any[] = [];
  let fail = true;
  const c = new ShoppingListController(
    {
      async callServerTool(input) {
        calls.push(input);
        if (input.name === "get_basket")
          return {
            structuredContent: {
              spaceId: "guest",
              revision: 7,
              dataEpoch: "epoch",
              basket: {
                id: "trip",
                status: "active",
                currencyFractionDigits: 2,
              },
            },
          };
        if (fail) throw Error("lost response");
        return {
          structuredContent: {
            spaceId: "guest",
            consumedShoppingListItemId: "item",
            shoppingListRevision: 2,
          },
        };
      },
    },
    () => {},
  );
  c.accept({ structuredContent: snapshot() });
  await c.addToTrip("item", "1.25", parsePrice);
  assert.equal(c.snapshot?.shoppingList.length, 1);
  assert.equal(c.hasPending, true);
  assert.deepEqual(
    calls.map((a) => a.name),
    ["get_basket", "add_item"],
  );
  assert.equal(calls[1].arguments.unitPriceCents, 125);
  assert.equal(calls[1].arguments.expectedShoppingListRevision, 1);
  assert.equal(calls[1].arguments.quantity, 2);
  fail = false;
  await c.load();
  assert.deepEqual(calls[2], calls[1]);
  assert.equal(c.snapshot?.shoppingList.length, 0);
  assert.equal(c.hasPending, false);
});
test("conflicts discard pending writes rather than blindly overwriting list changes", async () => {
  let n = 0;
  const c = new ShoppingListController(
    {
      async callServerTool() {
        n++;
        return {
          isError: true,
          structuredContent: { error: "shopping_list_conflict" },
        };
      },
    },
    () => {},
  );
  c.accept({ structuredContent: snapshot() });
  await c.remove(item.id);
  assert.equal(n, 1);
  assert.equal(c.snapshot, undefined);
  assert.equal(c.hasPending, false);
});

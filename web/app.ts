import { App } from "@modelcontextprotocol/ext-apps";
import {
  formatEuro,
  parseEuro,
  quantitySchema,
  thresholdsSchema,
  type Basket,
  type BasketResult,
  type Item,
} from "../src/domain.js";
import { createDemo } from "./demo.js";
import { byId, element, randomUUID } from "./utils.js";

type Envelope = Partial<BasketResult> & {
  items?: (Item & { tripId: string })[];
  trips?: { id: string; store: string; createdAt: string }[];
};
const demo =
  window.parent === window ||
  new URLSearchParams(window.location.search).has("demo");
const app = new App(
  { name: "Basket Wise", version: "0.1.0" },
  {},
  { autoResize: true },
);
const demoCall = createDemo();
let basket: Basket | null = null;
let busy = false;
let selectedExpiry: string | null = null;
const pendingOperations = new Map<string, string>();

function message(text: string, error = false) {
  const node = byId("message");
  node.textContent = text;
  node.hidden = !text;
  node.dataset.error = String(error);
}

function accept(result: Envelope) {
  if ("basket" in result) basket = result.basket ?? null;
  if (result.newlyReachedThresholdsCents?.length) {
    message(
      `Milestone reached: ${result.newlyReachedThresholdsCents.map(formatEuro).join(" and ")} in your milestone subtotal.`,
    );
  }
  render();
}

async function invoke(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope> {
  if (demo) return (await demoCall(name, args)) as Envelope;
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(
      result.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ") || "Unable to save this change.",
    );
  }
  return (result.structuredContent ?? {}) as Envelope;
}

async function run(
  name: string,
  args: Record<string, unknown> = {},
  write = false,
): Promise<boolean> {
  if (busy) return false;
  const key = JSON.stringify({ name, args });
  if (write && !pendingOperations.has(key))
    pendingOperations.set(key, randomUUID());
  busy = true;
  message("");
  render();
  try {
    accept(
      await invoke(
        name,
        write ? { ...args, operationId: pendingOperations.get(key) } : args,
      ),
    );
    pendingOperations.delete(key);
    if (name === "start_trip" || name === "checkout_trip") await refreshTrips();
    return true;
  } catch (error) {
    message(
      error instanceof Error ? error.message : "Unable to connect. Try again.",
      true,
    );
    return false;
  } finally {
    busy = false;
    render();
  }
}

async function refreshTrips() {
  const result = await invoke("list_trips");
  byId<HTMLSelectElement>("trip-select").replaceChildren(
    ...(result.trips ?? []).map((trip) => {
      const option = element(
        "option",
        undefined,
        `${trip.store} · ${new Date(trip.createdAt).toLocaleDateString("en-IE")}`,
      );
      option.value = trip.id;
      return option;
    }),
  );
}

function openExpiry(item: Item) {
  selectedExpiry = item.id;
  byId("expiry-item-name").textContent = item.name;
  byId<HTMLInputElement>("expiry-date").value = item.expiry?.date ?? "";
  byId<HTMLSelectElement>("expiry-kind").value = item.expiry?.kind ?? "use_by";
  byId<HTMLInputElement>("expiry-label").value = item.expiry?.labelText ?? "";
  byId<HTMLInputElement>("expiry-confirmed").checked = false;
  byId<HTMLDialogElement>("expiry-dialog").showModal();
}

function itemRow(item: Basket["items"][number]) {
  const row = element("div", "item-row");
  const badge = element(
    "span",
    "item-badge",
    item.name[0]?.toUpperCase() ?? "•",
  );
  badge.setAttribute("aria-hidden", "true");
  const info = element("div", "item-info");
  info.append(element("p", "item-name", item.name));
  const detail = element("div", "item-detail");
  detail.append(
    element(
      "span",
      undefined,
      `${formatEuro(item.unitPriceCents)} / ${item.unit}`,
    ),
  );
  const expiry = element(
    "button",
    "expiry-link",
    item.expiry
      ? `${item.expiry.kind === "use_by" ? "Use by" : item.expiry.kind === "best_before" ? "Best before" : "Date"} ${item.expiry.date}`
      : "+ Add expiry",
  );
  expiry.type = "button";
  expiry.onclick = () => openExpiry(item);
  detail.append(expiry);
  info.append(detail);
  const active = basket?.status === "active";
  if (active) {
    const label = element("label", "checkbox-inline");
    const check = element("input");
    check.type = "checkbox";
    check.checked = item.thresholdEligible;
    check.disabled = busy;
    check.onchange = () => {
      void run(
        "update_item",
        {
          tripId: basket!.id,
          itemId: item.id,
          patch: { thresholdEligible: check.checked },
        },
        true,
      );
    };
    label.append(check, document.createTextNode("Include in milestones"));
    detail.append(label);
  }
  const actions = element("div", "item-actions");
  if (active && item.unit === "each" && Number.isInteger(item.quantity)) {
    const qty = element("div", "qty-control");
    for (const delta of [-1, 1]) {
      if (delta === 1)
        qty.append(element("span", undefined, String(item.quantity)));
      const button = element("button", undefined, delta === -1 ? "−" : "+");
      button.setAttribute(
        "aria-label",
        `${delta < 0 ? "Decrease" : "Increase"} quantity of ${item.name}`,
      );
      button.dataset.unavailable = String(
        item.quantity + delta < 1 || item.quantity + delta > 1000,
      );
      button.onclick = () => {
        void run(
          "update_item",
          {
            tripId: basket!.id,
            itemId: item.id,
            patch: { quantity: item.quantity + delta },
          },
          true,
        );
      };
      qty.append(button);
    }
    actions.append(qty);
  } else
    actions.append(
      element("span", "fine-print", `× ${item.quantity} ${item.unit}`),
    );
  actions.append(
    element("span", "item-price", formatEuro(item.lineTotalCents)),
  );
  if (active) {
    const remove = element("button", "icon-button", "×");
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.onclick = () => {
      void run("remove_item", { tripId: basket!.id, itemId: item.id }, true);
    };
    actions.append(remove);
  }
  row.append(badge, info, actions);
  return row;
}

function render() {
  byId("app").setAttribute("aria-busy", String(busy));
  byId("empty").hidden = basket !== null;
  byId("basket-content").hidden = basket === null;
  if (basket) {
    const active = basket.status === "active";
    byId("store-name").textContent = basket.store;
    byId("total").textContent = formatEuro(basket.totalCents);
    byId("item-count").textContent =
      `${basket.items.length} ${basket.items.length === 1 ? "line" : "lines"} in your basket · EUR`;
    byId("basket-count").textContent = String(basket.items.length);
    byId("trip-status").textContent = active
      ? "● Shopping in progress"
      : "✓ Shopping finished";
    byId<HTMLSelectElement>("trip-select").value = basket.id;
    byId("add-form").hidden = !active;
    byId("checkout").hidden = !active;
    byId("edit-thresholds").hidden = !active;
    byId("checkout-note").textContent = active
      ? "Your estimate, not a checkout receipt."
      : "Purchase saved. You can still add expiry dates.";
    byId("qualifying-note").textContent =
      `${formatEuro(basket.thresholdSubtotalCents)} included in milestones. Personal targets only; actual voucher rules may differ.`;
    byId("thresholds").replaceChildren(
      ...basket.thresholds.map((threshold) => {
        const card = element(
          "div",
          `threshold-card${threshold.reached ? " reached" : ""}`,
        );
        const header = element("div", "threshold-header");
        header.append(
          element("strong", undefined, formatEuro(threshold.amountCents)),
          element(
            "span",
            "threshold-status",
            threshold.reached
              ? "✓ Reached"
              : `${formatEuro(threshold.remainingCents)} to go`,
          ),
        );
        const progress = element("div", "progress");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute(
          "aria-label",
          `${formatEuro(threshold.amountCents)} milestone`,
        );
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", String(threshold.amountCents));
        progress.setAttribute(
          "aria-valuenow",
          String(
            Math.min(threshold.amountCents, basket!.thresholdSubtotalCents),
          ),
        );
        const fill = element("span");
        fill.style.width = `${Math.min(100, (basket!.thresholdSubtotalCents / threshold.amountCents) * 100)}%`;
        progress.append(fill);
        card.append(header, progress);
        return card;
      }),
    );
    byId("items").replaceChildren(
      ...(basket.items.length
        ? basket.items.map(itemRow)
        : [
            element(
              "p",
              "list-empty",
              "An empty basket, a fresh start. Add your first item above.",
            ),
          ]),
    );
  }
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy || button.dataset.unavailable === "true";
  });
}

byId("start").onclick = byId("new-trip").onclick = () => {
  byId<HTMLInputElement>("start-store").value = "";
  byId<HTMLInputElement>("start-thresholds").value =
    basket?.thresholdsCents.map((value) => String(value / 100)).join(", ") ??
    "25, 50";
  byId<HTMLDialogElement>("start-dialog").showModal();
};
byId("close-start").onclick = () =>
  byId<HTMLDialogElement>("start-dialog").close();
byId<HTMLFormElement>("start-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const thresholdsCents = thresholdsSchema.parse(
      byId<HTMLInputElement>("start-thresholds")
        .value.split(",")
        .map((value) => parseEuro(value.trim())),
    );
    const store =
      byId<HTMLInputElement>("start-store").value.trim() || "Supermarket";
    if (await run("start_trip", { store, thresholdsCents }, true))
      byId<HTMLDialogElement>("start-dialog").close();
  } catch {
    message("Enter 1–10 positive euro milestones, separated by commas.", true);
  }
};
byId<HTMLSelectElement>("trip-select").onchange = (event) => {
  void run("get_basket", { tripId: (event.target as HTMLSelectElement).value });
};
byId<HTMLFormElement>("add-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!basket) return;
  try {
    const added = await run(
      "add_item",
      {
        tripId: basket.id,
        name: byId<HTMLInputElement>("item-name").value.trim(),
        unitPriceCents: parseEuro(byId<HTMLInputElement>("item-price").value),
        quantity: quantitySchema.parse(
          Number(byId<HTMLInputElement>("item-quantity").value),
        ),
        unit: byId<HTMLSelectElement>("item-unit").value,
      },
      true,
    );
    if (added) {
      byId<HTMLFormElement>("add-form").reset();
      byId<HTMLInputElement>("item-name").focus();
    }
  } catch (error) {
    message(
      error instanceof Error ? error.message : "Check the item details.",
      true,
    );
  }
};
byId("checkout").onclick = () => {
  if (basket) void run("checkout_trip", { tripId: basket.id }, true);
};
byId("close-expiry").onclick = () =>
  byId<HTMLDialogElement>("expiry-dialog").close();
byId<HTMLFormElement>("expiry-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!basket || !selectedExpiry) return;
  if (
    await run(
      "set_item_expiry",
      {
        tripId: basket.id,
        itemId: selectedExpiry,
        expiry: {
          date: byId<HTMLInputElement>("expiry-date").value,
          kind: byId<HTMLSelectElement>("expiry-kind").value,
          source: "user",
          confirmed: byId<HTMLInputElement>("expiry-confirmed").checked,
          ...(byId<HTMLInputElement>("expiry-label").value.trim()
            ? { labelText: byId<HTMLInputElement>("expiry-label").value.trim() }
            : {}),
        },
      },
      true,
    )
  )
    byId<HTMLDialogElement>("expiry-dialog").close();
};
byId("edit-thresholds").onclick = () => {
  if (!basket) return;
  byId<HTMLInputElement>("threshold-input").value = basket.thresholdsCents
    .map((amount) => String(amount / 100))
    .join(", ");
  byId<HTMLDialogElement>("threshold-dialog").showModal();
};
byId("close-thresholds").onclick = () =>
  byId<HTMLDialogElement>("threshold-dialog").close();
byId<HTMLFormElement>("threshold-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!basket) return;
  try {
    const thresholdsCents = thresholdsSchema.parse(
      byId<HTMLInputElement>("threshold-input")
        .value.split(",")
        .map((value) => parseEuro(value.trim())),
    );
    if (
      await run("set_thresholds", { tripId: basket.id, thresholdsCents }, true)
    )
      byId<HTMLDialogElement>("threshold-dialog").close();
  } catch {
    message("Enter 1–10 positive euro amounts, separated by commas.", true);
  }
};

async function showExpiry() {
  byId("basket-panel").hidden = true;
  byId("expiry-panel").hidden = false;
  byId("basket-tab").setAttribute("aria-pressed", "false");
  byId("expiry-tab").setAttribute("aria-pressed", "true");
  try {
    const result = await invoke("list_expiring_items", { daysAhead: 3 });
    byId("expiry-items").replaceChildren(
      ...(result.items?.length
        ? result.items.map((item) => {
            const row = element("div", "item-row");
            const info = element("div", "item-info");
            info.append(
              element("p", "item-name", item.name),
              element(
                "p",
                "item-detail",
                `${item.expiry!.kind.replaceAll("_", " ")} · ${item.expiry!.date}`,
              ),
            );
            row.append(info);
            if (
              (item as Item & { tripStatus?: string }).tripStatus ===
              "checked_out"
            ) {
              const used = element("button", "quiet", "Used it");
              used.onclick = async () => {
                if (
                  await run(
                    "mark_item_consumed",
                    { tripId: item.tripId, itemId: item.id, consumed: true },
                    true,
                  )
                )
                  await showExpiry();
              };
              row.append(used);
            }
            return row;
          })
        : [
            element(
              "p",
              "list-empty",
              "Nothing with a recorded date due in the next 3 days.",
            ),
          ]),
    );
  } catch (error) {
    message(
      error instanceof Error ? error.message : "Could not load expiry dates.",
      true,
    );
  }
}
byId("expiry-tab").onclick = byId("refresh-expiry").onclick = () => {
  void showExpiry();
};
byId("basket-tab").onclick = () => {
  byId("basket-panel").hidden = false;
  byId("expiry-panel").hidden = true;
  byId("basket-tab").setAttribute("aria-pressed", "true");
  byId("expiry-tab").setAttribute("aria-pressed", "false");
};

async function initialize() {
  if (demo) {
    byId("mode").textContent = "Preview · not saved";
  } else {
    app.ontoolresult = (result) => {
      accept((result.structuredContent ?? {}) as Envelope);
    };
    await app.connect();
    byId("mode").textContent = "Connected to chat";
  }
  await refreshTrips();
  accept(await invoke("get_basket"));
}

void initialize().catch((error: unknown) => {
  byId("mode").textContent = "Not connected";
  message(
    error instanceof Error
      ? error.message
      : "Open this view from the Basket Wise plugin in ChatGPT.",
    true,
  );
  render();
});

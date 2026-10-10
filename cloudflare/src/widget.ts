import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import {
  thresholdConfigSchema,
  type ThresholdConfig,
  type ThresholdBasket,
} from "./thresholds.js";
import { BasketController } from "./controller.js";
import { parsePrice } from "./widget-money.js";
const app = new App(
  { name: "basket-wise-durable", version: "0.5.0" },
  {},
  { autoResize: true },
);
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const output = el("result");
const form = el<HTMLFormElement>("add");
let bridgeReady = false;
let expanded = false;
let formOpen = false;
let displayedTrip: string | undefined;
let thresholdDraft = false;
let receivedToolResult = false;
const notice = (text: string) => {
  output.textContent = text;
  output.hidden = !text;
};
const controller = new BasketController(
  app,
  (text) => {
    notice(text);
  },
  undefined,
  render,
);

function money(amount: number, basket: ThresholdBasket) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: basket.currency,
    minimumFractionDigits: basket.currencyFractionDigits,
    maximumFractionDigits: basket.currencyFractionDigits,
  }).format(amount / basket.currencyScale);
}
function render() {
  const snapshot = controller.snapshot;
  const basket = snapshot?.basket;
  const loaded = controller.revision !== undefined;
  const blocked = controller.busy || !bridgeReady;
  if (displayedTrip !== basket?.id) {
    displayedTrip = basket?.id;
    expanded = false;
    formOpen = Boolean(basket && !basket.items.length);
    thresholdDraft = false;
  }
  el("app").setAttribute("aria-busy", String(controller.busy));
  el("basket-title").textContent = basket?.store ?? "Your basket";
  el("basket-subtitle").textContent = snapshot
    ? "Saved in your private guest space."
    : "A private guest space. No account needed.";
  el("basket-subtitle").hidden = Boolean(basket);
  el("trip-state").textContent =
    basket?.status === "checked_out"
      ? "Checked out"
      : basket
        ? "Active trip"
        : "Guest";
  el("empty").hidden = Boolean(basket);
  el("empty-title").textContent = controller.authorizationRequired
    ? "Reconnect to your guest space"
    : loaded
      ? snapshot?.lastBasketExpiredAt
        ? "Your previous baskets expired"
        : "Start a fresh trip"
      : receivedToolResult
        ? "Load your basket"
        : "Loading your basket…";
  el("empty-description").textContent = controller.authorizationRequired
    ? "Your authorization needs to be renewed before your basket can load."
    : loaded
      ? "You’re still connected. Start a new trip whenever you’re ready."
      : receivedToolResult
        ? "Load your connected guest space to refresh this saved view."
        : "Using your existing connection.";
  el("basket").hidden = !basket;
  el("threshold-settings").hidden = !basket;
  const canAdd = Boolean(basket && basket.status === "active");
  for (const id of [
    "threshold-mode",
    "threshold-amounts",
    "save-thresholds",
    "suggest-removals",
  ])
    el<HTMLInputElement>(id).disabled =
      blocked || controller.hasPending || !canAdd;
  form.hidden = !canAdd || !formOpen;
  const toggle = el<HTMLButtonElement>("toggle-add");
  toggle.hidden = !canAdd;
  toggle.textContent = formOpen ? "Cancel item" : "Add an item";
  toggle.classList.toggle("primary", !formOpen);
  toggle.setAttribute("aria-expanded", String(formOpen));
  toggle.disabled = blocked || controller.hasPending || !loaded;
  const load = el<HTMLButtonElement>("load");
  load.textContent = controller.busy
    ? "Working…"
    : controller.hasPending
      ? "Retry last action"
      : controller.authorizationRequired
        ? "Reconnect"
        : loaded
          ? "Refresh basket"
          : "Load basket";
  load.classList.toggle("primary", !loaded);
  const start = el<HTMLButtonElement>("start");
  start.hidden = !loaded || Boolean(basket);
  start.classList.toggle("primary", loaded && !basket);
  start.disabled = blocked || controller.hasPending;
  load.disabled = blocked;
  el("new-trip").hidden = !basket;
  for (const id of [
    "name",
    "price",
    "add-item",
    "new-trip",
    "delete",
    "yes-delete",
    "clear",
    "yes-clear",
  ]) {
    el<HTMLInputElement | HTMLButtonElement>(id).disabled =
      blocked || controller.hasPending || !loaded;
  }
  if (!basket) {
    el("items").replaceChildren();
    el("total").textContent = "";
    el("item-count").textContent = "";
    return;
  }
  el("total").textContent = money(basket.totalCents, basket);
  el("item-count").textContent =
    `${basket.items.length} ${basket.items.length === 1 ? "item" : "items"}`;
  el("currency").textContent = `(${basket.currency})`;
  el<HTMLInputElement>("price").placeholder = basket.currencyFractionDigits
    ? `0.${"0".repeat(basket.currencyFractionDigits)}`
    : "0";
  const list = el("items");
  list.hidden = !expanded || !basket.items.length;
  list.replaceChildren();
  for (const item of expanded ? basket.items : []) {
    const row = document.createElement("li");
    row.className = "item";
    const copy = document.createElement("div");
    copy.className = "item-copy";
    const name = document.createElement("p");
    name.className = "item-name";
    name.textContent = item.name;
    const detail = document.createElement("p");
    detail.className = "item-detail";
    detail.textContent = `${item.quantity} ${item.unit} × ${money(item.unitPriceCents, basket)}`;
    const amount = document.createElement("span");
    amount.className = "item-amount";
    amount.textContent = money(item.lineTotalCents, basket);
    copy.append(name, detail);
    row.append(copy, amount);
    list.append(row);
  }
  const more = el<HTMLButtonElement>("show-items");
  more.hidden = !basket.items.length;
  el("list-toggle-label").textContent = expanded
    ? "Hide basket items"
    : "Show basket items";
  more.setAttribute("aria-expanded", String(expanded));
  renderMilestone(basket);
  const config = basket.thresholdConfig;
  el("threshold-description").textContent =
    config?.mode === "unlimited"
      ? `Unlimited multiples of ${money(config.amountCents, basket)}.`
      : config?.mode === "static"
        ? `Available thresholds: ${config.entries.map((entry) => `${entry.count} × ${money(entry.amountCents, basket)}`).join(", ")}. Each can be used once; combinations count.`
        : `Existing independent milestones: ${basket.thresholdsCents.map((amount) => money(amount, basket)).join(", ")}. Unchanged until you save a new mode.`;
  if (basket.thresholdStatus?.highestReachedCents != null)
    el("threshold-description").textContent +=
      ` Highest met: ${money(basket.thresholdStatus.highestReachedCents, basket)}.`;
  if (!thresholdDraft) {
    el<HTMLSelectElement>("threshold-mode").value = config?.mode ?? "unlimited";
    const values =
      config?.mode === "static"
        ? config.entries.flatMap((entry) =>
            Array<number>(entry.count).fill(entry.amountCents),
          )
        : [
            config?.amountCents ??
              basket.thresholdsCents[0] ??
              25 * basket.currencyScale,
          ];
    el<HTMLInputElement>("threshold-amounts").value = values
      .map((amount) =>
        (amount / basket.currencyScale).toFixed(basket.currencyFractionDigits),
      )
      .join(", ");
  }
  const plan = snapshot?.removalSuggestion;
  el("removal-plan").hidden = !plan;
  el("removal-items").replaceChildren();
  if (plan) {
    el("removal-summary").textContent =
      plan.status === "no_threshold_reached"
        ? "No threshold has been met yet. Removing items cannot reach the next threshold."
        : plan.status === "trip_checked_out"
          ? "This trip is checked out; item removal is locked."
          : `${plan.optimal ? "Best whole-line suggestion" : "Safe suggestion; a better combination may exist"}: save ${money(plan.savingsCents, basket)}, leaving ${money(plan.resultingTotalCents, basket)} total and ${money(plan.resultingThresholdSubtotalCents, basket)} toward the ${money(plan.targetCents!, basket)} threshold.${plan.removals.length ? "" : " No removable lines fit."}`;
    if (plan.status === "suggested")
      for (const item of plan.removals) {
        const row = document.createElement("li");
        row.textContent = `${item.name} · ${item.quantity} ${item.unit} · ${money(item.lineTotalCents, basket)}`;
        el("removal-items").append(row);
      }
  }
}

function renderMilestone(basket: ThresholdBasket) {
  // Use the server's eligible subtotal and threshold policy, not the payable
  // total or a guessed repeating amount. Fall back only for old cached results.
  const highest = basket.thresholdStatus
    ? basket.thresholdStatus.highestReachedCents
    : (basket.thresholds.filter((threshold) => threshold.reached).at(-1)
        ?.amountCents ?? null);
  const next = basket.thresholdStatus
    ? basket.thresholdStatus.nextThresholdCents
    : (basket.thresholds.find((threshold) => !threshold.reached)?.amountCents ??
      null);
  const maximum = next ?? highest;
  el("milestone").hidden = false;
  el("milestone-status").textContent =
    highest !== null
      ? `${money(highest, basket)} milestone met`
      : next !== null
        ? `Next milestone: ${money(next, basket)}`
        : "No milestones set";
  el("milestone-detail").textContent =
    next !== null
      ? `${money(Math.max(0, next - basket.thresholdSubtotalCents), basket)} to ${money(next, basket)}`
      : highest !== null
        ? "All configured milestones met."
        : "Choose your targets in Thresholds & savings.";
  const progress = el("milestone-progress");
  progress.hidden = maximum === null;
  if (maximum !== null) {
    const current = Math.min(
      maximum,
      Math.max(0, basket.thresholdSubtotalCents),
    );
    progress.setAttribute("aria-valuemax", String(maximum));
    progress.setAttribute("aria-valuenow", String(current));
    progress.setAttribute(
      "aria-valuetext",
      `${money(basket.thresholdSubtotalCents, basket)} toward ${money(maximum, basket)}${next === null ? "; all milestones met" : ""}`,
    );
    el("milestone-fill").style.width = `${(current / maximum) * 100}%`;
  }
  el("milestone-basis").hidden =
    basket.thresholdSubtotalCents === basket.totalCents;
  el("milestone-basis").textContent =
    `${money(basket.thresholdSubtotalCents, basket)} eligible toward milestones`;
}

app.ontoolresult = (result) => {
  receivedToolResult = true;
  if (!controller.accept(result)) render();
};
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
};
el("load").addEventListener("click", () => {
  void controller.load();
});
el("start").addEventListener("click", () => {
  void controller.start();
});
el("new-trip").addEventListener("click", () => {
  void controller.start();
});
el("toggle-add").addEventListener("click", () => {
  formOpen = !formOpen;
  render();
  if (formOpen) el("name").focus();
});
el("show-items").addEventListener("click", () => {
  expanded = !expanded;
  render();
});
for (const id of ["threshold-mode", "threshold-amounts"])
  el(id).addEventListener("input", () => {
    thresholdDraft = true;
  });
el("threshold-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveThresholds();
});
el("save-thresholds").addEventListener("click", () => {
  void saveThresholds();
});
el("suggest-removals").addEventListener("click", () => {
  void controller.suggestRemovals();
});
async function saveThresholds() {
  const basket = controller.snapshot?.basket;
  if (!basket || controller.busy || controller.hasPending) return;
  const error = el("threshold-error");
  try {
    const mode = el<HTMLSelectElement>("threshold-mode").value;
    const amounts = el<HTMLInputElement>("threshold-amounts")
      .value.split(",")
      .map((text) => {
        const amount = parsePrice(text.trim(), basket.currencyFractionDigits);
        if (amount === undefined || amount <= 0) throw new Error();
        return amount;
      });
    const counts = new Map<number, number>();
    for (const amount of amounts)
      counts.set(amount, (counts.get(amount) ?? 0) + 1);
    let config: ThresholdConfig;
    if (mode === "unlimited") {
      if (amounts.length !== 1) throw new Error();
      config = { mode, amountCents: amounts[0]! };
    } else
      config = {
        mode: "static",
        entries: [...counts].map(([amountCents, count]) => ({
          amountCents,
          count,
        })),
      };
    config = thresholdConfigSchema.parse(config);
    error.hidden = true;
    await controller.setThresholds(config);
    if (!controller.hasPending) {
      thresholdDraft = false;
      render();
    }
  } catch {
    error.hidden = false;
    error.textContent = `Use one positive ${basket.currency} amount for unlimited multiples, or up to 20 comma-separated amounts for static thresholds (at most 10 different amounts).`;
  }
}
async function addItem() {
  const basket = controller.snapshot?.basket;
  if (!basket || controller.busy || controller.hasPending) return;
  if (!form.reportValidity()) return;
  const name = el<HTMLInputElement>("name");
  const price = el<HTMLInputElement>("price");
  const amount = parsePrice(price.value, basket.currencyFractionDigits);
  const error = el("price-error");
  error.hidden = amount !== undefined;
  price.setAttribute("aria-invalid", String(amount === undefined));
  if (amount === undefined) {
    error.textContent = `Enter a price in ${basket.currency} with up to ${basket.currencyFractionDigits} decimal places (maximum ${money(1_000_000, basket)}).`;
    price.focus();
    return;
  }
  if (!name.value.trim()) {
    name.focus();
    return;
  }
  const revision = controller.revision;
  await controller.add(name.value.trim(), amount);
  if (
    !controller.hasPending &&
    controller.revision !== undefined &&
    controller.revision !== revision
  ) {
    form.reset();
    formOpen = false;
    render();
    notice("Item added.");
    el("toggle-add").focus();
  }
}
// Host sandboxes need not allow native form submission. All actions use the
// authenticated bridge; clicking or pressing Enter must never navigate the frame.
el("add-item").addEventListener("click", () => {
  void addItem();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void addItem();
});
form.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    void addItem();
  }
});
const confirmDelete = el("confirm-delete");
const confirmClear = el("confirm-clear");
el("clear").addEventListener("click", () => {
  confirmClear.hidden = false;
  el("cancel-clear").focus();
});
el("cancel-clear").addEventListener("click", () => {
  confirmClear.hidden = true;
  el("clear").focus();
});
el("yes-clear").addEventListener("click", () => {
  confirmClear.hidden = true;
  void controller.clearConfirmed();
});
el("delete").addEventListener("click", () => {
  confirmDelete.hidden = false;
  el("cancel-delete").focus();
});
el("cancel-delete").addEventListener("click", () => {
  confirmDelete.hidden = true;
  el("delete").focus();
});
el("yes-delete").addEventListener("click", () => {
  confirmDelete.hidden = true;
  void controller.deleteConfirmed();
});
render();
app
  .connect()
  .then(() => {
    const context = app.getHostContext();
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables)
      applyHostStyleVariables(context.styles.variables);
    bridgeReady = true;
    render();
  })
  .catch(() => {
    notice(
      "Open this widget inside ChatGPT to connect. A standalone preview does not save data.",
    );
  });

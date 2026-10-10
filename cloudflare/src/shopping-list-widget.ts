import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { ShoppingListController } from "./shopping-list-controller.js";
import { parsePrice } from "./widget-money.js";
const app = new App(
  { name: "basket-wise-shopping-list", version: "0.5.0" },
  {},
  { autoResize: true },
);
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let ready = false,
  received = false,
  expanded = false;
let editing: string | undefined,
  purchasing: string | undefined,
  removing: string | undefined;
const show = (text: string) => {
  el("result").textContent = text;
  el("result").hidden = !text;
};
const controller = new ShoppingListController(app, show, render);
function reset() {
  editing = undefined;
  el<HTMLFormElement>("list-form").reset();
  el("form-title").textContent = "Add to shopping list";
  el("cancel-edit").hidden = true;
}
function render() {
  const snapshot = controller.snapshot;
  const items = snapshot?.shoppingList ?? [];
  el("app").setAttribute("aria-busy", String(controller.busy));
  el("list-count").textContent = snapshot
    ? `${items.length} to buy`
    : "Shopping list";
  el("empty").hidden = items.length > 0;
  el("empty").textContent = snapshot
    ? "Nothing on your list yet."
    : received
      ? "Refresh to load your connected shopping list."
      : "Loading your shopping list…";
  const ul = el("shopping-items");
  ul.replaceChildren();
  for (const item of expanded ? items : items.slice(0, 5)) {
    const li = document.createElement("li");
    li.className = "shopping-row";
    const title = document.createElement("strong");
    title.textContent = item.name;
    const detail = document.createElement("span");
    detail.className = "muted";
    detail.textContent = `${item.quantity} ${item.unit}${item.notes ? ` · ${item.notes}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = (label: string, handler: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.disabled = !ready || controller.busy || controller.hasPending;
      b.onclick = handler;
      actions.append(b);
    };
    button("Add to trip", () => {
      purchasing = item.id;
      el("purchase-title").textContent = `Add ${item.name} to your trip`;
      el("purchase").hidden = false;
      el<HTMLInputElement>("price").value = "";
      el("price").focus();
    });
    button("Edit", () => {
      editing = item.id;
      el<HTMLInputElement>("name").value = item.name;
      el<HTMLInputElement>("quantity").value = String(item.quantity);
      el<HTMLSelectElement>("unit").value = item.unit;
      el<HTMLInputElement>("notes").value = item.notes;
      el("form-title").textContent = "Edit shopping-list item";
      el("cancel-edit").hidden = false;
      el("list-form").hidden = false;
      el("name").focus();
    });
    button(removing === item.id ? "Confirm remove" : "Remove", () => {
      if (removing !== item.id) {
        removing = item.id;
        render();
        return;
      }
      removing = undefined;
      void controller.remove(item.id);
    });
    li.append(title, detail, actions);
    ul.append(li);
  }
  el("more").hidden = items.length <= 5;
  el("more").textContent = expanded
    ? "Show fewer"
    : `Show all ${items.length} items`;
  el("toggle-form").hidden = !snapshot;
  el("refresh").textContent = controller.hasPending
    ? "Retry same action"
    : controller.authorizationRequired
      ? "Reconnect in ChatGPT"
      : "Refresh list";
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button,input,select"))
    control.disabled =
      !ready ||
      controller.busy ||
      (controller.hasPending && control.id !== "refresh");
  if (purchasing && !items.some((item) => item.id === purchasing)) {
    purchasing = undefined;
    el("purchase").hidden = true;
  }
}
el("toggle-form").onclick = () => {
  reset();
  el("list-form").hidden = !el("list-form").hidden;
};
el("cancel-edit").onclick = () => {
  reset();
  el("list-form").hidden = true;
};
el("more").onclick = () => {
  expanded = !expanded;
  render();
};
el("refresh").onclick = () => void controller.load();
el("save").onclick = () => {
  const name = el<HTMLInputElement>("name").value.trim(),
    quantity = Number(el<HTMLInputElement>("quantity").value);
  if (
    !name ||
    !(quantity > 0 && quantity <= 1000) ||
    Math.abs(quantity * 1000 - Math.round(quantity * 1000)) >= 0.000001
  ) {
    show("Enter a name and quantity with at most three decimal places.");
    return;
  }
  void controller
    .save(
      {
        name,
        quantity,
        unit: el<HTMLSelectElement>("unit").value as "each" | "kg" | "litre",
        notes: el<HTMLInputElement>("notes").value.trim(),
      },
      editing,
    )
    .then(() => {
      if (!controller.hasPending && controller.snapshot) {
        reset();
        el("list-form").hidden = true;
      }
    });
};
el("list-form").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el("save").click();
  }
};
el("purchase-cancel").onclick = () => {
  purchasing = undefined;
  el("purchase").hidden = true;
};
el("purchase-confirm").onclick = () => {
  if (purchasing)
    void controller.addToTrip(
      purchasing,
      el<HTMLInputElement>("price").value,
      parsePrice,
    );
};
app.ontoolresult = (result) => {
  received = true;
  controller.accept(result);
  render();
};
app.onhostcontextchanged = (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
};
void app
  .connect()
  .then(() => {
    ready = true;
    const context = app.getHostContext();
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables)
      applyHostStyleVariables(context.styles.variables);
    render();
  })
  .catch(() => {
    show("Open this widget in ChatGPT with Basket Wise connected.");
    render();
  });
render();

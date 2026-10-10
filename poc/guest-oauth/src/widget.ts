import { App } from "@modelcontextprotocol/ext-apps";
import { ProbeController } from "./widget-controller.js";
import { VERSION } from "./constants.js";

const button = document.getElementById("check") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLElement;

async function connect(): Promise<void> {
  if (window.parent === window) {
    status.textContent =
      "Open this probe inside ChatGPT. A standalone preview cannot verify host OAuth.";
    return;
  }
  const app = new App(
    { name: "Guest OAuth compatibility probe", version: VERSION },
    {},
    { autoResize: true },
  );
  const controller = new ProbeController(app, (message) => {
    status.textContent = message;
  });
  try {
    await app.connect();
    button.disabled = false;
    status.textContent =
      "Connected to the host bridge. This alone does not verify guest authorization.";
    button.addEventListener("click", async () => {
      button.disabled = true;
      await controller.check();
      button.disabled = false;
    });
  } catch {
    status.textContent =
      "The host bridge is unavailable. No OAuth compatibility result can be claimed.";
  }
}

void connect();

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFromEnv } from "./config.js";
import { GuestAuthStore } from "./store.js";
import { createProbeApp } from "./http.js";
import { buildWidget } from "./widget-html.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "--help") {
    console.log(
      "Guest OAuth PoC: serve | revoke <guest-tag> | purge. See poc/guest-oauth/README.md. Never starts a tunnel.",
    );
    return;
  }
  if (!["serve", "revoke", "purge"].includes(command))
    throw new Error("Unknown command; use --help.");
  const config = configFromEnv(process.env);
  const path = resolve(
    process.env.POC_DB ??
      fileURLToPath(new URL("../data/oauth.sqlite", import.meta.url)),
  );
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new GuestAuthStore(path, config);
  chmodSync(path, 0o600);
  if (command === "revoke") {
    const tag = process.argv[3];
    if (!tag || !/^guest-[a-f0-9-]{36}$/.test(tag)) {
      store.close();
      throw new Error("Supply a guest tag from a probe result.");
    }
    console.log(
      store.revokeGuest(tag)
        ? "Guest access revoked."
        : "No active matching guest.",
    );
    store.close();
    return;
  }
  if (command === "purge") {
    store.purge();
    store.close();
    console.log("Expired PoC state purged.");
    return;
  }
  const port = Number(process.env.POC_PORT ?? 3417);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    store.close();
    throw new Error("POC_PORT must be 1024–65535.");
  }
  try {
    const app = createProbeApp(store, await buildWidget());
    const server = app.listen(port, "127.0.0.1", () => {
      console.log(
        `Isolated guest OAuth PoC listening on loopback port ${port}. No tunnel or cloud resources started. ChatGPT compatibility is NOT verified.`,
      );
    });
    server.on("error", () => {
      store.close();
      console.error("PoC listener failed. No request data logged.");
      process.exitCode = 1;
    });
    const stop = () => {
      server.closeAllConnections();
      server.close(() => store.close());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    store.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch(() => {
    console.error(
      "Guest OAuth PoC could not start. Check its configuration and README. No credentials are logged.",
    );
    process.exitCode = 1;
  });
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export const chromiumPath = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].find((path): path is string => Boolean(path && existsSync(path)));

/** Local CDP harness: no downloads, personal profile, or outbound browser access. */
export async function withChromium(
  run: (browser: {
    send: (method: string, params?: Record<string, unknown>) => Promise<any>;
    on: (method: string, handler: (params: any) => Promise<void>) => void;
    evaluate: (expression: string) => Promise<any>;
    waitFor: (condition: () => Promise<boolean>) => Promise<void>;
  }) => Promise<void>,
) {
  if (!chromiumPath)
    throw new Error("Set CHROME_BIN to a local Chromium executable");
  const profile = await mkdtemp(join(tmpdir(), "bw-csp-chromium-"));
  const child = spawn(
    chromiumPath,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--proxy-server=http://127.0.0.1:9",
      "--proxy-bypass-list=<-loopback>",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Chromium startup timed out")),
        10000,
      );
      let output = "";
      child.stderr.on("data", (data: Buffer) => {
        output += data.toString();
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Chromium exited during startup"));
      });
    });
    const ws = (socket = new WebSocket(endpoint));
    await once(ws, "open", { signal: AbortSignal.timeout(10000) });
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    const handlers = new Map<string, (params: any) => Promise<void>>();
    const errors: Error[] = [];
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      const call = pending.get(data.id);
      if (call) {
        pending.delete(data.id);
        if (data.error) call.reject(new Error(data.error.message));
        else call.resolve(data.result);
      } else if (handlers.has(data.method)) {
        void handlers.get(data.method)!(data.params).catch((error: Error) =>
          errors.push(error),
        );
      }
    });
    const sendRaw = (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timed out: ${method}`));
        }, 5000);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        ws.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
    const { targetId } = await sendRaw("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await sendRaw("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const send = (method: string, params?: Record<string, unknown>) =>
      sendRaw(method, params, sessionId);
    await send("Page.enable");
    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error("Browser evaluation failed");
      return result.result.value;
    };
    await run({
      send,
      on: (method, handler) => {
        handlers.set(method, handler);
      },
      evaluate,
      waitFor: async (condition) => {
        const deadline = Date.now() + 5000;
        while (!(await condition())) {
          if (errors.length) throw errors[0];
          if (Date.now() >= deadline)
            throw new Error("Browser condition timed out");
          await delay(25);
        }
      },
    });
    if (errors.length) throw errors[0];
  } finally {
    socket?.close();
    child.kill();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}

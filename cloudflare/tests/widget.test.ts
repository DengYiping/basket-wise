import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromiumPath, withChromium } from "./chromium.js";
import { widgetHarness } from "./widget-harness.js";
import { parsePrice } from "../src/widget-money.js";
import {
  summarizeThresholds,
  suggestRemovals,
  type ThresholdConfig,
  type ThresholdTrip,
} from "../src/thresholds.js";

test("widget prices preserve exact currency minor units without silent rounding", () => {
  assert.equal(parsePrice("2.19", 2), 219);
  assert.equal(parsePrice("2,19", 2), 219);
  assert.equal(parsePrice("0.29", 2), 29);
  assert.equal(parsePrice("12", 0), 12);
  assert.equal(parsePrice("2.195", 3), 2195);
  assert.equal(parsePrice("10000.00", 2), 1_000_000);
  for (const input of ["2.195", "-1", "1e3", "", "1,000.00", "10000.01", "NaN"])
    assert.equal(parsePrice(input, 2), undefined, input);
  assert.equal(parsePrice("12.1", 0), undefined);
});

test(
  "real widget bridge renders mobile/dark layouts and keeps actions safe",
  {
    skip: chromiumPath ? false : "Local Chromium is required",
    timeout: 30000,
  },
  async () => {
    const html = widgetHarness(
      await readFile(new URL("../dist/widget.html", import.meta.url), "utf8"),
    );
    await withChromium(async (browser) => {
      const unexpected: string[] = [];
      await browser.on(
        "Fetch.requestPaused",
        async ({ requestId, request }) => {
          if (request.url !== "https://widget-preview.test/") {
            unexpected.push(request.url);
            await browser.send("Fetch.failRequest", {
              requestId,
              errorReason: "Aborted",
            });
            return;
          }
          await browser.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: Buffer.from(html).toString("base64"),
          });
        },
      );
      await browser.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await browser.send("Page.navigate", {
        url: "https://widget-preview.test/",
      });
      await browser.waitFor(async () =>
        Boolean(await browser.evaluate("window.ready")),
      );
      const frame = (expression: string) =>
        browser.evaluate(
          `(() => {const d=document.querySelector('iframe').contentDocument;return ${expression};})()`,
        );
      const waitForSize = () =>
        browser.waitFor(
          async () =>
            await frame(
              "d.documentElement.scrollHeight <= d.defaultView.innerHeight + 1",
            ),
        );
      const screenshot = async (name: string) => {
        await waitForSize();
        const { cssContentSize } = await browser.send("Page.getLayoutMetrics");
        const capture = await browser.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: cssContentSize.width,
            height: cssContentSize.height,
            scale: 1,
          },
        });
        await writeFile(
          new URL(`../dist/screenshots/${name}.png`, import.meta.url),
          Buffer.from(capture.data, "base64"),
        );
      };
      assert.equal(
        await browser.evaluate("window.calls.length"),
        0,
        "initial paint must not renew retention",
      );
      assert.equal(
        await frame("d.getElementById('load').textContent"),
        "Load basket",
      );
      // The explicit open tool supplies the saved basket. Rendering it must
      // not require a click or issue another read, including when replayed.
      await browser.evaluate("window.deliver(window.current)");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('total').textContent")) === "€8.18",
      );
      await browser.evaluate("window.deliver(window.current)");
      assert.equal(await browser.evaluate("window.calls.length"), 0);
      assert.equal(
        await frame("d.getElementById('load').textContent"),
        "Refresh basket",
      );
      assert.equal(
        await frame("d.body.textContent.includes('Connect & load')"),
        false,
      );
      await frame("d.getElementById('load').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('total').textContent")) === "€8.18",
      );
      assert.equal(
        await browser.evaluate("window.calls[0].name"),
        "get_basket",
      );
      assert.equal(await frame("d.querySelector('pre')"), null);
      assert.equal(await frame("d.getElementById('items').hidden"), true);
      assert.equal(await frame("d.querySelectorAll('#items li').length"), 0);
      assert.equal(
        await frame(
          "d.getElementById('show-items').getAttribute('aria-expanded')",
        ),
        "false",
      );
      const beforeList = await browser.evaluate("window.calls.length");
      await frame("d.getElementById('show-items').click()");
      assert.equal(await frame("d.querySelectorAll('#items li').length"), 3);
      assert.equal(await frame("d.getElementById('items').hidden"), false);
      await frame("d.getElementById('show-items').click()");
      assert.equal(await frame("d.getElementById('items').hidden"), true);
      assert.equal(await browser.evaluate("window.calls.length"), beforeList);

      for (const width of [320, 375, 390, 480, 768]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        for (const theme of ["light", "dark"]) {
          await browser.evaluate(`window.setTheme('${theme}')`);
          await browser.waitFor(
            async () =>
              (await frame("d.documentElement.dataset.theme")) === theme,
          );
          assert.equal(
            await frame(
              "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
            ),
            true,
            `${width}/${theme}: no horizontal scrolling`,
          );
          const compactHeight = await frame(
            "d.querySelector('main').getBoundingClientRect().height",
          );
          assert.ok(
            compactHeight <= 460,
            `${width}/${theme}: collapsed basket stays compact (${compactHeight}px)`,
          );
          const boxes = await frame(
            "[...d.querySelectorAll('button,input,summary')].filter(e=>e.getClientRects().length).map(e=>({height:e.getBoundingClientRect().height,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:d.documentElement.clientWidth}))",
          );
          for (const box of boxes) {
            assert.ok(box.height >= 48, `${width}/${theme}: touch height`);
            assert.ok(
              box.left >= 0 && box.right <= box.width,
              `${width}/${theme}: controls inside frame`,
            );
          }
          assert.equal(
            await frame(
              "d.defaultView.getComputedStyle(d.querySelector('main')).backgroundColor",
            ),
            theme === "light" ? "rgb(247, 247, 240)" : "rgb(29, 40, 33)",
            `${width}/${theme}: brand surface remains coordinated with sign-in`,
          );
          assert.match(
            await frame(
              "d.defaultView.getComputedStyle(d.querySelector('h1')).fontFamily",
            ),
            /Georgia/,
          );
          assert.equal(
            await frame("d.querySelector('.brand').textContent.trim()"),
            "Basket Wise",
          );
          if (
            process.env.BW_WIDGET_SCREENSHOTS === "1" &&
            [390, 768].includes(width)
          ) {
            await mkdir(new URL("../dist/screenshots/", import.meta.url), {
              recursive: true,
            });
            await screenshot(`widget-${width}-${theme}`);
          }
          await frame("d.getElementById('toggle-add').click()");
          await waitForSize();
          assert.equal(
            await frame(
              "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
            ),
            true,
            `${width}/${theme}: expanded form has no horizontal scrolling`,
          );
          const fields = await frame(
            "[...d.querySelectorAll('#add button,#add input')].map(e=>({height:e.getBoundingClientRect().height,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:d.documentElement.clientWidth}))",
          );
          for (const box of fields) {
            assert.ok(box.height >= 48);
            assert.ok(box.left >= 0 && box.right <= box.width);
          }
          if (process.env.BW_WIDGET_SCREENSHOTS === "1" && width === 390) {
            await screenshot(`widget-${width}-${theme}-entry`);
          }
          await frame("d.getElementById('toggle-add').click()");
        }
      }
      const fonts = await frame(
        "[...d.querySelectorAll('input')].map(e=>parseFloat(d.defaultView.getComputedStyle(e).fontSize))",
      );
      assert.ok(
        fonts.every((size: number) => size >= 16),
        "readable mobile inputs",
      );
      await frame("d.getElementById('toggle-add').click()");
      await browser.evaluate("window.holdCalls=true");
      await frame(
        "(d.getElementById('name').value='Tea',d.getElementById('price').value='3.49',d.getElementById('add-item').click())",
      );
      try {
        await browser.waitFor(
          async () => await browser.evaluate("Boolean(window.pendingReply)"),
        );
      } catch (error) {
        assert.fail(
          JSON.stringify({
            cause: String(error),
            calls: await browser.evaluate("window.calls"),
            state: await frame(
              "({notice:d.getElementById('result').textContent,error:d.getElementById('price-error').textContent,valid:d.getElementById('add').checkValidity(),disabled:d.getElementById('add-item').disabled})",
            ),
          }),
        );
      }
      assert.equal(await frame("d.getElementById('add-item').disabled"), true);
      assert.equal(await frame("d.getElementById('load').disabled"), true);
      assert.equal(
        await browser.evaluate("window.calls.at(-1).arguments.unitPriceCents"),
        349,
      );
      await browser.evaluate(
        "window.pendingReply();window.pendingReply=null;window.holdCalls=false",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('total').textContent")) === "€11.67",
      );
      assert.equal(await frame("d.getElementById('name').value"), "");
      await frame("d.getElementById('toggle-add').click()");
      const callsBeforeInvalid = await browser.evaluate("window.calls.length");
      await frame(
        "(d.getElementById('name').value='Tea',d.getElementById('price').value='1.999',d.getElementById('add-item').click())",
      );
      assert.equal(
        await frame("d.getElementById('price').getAttribute('aria-invalid')"),
        "true",
      );
      assert.equal(
        await browser.evaluate("window.calls.length"),
        callsBeforeInvalid,
      );
      await frame(
        "(d.getElementById('price').value='0.29',d.getElementById('price').dispatchEvent(new d.defaultView.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})))",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('total').textContent")) === "€11.96",
      );

      // Long user input is text, not markup, and can never widen the frame.
      await browser.evaluate(
        "window.current.basket.items[0].name='<img src=x onerror=alert(1)>'+ 'W'.repeat(120);window.current.basket.items.push(...structuredClone(window.current.basket.items));window.current.revision++;window.deliver(window.current)",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('show-items').hidden")) === false,
      );
      assert.equal(await frame("d.querySelectorAll('#items li').length"), 0);
      await frame("d.getElementById('show-items').click()");
      assert.equal(await frame("d.querySelectorAll('#items li').length"), 10);
      assert.equal(await frame("d.querySelector('#items img')"), null);
      await frame("d.getElementById('show-items').click()");
      assert.equal(await frame("d.querySelectorAll('#items li').length"), 0);
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      assert.equal(
        await frame(
          "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
        ),
        true,
      );

      // Host design tokens update the rendered document, not just fallback CSS.
      await browser.evaluate(
        "document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark',styles:{variables:{'--color-background-primary':'rgb(20, 21, 22)'}}}},'*')",
      );
      await browser.waitFor(
        async () =>
          (await frame(
            "d.defaultView.getComputedStyle(d.body).backgroundColor",
          )) === "rgb(20, 21, 22)",
      );
      await browser.evaluate(
        "window.nextError={content:[],isError:true,structuredContent:{error:'revision_conflict'}}",
      );
      await frame("d.getElementById('load').click()");
      await browser.waitFor(async () =>
        Boolean(
          await frame(
            "d.getElementById('result').textContent.includes('rejected')",
          ),
        ),
      );
      assert.equal(await frame("d.getElementById('add-item').disabled"), true);
      await frame("d.getElementById('load').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('add-item').disabled")) === false,
      );
      // Failed transport keeps the exact mutation receipt and offers an explicit retry.
      await frame("d.getElementById('toggle-add').click()");
      await browser.evaluate(
        "window.nextError={content:[],isError:true,structuredContent:{error:'request_failed'}}",
      );
      await frame(
        "(d.getElementById('name').value='Retry item',d.getElementById('price').value='1.00',d.getElementById('add-item').click())",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('load').textContent")) ===
          "Retry last action",
      );
      const pendingCall = await browser.evaluate("window.calls.at(-1)");
      assert.equal(await frame("d.getElementById('add-item').disabled"), true);
      await frame("d.getElementById('load').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('load').textContent")) ===
          "Refresh basket",
      );
      const retriedCall = await browser.evaluate("window.calls.at(-1)");
      assert.deepEqual(retriedCall.arguments, pendingCall.arguments);
      await frame(
        "(d.getElementById('guest-settings').open=true,d.getElementById('delete').click())",
      );
      assert.equal(
        await frame("d.getElementById('confirm-delete').hidden"),
        false,
      );
      assert.notEqual(
        await browser.evaluate("window.calls.at(-1).name"),
        "delete_guest",
      );
      await frame("d.getElementById('cancel-delete').click()");
      assert.equal(
        await frame("d.getElementById('confirm-delete').hidden"),
        true,
      );
      await browser.evaluate(
        "window.current.basket.status='checked_out';window.current.revision++;window.deliver(window.current)",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('trip-state').textContent")) ===
          "Checked out",
      );
      assert.equal(await frame("d.getElementById('toggle-add').hidden"), true);
      await waitForSize();
      assert.equal(
        await frame(
          "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
        ),
        true,
        "checked-out long basket stays inside a 320-pixel host",
      );
      await browser.evaluate(
        "window.current.basket=null;window.current.revision++;window.deliver(window.current)",
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('empty-title').textContent")) ===
          "Start a fresh trip",
      );
      assert.equal(await frame("d.getElementById('start').hidden"), false);
      await waitForSize();
      assert.equal(
        await frame(
          "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
        ),
        true,
        "empty guest and expanded settings fit the phone viewport",
      );
      assert.ok(
        (await browser.evaluate("window.sizeUpdates.length")) > 1,
        "host auto-resize receives updates",
      );
      const beforeClear = await browser.evaluate("window.calls.length");
      await frame("d.getElementById('clear').click()");
      assert.equal(
        await frame("d.getElementById('confirm-clear').hidden"),
        false,
      );
      assert.equal(await browser.evaluate("window.calls.length"), beforeClear);
      await frame("d.getElementById('cancel-clear').click()");
      assert.equal(
        await frame("d.getElementById('confirm-clear').hidden"),
        true,
      );
      await frame(
        "(d.getElementById('clear').click(),d.getElementById('yes-clear').click())",
      );
      await browser.waitFor(
        async () =>
          (await browser.evaluate("window.calls.length")) === beforeClear + 1,
      );
      assert.equal(
        await browser.evaluate("window.calls.at(-1).name"),
        "clear_baskets",
      );
      assert.equal(
        await browser.evaluate("window.calls.at(-1).arguments.confirm"),
        true,
      );
      assert.equal(
        await browser.evaluate("window.calls.at(-1).arguments.dataEpoch"),
        "sample-epoch",
      );
      await browser.waitFor(
        async () =>
          await frame("d.getElementById('items').children.length === 0"),
      );
      await browser.evaluate(
        "window.nextError={isError:true,structuredContent:{error:'invalid_token'},_meta:{'mcp/www_authenticate':['Bearer']}}",
      );
      await frame("d.getElementById('load').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('load').textContent")) === "Reconnect",
      );
      const authCalls = await browser.evaluate("window.calls.length");
      assert.equal(
        await frame("d.getElementById('empty-title').textContent"),
        "Reconnect to your guest space",
      );
      assert.equal(
        await browser.evaluate("window.calls.length"),
        authCalls,
        "authorization never auto-retries",
      );
      await frame("d.getElementById('load').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('load').textContent")) ===
          "Refresh basket",
      );
      assert.deepEqual(unexpected, [], "no external widget resources");
    });
  },
);

test(
  "phone widget handles threshold progress, finite configurations and advisory removals",
  {
    skip: chromiumPath ? false : "Local Chromium is required",
    timeout: 30000,
  },
  async () => {
    const trip: ThresholdTrip = {
      id: "11111111-1111-4111-8111-111111111111",
      store: "Threshold test",
      currency: "EUR",
      timezone: "Europe/Dublin",
      createdAt: "2026-10-10T12:00:00Z",
      checkedOutAt: null,
      status: "active",
      thresholdsCents: [2500, 5000],
      thresholdConfig: { mode: "unlimited", amountCents: 2500 },
      items: [5000, 2500, 500].map((amount, index) => ({
        id: `22222222-2222-4222-8222-22222222222${index}`,
        name: index === 1 ? "<img src=x onerror=alert(1)>" : `Item ${amount}`,
        unitPriceCents: amount,
        quantity: 1,
        unit: "each",
        thresholdEligible: true,
        notes: "",
        consumed: false,
        expiry: null,
      })),
    };
    const initial = {
      spaceId: "threshold-test",
      revision: 2,
      dataEpoch: "test-epoch",
      expiresAt: Date.now() + 86400000,
      basket: summarizeThresholds(trip),
    };
    const html = widgetHarness(
      await readFile(new URL("../dist/widget.html", import.meta.url), "utf8"),
    );
    await withChromium(async (browser) => {
      await browser.on(
        "Fetch.requestPaused",
        async ({ requestId, request }) => {
          if (request.url !== "https://threshold-preview.test/") {
            await browser.send("Fetch.failRequest", {
              requestId,
              errorReason: "Aborted",
            });
            return;
          }
          await browser.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html" }],
            body: Buffer.from(html).toString("base64"),
          });
        },
      );
      await browser.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 360,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await browser.send("Page.navigate", {
        url: "https://threshold-preview.test/",
      });
      await browser.waitFor(async () =>
        Boolean(await browser.evaluate("window.ready")),
      );
      const frame = (expression: string) =>
        browser.evaluate(
          `(() => {const d=document.querySelector('iframe').contentDocument;return ${expression};})()`,
        );
      await browser.evaluate(
        `window.current=${JSON.stringify(initial)};window.deliver(window.current)`,
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('total').textContent")) === "€80.00",
      );
      await frame(
        "(d.getElementById('threshold-settings').open=true,d.getElementById('threshold-mode').value='static',d.getElementById('threshold-mode').dispatchEvent(new Event('input',{bubbles:true})),d.getElementById('threshold-amounts').value='50, 50',d.getElementById('threshold-amounts').dispatchEvent(new Event('input',{bubbles:true})))",
      );
      trip.thresholdConfig = {
        mode: "static",
        entries: [{ amountCents: 5000, count: 2 }],
      };
      const saved = {
        ...initial,
        revision: 3,
        basket: summarizeThresholds(trip),
      };
      await browser.evaluate(
        `window.nextError={structuredContent:${JSON.stringify(saved)}}`,
      );
      await frame("d.getElementById('save-thresholds').click()");
      await browser.waitFor(async () =>
        Boolean(
          await frame(
            "d.getElementById('threshold-description').textContent.includes('2 × €50.00')",
          ),
        ),
      );
      const call = await browser.evaluate("window.calls.at(-1)");
      assert.equal(call.name, "set_thresholds");
      assert.equal(call.arguments.dataEpoch, "test-epoch");
      assert.equal(call.arguments.expectedRevision, 2);
      assert.deepEqual(call.arguments.thresholdConfig, trip.thresholdConfig);
      const plan = suggestRemovals(trip, {
        kind: "suggest_removals",
        keepItemIds: [],
      });
      const advice = { ...saved, removalSuggestion: plan };
      await browser.evaluate(
        `window.nextError={structuredContent:${JSON.stringify(advice)}}`,
      );
      await frame("d.getElementById('suggest-removals').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('removal-plan').hidden")) === false,
      );
      assert.equal(
        await browser.evaluate("window.calls.at(-1).name"),
        "suggest_removals",
      );
      assert.match(
        await frame("d.getElementById('removal-summary').textContent"),
        /save €30.00, leaving €50.00/,
      );
      assert.equal(
        await frame("d.querySelectorAll('#removal-items li').length"),
        2,
      );
      assert.equal(await frame("d.querySelector('#removal-items img')"), null);
      assert.equal(
        await browser.evaluate(
          "window.calls.some(call=>call.name==='remove_item')",
        ),
        false,
      );
      assert.equal(
        await frame(
          "d.documentElement.scrollWidth <= d.documentElement.clientWidth",
        ),
        true,
      );
      await browser.waitFor(
        async () =>
          await frame(
            "d.documentElement.scrollHeight <= d.defaultView.innerHeight + 1",
          ),
      );
      await mkdir(new URL("../dist/screenshots/", import.meta.url), {
        recursive: true,
      });
      const { cssContentSize } = await browser.send("Page.getLayoutMetrics");
      const capture = await browser.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: cssContentSize.width,
          height: cssContentSize.height,
          scale: 1,
        },
      });
      await writeFile(
        new URL("../dist/screenshots/thresholds-phone.png", import.meta.url),
        Buffer.from(capture.data, "base64"),
      );
      // Newer basket responses discard the old proposal rather than reusing it.
      await browser.evaluate(
        `window.deliver(${JSON.stringify({ ...saved, revision: 4 })})`,
      );
      await browser.waitFor(
        async () =>
          (await frame("d.getElementById('removal-plan').hidden")) === true,
      );

      // Threshold progress must follow the server policy and eligible subtotal,
      // including exact boundaries, completed finite targets and old snapshots.
      const recurring: ThresholdConfig = {
        mode: "unlimited",
        amountCents: 2500,
      };
      const finite: ThresholdConfig = {
        mode: "static",
        entries: [
          { amountCents: 3000, count: 1 },
          { amountCents: 5000, count: 1 },
        ],
      };
      const examples: {
        name: string;
        amount: number;
        excluded?: number;
        config?: ThresholdConfig;
        milestones?: number[];
        currency?: string;
        legacy?: boolean;
        highest: number | null;
        next: number | null;
      }[] = [
        {
          name: "below first",
          amount: 2499,
          config: recurring,
          highest: null,
          next: 2500,
        },
        {
          name: "exact recurring target",
          amount: 2500,
          config: recurring,
          highest: 2500,
          next: 5000,
        },
        {
          name: "reported phone basket",
          amount: 2691,
          config: recurring,
          highest: 2500,
          next: 5000,
        },
        {
          name: "excluded subtotal",
          amount: 2691,
          excluded: 2309,
          config: recurring,
          highest: 2500,
          next: 5000,
        },
        {
          name: "later repeating target",
          amount: 20100,
          config: recurring,
          highest: 20000,
          next: 22500,
        },
        {
          name: "finite combinations",
          amount: 6000,
          config: finite,
          highest: 5000,
          next: 8000,
        },
        {
          name: "all finite targets met",
          amount: 8000,
          config: finite,
          highest: 8000,
          next: null,
        },
        {
          name: "above finite maximum",
          amount: 8500,
          config: finite,
          highest: 8000,
          next: null,
        },
        {
          name: "no targets",
          amount: 100,
          milestones: [],
          highest: null,
          next: null,
        },
        {
          name: "legacy cached result",
          amount: 2691,
          milestones: [2500, 5000],
          legacy: true,
          highest: 2500,
          next: 5000,
        },
        {
          name: "zero-decimal currency",
          amount: 26,
          currency: "JPY",
          config: { mode: "unlimited", amountCents: 25 },
          highest: 25,
          next: 50,
        },
      ];
      const { thresholdConfig: _config, ...plainTrip } = trip;
      await frame("d.getElementById('threshold-settings').open=false");
      await browser.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const [index, example] of examples.entries()) {
        const basket = summarizeThresholds({
          ...plainTrip,
          id: `33333333-3333-4333-8333-3333333333${String(index).padStart(2, "0")}`,
          store: "Supermarket",
          currency: example.currency ?? "EUR",
          thresholdsCents: example.milestones ?? [],
          ...(example.config ? { thresholdConfig: example.config } : {}),
          items: [
            {
              ...trip.items[0]!,
              name: "Sample groceries",
              unitPriceCents: example.amount,
            },
            ...(example.excluded
              ? [
                  {
                    ...trip.items[1]!,
                    name: "Excluded item",
                    unitPriceCents: example.excluded,
                    thresholdEligible: false,
                  },
                ]
              : []),
          ],
        });
        const payload: Record<string, unknown> = { ...basket };
        if (example.legacy) delete payload.thresholdStatus;
        const snapshot = { ...initial, revision: index + 10, basket: payload };
        await browser.evaluate(
          `window.current=${JSON.stringify(snapshot)};window.deliver(window.current)`,
        );
        const money = (amount: number) =>
          new Intl.NumberFormat("en-IE", {
            style: "currency",
            currency: basket.currency,
            minimumFractionDigits: basket.currencyFractionDigits,
            maximumFractionDigits: basket.currencyFractionDigits,
          }).format(amount / basket.currencyScale);
        const headline =
          example.highest !== null
            ? `${money(example.highest)} milestone met`
            : example.next !== null
              ? `Next milestone: ${money(example.next)}`
              : "No milestones set";
        await browser.waitFor(
          async () =>
            (await frame(
              "d.getElementById('milestone-status').textContent",
            )) === headline,
        );
        assert.equal(
          await frame("d.getElementById('items').hidden"),
          true,
          example.name,
        );
        assert.equal(
          await frame("d.querySelectorAll('#items li').length"),
          0,
          example.name,
        );
        const maximum = example.next ?? example.highest;
        assert.equal(
          await frame("d.getElementById('milestone-progress').hidden"),
          maximum === null,
          example.name,
        );
        if (maximum !== null) {
          assert.equal(
            await frame(
              "Number(d.getElementById('milestone-progress').getAttribute('aria-valuemax'))",
            ),
            maximum,
            example.name,
          );
          assert.equal(
            await frame(
              "Number(d.getElementById('milestone-progress').getAttribute('aria-valuenow'))",
            ),
            Math.min(basket.thresholdSubtotalCents, maximum),
            example.name,
          );
          assert.ok(
            Math.abs(
              (await frame(
                "parseFloat(d.getElementById('milestone-fill').style.width)",
              )) -
                Math.min(100, (basket.thresholdSubtotalCents / maximum) * 100),
            ) < 0.001,
            example.name,
          );
        }
        assert.equal(
          await frame("d.getElementById('milestone-detail').textContent"),
          example.next !== null
            ? `${money(example.next - basket.thresholdSubtotalCents)} to ${money(example.next)}`
            : example.highest !== null
              ? "All configured milestones met."
              : "Choose your targets in Thresholds & savings.",
          example.name,
        );
        assert.equal(
          await frame("d.getElementById('milestone-basis').hidden"),
          !example.excluded,
          example.name,
        );
        if (example.excluded)
          assert.match(
            await frame("d.getElementById('milestone-basis').textContent"),
            /€26\.91 eligible/,
          );
        if (
          example.name === "reported phone basket" &&
          process.env.BW_WIDGET_SCREENSHOTS === "1"
        ) {
          for (const theme of ["light", "dark"]) {
            await browser.evaluate(`window.setTheme('${theme}')`);
            await browser.waitFor(
              async () =>
                (await frame("d.documentElement.dataset.theme")) === theme,
            );
            await browser.waitFor(
              async () =>
                await frame(
                  "d.documentElement.scrollHeight <= d.defaultView.innerHeight + 1",
                ),
            );
            const bounds = await browser.evaluate(
              "document.querySelector('iframe').getBoundingClientRect().toJSON()",
            );
            const image = await browser.send("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: true,
              clip: {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                scale: 1,
              },
            });
            await writeFile(
              new URL(
                `../dist/screenshots/milestone-phone-${theme}.png`,
                import.meta.url,
              ),
              Buffer.from(image.data, "base64"),
            );
          }
        }
        // Leave the old list open: switching to a different trip must close it.
        const callsBeforeOpen = await browser.evaluate("window.calls.length");
        await frame("d.getElementById('show-items').click()");
        assert.equal(
          await frame("d.querySelectorAll('#items li').length"),
          basket.items.length,
        );
        assert.equal(
          await browser.evaluate("window.calls.length"),
          callsBeforeOpen,
        );
      }
    });
  },
);

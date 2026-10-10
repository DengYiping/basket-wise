import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromiumPath, withChromium } from "./chromium.js";
import { shoppingListHarness } from "./widget-harness.js";

test(
  "separate shopping-list widget is passive, mobile-safe, themed and uses authenticated tools",
  { skip: !chromiumPath, timeout: 30000 },
  async () => {
    const html = shoppingListHarness(
      await readFile(
        new URL("../dist/shopping-list.html", import.meta.url),
        "utf8",
      ),
    );
    await withChromium(async (browser) => {
      const unexpected: string[] = [];
      browser.on("Fetch.requestPaused", async ({ requestId, request }) => {
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
      });
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
      assert.equal(await browser.evaluate("window.calls.length"), 0);
      await browser.evaluate("window.deliver(window.list)");
      await browser.waitFor(
        async () =>
          (await frame("d.querySelectorAll('.shopping-row').length")) === 1,
      );
      assert.equal(await browser.evaluate("window.calls.length"), 0);
      for (const width of [320, 390, 768]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: true,
        });
        for (const theme of ["light", "dark"]) {
          await browser.evaluate(`window.setTheme('${theme}')`);
          await browser.waitFor(
            async () =>
              await frame(
                "d.documentElement.scrollHeight <= d.defaultView.innerHeight + 1",
              ),
          );
          assert.equal(
            await frame(
              "d.documentElement.scrollWidth <= d.defaultView.innerWidth",
            ),
            true,
          );
          await mkdir(new URL("../dist/screenshots/", import.meta.url), {
            recursive: true,
          });
          const capture = await browser.send("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(
            new URL(
              `../dist/screenshots/shopping-list-${width}-${theme}.png`,
              import.meta.url,
            ),
            Buffer.from(capture.data, "base64"),
          );
        }
      }
      await frame("d.getElementById('toggle-form').click()");
      await frame(
        "d.getElementById('name').value = '<img src=x onerror=alert(1)>'",
      );
      await frame("d.getElementById('save').click()");
      try {
        await browser.waitFor(
          async () =>
            (await frame("d.querySelectorAll('.shopping-row').length")) === 2,
        );
      } catch (error) {
        throw new Error(
          JSON.stringify({
            calls: await browser.evaluate("window.calls"),
            list: await browser.evaluate("window.list"),
            inputs: await frame(
              "Array.from(d.querySelectorAll('input')).map(x=>({id:x.id,value:x.value,valid:x.checkValidity(),validation:x.validationMessage,disabled:x.disabled}))",
            ),
            text: await frame("d.body.innerText"),
          }),
          { cause: error },
        );
      }
      assert.equal(await frame("d.querySelector('#shopping-items img')"), null);
      assert.equal(
        await browser.evaluate("window.calls[0].name"),
        "add_shopping_list_item",
      );
      await frame("d.querySelector('.shopping-row button').click()");
      await frame("d.getElementById('price').value = '1.25'");
      await frame("d.getElementById('purchase-confirm').click()");
      await browser.waitFor(
        async () =>
          (await frame("d.querySelectorAll('.shopping-row').length")) === 1,
      );
      assert.deepEqual(
        await browser.evaluate("window.calls.slice(-2).map(c=>c.name)"),
        ["get_basket", "add_item"],
      );
      assert.equal(
        await browser.evaluate(
          "window.calls.at(-1).arguments.shoppingListItemId",
        ),
        "11111111-1111-4111-8111-111111111111",
      );
      assert.deepEqual(unexpected, []);
    });
  },
);

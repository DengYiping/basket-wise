import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  authorizationPage,
  recoveryKeyPage,
  authorizationErrorPage,
} from "../src/auth-pages.js";
import { setup, ORIGIN } from "./helpers.js";
import { chromiumPath, withChromium } from "./chromium.js";

const context = { flow: 'flow\"><script>bad()</script>', csrf: 'csrf\"&<>' };
const key = "PREVIEW-ONLY." + "aB12".repeat(45);

test("guest access pages escape all dynamic values and require explicit key acknowledgement", () => {
  const consent = authorizationPage(context);
  const saved = recoveryKeyPage({
    ...context,
    recovery: '<secret>&"',
    replacing: false,
  });
  const recovery = recoveryKeyPage({
    ...context,
    recovery: key,
    replacing: true,
  });
  for (const html of [
    consent,
    saved,
    recovery,
    authorizationErrorPage("<script>bad()</script>"),
  ]) {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<main id="main">/);
    assert.match(html, /href="\/auth.css"/);
    assert.doesNotMatch(
      html,
      /<script|<style|style=|onclick=|bad\(\)<\/script>|https?:\/\/[^\s"<]*\.(woff|css|js)/,
    );
  }
  assert.match(consent, /<details class="recovery">/);
  assert.match(consent, /name="recovery"[^>]*type="password"/);
  assert.match(consent, /name="flow" value="flow&quot;&gt;&lt;script&gt;/);
  assert.match(saved, /<pre>&lt;secret&gt;&amp;&quot;<\/pre>/);
  assert.match(saved, /name="saved" value="yes" required/);
  assert.match(recovery, /Your existing key and connections still work/);
  assert.match(recovery, /Confirming below activates this replacement/);
  assert.match(consent, /90 inactive days/);
  assert.match(consent, /Recovery does not/);
  assert.doesNotMatch(saved, /Your existing key and connections still work/);
});

test("first-party auth assets work without public pages and preserve security headers and guest expiry", async () => {
  const h = await setup();
  try {
    const guest = await h.connected();
    const before = await h.record(guest.locator);
    for (const [path, type] of [
      ["/auth.css", "text/css"],
      ["/auth-icon.svg", "image/svg+xml"],
    ]) {
      const response = await h.request(path!);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(type!));
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.doesNotMatch(
        await response.text(),
        /@import|https?:\/\/[^\s"<)]*\.(woff|css|js)/,
      );
      const head = await h.request(path!, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await h.request(path!, { method: "POST" })).status, 404);
    }
    assert.deepEqual(await h.record(guest.locator), before);
    const f = await h.begin();
    const response = await h.post(
      "/authorize",
      { flow: f.flow, csrf: f.csrf, decision: "new" },
      f.cookie,
    );
    assert.match(
      response.headers.get("content-security-policy")!,
      /style-src 'self'; img-src 'self'/,
    );
    assert.doesNotMatch(
      response.headers.get("content-security-policy")!,
      /unsafe-inline|script-src/,
    );
    assert.match(
      response.headers.get("content-security-policy")!,
      /form-action 'self' https:\/\/chatgpt.com/,
    );
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.match(await response.text(), /name="saved" value="yes" required/);
    assert.doesNotMatch(
      (await h.request("/health")).headers.get("content-security-policy")!,
      /style-src/,
    );
  } finally {
    await h.close();
  }
});

test("browser OAuth errors are readable without changing JSON errors or reflecting credentials", async () => {
  const h = await setup();
  try {
    const path =
      "/authorize?state=private-not-to-be-reflected&recovery=secret-key";
    const response = await h.request(path, {
      headers: { Accept: "text/html" },
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type")!, /^text\/html/);
    const html = await response.text();
    assert.match(html, /Let’s try/);
    assert.doesNotMatch(html, /private-not-to-be-reflected|secret-key/);
    assert.match(
      response.headers.get("content-security-policy")!,
      /form-action 'self';/,
    );
    assert.doesNotMatch(
      response.headers.get("content-security-policy")!,
      /form-action[^;]*https:/,
    );
    const json = await h.request(path);
    assert.equal(json.status, 400);
    assert.deepEqual(await json.json(), { error: "invalid_request" });
    const token = await h.request("/token", {
      method: "POST",
      headers: { Accept: "text/html" },
    });
    assert.match(token.headers.get("content-type")!, /application\/json/);
  } finally {
    await h.close();
  }
});

test(
  "guest access layouts fit narrow phones and desktop with native keyboard controls",
  {
    skip: chromiumPath ? false : "Install Chromium locally or set CHROME_BIN",
    timeout: 30000,
  },
  async () => {
    const css = await readFile(
      new URL("../src/auth.css", import.meta.url),
      "utf8",
    );
    await withChromium(async (browser) => {
      let mode = "consent";
      const unexpected: string[] = [];
      browser.on("Fetch.requestPaused", async ({ requestId, request }) => {
        const url = new URL(request.url);
        if (url.origin !== ORIGIN) {
          unexpected.push(url.origin);
          await browser.send("Fetch.failRequest", {
            requestId,
            errorReason: "Aborted",
          });
          return;
        }
        const html =
          mode === "consent"
            ? authorizationPage({ flow: "sample", csrf: "sample" })
            : recoveryKeyPage({
                flow: "sample",
                csrf: "sample",
                recovery: key,
                replacing: mode === "recovery",
              });
        const text =
          url.pathname === "/auth.css"
            ? css
            : url.pathname === "/auth-icon.svg"
              ? ""
              : html;
        await browser.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            {
              name: "Content-Type",
              value:
                url.pathname === "/auth.css"
                  ? "text/css"
                  : url.pathname.endsWith(".svg")
                    ? "image/svg+xml"
                    : "text/html",
            },
            {
              name: "Content-Security-Policy",
              value:
                "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'",
            },
          ],
          body: Buffer.from(text).toString("base64"),
        });
      });
      await browser.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      for (const width of [320, 390, 768, 1280]) {
        await browser.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width < 500,
        });
        for (mode of ["consent", "saved", "recovery"]) {
          await browser.send("Page.navigate", {
            url: `${ORIGIN}/${mode}?width=${width}`,
          });
          await browser.waitFor(
            async () =>
              await browser.evaluate(
                "getComputedStyle(document.querySelector('.access-card') ?? document.documentElement).borderRadius !== '0px'",
              ),
          );
          assert.equal(
            await browser.evaluate(
              "document.documentElement.scrollWidth <= window.innerWidth",
            ),
            true,
            `${mode} overflow at ${width}`,
          );
          assert.ok(
            await browser.evaluate(
              "document.querySelector('.button').getBoundingClientRect().height >= 48",
            ),
          );
          if (mode === "consent") {
            assert.equal(
              await browser.evaluate("document.querySelector('details').open"),
              false,
            );
            await browser.evaluate("document.querySelector('summary').focus()");
            await browser.send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              text: "\r",
              unmodifiedText: "\r",
            });
            await browser.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
            });
            await browser.waitFor(
              async () =>
                await browser.evaluate(
                  "document.querySelector('details').open",
                ),
            );
            assert.equal(
              await browser.evaluate(
                "getComputedStyle(document.querySelector('[name=recovery]')).fontSize",
              ),
              "16px",
            );
            assert.equal(
              await browser.evaluate(
                "document.documentElement.scrollWidth <= window.innerWidth",
              ),
              true,
            );
          } else {
            assert.equal(
              await browser.evaluate(
                "document.querySelector('form').checkValidity()",
              ),
              false,
            );
            await browser.evaluate(
              "document.querySelector('[name=saved]').checked = true",
            );
            assert.equal(
              await browser.evaluate(
                "document.querySelector('form').checkValidity()",
              ),
              true,
            );
            assert.equal(
              await browser.evaluate(
                "document.querySelector('pre').scrollWidth <= document.querySelector('pre').clientWidth",
              ),
              true,
            );
          }
        }
      }
      assert.deepEqual(unexpected, []);
    });
  },
);

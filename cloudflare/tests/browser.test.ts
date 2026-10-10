import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, ORIGIN, CALLBACK, digest } from "./helpers.js";
import { chromiumPath, withChromium } from "./chromium.js";

test(
  "Chromium completes OAuth form redirects and blocks unregistered form destinations",
  {
    skip: chromiumPath
      ? false
      : "Install Chromium locally or set CHROME_BIN to run browser coverage",
    timeout: 30000,
  },
  async () => {
    const h = await setup();
    try {
      await withChromium(async (browser) => {
        const callbacks: URL[] = [];
        const unexpected: string[] = [];
        let originalPolicy = true;
        browser.on("Fetch.requestPaused", async ({ requestId, request }) => {
          const url = new URL(request.url);
          let response: Response;
          if (url.origin === ORIGIN) {
            response = await h.request(url.pathname + url.search, {
              method: request.method,
              headers: request.headers,
              ...(request.postData ? { body: request.postData } : {}),
              redirect: "manual",
            });
            if (originalPolicy)
              response.headers.set(
                "Content-Security-Policy",
                "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
              );
          } else if (
            url.origin === new URL(CALLBACK).origin &&
            url.pathname === new URL(CALLBACK).pathname
          ) {
            callbacks.push(url);
            assert.equal(new Headers(request.headers).has("referer"), false);
            response = new Response(
              '<!doctype html><title>Local callback interception</title><link rel="icon" href="data:,">',
              {
                headers: { "Content-Type": "text/html" },
              },
            );
          } else {
            unexpected.push(url.origin + url.pathname);
            await browser.send("Fetch.failRequest", {
              requestId,
              errorReason: "Aborted",
            });
            return;
          }
          await browser.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: response.status,
            responseHeaders: [...response.headers].map(([name, value]) => ({
              name,
              value,
            })),
            body: Buffer.from(await response.arrayBuffer()).toString("base64"),
          });
        });
        await browser.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        const begin = async () => {
          const verifier = digest(randomUUID()),
            state = randomUUID();
          const params = new URLSearchParams({
            client_id: "basket-test",
            response_type: "code",
            redirect_uri: CALLBACK,
            state,
            code_challenge: digest(verifier),
            code_challenge_method: "S256",
            resource: `${ORIGIN}/mcp`,
            scope: "basket:manage",
          });
          await browser.send("Page.navigate", {
            url: `${ORIGIN}/authorize?${params}`,
          });
          await browser.waitFor(async () =>
            Boolean(
              await browser.evaluate(
                "document.querySelector('button[value=new]')",
              ),
            ),
          );
          return { verifier, state };
        };
        const continueToCallback = async (count: number, state: string) => {
          await browser.evaluate(
            "document.querySelector('[name=saved]').checked = true; document.querySelector('form').requestSubmit()",
          );
          await browser.waitFor(async () => callbacks.length === count);
          assert.equal(callbacks[count - 1]!.searchParams.get("state"), state);
          assert.equal(callbacks[count - 1]!.searchParams.get("iss"), ORIGIN);
        };
        // Negative control: keeping the old CSP must still block the real
        // browser redirect, even though the server accepts the consent POST.
        await begin();
        await browser.evaluate(
          "document.querySelector('button[value=new]').click()",
        );
        await browser.waitFor(async () =>
          Boolean(
            await browser.evaluate("document.querySelector('[name=saved]')"),
          ),
        );
        await browser.evaluate(
          "globalThis.blockedForm = false; document.addEventListener('securitypolicyviolation', e => { if (e.effectiveDirective === 'form-action') globalThis.blockedForm = true; }); document.querySelector('[name=saved]').checked = true; document.querySelector('form').requestSubmit()",
        );
        await browser.waitFor(
          async () => await browser.evaluate("globalThis.blockedForm === true"),
        );
        assert.equal(callbacks.length, 0);
        originalPolicy = false;

        const first = await begin();
        await browser.evaluate(
          "document.querySelector('button[value=new]').click()",
        );
        await browser.waitFor(async () =>
          Boolean(
            await browser.evaluate("document.querySelector('[name=saved]')"),
          ),
        );
        const recovery: string = await browser.evaluate(
          "document.querySelector('pre').textContent",
        );
        await continueToCallback(1, first.state);
        assert.equal(
          (
            await h.exchange(
              callbacks[0]!.searchParams.get("code")!,
              first.verifier,
            )
          ).status,
          200,
        );

        const recovered = await begin();
        await browser.evaluate(
          "document.querySelector('.recovery summary').click()",
        );
        await browser.evaluate(
          `document.querySelector('[name=recovery]').value = ${JSON.stringify(recovery)}; document.querySelector('button[value=recover]').click()`,
        );
        await browser.waitFor(async () =>
          Boolean(
            await browser.evaluate("document.querySelector('[name=saved]')"),
          ),
        );
        assert.notEqual(
          await browser.evaluate("document.querySelector('pre').textContent"),
          recovery,
        );
        await continueToCallback(2, recovered.state);
        assert.equal(
          (
            await h.exchange(
              callbacks[1]!.searchParams.get("code")!,
              recovered.verifier,
            )
          ).status,
          200,
        );

        const denied = await begin();
        await browser.evaluate(
          "document.querySelector('button[value=deny]').click()",
        );
        await browser.waitFor(async () => callbacks.length === 3);
        assert.equal(callbacks[2]!.searchParams.get("state"), denied.state);
        assert.equal(callbacks[2]!.searchParams.get("error"), "access_denied");
        assert.equal(callbacks[2]!.searchParams.has("code"), false);

        await begin();
        await browser.evaluate(
          "globalThis.blockedForm = false; document.addEventListener('securitypolicyviolation', e => { if (e.effectiveDirective === 'form-action') globalThis.blockedForm = true; }); document.querySelector('form').action = 'https://unregistered.example/collect'; document.querySelector('button[value=deny]').click()",
        );
        await browser.waitFor(
          async () => await browser.evaluate("globalThis.blockedForm === true"),
        );
        assert.deepEqual(unexpected, []);
        assert.equal(callbacks.length, 3);
      });
    } finally {
      await h.close();
    }
  },
);

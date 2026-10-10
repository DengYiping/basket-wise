import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicContact,
  publicPageResponse,
  PUBLIC_PAGE_PATHS,
} from "../src/public-pages.js";
import { setup } from "./helpers.js";

const contact = "support@basket-wise.test";

test("public contact accepts an email or HTTPS form but rejects unsafe values", () => {
  assert.deepEqual(publicContact(contact), {
    href: `mailto:${contact}`,
    label: contact,
  });
  assert.deepEqual(
    publicContact("https://support.basket-wise.test/contact?service=basket"),
    {
      href: "https://support.basket-wise.test/contact?service=basket",
      label: "Open the support contact form",
    },
  );
  for (const invalid of [
    undefined,
    "",
    "https://user:pass@support.test/",
    "javascript:alert(1)",
    "http://support.test/",
    "hello\r\nBcc:evil@test.test",
    'hello@test.test\" onclick=\"evil',
    "https://support.test/#fragment",
  ])
    assert.equal(publicContact(invalid), undefined, invalid);
});

test("production pages require explicit enablement and a valid publisher contact", async () => {
  for (const options of [
    {},
    { publicPages: "false", publicContact: contact },
    { publicPages: "true" },
    { publicPages: "true", publicContact: "javascript:alert(1)" },
  ]) {
    const h = await setup(options);
    try {
      for (const path of [
        "/support",
        "/privacy",
        "/terms",
        "/site.css",
        "/site-icon.svg",
      ])
        assert.equal((await h.request(path)).status, 404, path);
      assert.doesNotMatch(
        await (await h.request("/")).text(),
        /Public contact awaiting|Local preview/,
      );
    } finally {
      await h.close();
    }
  }
});

test("public pages are accessible, linked, self-contained, and do not touch guest retention", async () => {
  const h = await setup({ publicPages: "true", publicContact: contact });
  try {
    const guest = await h.connected();
    const before = await h.record(guest.locator);
    for (const path of PUBLIC_PAGE_PATHS) {
      const response = await h.request(path, {
        headers: { Authorization: `Bearer ${guest.tokens.access_token}` },
      });
      assert.equal(response.status, 200, path);
      assert.equal(
        response.headers.get("content-type"),
        "text/html;charset=utf-8",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(
        response.headers.get("content-security-policy")!,
        /style-src 'self'/,
      );
      const html = await response.text();
      assert.match(html, /<html lang="en">/);
      assert.match(html, /<main id="main"/);
      assert.match(html, /Yiping Deng/);
      assert.match(html, /24(?: inactive hours| hours|-hour)/);
      assert.doesNotMatch(
        html,
        /<script|<form|Local preview|awaiting publisher|v1\.(access|recovery|refresh)/,
      );
      assert.doesNotMatch(
        html,
        /confirmed packaging dates|use-by|best-before|saving a date|packaging dates you confirm/,
      );
      for (const route of ["/support", "/privacy", "/terms"])
        assert.ok(html.includes(`href="${route}"`));
      if (path !== "/") assert.ok(html.includes(`href="mailto:${contact}"`));
      const head = await h.request(path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await h.request(path, { method: "POST" })).status, 404);
    }
    assert.deepEqual(await h.record(guest.locator), before);
    const css = await h.request("/site.css");
    assert.equal(css.headers.get("content-type"), "text/css;charset=utf-8");
    assert.match(await css.text(), /@media\(max-width:750px\)/);
    const icon = await h.request("/site-icon.svg");
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.doesNotMatch(await icon.text(), /script|foreignObject|href=/);
    for (const path of ["/privacy/", "/site.css/extra", "/public-pages.ts"])
      assert.equal((await h.request(path)).status, 404, path);
    assert.equal(
      (
        await h.request("/privacy", {
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    const query = await (
      await h.request("/privacy?contact=%3Cscript%3Eevil%3C/script%3E")
    ).text();
    assert.doesNotMatch(query, /<script>|evil/);
    const privacy = await (await h.request("/privacy")).text();
    assert.match(privacy, /provider backup or operational record/);
    assert.match(privacy, /ChatGPT history is not erased/);
    assert.match(privacy, /does not receive or store photographs/);
    const oauth = await h.begin();
    assert.ok(oauth.flow);
    // Enabling public styling must not weaken non-site responses' CSP.
    const response = await h.request("/health");
    assert.doesNotMatch(
      response.headers.get("content-security-policy")!,
      /style-src/,
    );
  } finally {
    await h.close();
  }
});

test("local preview is visibly unpublished and can never supply production contact data", async () => {
  for (const path of PUBLIC_PAGE_PATHS) {
    const response = publicPageResponse(
      new Request(`http://127.0.0.1${path}`),
      undefined,
      true,
    )!;
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    const html = await response.text();
    assert.match(html, /Local preview — not published/);
    if (path !== "/")
      assert.match(html, /Public contact awaiting publisher confirmation/);
    assert.doesNotMatch(html, /href="mailto:/);
    assert.equal(
      publicPageResponse(new Request(`https://basket.test${path}`)),
      undefined,
    );
  }
});

test("public contact is escaped without URL or HTML injection", async () => {
  const response = publicPageResponse(
    new Request("https://basket.test/support"),
    "https://support.test/form?service=basket&topic=privacy",
  )!;
  const html = await response.text();
  assert.ok(
    html.includes(
      'href="https://support.test/form?service=basket&amp;topic=privacy"',
    ),
  );
  assert.doesNotMatch(html, /href="javascript:/);
});

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [plugin, pkg, lock, mcp, skill, html, serverSource, appSource] =
  await Promise.all([
    readJson("plugin.json"),
    readJson("package.json"),
    readJson("package-lock.json"),
    readJson("mcp.json"),
    readFile("skills/shopping-tracker/SKILL.md", "utf8"),
    readFile("dist/web/index.html", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("web/app.ts", "utf8"),
  ]);
assert.equal(plugin.name, pkg.name);
assert.equal(plugin.version, pkg.version);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.ok(serverSource.includes(`version: "${pkg.version}"`));
assert.ok(appSource.includes(`version: "${pkg.version}"`));
const guestSource = await readFile("src/guest-server.ts", "utf8");
assert.ok(guestSource.includes(`version: "${pkg.version}"`));
const guestHtml = await readFile("dist/guest/index.html", "utf8");
assert.ok(guestHtml.includes('name="basket-wise-mode" content="guest"'));
assert.ok(!guestHtml.includes('src="./app.ts"'));
assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.ok(
  plugin.extensions["com.openai"].interface.shortDescription.length <= 30,
);
const listing = plugin.extensions["com.openai"].interface;
assert.ok(listing.displayName.length <= 30);
assert.ok(listing.longDescription.length <= 4000);
assert.ok(listing.developerName.length <= 80);
const prompts = Array.isArray(listing.defaultPrompt)
  ? listing.defaultPrompt
  : [listing.defaultPrompt];
assert.ok(prompts.length > 0 && prompts.length <= 3);
for (const prompt of prompts) {
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.trim().length > 0 && prompt.length <= 128);
  assert.ok(!/[\r\n@]/.test(prompt));
}
assert.equal(
  new Set(prompts.map((p) => p.trim().replace(/\s+/g, " "))).size,
  prompts.length,
);
const cases = plugin.extensions["com.openai"].review.test_cases;
assert.equal(cases.positive.length, 5);
assert.equal(cases.negative.length, 3);
for (const test of cases.positive) {
  for (const key of [
    "description",
    "prompt",
    "tools_triggered",
    "expected_behavior",
  ])
    assert.ok(typeof test[key] === "string" && test[key].trim());
}
for (const test of cases.negative) {
  for (const key of ["description", "prompt"])
    assert.ok(typeof test[key] === "string" && test[key].trim());
}
assert.deepEqual(plugin.extensions["com.openai"].publication.countries, []);
assert.equal(mcp.mcpServers[plugin.name].type, "stdio");
assert.deepEqual(mcp.mcpServers[plugin.name].args, [
  "${PLUGIN_ROOT}/dist/main.js",
  "--stdio",
]);
await access("dist/main.js");
assert.match(skill, /^---\nname: shopping-tracker\ndescription: .+\n---/);
assert.ok(
  html.includes("Basket Wise") && html.includes('<script type="module">'),
);
assert.ok(
  !html.includes('src="./app.ts"') && !html.includes('href="./style.css"'),
);
console.log(
  "Plugin identity, stdio entrypoint, skill and self-contained UI validated.",
);

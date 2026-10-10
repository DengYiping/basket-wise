import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [plugin, pkg, mcp, skill, html] = await Promise.all([
  readJson("plugin.json"),
  readJson("package.json"),
  readJson("mcp.json"),
  readFile("skills/shopping-tracker/SKILL.md", "utf8"),
  readFile("dist/web/index.html", "utf8"),
]);
assert.equal(plugin.name, pkg.name);
assert.equal(plugin.version, pkg.version);
assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.ok(
  plugin.extensions["com.openai"].interface.shortDescription.length <= 30,
);
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

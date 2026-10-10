import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = dirname(fileURLToPath(import.meta.url));
const root = join(base, "basket-wise-durable");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const localManifest = join(root, "plugin.json");
const usingTemplate =
  process.argv.includes("--template") || !existsSync(localManifest);
const plugin = await readJson(
  usingTemplate ? join(base, "plugin.example.json") : localManifest,
);
const pkg = await readJson(join(base, "..", "package.json"));
const mcp = await readJson(join(root, "mcp.json"));
const extension = plugin.extensions["com.openai"];
assert.equal(plugin.name, "basket-wise-durable");
assert.equal(plugin.version, pkg.version);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.equal(plugin.apps, undefined);
assert.equal(extension.apps, undefined);
assert.deepEqual(mcp.mcpServers, {
  "basket-wise-durable": {
    type: "streamable-http",
    url: "https://basketwise.loudcoder.com/mcp",
    extensions: {
      "com.openai": {
        auth: {
          type: "oauth",
          client: {
            mode: "dcr",
          },
          authorizationUrl: "https://basketwise.loudcoder.com/authorize",
          tokenUrl: "https://basketwise.loudcoder.com/token",
          registrationUrl: "https://basketwise.loudcoder.com/register",
          resource: "https://basketwise.loudcoder.com/mcp",
          baseScopes: ["basket:manage"],
        },
      },
    },
  },
});
const listing = extension.interface;
assert.equal(listing.displayName, "Basket Wise");
assert.equal(listing.logo, "./assets/icon.png");
assert.equal(listing.composerIcon, "./assets/icon.png");
for (const [key, path] of Object.entries({
  websiteURL: "/",
  supportURL: "/support",
  privacyPolicyURL: "/privacy",
  termsOfServiceURL: "/terms",
})) {
  assert.equal(listing[key], `https://basketwise.loudcoder.com${path}`);
  assert.ok(listing[key].length <= 1024);
}
for (const [key, limit] of Object.entries({
  displayName: 30,
  shortDescription: 30,
  longDescription: 4000,
  developerName: 80,
})) {
  assert.ok(
    listing[key].trim().length > 0 && listing[key].length <= limit,
    key,
  );
}
assert.ok(
  listing.defaultPrompt.length > 0 && listing.defaultPrompt.length <= 3,
);
assert.equal(new Set(listing.defaultPrompt).size, listing.defaultPrompt.length);
for (const prompt of listing.defaultPrompt)
  assert.ok(prompt.length <= 128 && !/[\r\n@]/.test(prompt));
if (extension.review.demo_recording_url) {
  const demoUrl = new URL(extension.review.demo_recording_url);
  assert.equal(demoUrl.protocol, "https:", "walkthrough uses HTTPS");
  assert.equal(demoUrl.username, "", "walkthrough URL contains no username");
  assert.equal(demoUrl.password, "", "walkthrough URL contains no password");
  assert.ok(
    extension.review.demo_recording_url.length <= 1024,
    "walkthrough URL <= 1024 characters",
  );
} else {
  assert.ok(usingTemplate, "private submission requires a walkthrough URL");
}
assert.equal(extension.review.test_cases.positive.length, 5);
assert.equal(extension.review.test_cases.negative.length, 3);
for (const test of extension.review.test_cases.positive) {
  for (const key of [
    "description",
    "prompt",
    "tools_triggered",
    "expected_behavior",
  ])
    assert.ok(test[key].trim());
  assert.ok(
    test.tools_triggered
      .split(/,\s*/)
      .every((name) =>
        [
          "open_basket",
          "get_profile",
          "clear_baskets",
          "suggest_removals",
          "get_basket",
          "get_shopping_list",
          "list_trips",

          "start_trip",
          "add_item",
          "update_item",
          "remove_item",
          "set_thresholds",

          "checkout_trip",

          "delete_guest",
        ].includes(name),
      ),
  );
}
for (const test of extension.review.test_cases.negative) {
  for (const key of ["description", "prompt"]) assert.ok(test[key].trim());
}
const expected = [
  "assets/icon.png",
  "mcp.json",
  ...(usingTemplate ? [] : ["plugin.json"]),
  "skills/guest-baskets/SKILL.md",
];
const found = [];
async function inspect(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "no symlinks");
    const path = prefix + entry.name;
    if (usingTemplate && path === "plugin.json") continue;
    if (entry.isDirectory()) await inspect(join(dir, entry.name), path + "/");
    else {
      found.push(path);
      const bytes = await readFile(join(dir, entry.name));
      if (path === "assets/icon.png") {
        assert.ok(bytes.length <= 5 * 1024 * 1024, "icon <= 5 MiB");
        assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        assert.ok(
          width >= 256 && width <= 4096 && height === width,
          "square icon",
        );
        continue;
      }
      const text = bytes.toString("utf8");
      assert.ok(
        !/v1\.(?:recovery|access|refresh|code)\.[a-f0-9]{32}\./.test(text),
        "no guest credentials",
      );
      assert.ok(
        !/-----BEGIN .*PRIVATE KEY-----|sk-proj-|CLIENT_SECRET\s*[=:]|ROOT_KEY\s*[=:]/.test(
          text,
        ),
        "no secrets",
      );
    }
  }
}
await inspect(root);
assert.deepEqual(found.sort(), expected.sort());
const skill = await readFile(
  join(root, "skills/guest-baskets/SKILL.md"),
  "utf8",
);
assert.match(skill, /^---\nname: guest-baskets\ndescription: .+\n---/);
assert.doesNotMatch(
  JSON.stringify(plugin) + skill,
  /set_item_expiry|list_expiring_items|mark_item_consumed/,
);
console.log(
  usingTemplate
    ? `Validated public template ${plugin.name} v${plugin.version}: ${found.length} asset files. Configure a private manifest and review materials before uploading.`
    : `Validated ${plugin.name} v${plugin.version}: ${found.length} upload files, remote MCP, no packaged credentials.`,
);

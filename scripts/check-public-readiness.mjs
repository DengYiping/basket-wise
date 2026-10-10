import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [plugin, mcp] = await Promise.all([
  readJson("plugin.json"),
  readJson("mcp.json"),
]);
const extension = plugin.extensions["com.openai"];
const listing = extension.interface;
const gaps = [];

function isHttps(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !/^(localhost|127\.|\[::1\])/.test(url.hostname) &&
      !/(^|\.)(example\.(com|org|net)|invalid|test)$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

const servers = Object.values(mcp.mcpServers ?? {});
if (servers.length !== 1 || !isHttps(servers[0]?.url)) {
  gaps.push(
    "A deployed HTTPS guest MCP endpoint (current config is local stdio). Guest tools use noauth and must never expose the private SQLite server.",
  );
}
for (const field of [
  "websiteURL",
  "supportURL",
  "privacyPolicyURL",
  "termsOfServiceURL",
]) {
  if (!isHttps(listing[field])) gaps.push(`A real public HTTPS ${field}.`);
}
for (const field of ["logo", "composerIcon"]) {
  if (typeof listing[field] !== "string")
    gaps.push(`A verified PNG ${field} asset.`);
}
if (!isHttps(extension.review?.demo_recording_url)) {
  gaps.push(
    "A reviewer-accessible, verified recording of real ChatGPT interactions.",
  );
}
if (
  extension.review?.commerce === undefined ||
  !extension.review?.commerce_description
) {
  gaps.push("The portal's free-tracking/no-commerce declaration.");
}

console.log(
  "Public-release static preflight (not an authentication or review certification):",
);
for (const gap of gaps) console.log(`- Missing: ${gap}`);
console.log(
  "Manual gates: verify no-sign-in guest flow, independent widget snapshots, no server basket persistence, and honest recovery warnings; confirm publisher identity; run all review cases and phone checks; verify URL content, policy decisions, assets, reviewer access, and platform review.",
);
if (gaps.length) {
  console.error(
    "Not ready to package or submit. No upload or publication was attempted.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "Static fields are present. Complete the manual gates in submission/README.md before packaging.",
  );
}

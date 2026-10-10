import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Exclusive create: never rotate a live root key or overwrite client credentials.
const path = fileURLToPath(
  new URL(".secrets.production.json", import.meta.url),
);
const file = await open(path, "wx", 0o600);
try {
  await file.writeFile(
    `${JSON.stringify(
      {
        CLIENT_SECRET: randomBytes(32).toString("base64url"),
        ROOT_KEY: randomBytes(32).toString("base64url"),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await file.close();
}
console.log(
  "Created owner-readable production secret file; values not printed.",
);

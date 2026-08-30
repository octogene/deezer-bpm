import { readFile, writeFile } from "node:fs/promises";

const endpoint = process.argv[2];
if (!endpoint) {
  throw new Error("Usage: npm run configure:sync-endpoint -- <endpoint>");
}

const url = new URL(endpoint);
if (
  url.protocol !== "https:" ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) {
  throw new Error("The sync endpoint must be an HTTPS origin without a path");
}

const syncEndpoint = url.origin;
const backgroundPath = "background.js";
const endpointPattern = /const SYNC_ENDPOINT = "([^"]+)";/;
const background = await readFile(backgroundPath, "utf8");
const endpointMatch = background.match(endpointPattern);

if (!endpointMatch) {
  throw new Error("SYNC_ENDPOINT declaration was not found in background.js");
}

const previousEndpoint = endpointMatch[1];
await writeFile(
  backgroundPath,
  background.replace(
    endpointPattern,
    `const SYNC_ENDPOINT = "${syncEndpoint}";`,
  ),
);

const manifestPath = "manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const hostPermission = `${syncEndpoint}/*`;

manifest.host_permissions = manifest.host_permissions.filter(
  (permission) => permission !== `${previousEndpoint}/*`,
);
if (!manifest.host_permissions.includes(hostPermission)) {
  manifest.host_permissions.push(hostPermission);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

import { readFile, writeFile } from "node:fs/promises";

// Firefox has no MV3 service_worker support at all, so manifest.json in the
// repo (used for local `about:debugging` loading and the AMO/Firefox build)
// declares `background.scripts`. Chrome's MV3 validator rejects that key
// outright ("'background.scripts' requires manifest version of 2 or
// lower"), so the release workflow runs this -- against a checkout meant
// only for the Chrome Web Store build, right before packaging it -- to swap
// in the service_worker shape Chrome needs. It never runs against, or is
// committed back into, the repo's own manifest.json.
const manifestPath = "manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const script = manifest.background?.scripts?.[0];
if (!script) {
  throw new Error("expected background.scripts in manifest.json");
}

manifest.background = { service_worker: script };

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

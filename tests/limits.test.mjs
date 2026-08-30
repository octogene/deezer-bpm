// Verifies the edge rate limiters using the real wrangler.toml values, so the
// production thresholds themselves are under test rather than a relaxed copy.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_DIR = fileURLToPath(new URL("../worker", import.meta.url));
const WRANGLER = fileURLToPath(
  new URL("../node_modules/.bin/wrangler", import.meta.url),
);
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** Reads a `[ratelimits.simple] limit` value out of wrangler.toml by binding name. */
function configuredLimit(binding) {
  const toml = readFileSync(`${WORKER_DIR}/wrangler.toml`, "utf8");
  const section = toml.split(`name = "${binding}"`)[1];
  assert.ok(section, `${binding} is not configured in wrangler.toml`);
  const match = section.match(/limit\s*=\s*(\d+)/);
  assert.ok(match, `${binding} has no simple.limit`);
  return Number(match[1]);
}

let server;

before(async () => {
  await rm(`${WORKER_DIR}/.wrangler/state`, { recursive: true, force: true });
  await run(WRANGLER, ["d1", "migrations", "apply", "DB", "--local"]);
  server = spawn(WRANGLER, ["dev", "--local", "--port", String(PORT)], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler exited early with code ${server.exitCode}`);
    }
    try {
      if ((await fetch(`${BASE}/activate`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("wrangler dev did not become ready in time");
});

after(() => {
  server?.kill("SIGTERM");
});

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: WORKER_DIR, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

test("space creation is throttled at the configured per-IP limit", async () => {
  const limit = configuredLimit("CREATE_RATE_LIMITER");
  const statuses = [];

  for (let attempt = 0; attempt < limit + 3; attempt++) {
    const response = await fetch(`${BASE}/spaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken: TURNSTILE_TOKEN }),
    });
    statuses.push(response.status);
    if (response.status !== 429) continue;

    const body = await response.json();
    assert.equal(body.code, "rate_limited");
    assert.equal(
      response.headers.get("retry-after"),
      "60",
      "a 429 must tell the client how long to wait",
    );
    assert.equal(
      response.headers.get("access-control-expose-headers"),
      "Retry-After",
      "Retry-After must be readable by a CORS caller",
    );
    return;
  }

  assert.fail(
    `creation was never throttled past ${limit} attempts: ${statuses.join(",")}`,
  );
});

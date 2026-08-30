// Integration tests for the two guards that protect the whole account rather
// than a single request: the Durable Object daily budget and the scheduled
// cleanup of expired spaces.
//
// Both only trigger at thresholds no test could reach with the production
// numbers, so this boots its own Wrangler instance with `--var` overrides on top
// of wrangler.test.toml. Run with `npm run test:worker`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_DIR = fileURLToPath(new URL("../worker", import.meta.url));
const WRANGLER = fileURLToPath(
  new URL("../node_modules/.bin/wrangler", import.meta.url),
);
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const CONFIG = "wrangler.test.toml";
const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const SECONDS_PER_DAY = 86_400;

// Small enough to hit in a test, and each one is asserted against below rather
// than assumed, so a change here cannot silently weaken the test.
const CREATION_BUDGET = 2;
const CLEANUP_BATCH_SIZE = 2;
const EMPTY_RETENTION_DAYS = 1;
const INACTIVE_RETENTION_DAYS = 30;

// Spaces seeded straight into D1, because the API has no way to backdate a row
// and age is exactly what the cleanup query selects on. `deletedInRound` is the
// scheduled run that must remove the row; null means it must survive all of
// them. Rows are deleted oldest-active-first, so these ages also fix the order
// in which the batches take them.
const SEEDED = [
  {
    label: "empty for 100 days",
    code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAA2",
    tracks: 0,
    createdDaysAgo: 100,
    idleDaysAgo: 100,
    deletedInRound: 1,
  },
  {
    label: "empty for 90 days",
    code: "BBBBB-BBBBB-BBBBB-BBBBB-BBBB2",
    tracks: 0,
    createdDaysAgo: 90,
    idleDaysAgo: 90,
    deletedInRound: 1,
  },
  {
    label: "empty for 80 days",
    code: "CCCCC-CCCCC-CCCCC-CCCCC-CCCC2",
    tracks: 0,
    createdDaysAgo: 80,
    idleDaysAgo: 80,
    deletedInRound: 2,
  },
  {
    label: "populated but idle for 60 days",
    code: "DDDDD-DDDDD-DDDDD-DDDDD-DDDD2",
    tracks: 2,
    createdDaysAgo: 200,
    idleDaysAgo: 60,
    deletedInRound: 2,
  },
  {
    label: "empty but created today",
    code: "EEEEE-EEEEE-EEEEE-EEEEE-EEEE2",
    tracks: 0,
    createdDaysAgo: 0,
    idleDaysAgo: 0,
    deletedInRound: null,
  },
  {
    label: "populated and active",
    code: "FFFFF-FFFFF-FFFFF-FFFFF-FFFF2",
    tracks: 2,
    createdDaysAgo: 200,
    idleDaysAgo: 0,
    deletedInRound: null,
  },
];

const CLEANUP_ROUNDS = 3;

let server;

function syncHash(code) {
  return createHash("sha256").update(code).digest("hex");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORKER_DIR,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}

/** Runs SQL against the same local D1 file the Worker is using. */
async function d1(sql) {
  const output = await run(
    WRANGLER,
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      CONFIG,
      "--json",
      "--command",
      sql,
    ],
    { capture: true },
  );
  // Wrangler prefixes its JSON with human-readable banners.
  const json = output.slice(output.indexOf("["));
  return JSON.parse(json)[0].results;
}

function seedStatements() {
  const statements = [];

  for (const space of SEEDED) {
    const hash = syncHash(space.code);
    const revision = space.tracks > 0 ? 1 : 0;
    statements.push(
      `INSERT INTO sync_spaces
         (sync_hash, revision, created_at, last_active_at, track_count, active)
       VALUES (
         '${hash}',
         ${revision},
         unixepoch() - ${space.createdDaysAgo * SECONDS_PER_DAY},
         unixepoch() - ${space.idleDaysAgo * SECONDS_PER_DAY},
         ${space.tracks},
         1
       )`,
    );

    for (let index = 0; index < space.tracks; index++) {
      statements.push(
        `INSERT INTO overrides (sync_hash, track_id, bpm, deleted, revision)
         VALUES ('${hash}', '${100 + index}', ${120 + index}, 0, 1)`,
      );
    }
  }

  return statements.join(";\n");
}

async function waitForReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;

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
}

function createSpace() {
  return fetch(`${BASE}/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken: TURNSTILE_TOKEN }),
  });
}

/** Probes a space with a read-only sync, which never writes last_active_at. */
async function spaceExists(code) {
  const response = await fetch(`${BASE}/sync`, {
    method: "POST",
    headers: { "X-Sync-Code": code, "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, force: false, changes: [] }),
  });
  const body = await response.json();

  if (response.status === 404) {
    assert.equal(body.code, "sync_space_not_found");
    return false;
  }

  assert.equal(response.status, 200, `unexpected status: ${body.error}`);
  return true;
}

/**
 * Triggers the cron handler and waits for it to land. The scheduled response
 * returns before the handler finishes, so poll rather than sleep.
 */
async function runCleanup(expectedRemaining) {
  const response = await fetch(`${BASE}/__scheduled?cron=17+3+*+*+*`);
  assert.equal(response.status, 200, "scheduled trigger failed");

  const hashes = SEEDED.map((space) => `'${syncHash(space.code)}'`).join(",");
  const deadline = Date.now() + 20_000;
  let remaining = -1;

  while (Date.now() < deadline) {
    const rows = await d1(
      `SELECT COUNT(*) AS n FROM sync_spaces WHERE sync_hash IN (${hashes})`,
    );
    remaining = rows[0].n;
    if (remaining === expectedRemaining) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.fail(
    `cleanup left ${remaining} seeded spaces, expected ${expectedRemaining}`,
  );
}

before(async () => {
  await rm(`${WORKER_DIR}/.wrangler/state`, { recursive: true, force: true });
  await run(WRANGLER, [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    CONFIG,
  ]);
  await d1(seedStatements());

  server = spawn(
    WRANGLER,
    [
      "dev",
      "--local",
      "--port",
      String(PORT),
      "--config",
      CONFIG,
      // Exposes /__scheduled so the cron handler can be driven from a test.
      "--test-scheduled",
      "--var",
      `DAILY_CREATION_BUDGET:${CREATION_BUDGET}`,
      "--var",
      `CLEANUP_BATCH_SIZE:${CLEANUP_BATCH_SIZE}`,
      "--var",
      `EMPTY_SPACE_RETENTION_DAYS:${EMPTY_RETENTION_DAYS}`,
      "--var",
      `INACTIVE_SPACE_RETENTION_DAYS:${INACTIVE_RETENTION_DAYS}`,
    ],
    { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  await waitForReady();
});

after(() => {
  server?.kill("SIGTERM");
});

describe("daily safety budget", () => {
  test("space creation stops once the daily budget is spent", async () => {
    for (let attempt = 1; attempt <= CREATION_BUDGET; attempt++) {
      const response = await createSpace();
      assert.equal(
        response.status,
        200,
        `creation ${attempt} of ${CREATION_BUDGET} should be admitted`,
      );
      await response.json();
    }

    const blocked = await createSpace();
    const body = await blocked.json();
    assert.equal(blocked.status, 503, "the budget must refuse, not throttle");
    assert.equal(body.code, "safety_budget_exhausted");

    // The counters only reset at UTC midnight, so the hint must point there
    // rather than at the 60s the rate limiters use.
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(
      retryAfter > 0 && retryAfter <= SECONDS_PER_DAY,
      `Retry-After must be within a day, got ${retryAfter}`,
    );
  });

  test("the budget refuses without consuming D1", async () => {
    const countBefore = await d1("SELECT COUNT(*) AS n FROM sync_spaces");
    await createSpace();
    const countAfter = await d1("SELECT COUNT(*) AS n FROM sync_spaces");

    assert.equal(
      countAfter[0].n,
      countBefore[0].n,
      "a refused creation must not insert a space",
    );
  });
});

describe("expired space cleanup", () => {
  test("deletes only expired spaces, in bounded batches", async () => {
    for (const space of SEEDED) {
      assert.ok(await spaceExists(space.code), `${space.label} was not seeded`);
    }

    let expired = 0;

    for (let round = 1; round <= CLEANUP_ROUNDS; round++) {
      const thisRound = SEEDED.filter(
        (space) => space.deletedInRound === round,
      ).length;
      assert.ok(
        thisRound <= CLEANUP_BATCH_SIZE,
        "the fixture expects more deletions in one round than the batch allows",
      );
      expired += thisRound;

      await runCleanup(SEEDED.length - expired);

      for (const space of SEEDED) {
        const gone =
          space.deletedInRound !== null && space.deletedInRound <= round;
        assert.equal(
          await spaceExists(space.code),
          !gone,
          `${space.label} after round ${round}`,
        );
      }
    }
  });

  test("deleting a space cascades to its overrides", async () => {
    const deleted = SEEDED.find(
      (space) => space.deletedInRound !== null && space.tracks > 0,
    );
    const rows = await d1(
      `SELECT COUNT(*) AS n FROM overrides WHERE sync_hash = '${syncHash(deleted.code)}'`,
    );

    assert.equal(rows[0].n, 0, "the space's overrides must be removed with it");
  });
});

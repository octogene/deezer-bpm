// Integration tests for the sync Worker against a local Wrangler/D1 instance.
//
// Boots `wrangler dev --local` once with tightened limits so pagination and the
// per-space row cap are reachable with a handful of rows, then drives the real
// HTTP protocol end to end. Run with `npm run test:worker`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_DIR = fileURLToPath(new URL("../worker", import.meta.url));
const WRANGLER = fileURLToPath(
  new URL("../node_modules/.bin/wrangler", import.meta.url),
);
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const CONFIG = "wrangler.test.toml";

// Must match the MAX_DELTA_ROWS / MAX_TRACKS_PER_SPACE vars in wrangler.test.toml.
const PAGE_SIZE = 2;
const MAX_CHANGES = 10;

// Cloudflare's documented always-passing Turnstile test token.
const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let server;

async function waitForReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler exited early with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE}/activate`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("wrangler dev did not become ready in time");
}

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

async function createSpace() {
  const response = await fetch(`${BASE}/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken: TURNSTILE_TOKEN }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `space creation failed: ${body.error}`);
  assert.match(
    body.code,
    /^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/,
    "code must be five dash-separated groups from the reduced alphabet",
  );
  return body.code;
}

async function sync(code, payload) {
  const response = await fetch(`${BASE}/sync`, {
    method: "POST",
    headers: { "X-Sync-Code": code, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

/** Follows nextCursor to completion, as the extension does. */
async function syncAll(code, payload) {
  const first = await sync(code, payload);
  assert.equal(first.status, 200, `sync failed: ${first.body.error}`);
  const changes = [...first.body.changes];
  let pages = 1;
  let cursor = first.body.nextCursor;

  while (cursor) {
    const next = await sync(code, {
      baseRevision: payload.baseRevision,
      force: false,
      changes: [],
      cursor,
      throughRevision: first.body.throughRevision,
    });
    assert.equal(next.status, 200, `page failed: ${next.body.error}`);
    assert.equal(
      next.body.throughRevision,
      first.body.throughRevision,
      "throughRevision must stay pinned across pages",
    );
    changes.push(...next.body.changes);
    cursor = next.body.nextCursor;
    pages += 1;
    assert.ok(pages < 50, "pagination did not terminate");
  }

  return { revision: first.body.throughRevision, changes, pages, first };
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

  server = spawn(
    WRANGLER,
    ["dev", "--local", "--port", String(PORT), "--config", CONFIG],
    { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  await waitForReady();
});

after(() => {
  server?.kill("SIGTERM");
});

describe("space creation", () => {
  test("rejects a missing or malformed challenge token", async () => {
    for (const body of [{}, { turnstileToken: "" }]) {
      const response = await fetch(`${BASE}/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.ok(response.status >= 400, "empty token must be refused");
    }
  });

  test("returns distinct codes", async () => {
    const [a, b] = [await createSpace(), await createSpace()];
    assert.notEqual(a, b);
  });

  test("serves the activation page", async () => {
    const response = await fetch(`${BASE}/activate`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /cf-turnstile/);
    // The generated code must never be injected as HTML.
    assert.doesNotMatch(html, /innerHTML\s*=\s*"[^"]*data\.code/);
  });
});

describe("sync protocol", () => {
  test("an unknown but well-formed code is never created implicitly", async () => {
    const result = await sync("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", {
      baseRevision: 0,
      force: false,
      changes: [],
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, "sync_space_not_found");
  });

  test("rejects an invalid sync code before touching D1", async () => {
    const result = await sync("short", { baseRevision: 0, changes: [] });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_sync_code");
  });

  test("round-trips changes and tombstones", async () => {
    const code = await createSpace();

    const first = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [
        { trackId: "111", bpm: 128 },
        { trackId: "222", bpm: 90 },
      ],
    });
    assert.equal(first.revision, 1);
    assert.deepEqual(first.changes.map((c) => [c.trackId, c.bpm]).sort(), [
      ["111", 128],
      ["222", 90],
    ]);

    // A second client starting from scratch sees the same state.
    const fresh = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });
    assert.equal(fresh.revision, 1);
    assert.equal(fresh.changes.length, 2);

    // Deleting propagates as a null tombstone.
    const deleted = await syncAll(code, {
      baseRevision: 1,
      force: false,
      changes: [{ trackId: "222", bpm: null }],
    });
    assert.equal(deleted.revision, 2);
    assert.deepEqual(deleted.changes, [
      { trackId: "222", bpm: null, revision: 2 },
    ]);
  });

  test("a no-op change set does not advance the revision", async () => {
    const code = await createSpace();
    const first = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [{ trackId: "111", bpm: 128 }],
    });
    assert.equal(first.revision, 1);

    const repeat = await syncAll(code, {
      baseRevision: 1,
      force: false,
      changes: [{ trackId: "111", bpm: 128 }],
    });
    assert.equal(repeat.revision, 1, "resubmitting the same value is a no-op");
    assert.equal(repeat.changes.length, 0);

    const empty = await syncAll(code, {
      baseRevision: 1,
      force: false,
      changes: [],
    });
    assert.equal(empty.revision, 1, "polling must not advance the revision");
  });

  test("a conflicting write is refused without force and applied with it", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [{ trackId: "111", bpm: 128 }],
    });

    // Stale client at revision 0 tries to overwrite.
    const stale = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [{ trackId: "111", bpm: 99 }],
    });
    assert.deepEqual(
      stale.changes,
      [{ trackId: "111", bpm: 128, revision: 1 }],
      "the server value must win and be reported back",
    );

    const forced = await syncAll(code, {
      baseRevision: 0,
      force: true,
      changes: [{ trackId: "111", bpm: 99 }],
    });
    assert.equal(forced.changes.find((c) => c.trackId === "111").bpm, 99);
  });

  test("paginates a delta against a pinned revision", async () => {
    const code = await createSpace();
    const changes = ["11", "22", "33", "44"].map((trackId, index) => ({
      trackId,
      bpm: 100 + index,
    }));
    await syncAll(code, { baseRevision: 0, force: false, changes });

    const full = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });
    assert.equal(full.changes.length, 4);
    assert.ok(
      full.pages > 1,
      `expected multiple pages with page size ${PAGE_SIZE}, got ${full.pages}`,
    );
    assert.deepEqual(
      full.changes.map((c) => c.trackId),
      ["11", "22", "33", "44"],
      "pages must arrive ordered by (revision, track_id) with no gaps or repeats",
    );
    assert.equal(full.first.body.changes.length, PAGE_SIZE);
    assert.ok(full.first.body.nextCursor, "first page must carry a cursor");
  });

  test("a write during pagination is deferred to the next sync", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [
        { trackId: "11", bpm: 100 },
        { trackId: "22", bpm: 101 },
        { trackId: "33", bpm: 102 },
      ],
    });

    const first = await sync(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });
    assert.ok(first.body.nextCursor);
    const pinned = first.body.throughRevision;

    // Another browser writes while we are mid-pagination.
    await sync(code, {
      baseRevision: pinned,
      force: false,
      changes: [{ trackId: "44", bpm: 103 }],
    });

    const page2 = await sync(code, {
      baseRevision: 0,
      force: false,
      changes: [],
      cursor: first.body.nextCursor,
      throughRevision: pinned,
    });
    assert.equal(page2.status, 200);
    assert.equal(
      page2.body.throughRevision,
      pinned,
      "the snapshot must not move under the client",
    );
    assert.ok(
      !page2.body.changes.some((c) => c.trackId === "44"),
      "a change after throughRevision must not appear in this snapshot",
    );

    // It shows up on the next sync from the pinned revision.
    const next = await syncAll(code, {
      baseRevision: pinned,
      force: false,
      changes: [],
    });
    assert.deepEqual(
      next.changes.map((c) => c.trackId),
      ["44"],
    );
  });

  test("rejects malformed, oversized and mismatched cursors", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [{ trackId: "11", bpm: 100 }],
    });

    const cases = [
      { cursor: "!!!not-base64!!!", throughRevision: 1 },
      { cursor: "x".repeat(400), throughRevision: 1 },
      // Valid encoding, but the pinned revision does not match the request.
      {
        cursor: Buffer.from(
          JSON.stringify({
            base_revision: 0,
            through_revision: 99,
            last_revision: 1,
            last_track_id: "11",
          }),
        ).toString("base64url"),
        throughRevision: 1,
      },
    ];

    for (const { cursor, throughRevision } of cases) {
      const result = await sync(code, {
        baseRevision: 0,
        force: false,
        changes: [],
        cursor,
        throughRevision,
      });
      assert.equal(result.status, 400, `cursor should be refused: ${cursor}`);
      assert.ok(
        ["invalid_cursor", "invalid_request"].includes(result.body.code),
        `unexpected error code ${result.body.code}`,
      );
    }
  });

  test("rejects a continuation that smuggles in changes", async () => {
    const code = await createSpace();
    const result = await sync(code, {
      baseRevision: 0,
      force: false,
      changes: [{ trackId: "11", bpm: 100 }],
      cursor: "AAAA",
      throughRevision: 0,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_request");
  });

  test("a full space still serves reads and reports capacityExceeded", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: ["1", "2", "3", "4"].map((trackId) => ({
        trackId,
        bpm: 120,
      })),
    });

    const overflow = await sync(code, {
      baseRevision: 1,
      force: false,
      changes: [{ trackId: "5", bpm: 130 }],
    });
    assert.equal(
      overflow.status,
      200,
      "a full space must not fail the request",
    );
    assert.equal(overflow.body.capacityExceeded, true);

    // The rejected track was not stored.
    const state = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });
    assert.ok(!state.changes.some((c) => c.trackId === "5"));

    // Overwriting an existing track needs no new row, so it still works.
    const update = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "1", bpm: 121 }],
    });
    assert.equal(update.body.capacityExceeded, false);
  });

  test("an over-cap new track does not block the rest of the same batch", async () => {
    const code = await createSpace();
    let state = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: ["1", "2", "3", "4"].map((trackId) => ({
        trackId,
        bpm: 120,
      })),
    });

    // A capacity-neutral edit to an existing track is bundled with a
    // brand-new track the full space has no room for. The edit must still
    // land -- only the new track is rejected -- otherwise it would be stuck
    // behind the same over-cap track on every retry.
    const mixed = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [
        { trackId: "1", bpm: 121 },
        { trackId: "5", bpm: 130 },
      ],
    });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.capacityExceeded, true);

    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });
    assert.ok(
      state.changes.some((c) => c.trackId === "1" && c.bpm === 121),
      "the bundled edit to an existing track must not be dropped",
    );
    assert.ok(!state.changes.some((c) => c.trackId === "5"));
  });

  test("deleting a track frees its slot for a new one", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: ["1", "2", "3", "4"].map((trackId) => ({
        trackId,
        bpm: 120,
      })),
    });

    let state = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });

    // Deleting leaves a tombstone behind (needed to propagate the deletion to
    // other clients) -- it must not keep counting toward the space's cap.
    const deletion = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "1", bpm: null }],
    });
    assert.equal(deletion.status, 200);
    assert.equal(deletion.body.capacityExceeded, false);

    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });

    const added = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "5", bpm: 130 }],
    });
    assert.equal(
      added.body.capacityExceeded,
      false,
      "deleting a track must free its slot for a new one",
    );

    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });
    assert.ok(state.changes.some((c) => c.trackId === "5" && c.bpm === 130));
  });

  test("reviving a tombstoned track counts against the cap like any new track", async () => {
    const code = await createSpace();
    await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: ["1", "2", "3", "4"].map((trackId) => ({
        trackId,
        bpm: 120,
      })),
    });

    let state = await syncAll(code, {
      baseRevision: 0,
      force: false,
      changes: [],
    });

    // Delete "1" and immediately refill its slot with "5", so the space is
    // back at the cap (2,3,4,5 live) while "1" survives on file as a
    // tombstone.
    await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "1", bpm: null }],
    });
    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });
    const refill = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "5", bpm: 130 }],
    });
    assert.equal(refill.body.capacityExceeded, false);
    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });

    // The space is full again. Reviving the tombstoned "1" must be treated
    // as adding a track, not as a capacity-neutral update to an existing
    // one, even though a row for "1" already exists on file.
    const revived = await sync(code, {
      baseRevision: state.revision,
      force: false,
      changes: [{ trackId: "1", bpm: 121 }],
    });
    assert.equal(revived.status, 200);
    assert.equal(revived.body.capacityExceeded, true);

    state = await syncAll(code, { baseRevision: 0, force: false, changes: [] });
    assert.ok(
      !state.changes.some((c) => c.trackId === "1" && c.bpm === 121),
      "reviving a tombstoned track must not bypass a full space's cap",
    );
  });

  test("reports revision_ahead for a client ahead of the server", async () => {
    const code = await createSpace();
    const result = await sync(code, {
      baseRevision: 7,
      force: false,
      changes: [],
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "revision_ahead");
  });

  test("enforces request validation limits", async () => {
    const code = await createSpace();
    const cases = [
      { changes: [{ trackId: "1", bpm: 0 }] },
      { changes: [{ trackId: "1", bpm: 1000 }] },
      { changes: [{ trackId: "abc", bpm: 100 }] },
      { changes: [{ trackId: "1".repeat(40), bpm: 100 }] },
      {
        changes: [
          { trackId: "1", bpm: 100 },
          { trackId: "1", bpm: 101 },
        ],
      },
      {
        changes: Array.from({ length: MAX_CHANGES + 1 }, (_, i) => ({
          trackId: String(i + 1),
          bpm: 120,
        })),
      },
    ];

    for (const { changes } of cases) {
      const result = await sync(code, {
        baseRevision: 0,
        force: false,
        changes,
      });
      assert.equal(
        result.status,
        400,
        `expected rejection for ${JSON.stringify(changes).slice(0, 60)}`,
      );
      assert.equal(result.body.code, "invalid_request");
    }
  });

  test("rejects a negative baseRevision", async () => {
    const code = await createSpace();
    const result = await sync(code, {
      baseRevision: -1,
      force: false,
      changes: [],
    });
    assert.equal(result.status, 400);
  });

  test("unknown routes and methods are refused", async () => {
    assert.equal((await fetch(`${BASE}/nope`)).status, 404);
    assert.equal((await fetch(`${BASE}/sync`)).status, 404);
    const preflight = await fetch(`${BASE}/sync`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-expose-headers"),
      "Retry-After",
    );
  });
});

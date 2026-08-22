// Unit tests for the sync merge logic in background.js.
//
// background.js is a classic (non-module) extension background script, so it is
// loaded here with a stub `chrome` API and its pure helpers are read back off
// globalThis.DeezerBpmSyncInternals.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function stubChrome() {
  const noopListener = { addListener() {} };
  return {
    runtime: { onInstalled: noopListener, onMessage: noopListener },
    tabs: { create: async () => ({}) },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: noopListener,
    },
    alarms: { create() {}, clear() {}, onAlarm: noopListener },
  };
}

function loadInternals() {
  const source = readFileSync(
    new URL("../background.js", import.meta.url),
    "utf8",
  );
  // `typeof browser` inside the script resolves to "undefined" here, so the
  // chrome branch is taken.
  new Function("chrome", source)(stubChrome());
  const internals = globalThis.DeezerBpmSyncInternals;
  assert.ok(internals, "background.js did not expose DeezerBpmSyncInternals");
  return internals;
}

const { buildClientChanges, applyServerChanges, reconcileSync } =
  loadInternals();

test("buildClientChanges sends edits and tombstones, skipping blocked conflicts", () => {
  const baseline = { 1: 100, 2: 110, 3: 120 };
  const local = { 1: 128, 2: 110 };
  const conflicts = { 3: { local: null, remote: 120 } };

  const { changes, sentIds } = buildClientChanges(
    baseline,
    local,
    conflicts,
    false,
  );

  assert.deepEqual(changes, [{ trackId: "1", bpm: 128 }]);
  assert.deepEqual([...sentIds], ["1"]);

  // force ignores the blocked conflict and re-sends the deletion.
  const forced = buildClientChanges(baseline, local, conflicts, true);
  assert.deepEqual(forced.changes.map((c) => c.trackId).sort(), ["1", "3"]);
  assert.equal(
    forced.changes.find((c) => c.trackId === "3").bpm,
    null,
    "deleting locally must upload a null tombstone",
  );
});

test("applyServerChanges rebuilds the baseline and reports applied ids", () => {
  const { serverBaseline, appliedIds } = applyServerChanges(
    { 1: 100, 2: 110 },
    [
      { trackId: "1", bpm: 128, revision: 5 },
      { trackId: "2", bpm: null, revision: 5 },
      { trackId: "9", bpm: 90, revision: 6 },
    ],
  );

  assert.deepEqual(serverBaseline, { 1: 128, 9: 90 });
  assert.deepEqual([...appliedIds].sort(), ["1", "2", "9"]);
});

test("applyServerChanges rejects malformed server rows", () => {
  assert.throws(() => applyServerChanges({}, [{ trackId: "abc", bpm: 100 }]));
  assert.throws(() => applyServerChanges({}, [{ trackId: "1", bpm: 0 }]));
  assert.throws(() => applyServerChanges({}, [{ trackId: "1", bpm: 1000 }]));
});

test("reconcileSync accepts the server value for a track only we changed", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 100 },
    requestLocal: { 1: 128 },
    latestLocal: { 1: 128 },
    serverBaseline: { 1: 128 },
    appliedIds: new Set(["1"]),
    previousConflicts: {},
    sentIds: new Set(["1"]),
    force: false,
  });

  assert.deepEqual(finalLocal, { 1: 128 });
  assert.deepEqual(conflicts, {});
});

test("reconcileSync keeps the local value and records a same-track conflict", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 100 },
    requestLocal: { 1: 128 },
    latestLocal: { 1: 128 },
    serverBaseline: { 1: 140 },
    appliedIds: new Set(["1"]),
    previousConflicts: {},
    sentIds: new Set(["1"]),
    force: false,
  });

  assert.deepEqual(finalLocal, { 1: 128 });
  assert.deepEqual(conflicts, { 1: { local: 128, remote: 140 } });
});

// Regression: the server accepted the request but rejected this track (the
// space was at its row cap). The delta therefore carries no row for it, so the
// server baseline still holds the old value. Resetting local to that value would
// silently throw away the user's edit.
test("reconcileSync keeps a local edit the server did not apply", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 100 },
    requestLocal: { 1: 128 },
    latestLocal: { 1: 128 },
    serverBaseline: { 1: 100 },
    appliedIds: new Set(),
    previousConflicts: {},
    sentIds: new Set(["1"]),
    force: false,
  });

  assert.deepEqual(finalLocal, { 1: 128 }, "local edit must survive rejection");
  assert.deepEqual(conflicts, {}, "a rejection is not a conflict");
});

test("reconcileSync keeps a rejected deletion pending instead of resurrecting it", () => {
  const { finalLocal } = reconcileSync({
    baseline: { 1: 100 },
    requestLocal: {},
    latestLocal: {},
    serverBaseline: { 1: 100 },
    appliedIds: new Set(),
    previousConflicts: {},
    sentIds: new Set(["1"]),
    force: false,
  });

  assert.deepEqual(finalLocal, {}, "deletion must stay pending, not come back");
});

test("reconcileSync prefers an edit made while the request was in flight", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 100 },
    requestLocal: { 1: 128 },
    latestLocal: { 1: 133 },
    serverBaseline: { 1: 140 },
    appliedIds: new Set(["1"]),
    previousConflicts: {},
    sentIds: new Set(["1"]),
    force: false,
  });

  assert.deepEqual(finalLocal, { 1: 133 });
  assert.deepEqual(conflicts, {}, "a fresh local edit supersedes the conflict");
});

test("reconcileSync pulls remote-only changes and drops remote deletions", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 100, 2: 110 },
    requestLocal: { 1: 100, 2: 110 },
    latestLocal: { 1: 100, 2: 110 },
    serverBaseline: { 1: 150 },
    appliedIds: new Set(["1", "2"]),
    previousConflicts: {},
    sentIds: new Set(),
    force: false,
  });

  assert.deepEqual(finalLocal, { 1: 150 });
  assert.deepEqual(conflicts, {});
});

test("reconcileSync resolves a previously blocked conflict under force", () => {
  const { finalLocal, conflicts } = reconcileSync({
    baseline: { 1: 140 },
    requestLocal: { 1: 128 },
    latestLocal: { 1: 128 },
    serverBaseline: { 1: 128 },
    appliedIds: new Set(["1"]),
    previousConflicts: { 1: { local: 128, remote: 140 } },
    sentIds: new Set(["1"]),
    force: true,
  });

  assert.deepEqual(finalLocal, { 1: 128 });
  assert.deepEqual(conflicts, {}, "force must clear the conflict");
});

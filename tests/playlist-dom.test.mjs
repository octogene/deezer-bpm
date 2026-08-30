// DOM-level tests for content/playlist.js's inline BPM editor, run against a
// jsdom environment loading the real content scripts (see tests/dom/harness.mjs)
// instead of a real browser.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createContentScriptEnvironment,
  deferred,
  flushMicrotasks,
} from "./dom/harness.mjs";

function buildRow(document) {
  const row = document.createElement("div");
  row.setAttribute("role", "row");
  row.setAttribute("aria-rowindex", "1");

  const title = document.createElement("span");
  title.dataset.testid = "title";
  title.textContent = "Test Track";
  row.appendChild(title);

  document.body.appendChild(row);
  return row;
}

function attachBpmSpan(DeezerBpm, document, row, trackId) {
  const span = document.createElement("span");
  span.className = DeezerBpm.constants.INLINE_CLASS;
  row.appendChild(span);

  // Matches how injectBpmsIntoRows wires up a span: stamp the track id, then
  // hand the span to renderBpmValue, which attaches the dblclick editor.
  span.dataset.dbpmTrack = trackId;
  DeezerBpm.playlist.renderBpmValue(span, trackId, row)(null);
  return span;
}

function openEditor(window, span) {
  span.dispatchEvent(
    new window.Event("dblclick", { bubbles: true, cancelable: true }),
  );
  const input = span.querySelector("input");
  assert.ok(input, "double-click must open the BPM input");
  return input;
}

function commitValue(window, input, rawValue) {
  input.value = rawValue;
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("playlist inline BPM editor", () => {
  test("double-click, type a value, and commit saves the override", async () => {
    const { window, document, DeezerBpm } = createContentScriptEnvironment();
    const row = buildRow(document);
    const span = attachBpmSpan(DeezerBpm, document, row, "1");

    const input = openEditor(window, span);
    commitValue(window, input, "128");
    await flushMicrotasks();

    assert.equal(DeezerBpm.cache.manualBpmCache.get("1"), 128);
    assert.equal(span.textContent, "128");
    assert.equal(span.querySelector("input"), null);
  });

  test("a stale failed save does not clobber a newer successful edit", async () => {
    const firstSave = deferred();
    const { window, document, DeezerBpm } = createContentScriptEnvironment({
      // The first commit's save (120) is held open; the second commit's
      // save (130) resolves immediately, as if it landed first.
      sendMessage: (message) =>
        message.bpm === 120 ? firstSave.promise : Promise.resolve({ ok: true }),
    });
    const row = buildRow(document);
    const span = attachBpmSpan(DeezerBpm, document, row, "1");

    // First edit session: commit 120. Its save stays pending.
    let input = openEditor(window, span);
    commitValue(window, input, "120");
    await flushMicrotasks();
    assert.equal(DeezerBpm.cache.manualBpmCache.get("1"), 120);

    // Before the first save resolves, a second edit session opens on the
    // same span (the dblclick listener is never removed) and commits 130,
    // which succeeds right away.
    input = openEditor(window, span);
    commitValue(window, input, "130");
    await flushMicrotasks();
    assert.equal(DeezerBpm.cache.manualBpmCache.get("1"), 130);

    // The first save now fails. Its revert must not stomp on the second,
    // already-successful edit.
    firstSave.resolve({ ok: false, error: "boom" });
    await flushMicrotasks();

    assert.equal(
      DeezerBpm.cache.manualBpmCache.get("1"),
      130,
      "a stale failed save must not clobber the newer successful edit",
    );
    assert.equal(span.textContent, "130");
  });

  test("a failed save with no overlapping edit still reverts", async () => {
    const save = deferred();
    const { window, document, DeezerBpm } = createContentScriptEnvironment({
      sendMessage: () => save.promise,
    });
    const row = buildRow(document);
    const span = attachBpmSpan(DeezerBpm, document, row, "1");

    const input = openEditor(window, span);
    commitValue(window, input, "120");
    await flushMicrotasks();
    assert.equal(DeezerBpm.cache.manualBpmCache.get("1"), 120);

    save.resolve({ ok: false, error: "boom" });
    await flushMicrotasks();

    assert.equal(
      DeezerBpm.cache.manualBpmCache.has("1"),
      false,
      "with no newer edit in flight, a failed save must still revert",
    );
    assert.equal(span.textContent, "N/A");
  });
});

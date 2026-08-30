// Minimal jsdom harness for exercising the extension's content scripts as
// real DOM code instead of re-implementing their logic in test doubles.
//
// The content scripts are plain IIFEs (not ES modules) that read/write
// `window.DeezerBpm.*`, exactly like the browser loads them per
// manifest.json's content_scripts list. We run each file's source through
// jsdom's `window.eval` (the documented way to execute script text inside a
// jsdom realm -- see https://github.com/jsdom/jsdom#executing-scripts), in
// the same order the manifest loads them, so `window.DeezerBpm.playlist`
// etc. come out wired up the same way they are on a real page.
//
// `resolver.js` (player-DOM scraping) is stubbed rather than loaded for real
// -- it talks to Deezer's player markup, which none of these tests render --
// and `chrome.runtime`/`chrome.storage` are stubbed so cache.js can load
// without a real extension runtime. Override either via the options below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const CONTENT_DIR = fileURLToPath(new URL("../../content/", import.meta.url));

// Subset of manifest.json's content_scripts order needed to bring up
// `window.DeezerBpm.playlist`. resolver.js is deliberately excluded -- see
// `resolver` in createContentScriptEnvironment below.
const SCRIPT_ORDER = [
  "constants.js",
  "manual-bpm.js",
  "utils.js",
  "cache.js",
  "api.js",
  "badge.js",
  "playlist.js",
];

function runContentScript(window, filename) {
  const code = readFileSync(`${CONTENT_DIR}${filename}`, "utf8");
  // Keep stack traces pointing at the real file on failure.
  window.eval(`${code}\n//# sourceURL=content/${filename}`);
}

/**
 * Boots a jsdom window, loads the real content scripts through it, and
 * returns the window/document plus the assembled `window.DeezerBpm`
 * namespace.
 *
 * @param {object} [options]
 * @param {(message: object) => Promise<any>} [options.sendMessage] Stub for
 *   `chrome.runtime.sendMessage`. Defaults to always resolving `{ ok: true }`.
 * @param {object} [options.resolver] Stub for `window.DeezerBpm.resolver`,
 *   which badge.js reads at load time. Defaults to a no-op
 *   `detectTrackIdFromPlayer`.
 * @param {string} [options.html] Initial document body markup.
 */
export function createContentScriptEnvironment({
  sendMessage = () => Promise.resolve({ ok: true }),
  resolver = { detectTrackIdFromPlayer: () => null },
  html = "<!doctype html><html><body></body></html>",
} = {}) {
  const dom = new JSDOM(html, {
    url: "https://www.deezer.com/",
    runScripts: "outside-only",
  });
  const { window } = dom;

  window.chrome = {
    runtime: {
      sendMessage: (...args) => sendMessage(...args),
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
  };

  // jsdom does not implement CSS.escape; playlist.js uses it to build
  // attribute selectors for track ids.
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (value) =>
      String(value).replace(
        /[^a-zA-Z0-9_-]/g,
        (char) => `\\${char.codePointAt(0).toString(16)} `,
      );
  }

  for (const filename of SCRIPT_ORDER) {
    if (filename === "badge.js") {
      window.DeezerBpm.resolver = resolver;
    }
    runContentScript(window, filename);
  }

  return {
    dom,
    window,
    document: window.document,
    DeezerBpm: window.DeezerBpm,
  };
}

/** Waits for pending promise chains (e.g. inside commit()) to settle. */
export function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise plus its external resolve, for controlling save timing in tests. */
export function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

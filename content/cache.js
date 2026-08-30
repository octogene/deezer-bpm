(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  const {
    BPM_CACHE_STORAGE_KEY,
    COVER_CACHE_STORAGE_KEY,
    COVER_TRACK_CACHE_STORAGE_KEY,
    CLEAR_CACHE_STORAGE_KEY,
    CLEAR_UNRESOLVABLE_CACHE_STORAGE_KEY,
    UNRESOLVABLE_CACHE_LAST_CLEAR_STORAGE_KEY,
    UNRESOLVABLE_CACHE_MAX_AGE_MS,
    MAX_CACHE_SIZE,
    CACHE_SAVE_DEBOUNCE_MS,
    MANUAL_BPM_STORAGE_KEY,
    LOG_PREFIX,
  } = window.DeezerBpm.constants;

  const { logDebugInfo, clearUnresolvableTrackCache } = window.DeezerBpm.utils;

  const { parseManualOverrides } = window.DeezerBpm.manualBpm;

  class LruMap extends Map {
    constructor(maxSize, entries) {
      super(entries);
      this.maxSize = maxSize;
      this.evictOverflow();
    }

    get(key) {
      if (!super.has(key)) return undefined;
      const value = super.get(key);
      super.delete(key);
      super.set(key, value);
      return value;
    }

    set(key, value) {
      if (super.has(key)) super.delete(key);
      super.set(key, value);
      this.evictOverflow();
      return this;
    }

    evictOverflow() {
      while (this.size > this.maxSize) {
        const oldestKey = this.keys().next().value;
        super.delete(oldestKey);
      }
    }
  }

  const bpmCache = new LruMap(MAX_CACHE_SIZE);
  const coverCache = new LruMap(MAX_CACHE_SIZE);
  const albumCache = new LruMap(MAX_CACHE_SIZE);
  const trackResolutionCache = new LruMap(MAX_CACHE_SIZE);
  // User-entered overrides — plain Map (never evicted, survives cache clears)
  const manualBpmCache = new Map();
  const inFlight = new Map();

  const storageApi =
    typeof browser !== "undefined" && browser.storage
      ? browser.storage
      : chrome.storage;
  const runtimeApi =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

  let saveDebounce = null;

  async function checkCacheClear() {
    try {
      if (localStorage.getItem(CLEAR_CACHE_STORAGE_KEY) !== "1") return;

      await storageApi.local.remove([
        BPM_CACHE_STORAGE_KEY,
        COVER_CACHE_STORAGE_KEY,
        COVER_TRACK_CACHE_STORAGE_KEY,
      ]);

      bpmCache.clear();
      coverCache.clear();
      albumCache.clear();
      trackResolutionCache.clear();
      inFlight.clear();

      logDebugInfo("Cache cleared");
      localStorage.removeItem(CLEAR_CACHE_STORAGE_KEY);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Error clearing cache:`, error);
    }
  }

  async function checkUnresolvableCacheClear() {
    try {
      if (localStorage.getItem(CLEAR_UNRESOLVABLE_CACHE_STORAGE_KEY) !== "1")
        return;
      await clearUnresolvableTrackCache();
      localStorage.setItem(
        UNRESOLVABLE_CACHE_LAST_CLEAR_STORAGE_KEY,
        String(Date.now()),
      );
      logDebugInfo("Unresolvable cache cleared");
      localStorage.removeItem(CLEAR_UNRESOLVABLE_CACHE_STORAGE_KEY);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Error clearing unresolvable cache:`, error);
    }
  }

  async function checkUnresolvableCacheAge() {
    try {
      const lastClearRaw = localStorage.getItem(
        UNRESOLVABLE_CACHE_LAST_CLEAR_STORAGE_KEY,
      );
      const lastClear = lastClearRaw ? Number(lastClearRaw) : 0;
      const now = Date.now();

      if (
        Number.isFinite(lastClear) &&
        lastClear > 0 &&
        now - lastClear < UNRESOLVABLE_CACHE_MAX_AGE_MS
      ) {
        return;
      }

      const removed = await clearUnresolvableTrackCache();
      localStorage.setItem(
        UNRESOLVABLE_CACHE_LAST_CLEAR_STORAGE_KEY,
        String(now),
      );
      logDebugInfo("Startup unresolved cache age check complete:", removed);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Error clearing aged unresolved cache:`,
        error,
      );
    }
  }

  async function loadPersistedCache() {
    try {
      const cache = await storageApi.local.get([
        BPM_CACHE_STORAGE_KEY,
        COVER_CACHE_STORAGE_KEY,
        COVER_TRACK_CACHE_STORAGE_KEY,
        MANUAL_BPM_STORAGE_KEY,
      ]);

      const savedBpm = cache[BPM_CACHE_STORAGE_KEY];
      if (savedBpm && typeof savedBpm === "object") {
        for (const [id, bpm] of Object.entries(savedBpm)) {
          bpmCache.set(id, bpm);
        }
      }

      const savedCover = cache[COVER_CACHE_STORAGE_KEY];
      if (savedCover && typeof savedCover === "object") {
        for (const [id, albumId] of Object.entries(savedCover)) {
          coverCache.set(id, albumId);
        }
      }

      const savedCoverTrack = cache[COVER_TRACK_CACHE_STORAGE_KEY];
      if (savedCoverTrack && typeof savedCoverTrack === "object") {
        for (const [key, trackId] of Object.entries(savedCoverTrack)) {
          trackResolutionCache.set(key, trackId);
        }
      }

      for (const [id, bpm] of parseManualOverrides(
        cache[MANUAL_BPM_STORAGE_KEY],
      )) {
        manualBpmCache.set(id, bpm);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Could not load caches:`, error);
    }
  }

  function persistCaches() {
    logDebugInfo("[CACHE] Persisting caches");

    // storageApi.local.set can throw synchronously (rather than reject) when
    // the extension context is invalidated mid page-teardown, e.g. the
    // flushPendingCacheSave() call on pagehide — the try/catch below is
    // needed because a synchronous throw happens before .catch() attaches.
    try {
      return Promise.resolve(
        storageApi.local.set({
          [BPM_CACHE_STORAGE_KEY]: Object.fromEntries(bpmCache),
          [COVER_CACHE_STORAGE_KEY]: Object.fromEntries(coverCache),
          [COVER_TRACK_CACHE_STORAGE_KEY]:
            Object.fromEntries(trackResolutionCache),
        }),
      ).catch((error) => {
        console.warn(`${LOG_PREFIX} Could not persist cache:`, error);
      });
    } catch (error) {
      console.warn(`${LOG_PREFIX} Could not persist cache:`, error);
      return Promise.resolve();
    }
  }

  // Manual overrides are edited one at a time by deliberate user action (the
  // playlist double-click editor, or a popup import), never in a tight loop,
  // so they get their own immediate (non-debounced) write instead of riding
  // along on the bulkier, high-frequency auto-cache debounce above — that
  // used to let an unrelated auto-cache save silently clobber a fresh manual
  // edit in another tab.
  //
  // Resolves to true/false instead of throwing, so a caller that already
  // applied an optimistic UI update can tell whether to keep or undo it.
  function saveManualOverride(trackId, bpm) {
    logDebugInfo("[CACHE] Persisting manual overrides");

    // Same synchronous-throw hazard as persistCaches() above: sendMessage
    // can throw immediately instead of rejecting when the extension context
    // is invalidated mid navigation.
    try {
      return runtimeApi
        .sendMessage({
          type: "set-manual-override",
          trackId,
          bpm,
        })
        .then((response) => {
          if (!response?.ok) {
            throw new Error(response?.error || "manual override write failed");
          }
          return true;
        })
        .catch((error) => {
          console.warn(
            `${LOG_PREFIX} Could not persist manual overrides:`,
            error,
          );
          return false;
        });
    } catch (error) {
      console.warn(`${LOG_PREFIX} Could not persist manual overrides:`, error);
      return Promise.resolve(false);
    }
  }

  // Rebuilds manualBpmCache from a stored overrides object (same shape and
  // validation as loadPersistedCache). Used when the popup imports overrides and
  // writes to storage.local. Returns true only if the contents actually changed,
  // so we ignore our own writes echoed back via storage.onChanged.
  function applyManualOverridesFromStorage(rawValue) {
    const next = parseManualOverrides(rawValue);

    if (next.size === manualBpmCache.size) {
      let identical = true;
      for (const [id, bpm] of next) {
        if (manualBpmCache.get(id) !== bpm) {
          identical = false;
          break;
        }
      }
      if (identical) return false;
    }

    manualBpmCache.clear();
    for (const [id, bpm] of next) manualBpmCache.set(id, bpm);
    return true;
  }

  // Returns the BPM to display: manual override takes priority over API value.
  // Returns null if neither source has a value; undefined if API not yet fetched.
  function getEffectiveBpm(trackId) {
    if (manualBpmCache.has(trackId)) return manualBpmCache.get(trackId);
    return bpmCache.get(trackId);
  }

  function scheduleSaveCache() {
    if (saveDebounce !== null) return;

    saveDebounce = setTimeout(() => {
      saveDebounce = null;
      persistCaches();
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  function flushPendingCacheSave() {
    if (saveDebounce === null) return;

    clearTimeout(saveDebounce);
    saveDebounce = null;
    persistCaches();
  }

  window.DeezerBpm.cache = {
    LruMap,
    bpmCache,
    coverCache,
    albumCache,
    trackResolutionCache,
    manualBpmCache,
    inFlight,
    storageApi,
    checkCacheClear,
    checkUnresolvableCacheClear,
    checkUnresolvableCacheAge,
    loadPersistedCache,
    persistCaches,
    scheduleSaveCache,
    flushPendingCacheSave,
    getEffectiveBpm,
    saveManualOverride,
    applyManualOverridesFromStorage,
  };
})();

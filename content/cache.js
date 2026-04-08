(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        BPM_CACHE_STORAGE_KEY,
        COVER_CACHE_STORAGE_KEY,
        COVER_TRACK_CACHE_STORAGE_KEY,
        CLEAR_CACHE_STORAGE_KEY,
        MAX_CACHE_SIZE,
        CACHE_SAVE_DEBOUNCE_MS,
        LOG_PREFIX,
    } = window.DeezerBpm.constants;

    const { logDebugInfo } = window.DeezerBpm.utils;

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
    const inFlight = new Map();

    const storageApi = (typeof browser !== 'undefined' && browser.storage)
        ? browser.storage
        : chrome.storage;

    let saveDebounce = null;

    async function checkCacheClear() {
        try {
            if (localStorage.getItem(CLEAR_CACHE_STORAGE_KEY) !== '1') return;

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

            logDebugInfo('Cache cleared');
            localStorage.removeItem(CLEAR_CACHE_STORAGE_KEY);
        } catch (error) {
            console.warn(`${LOG_PREFIX} Error clearing cache:`, error);
        }
    }

    async function loadPersistedCache() {
        try {
            const cache = await storageApi.local.get([
                BPM_CACHE_STORAGE_KEY,
                COVER_CACHE_STORAGE_KEY,
                COVER_TRACK_CACHE_STORAGE_KEY,
            ]);

            const savedBpm = cache[BPM_CACHE_STORAGE_KEY];
            if (savedBpm && typeof savedBpm === 'object') {
                for (const [id, bpm] of Object.entries(savedBpm)) {
                    bpmCache.set(id, bpm);
                }
            }

            const savedCover = cache[COVER_CACHE_STORAGE_KEY];
            if (savedCover && typeof savedCover === 'object') {
                for (const [id, albumId] of Object.entries(savedCover)) {
                    coverCache.set(id, albumId);
                }
            }

            const savedCoverTrack = cache[COVER_TRACK_CACHE_STORAGE_KEY];
            if (savedCoverTrack && typeof savedCoverTrack === 'object') {
                for (const [key, trackId] of Object.entries(savedCoverTrack)) {
                    trackResolutionCache.set(key, trackId);
                }
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} Could not load caches:`, error);
        }
    }

    function persistCaches() {
        logDebugInfo('[CACHE] Persisting caches');

        return storageApi.local.set({
            [BPM_CACHE_STORAGE_KEY]: Object.fromEntries(bpmCache),
            [COVER_CACHE_STORAGE_KEY]: Object.fromEntries(coverCache),
            [COVER_TRACK_CACHE_STORAGE_KEY]: Object.fromEntries(trackResolutionCache),
        }).catch(error => {
            console.warn(`${LOG_PREFIX} Could not persist cache:`, error);
        });
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
        inFlight,
        storageApi,
        checkCacheClear,
        loadPersistedCache,
        persistCaches,
        scheduleSaveCache,
        flushPendingCacheSave,
    };
})();
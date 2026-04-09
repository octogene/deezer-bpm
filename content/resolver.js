(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        UNRESOLVABLE,
    } = window.DeezerBpm.constants;

    const {
        normalizeTrackKeyPart,
        makeCoverTrackKey,
        makeAlbumTrackKey,
        extractCoverId,
        logDebugInfo,
        logDebugError,
        delay,
    } = window.DeezerBpm.utils;

    const {
        coverCache,
        albumCache,
        trackResolutionCache,
        scheduleSaveCache,
    } = window.DeezerBpm.cache;

    const {
        fetchAlbumCached,
        findTrackMatch,
        searchTrackFallback,
    } = window.DeezerBpm.api;

    function extractRowElement(row) {
        const titleEl = row.querySelector('[data-testid="title"]');
        const artistEl = row.querySelector('[data-testid="artist"]');
        const albumEl = row.querySelector('[data-testid="album"]');
        const coverId = extractCoverId(row) ?? null;

        return {
            titleEl,
            artistEl,
            albumEl,
            coverId,
        };
    }

    async function extractRowElementAsync(row, maxWait = 150) {
        const result = extractRowElement(row);
        if (result.coverId) return result;

        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            await delay(16);
            if (!row.isConnected) break;

            const retried = extractRowElement(row);
            if (retried.coverId) {
                return retried;
            }
        }

        return result;
    }

    async function detectTrackIdFromPlayer() {
        const container = document.querySelector('[data-testid="miniplayer_container"]');
        if (!container) return null;

        const anchor = container.querySelector('[data-testid="item_title"] a[href*="/album/"]');
        if (!anchor) return null;

        const rawTitle = anchor.textContent.trim();
        const albumMatch = anchor.getAttribute('href')?.match(/\/album\/(\d+)/);
        if (!albumMatch) return null;

        const albumId = albumMatch[1];

        const albumKey = makeAlbumTrackKey(albumId, rawTitle);
        const cachedByAlbumKey = trackResolutionCache.get(albumKey);
        if (cachedByAlbumKey) {
            logDebugInfo('[BADGE] Album-key cache hit:', albumKey);
            return cachedByAlbumKey;
        }

        const coverId = extractCoverId(container, 'item_cover');
        let key = null;

        if (coverId) {
            key = makeCoverTrackKey(coverId, rawTitle);
            logDebugInfo('[BADGE] Checking cover cache for:', key);

            const cachedTrackId = trackResolutionCache.get(key);
            if (cachedTrackId) {
                logDebugInfo('[BADGE] Cover cache hit:', cachedTrackId);
                return cachedTrackId;
            }

            logDebugInfo('[BADGE] Cover cache miss for cover:', coverId);
        } else {
            logDebugInfo('[BADGE] Cover track cache miss for cover:', coverId);
        }

        try {
            logDebugInfo('[BADGE] Fetching album data for track id detection', albumId);

            const albumData = await fetchAlbumCached(albumId);
            const match = (albumData.tracks || []).find(
                track => normalizeTrackKeyPart(track.title) === normalizeTrackKeyPart(rawTitle)
            );

            const trackId = match ? String(match.id) : null;

            if (trackId) {
                logDebugInfo('[BADGE] Album track match:', match);
                if (key) trackResolutionCache.set(key, trackId);
            }

            return trackId;
        } catch (error) {
            logDebugInfo('[BADGE] Album track fetch error:', error);
            return null;
        }
    }

    async function resolveRowTrackId(row, { allowSearchFallback = false } = {}) {
        if (row.getAttribute('aria-disabled') === 'true') {
            logDebugInfo('[ROW RES]', 'Skipping disabled row');
            return UNRESOLVABLE;
        }

        const { titleEl, artistEl, albumEl, coverId } = await extractRowElementAsync(row);
        if (!titleEl) return null;

        const rawTitle = titleEl.textContent.trim();

        let albumId;
        if (albumEl) {
            const albumMatch = albumEl.getAttribute('href')?.match(/\/album\/(\d+)/);
            albumId = albumMatch ? albumMatch[1] : null;
        } else {
            albumId = location.pathname.match(/\/album\/(\d+)/)?.[1] ?? null;
        }

        if (albumId) {
            const albumKey = makeAlbumTrackKey(albumId, rawTitle);
            const cachedTrackId = trackResolutionCache.get(albumKey);

            if (cachedTrackId) {
                logDebugInfo('[ROW RES]', 'Album-key cache hit:', albumKey);
                return cachedTrackId;
            }

            logDebugInfo('[ROW RES]', 'Album-key cache miss:', albumKey);
        }

        let key = null;
        if (coverId) {
            key = makeCoverTrackKey(coverId, rawTitle);

            const cached = trackResolutionCache.get(key);
            if (cached) {
                logDebugInfo('[ROW RES]', 'Cover cache hit:', key);
                return cached;
            }

            logDebugInfo('[ROW RES]', 'Cover cache miss:', key);

            const cachedAlbumId = coverCache.get(coverId);
            if (cachedAlbumId) {
                logDebugInfo('[ROW RES]', 'Album-cover cache hit:', cachedAlbumId, rawTitle);

                const albumData = albumCache.get(cachedAlbumId);
                if (albumData) {
                    const match = findTrackMatch(albumData.tracks, rawTitle);
                    const trackId = match ? String(match.id) : null;

                    if (trackId) {
                        logDebugInfo('[ROW RES]', 'Track cache hit:', key);
                        trackResolutionCache.set(key, trackId);
                        scheduleSaveCache();
                        return trackId;
                    }

                    logDebugInfo('[ROW RES]', 'Track not found in album data:', albumData);
                } else {
                    logDebugInfo('[ROW RES]', 'Album-cover cache miss:', key);
                }
            }
        } else {
            logDebugInfo('[ROW RES]', 'No cover ID found');
        }

        if (albumId) {
            logDebugInfo('[ROW RES]', 'Album ID found:', albumId);

            if (coverId && !coverCache.has(coverId)) {
                coverCache.set(coverId, albumId);
            }

            try {
                logDebugInfo('[ROW RES]', 'Fetching album data for ID:', albumId);

                const albumData = await fetchAlbumCached(albumId);
                const match = (albumData.tracks || []).find(
                    track => normalizeTrackKeyPart(track.title) === normalizeTrackKeyPart(rawTitle)
                );

                const trackId = match ? String(match.id) : null;

                if (trackId) {
                    logDebugInfo('[ROW RES]', 'Track ID found:', trackId);
                } else {
                    logDebugInfo('[ROW RES]', 'Track ID not found:', trackId);
                }

                if (trackId && albumData.coverId) {
                    trackResolutionCache.set(makeCoverTrackKey(albumData.coverId, rawTitle), trackId);
                }

                const albumKey = makeAlbumTrackKey(albumId, rawTitle);
                trackResolutionCache.set(albumKey, trackId);
                logDebugInfo('[ROW RES]', 'Album-track cache set:', albumKey, trackId);

                scheduleSaveCache();

                if (!allowSearchFallback) return trackId;
                if (trackId) return trackId;
            } catch (error) {
                logDebugError('[ROW RES]', 'Album fetch failed', error);
                if (!allowSearchFallback) return UNRESOLVABLE;
            }
        } else {
            logDebugInfo('[ROW RES]', 'No album ID found');
        }

        if (!allowSearchFallback || !artistEl) return UNRESOLVABLE;

        const artistName = artistEl.textContent.trim();

        return searchTrackFallback({
            rawTitle,
            artistName,
            coverId,
            cacheKey: key,
        });
    }

    window.DeezerBpm.resolver = {
        extractRowElement,
        extractRowElementAsync,
        detectTrackIdFromPlayer,
        resolveRowTrackId,
    };
})();
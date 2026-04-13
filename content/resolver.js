(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  const { UNRESOLVABLE } = window.DeezerBpm.constants;

  const {
    normalizeTrackKeyPart,
    makeCoverTrackKey,
    makeAlbumTrackKey,
    extractCoverId,
    logDebugInfo,
    logDebugError,
    delay,
  } = window.DeezerBpm.utils;

  const { coverCache, albumCache, trackResolutionCache, scheduleSaveCache } =
    window.DeezerBpm.cache;

  const { fetchAlbumCached, findTrackMatch, searchTrackFallback } =
    window.DeezerBpm.api;

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
    const container = document.querySelector(
      '[data-testid="miniplayer_container"]',
    );
    if (!container) return null;

    const anchor = container.querySelector(
      '[data-testid="item_title"] a[href*="/album/"]',
    );
    if (!anchor) return null;

    const rawTitle = anchor.textContent.trim();
    const albumMatch = anchor.getAttribute("href")?.match(/\/album\/(\d+)/);
    if (!albumMatch) return null;

    const albumId = albumMatch[1];

    const albumKey = makeAlbumTrackKey(albumId, rawTitle);
    if (trackResolutionCache.has(albumKey)) {
      logDebugInfo("[BADGE] Album-key cache hit:", albumKey);
      return trackResolutionCache.get(albumKey);
    }

    const coverId = extractCoverId(container, "item_cover");
    let key = null;

    if (coverId) {
      key = makeCoverTrackKey(coverId, rawTitle);
      logDebugInfo("[BADGE] Checking cover cache for:", key);

      if (trackResolutionCache.has(key)) {
        logDebugInfo("[BADGE] Cover cache hit:", key);
        return trackResolutionCache.get(key);
      }

      logDebugInfo("[BADGE] Cover cache miss for cover:", coverId);
    } else {
      logDebugInfo("[BADGE] Cover track cache miss for cover:", coverId);
    }

    try {
      logDebugInfo(
        "[BADGE] Fetching album data for track id detection",
        albumId,
      );

      const albumData = await fetchAlbumCached(albumId);
      const match = (albumData.tracks || []).find(
        (track) =>
          normalizeTrackKeyPart(track.title) ===
          normalizeTrackKeyPart(rawTitle),
      );

      const trackId = match ? String(match.id) : UNRESOLVABLE;

      if (key) trackResolutionCache.set(key, trackId);
      trackResolutionCache.set(albumKey, trackId);
      scheduleSaveCache();

      if (trackId !== UNRESOLVABLE) {
        logDebugInfo("[BADGE] Album track match:", match);
      }

      return trackId;
    } catch (error) {
      logDebugInfo("[BADGE] Album track fetch error:", error);
      return null;
    }
  }

  async function resolveRowTrackId(row, { allowSearchFallback = false } = {}) {
    if (row.getAttribute("aria-disabled") === "true") {
      logDebugInfo("[ROW RES]", "Skipping disabled row");
      return UNRESOLVABLE;
    }

    const { titleEl, artistEl, albumEl, coverId } =
      await extractRowElementAsync(row);
    if (!titleEl) return null;

    const rawTitle = titleEl.textContent.trim();

    let albumId;
    if (albumEl) {
      const albumMatch = albumEl.getAttribute("href")?.match(/\/album\/(\d+)/);
      albumId = albumMatch ? albumMatch[1] : null;
    } else {
      albumId = location.pathname.match(/\/album\/(\d+)/)?.[1] ?? null;
    }

    if (albumId) {
      const albumKey = makeAlbumTrackKey(albumId, rawTitle);

      if (trackResolutionCache.has(albumKey)) {
        logDebugInfo("[ROW RES]", "Album-key cache hit:", albumKey);
        return trackResolutionCache.get(albumKey);
      }

      logDebugInfo("[ROW RES]", "Album-key cache miss:", albumKey);
    }

    let key = null;
    if (coverId) {
      key = makeCoverTrackKey(coverId, rawTitle);

      if (trackResolutionCache.has(key)) {
        logDebugInfo("[ROW RES]", "Cover cache hit:", key);
        return trackResolutionCache.get(key);
      }

      logDebugInfo("[ROW RES]", "Cover cache miss:", key);

      const cachedAlbumId = coverCache.get(coverId);
      if (cachedAlbumId) {
        logDebugInfo(
          "[ROW RES]",
          "Album-cover cache hit:",
          cachedAlbumId,
          rawTitle,
        );

        const albumData = albumCache.get(cachedAlbumId);
        if (albumData) {
          const match = findTrackMatch(albumData.tracks, rawTitle);
          const trackId = match ? String(match.id) : UNRESOLVABLE;

          trackResolutionCache.set(key, trackId);
          scheduleSaveCache();

          if (trackId !== UNRESOLVABLE) {
            logDebugInfo("[ROW RES]", "Track cache hit:", key);
            return trackId;
          }

          console.warn(
            "[Deezer BPM] [ROW RES] Track not found in cached album data",
            {
              rawTitle,
              normalizedTitle: normalizeTrackKeyPart(rawTitle),
              albumId: albumData.id,
              albumTitle: albumData.title,
              candidates: (albumData.tracks || [])
                .slice(0, 10)
                .map((track) => ({
                  id: track.id,
                  title: track.title,
                  normalizedTitle: normalizeTrackKeyPart(track.title),
                })),
            },
          );

          return UNRESOLVABLE;
        } else {
          logDebugInfo("[ROW RES]", "Album-cover cache miss:", key);
        }
      }
    } else {
      logDebugInfo("[ROW RES]", "No cover ID found");
    }

    if (albumId) {
      logDebugInfo("[ROW RES]", "Album ID found:", albumId);

      if (coverId && !coverCache.has(coverId)) {
        coverCache.set(coverId, albumId);
      }

      try {
        logDebugInfo("[ROW RES]", "Fetching album data for ID:", albumId);

        const albumData = await fetchAlbumCached(albumId);
        const match = (albumData.tracks || []).find(
          (track) =>
            normalizeTrackKeyPart(track.title) ===
            normalizeTrackKeyPart(rawTitle),
        );

        const trackId = match ? String(match.id) : UNRESOLVABLE;

        if (trackId !== UNRESOLVABLE) {
          logDebugInfo("[ROW RES]", "Track ID found:", trackId);
        } else {
          console.warn(
            "[Deezer BPM] [ROW RES] Track ID not found in album data",
            {
              rawTitle,
              normalizedTitle: normalizeTrackKeyPart(rawTitle),
              albumId: albumData.id,
              albumTitle: albumData.title,
              candidates: (albumData.tracks || [])
                .slice(0, 10)
                .map((track) => ({
                  id: track.id,
                  title: track.title,
                  normalizedTitle: normalizeTrackKeyPart(track.title),
                })),
            },
          );
        }

        if (albumData.coverId) {
          trackResolutionCache.set(
            makeCoverTrackKey(albumData.coverId, rawTitle),
            trackId,
          );
        }

        const albumKey = makeAlbumTrackKey(albumId, rawTitle);
        trackResolutionCache.set(albumKey, trackId);
        logDebugInfo("[ROW RES]", "Album-track cache set:", albumKey, trackId);

        scheduleSaveCache();

        if (!allowSearchFallback) return trackId;
        if (trackId !== UNRESOLVABLE) return trackId;
      } catch (error) {
        logDebugError("[ROW RES]", "Album fetch failed", error);
        if (!allowSearchFallback) return UNRESOLVABLE;
      }
    } else {
      logDebugInfo("[ROW RES]", "No album ID found");
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

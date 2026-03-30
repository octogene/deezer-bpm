(function () {
    'use strict';

    // DOM identifiers used to find/mark our own elements.
    // Keeping them as constants prevents typos and makes them easy to change.
    const BADGE_ID = 'deezer-bpm-badge';   // id of the floating badge div
    const INLINE_CLASS = 'dbpm-inline';         // class on each per-row BPM span
    const HEADER_CLASS = 'dbpm-header';         // class on the injected BPM column header
    const INJECTED_ATTR = 'data-dbpm-injected';  // attribute we set on rows we already processed
    const STORAGE_KEY = 'deezerBpmPlaylistMode'; // localStorage key for playlist mode preference
    const COVER_PLACEHOLDER_ID = 'd41d8cd98f00b204e9800998ecf8427e' // hash of the cover image placeholder
    const UNRESOLVABLE = Symbol('unresolvable'); // returned by resolvers to permanently skip a row

    // ── Persistent BPM cache ─────────────────────────────────────────────────
    // We cache BPM values so we never fetch the same track twice, even across
    // page reloads. The in-memory Map is populated from extension storage at
    // startup and written back after every new fetch.

    const bpmCache = new Map(); // trackId (string) → number|null
    const coverCache = new Map(); // coverId (string) → albumId (string|null)
    const inFlight = new Map(); // inFlightId (string) → Promise
    const albumCache = new Map(); // coverId (string) → albumData
    const coverTrackCache = new Map(); // coverId+trackTitle (string) → trackId (string|null)
    // Tracks requests that are currently in-flight so
    // two callers asking for the same track share one fetch.

    // browser.storage is the Firefox API name; chrome.storage is Chrome's.
    // We pick whichever is available so the same code works in both browsers.
    const storageApi = (typeof browser !== 'undefined' && browser.storage)
        ? browser.storage
        : chrome.storage;

    const BPM_CACHE_STORAGE_KEY = 'deezerBpmCache';
    const COVER_CACHE_STORAGE_KEY = 'deezerCoverIdCache';
    const CLEAR_CACHE_STORAGE_KEY = 'deezerBpmCacheClear';
    const COVER_TRACK_CACHE_STORAGE_KEY = 'deezerCoverTrackCache';
    const MAX_CACHE_SIZE = 5000; // cap to avoid filling up extension storage
    const DEBUG = localStorage.getItem('deezerBpmDebug') === '1';

    // ── Debug logging ─────────────────────────────────────────────────────────
    // Set localStorage key 'deezerBpmDebug' to '1' in the browser console to
    // enable verbose logging. Persists across reloads until manually removed.
    //   enable:  localStorage.setItem('deezerBpmDebug', '1')
    //   disable: localStorage.removeItem('deezerBpmDebug')
    const logDebugInfo = DEBUG
        ? (msg, ...args) => console.log('%c[Deezer BPM]', 'color: white; background: #7B2FBE; border-radius: 3px; font-weight: bold', msg, ...args)
        : () => {
        };

    const logDebugError = DEBUG
        ? (msg, ...args) => console.log('%c[Deezer BPM]', 'color: white; background: red; border-radius: 3px; font-weight: bold', msg, ...args)
        : () => {
        };

    async function checkCacheClear() {
        try {
            if (localStorage.getItem(CLEAR_CACHE_STORAGE_KEY) === '1') {
                storageApi.local.remove([BPM_CACHE_STORAGE_KEY, COVER_CACHE_STORAGE_KEY, COVER_TRACK_CACHE_STORAGE_KEY]);
                logDebugInfo('Cache cleared');
                localStorage.removeItem(CLEAR_CACHE_STORAGE_KEY);
            }
        } catch (e) {
            console.warn('[Deezer BPM] Error clearing cache:', e);
        }
    }

    // Read the persisted cache from extension storage into the in-memory Map.
    // Called once at startup, before any fetches happen.
    async function loadPersistedCache() {
        try {
            const cache = await storageApi.local.get([
                BPM_CACHE_STORAGE_KEY,
                COVER_CACHE_STORAGE_KEY,
                COVER_TRACK_CACHE_STORAGE_KEY,
            ]);

            const savedBpm = cache[BPM_CACHE_STORAGE_KEY];
            if (savedBpm && typeof savedBpm === 'object') {
                for (const [id, bpm] of Object.entries(savedBpm)) bpmCache.set(id, bpm);
            }
            const savedCover = cache[COVER_CACHE_STORAGE_KEY];
            if (savedCover && typeof savedCover === 'object') {
                for (const [id, albumId] of Object.entries(savedCover)) coverCache.set(id, albumId);
            }
            const savedCoverTrack = cache[COVER_TRACK_CACHE_STORAGE_KEY];
            if (savedCoverTrack && typeof savedCoverTrack === 'object') {
                for (const [key, trackId] of Object.entries(savedCoverTrack)) coverTrackCache.set(key, trackId);
            }
        } catch (e) {
            console.warn('[Deezer BPM] Could not load caches:', e);
        }
    }

    // Write the in-memory cache back to extension storage.
    // We debounce by 2 s so that a burst of fetches (e.g. loading a full playlist)
    // only triggers one write instead of hundreds.
    let saveDebounce = null;

    function scheduleSaveCache() {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(persistCaches, 2000);
    }

    function persistCaches() {
        const bpmEntries = [...bpmCache.entries()].slice(-MAX_CACHE_SIZE);
        const coverEntries = [...coverCache.entries()].slice(-MAX_CACHE_SIZE);
        const coverTrackEntries = [...coverTrackCache.entries()].slice(-MAX_CACHE_SIZE);
        storageApi.local.set({
            [BPM_CACHE_STORAGE_KEY]: Object.fromEntries(bpmEntries),
            [COVER_CACHE_STORAGE_KEY]: Object.fromEntries(coverEntries),
            [COVER_TRACK_CACHE_STORAGE_KEY]: Object.fromEntries(coverTrackEntries),
        }).catch(e => console.warn('[Deezer BPM] Could not persist cache:', e));
    }

    // ── Fetch queue (max 3 concurrent requests) ───────────────────────────────
    // When playlist mode is on we could fire dozens of API requests at once,
    // which would likely get rate-limited. This queue keeps at most 3 requests
    // running simultaneously and queues the rest.
    function createQueue(max = 3) {
        return {
            running: 0,
            max,
            pending: [],
            // Enqueue a function; returns a Promise that resolves with its return value.
            add(fn) {
                return new Promise((resolve, reject) => {
                    this.pending.push({fn, resolve, reject});
                    this._run();
                });
            },
            // Start the next pending task if we're below the concurrency limit.
            async _run() {
                if (this.running >= this.max || !this.pending.length) return;
                this.running++;
                const {fn, resolve, reject} = this.pending.shift();
                try {
                    resolve(await fn());
                } catch (e) {
                    reject(e);
                } finally {
                    this.running--;
                    this._run();
                } // when one finishes, start the next
            },
        };
    }

    const queue = createQueue(5);
    const albumQueue = createQueue(3);

    // Fetch the BPM for a single track, using the in-memory cache and the queue.
    async function fetchBpmCached(trackId) {
        const id = String(trackId); // normalise to string so cache keys are consistent
        const inFlightId = "track:" + id;
        if (bpmCache.has(id)) return bpmCache.get(id); // already known — return immediately
        if (inFlight.has(inFlightId)) return inFlight.get(inFlightId); // request already in-flight — share it

        // No cache hit — create a new queued fetch.
        const promise = queue.add(async () => {
            try {
                const resp = await fetch(`https://api.deezer.com/track/${id}`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                logDebugInfo('Fetched track from API:', data);
                // Deezer reports 0 for tracks with no BPM data; treat that as "unknown".
                const bpm = (typeof data.bpm === 'number' && data.bpm > 0) ? Math.round(data.bpm) : null;
                bpmCache.set(id, bpm);
                scheduleSaveCache();
                return bpm;
            } finally {
                // Always remove from inFlight when done, whether it succeeded or threw.
                inFlight.delete(inFlightId);
            }
        });

        inFlight.set(inFlightId, promise);
        return promise;
    }

    // Fetch the album info for an id, using the in-memory cache and the queue.
    async function fetchAlbumCached(albumId) {
        const id = String(albumId); // normalise to string so cache keys are consistent
        if (albumCache.has(id)) return albumCache.get(id);
        const inFlightId = "album:" + id;
        if (inFlight.has(inFlightId)) return inFlight.get(inFlightId); // request already in-flight — share it
        // No cache hit — create a new queued fetch.
        const promise = albumQueue.add(async () => {
            try {
                logDebugInfo('No inflight request for album id: ', id)
                const resp = await fetch(
                    `https://api.deezer.com/album/${id}`
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                logDebugInfo('Fetched raw data from API:', data);
                if (data.error) throw new Error(`API error: ${data.error}`);

                // Collect the first page of tracks
                let allTracks = [];
                let nextUrl = data.tracklist;

                while (nextUrl) {
                    const pageResp = await fetch(nextUrl);
                    if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status}`);
                    const pageData = await pageResp.json();
                    if (pageData.error) throw new Error(`API error: ${pageData.error}`);
                    allTracks = allTracks.concat(pageData.data || []);
                    nextUrl = pageData.next || null;
                }
                logDebugInfo('Fetched all tracks via tracklist, total:', allTracks.length, '(nb_tracks reported:', data.nb_tracks, ')');
                const albumData = {
                    id: data.id,
                    title: data.title,
                    coverId: data.md5_image,
                    tracks: allTracks.map(track => ({
                        id: track.id,
                        title: track.title
                    })),
                };
                logDebugInfo('Fetched album from API:', albumData);
                albumCache.set(id, albumData);
                logDebugInfo('Album cache size:', albumCache.size);
                logDebugInfo('Set album cover cache entry for coverId:', data.md5_image, 'with albumId:', id);
                coverCache.set(data.md5_image, id)
                return albumData;
            } finally {
                // Always remove from inFlight when done, whether it succeeded or threw.
                inFlight.delete(inFlightId);
            }
        });

        inFlight.set(inFlightId, promise);
        return promise;
    }

    // ── Badge ─────────────────────────────────────────────────────────────────
    // The floating badge is a small circular widget fixed to the bottom-right
    // corner. It shows the BPM of the currently playing track and has a toggle
    // button (≡) to enable/disable playlist mode.

    // Returns the badge element, creating it if it doesn't exist yet.
    function getBadge() {
        let badge = document.getElementById(BADGE_ID);
        if (!badge) {
            badge = document.createElement('div');
            badge.id = BADGE_ID;
            badge.innerHTML =
                '<span class="dbpm-label">BPM</span>' +
                '<span class="dbpm-value">–</span>' +
                '<button class="dbpm-list-btn" title="Show BPM in playlist">≡</button>';
            // Reflect current playlist mode state on the button right away.
            badge.querySelector('.dbpm-list-btn').classList.toggle('dbpm-list-btn--on', playlistModeEnabled);
            document.body.appendChild(badge);
        }
        return badge;
    }

    // Update the BPM number shown on the badge.
    // `active` adds a visual highlight (purple border) when a real BPM is shown.
    function setBadgeValue(text, active) {
        const badge = getBadge();
        badge.querySelector('.dbpm-value').textContent = text;
        badge.classList.toggle('dbpm-active', !!active);
    }

    // Deezer is a SPA and sometimes removes/replaces body children during navigation.
    // This observer recreates the badge if it disappears.
    new MutationObserver(() => {
        if (!document.getElementById(BADGE_ID)) getBadge();
    }).observe(document.body, {childList: true});

    // ── Player – track detection ──────────────────────────────────────────────
    // We need to know which track is currently playing so we can fetch its BPM.
    // Deezer doesn't expose a simple event for this, so we infer it from the URL
    // or from DOM elements in the player bar.

    let currentTrackId = null; // track ID shown on the badge right now

    // Extract the playing track ID from the miniplayer by:
    // 1. Reading the track title and album link from data-testid="miniplayer_container"
    // 2. Fetching the album's track list from the Deezer API
    // 3. Matching the track title against the list to find the exact track ID
    // This guarantees the same ID as the playlist injection uses, so BPMs always agree.
    async function detectTrackIdFromPlayer() {
        const container = document.querySelector('[data-testid="miniplayer_container"]');
        if (!container) return null;

        // The single item_title in the player contains an anchor whose text is the
        // track title and whose href contains the album ID.
        const anchor = container.querySelector('[data-testid="item_title"] a[href*="/album/"]');
        if (!anchor) return null;

        const rawTitle = anchor.textContent.trim();

        const albumMatch = anchor.getAttribute('href').match(/\/album\/(\d+)/);
        if (!albumMatch) return null;
        const albumId = albumMatch[1];

        // ── Fast path: try to resolve via the cover image in the miniplayer ──
        // If the cover is already in coverCache and the track is in coverTrackCache
        // we can resolve without any network request.
        const coverId = extractCoverId(container, 'item_cover')
        let key = null;
        if (coverId) {
            key = makeCoverTrackKey(coverId, rawTitle)
            logDebugInfo('[BADGE] Checking cover cache for:', key);
            const cachedTrackId = coverTrackCache.get(key)
            if (cachedTrackId) {
                logDebugInfo('[BADGE] Cover cache hit:', cachedTrackId);
                return cachedTrackId;
            } else {
                logDebugInfo('[BADGE] Cover cache miss for cover:', coverId);
            }
        } else {
            logDebugInfo('[BADGE] cover track cache miss for cover:', coverId);
        }

        try {
            logDebugInfo('[BADGE] Fetching album data for trackd id detection', albumId)
            const albumData = await fetchAlbumCached(albumId);
            const match = (albumData.tracks || []).find(
                t => normalizeTrackKeyPart(t.title) === normalizeTrackKeyPart(rawTitle)
            );
            const trackId = match ? String(match.id) : null;
            if (trackId) {
                logDebugInfo('[BADGE] Album track match:', match);
                if (key) coverTrackCache.set(key, trackId);
            }
            return trackId
        } catch (e) {
            logDebugInfo('[BADGE] Album track fetch error:', e);
            return null;
        }
    }

    // Refresh the floating badge for the currently playing track.
    // Called whenever the title or URL changes.
    let badgeUpdateId = 0; // incremented on each call; lets stale calls detect they've been superseded
    async function updatePlayerBadge() {
        const callId = ++badgeUpdateId;
        setBadgeValue('…');
        const trackId = await detectTrackIdFromPlayer().catch(() => null);
        if (callId !== badgeUpdateId) return; // a newer call has started — discard this result
        if (!trackId) {
            setBadgeValue('–');
            currentTrackId = null;
            return;
        }
        if (trackId === currentTrackId) return; // nothing changed, skip
        currentTrackId = trackId;
        setBadgeValue('…');
        try {
            const bpm = await fetchBpmCached(trackId);
            if (callId !== badgeUpdateId) return; // superseded while waiting for BPM
            logDebugInfo('Fetched track BPM:', bpm);
            setBadgeValue(bpm ?? 'N/A', bpm !== null);
        } catch (err) {
            logDebugError('[BADGE] Failed to update', err);
            setBadgeValue('✕');
        }
    }

    // ── Playlist mode ─────────────────────────────────────────────────────────
    // When enabled, a BPM tag is injected next to the duration of every visible
    // row in a playlist or album view. Deezer uses a virtualised list so only a
    // handful of rows exist in the DOM at any time; we use a MutationObserver to
    // inject tags into newly rendered rows as the user scrolls.

    let playlistModeEnabled = true;
    let playlistObserver = null;
    let currentPageUrl = null; // pathname for which currentTrackIds was fetched
    let isLoadingTrackIds = false; // prevents concurrent loads of the same page
    let isTrackPage = false; // true when on a playlist or album page

    // Entry point for injecting BPMs into the current page.
    // Handles the case where the page URL changed since the last call (navigated
    // to a different playlist/album) by fetching a fresh track list first.
    async function injectPlaylistBpms() {
        if (currentPageUrl !== location.pathname) {
            // The user navigated to a new page. Clean up any tags from the previous page
            // before loading the new track list.
            removePlaylistBpms();

            const targetUrl = location.pathname;
            isLoadingTrackIds = true;
            currentPageUrl = targetUrl; // set early so other callers see the new URL
            isTrackPage = false;

            try {
                isTrackPage = detectPageType();
            } finally {
                isLoadingTrackIds = false;
            }

            // If the URL changed *again* while we were awaiting the API response,
            // our data is already stale. Reset and schedule a fresh attempt.
            if (location.pathname !== targetUrl) {
                currentPageUrl = null;
                setTimeout(injectPlaylistBpms, 100);
                return;
            }
        }

        if (!isTrackPage) return; // not a playlist/album page

        injectPlaceholders();
    }

    // Enable or disable playlist mode, persisting the preference to localStorage.
    function setPlaylistMode(enabled) {
        playlistModeEnabled = enabled;
        localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
        getBadge().querySelector('.dbpm-list-btn').classList.toggle('dbpm-list-btn--on', enabled);
        if (enabled) {
            injectPlaylistBpms();
            startPlaylistObserver();
        } else {
            removePlaylistBpms();
            stopPlaylistObserver();
        }
    }

    // Inspect the current URL and determine if this is a playlist or album page.
    // Returns true if BPM injection should proceed, false otherwise.
    function detectPageType() {
        return /\/(playlist|album)\/\d+/.test(location.pathname);
    }

    // ── Deezer API – fetch ordered track IDs for current playlist/album ───────
    // We need the track IDs in the same order as they appear on the page so we
    // can map each row's aria-rowindex (1-based position) to a track ID.
    // We also build lookup maps so we can re-identify tracks after the user sorts
    // the list by a column header.

    function normalizeTrackKeyPart(value) {
        return String(value)
            .trim()
            .replace(/^\d+\.\s+/, '') // strip leading track number e.g. "1. " or "12. "
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[’']/g, "'")
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function makeCoverTrackKey(coverId, title) {
        return coverId + '\0' + normalizeTrackKeyPart(title);
    }

    function makeTrackKey(title, artistId) {
        const parts = [normalizeTrackKeyPart(title), normalizeTrackKeyPart(artistId)];
        return parts.join('\0');
    }

    function extractRowElement(row) {
        const coverImg = row.querySelector('[data-testid="cover"] img');
        const titleEl = row.querySelector('[data-testid="title"]');
        const artistEl = row.querySelector('[data-testid="artist"]');
        const albumEl = row.querySelector('[data-testid="album"]');
        const coverMatch = coverImg?.getAttribute('src')?.match(/\/images\/cover\/([a-f0-9]+)\//);
        const coverId = coverMatch ? coverMatch[1] : null;
        return {titleEl, artistEl, albumEl, coverId};
    }

    // Waits until the cover image src is populated (up to `maxWait` ms),
    // then returns the row elements including a resolved coverId.
    async function extractRowElementAsync(row, maxWait = 800) {
        const result = extractRowElement(row);
        if (result.coverId) return result;

        // Cover ID not yet available — poll briefly for it.
        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 50));
            if (!row.isConnected) break; // row was removed while we waited
            const retried = extractRowElement(row);
            if (retried.coverId !== null && retried.coverId !== COVER_PLACEHOLDER_ID) return retried;
        }
        return result; // return whatever we have, coverId may still be null
    }

    // Extract a coverId from any element's cover image, filtering out the placeholder.
    function extractCoverId(el, coverTestId = 'cover') {
        const coverImg = el.querySelector(`[data-testid="${coverTestId}"] img`);
        const coverMatch = coverImg?.getAttribute('src')?.match(/\/images\/cover\/([a-f0-9]+)\//);
        const coverId = coverMatch ? coverMatch[1] : null;
        return coverId !== COVER_PLACEHOLDER_ID ? coverId : null;
    }

    // Resolve a track ID for a row. Strategy:
    // 1. Fast path: check albumIdTrackIdMap via coverId (free, no network)
    // 2. Album path: fetch the album tracklist and match by title
    // 3. Search fallback: use the Deezer search API by title + artist (queue rows only,
    //    when no album link is available)
    async function resolveRowTrackId(row, {allowSearchFallback = false} = {}) {
        const {titleEl, artistEl, albumEl, coverId} = await extractRowElementAsync(row);
        if (!titleEl) return null;

        const rawTitle = titleEl.textContent.trim();

        // ── 1. Fast path ─────
        let key = null;
        if (coverId) {
            // ── 1a. Fastest path: coverId + title → trackId (single lookup) ──────
            key = makeCoverTrackKey(coverId, rawTitle)
            const cached = coverTrackCache.get(key);
            if (cached) {
                logDebugInfo('[ROW RES]', 'Cover cache hit:', key);
                return cached;
            }
            logDebugInfo('[ROW RES]', 'Cover cache miss:', key);

            // ── 1b. Cover path: coverId → albumId → in-memory album → trackId ────
            const albumId = coverCache.get(coverId);
            if (albumId) {
                logDebugInfo('[ROW RES]', 'Album cache hit:', albumId, rawTitle);
                const albumData = albumCache.get(albumId);
                if (albumData) {
                    const match = albumData.tracks.find(
                        t => normalizeTrackKeyPart(t.title) === normalizeTrackKeyPart(rawTitle)
                    );
                    const trackId = match ? String(match.id) : null;
                    if (trackId) {
                        logDebugInfo('[ROW RES]', 'Track cache hit:', key);
                        coverTrackCache.set(key, trackId);
                        scheduleSaveCache();
                        return trackId;
                    } else {
                        logDebugInfo('[ROW RES]', 'Track not found in album data:', albumData);
                    }
                } else {
                    logDebugInfo('[ROW RES]', 'Album cache miss:', key);
                }
            }
        }

        // ── 2. Album path: resolve albumId from DOM or URL, fetch if needed ──
        let albumId;
        if (albumEl) {
            // Album link is present in the row, use it to resolve the album ID.
            const albumMatch = albumEl.getAttribute('href').match(/\/album\/(\d+)/);
            albumId = albumMatch ? albumMatch[1] : null;
        } else {
            // We probably are on an album page, extract album ID from URL.
            albumId = location.pathname.match(/\/album\/(\d+)/)?.[1] ?? null;
        }

        if (albumId) {
            if (DEBUG) logDebugInfo('[ROW RES]', 'Album ID found:', albumId);
            if (coverId && !coverCache.has(coverId)) coverCache.set(coverId, albumId);

            try {
                if (DEBUG) logDebugInfo('[ROW RES]', 'Fetching album data for ID:', albumId);
                const albumData = await fetchAlbumCached(albumId);
                const match = (albumData.tracks || []).find(
                    t => normalizeTrackKeyPart(t.title) === normalizeTrackKeyPart(rawTitle)
                );
                const trackId = match ? String(match.id) : null;
                if (trackId) {
                    if (DEBUG) logDebugInfo('[ROW RES]', 'Track ID found:', trackId);
                } else {
                    if (DEBUG) logDebugInfo('[ROW RES]', 'Track ID not found:', trackId);
                }
                if (trackId && albumData.coverId) {
                    coverTrackCache.set(makeCoverTrackKey(albumData.coverId, rawTitle), trackId);
                }
                if (!allowSearchFallback) return trackId;
            } catch (e) {
                if (DEBUG) logDebugInfo('[ROW RES]', 'Album fetch failed', e);
                if (!allowSearchFallback) return UNRESOLVABLE;
            }
        } else {
            if (DEBUG) logDebugInfo('[ROW RES]', 'No album ID found');
        }

        // ── 3. Search fallback (queue rows without album link) ────────────
        if (!allowSearchFallback || !artistEl) return UNRESOLVABLE;


        const artistName = artistEl.textContent.trim();
        const query = `track:"${rawTitle}" artist:"${artistName}"`;

        if (inFlight.has(query)) return inFlight.get(query);

        const searchPromise = albumQueue.add(async () => {
            try {
                if (DEBUG) logDebugInfo('[ROW RES]', 'Search fallback for', query);
                const resp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`);
                if (!resp.ok) return UNRESOLVABLE;
                const data = await resp.json();
                if (DEBUG) logDebugInfo('[ROW RES]', 'Search response:', data);
                const results = data.data || [];
                // Try to find a result whose cover image matches the row's cover.
                const match = results.find(r => r.md5_image === coverId) ?? results[0];
                const trackId = match?.id !== null ? String(match.id) : UNRESOLVABLE;
                // Exact match found, cache it.
                if (trackId !== UNRESOLVABLE) {
                    if (DEBUG) logDebugInfo('[ROW RES]', 'Search hit:', trackId, '. Caching it...');
                    coverTrackCache.set(key, trackId);
                } else {
                    if (DEBUG) logDebugInfo('[ROW RES]', 'Search hit ', trackId, 'for ', query, 'and cover', coverId, '. Not caching it.');
                }
                return trackId;
            } catch {
                if (DEBUG) logDebugError('Search failed for', query);
                return UNRESOLVABLE;
            } finally {
                inFlight.delete(query);
            }
        });

        inFlight.set(query, searchPromise);
        return searchPromise;
    }

    // ── Playlist injection ────────────────────────────────────────────────────

    // Given a playlist row element, find the cell that contains the track duration
    // (e.g. "3:45") so we can insert our BPM tag just before it.
    //
    // Deezer's DOM doesn't have stable class names for the duration column, so we
    // detect it by content: a leaf element whose text matches mm:ss. We then walk
    // up the tree to find the direct child of the row's column container — any
    // ancestor with 3+ siblings is the column layout level we want.
    function findDurationCell(row) {
        let el = row.querySelector('[data-testid="duration"]');
        if (!el) return null;

        // Walk up to the column-level ancestor (first parent with 3+ siblings).
        while (el.parentElement && el.parentElement !== row) {
            if (el.parentElement.children.length >= 3) return el;
            el = el.parentElement;
        }
        return null;
    }

    function injectBpmsIntoRows(container, resolveTrackId, {
        rowFilter = null,
        eagerSpan = false
    } = {}) {
        const rows = [...container.querySelectorAll('[role="row"][aria-rowindex]')];

        for (const row of rows) {
            const injectedAttr = row.getAttribute(INJECTED_ATTR);

            if (injectedAttr === 'pending') continue;

            if (injectedAttr === '1') {
                const existing = row.querySelector(`.${INLINE_CLASS}`);
                if (existing) {
                    const currentKey = getRowKey(row);
                    if (existing.dataset.dbpmRowKey === currentKey) continue; // unchanged — skip

                    // Row was recycled. If the new track's BPM is already cached,
                    // update the span in place instantly to avoid any '…' flash.
                    const cachedTrackId = existing.dataset.dbpmTrack;
                    if (cachedTrackId) {
                        const bpm = bpmCache.get(cachedTrackId);
                        if (bpm !== undefined) {
                            existing.dataset.dbpmRowKey = currentKey;
                            existing.textContent = bpm !== null ? String(bpm) : 'N/A';
                            continue;
                        }
                    }

                    existing.remove(); // stale — remove and re-inject below
                }
                row.removeAttribute(INJECTED_ATTR);
            }

            if (rowFilter && !rowFilter(row)) continue;

            // Claim the row synchronously to prevent concurrent injection.
            row.setAttribute(INJECTED_ATTR, 'pending');

            // When eagerSpan is true, insert the placeholder span immediately
            // (before any await) so '…' appears for all rows at once.
            const span = eagerSpan ? createBpmSpan(row) : null;

            resolveTrackId(row).then(trackId => {
                if (!row.isConnected) {
                    row.removeAttribute(INJECTED_ATTR);
                    span?.remove();
                    return;
                }
                if (trackId === null) {
                    // Transiently unresolvable (row not ready yet) — leave unmarked for retry.
                    row.setAttribute(INJECTED_ATTR, '1');
                    if (span) span.textContent = '–';
                    return;
                }
                if (row.getAttribute(INJECTED_ATTR) !== 'pending') {
                    // Another injection took over this row while we were awaiting.
                    span?.remove();
                    return;
                }

                row.setAttribute(INJECTED_ATTR, '1');
                const rowKey = getRowKey(row) ?? trackId;

                if (trackId === UNRESOLVABLE) {
                    // Permanently failed — show '✕' and don't retry.
                    if (span) {
                        span.dataset.dbpmRowKey = rowKey;
                        span.textContent = '✕';
                    }
                    return;
                }

                // Reuse the eager span if present, otherwise create one now.
                const bpmSpan = span ?? createBpmSpan(row, {rowKey});
                if (span) span.dataset.dbpmRowKey = rowKey;
                bpmSpan.dataset.dbpmTrack = trackId;

                fetchBpmCached(trackId).then(renderBpmValue(bpmSpan, trackId)).catch(err => {
                    if (DEBUG) console.warn('[Deezer BPM] fetch error for track', trackId, err);
                    if (bpmSpan.isConnected) bpmSpan.textContent = 'N/A';
                });
            });
        }
    }

    // Inject BPM placeholders into all currently visible rows that haven't been
    // processed yet. The actual BPM value is filled in asynchronously once fetched.
    // Also handles in-place row recycling (e.g. after a column-header sort) by
    // detecting when a row's track has changed and refreshing its BPM span.
    function injectPlaceholders() {
        // Guard: don't inject stale data if the page has already changed.
        if (!isTrackPage || currentPageUrl !== location.pathname) return;

        // Inject the BPM column header if not already present.
        injectColumnHeader();

        injectBpmsIntoRows(document, row => resolveRowTrackId(row), {
            eagerSpan: true,
            rowFilter: row =>
                !row.closest('.player-queuelist') &&
                !!row.querySelector('[data-testid="title"]') &&
                !row.querySelector('button[aria-label="Add track"]'),
        });
    }

    // Remove all BPM tags we injected and clear the "already processed" markers
    // so they will be re-injected if playlist mode is turned back on.
    function removePlaylistBpms() {
        document.querySelectorAll(`.${INLINE_CLASS}, .${HEADER_CLASS}`).forEach(el => el.remove());
        document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => el.removeAttribute(INJECTED_ATTR));
    }

    // Inject a "BPM" columnheader into the playlist header row, positioned just
    // before the duration header. Idempotent — does nothing if already injected.
    function injectColumnHeader() {
        // Already injected — nothing to do.
        if (document.querySelector(`.${HEADER_CLASS}`)) return;

        // Find the duration columnheader: the one whose text matches a time pattern
        // (e.g. "DURÉE", "DURATION") or that contains a clock/duration icon.
        // As a fallback we match the last columnheader in the row.
        const headers = [...document.querySelectorAll('[role="columnheader"]')];
        if (!headers.length) return;

        // Use findDurationCell on a live data row to detect which column index
        // holds the duration, then insert the BPM header before that column header.
        let durationHeader = null;
        const sampleRow = document.querySelector('[role="row"][aria-rowindex]');
        if (sampleRow) {
            const durationCell = findDurationCell(sampleRow);
            if (durationCell) {
                const colIndex = [...durationCell.parentElement.children].indexOf(durationCell);
                logDebugInfo("Found duration cell column index ", colIndex)
                if (colIndex >= 0 && colIndex < headers.length) {
                    durationHeader = headers[colIndex];
                }
            }
        }
        if (!durationHeader) return;

        const bpmHeader = document.createElement('div');
        bpmHeader.className = HEADER_CLASS;
        bpmHeader.setAttribute('role', 'columnheader');

        const btn = document.createElement('button');
        btn.className = durationHeader.querySelector('button')?.className ?? '';
        btn.type = 'button';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'BPM');
        btn.textContent = 'BPM';

        bpmHeader.appendChild(btn);

        durationHeader.before(bpmHeader);
    }

    function getRowKey(row) {
        const titleEl = row.querySelector('[data-testid="title"]');
        const artistEl = row.querySelector('[data-testid="artist"]');
        const title = titleEl.textContent.trim();
        const artistName = artistEl?.textContent.trim() ?? '';
        return makeTrackKey(title, artistName);
    }

    function renderBpmValue(span, trackId) {
        return bpm => {
            if (!span.isConnected || span.dataset.dbpmTrack !== trackId) return;
            span.textContent = bpm !== null ? String(bpm) : 'N/A';
            if (bpm !== null) span.classList.add(`${INLINE_CLASS}--loaded`)
            else span.classList.add(`${INLINE_CLASS}--unknown`);
        };
    }

    function createBpmSpan(row, {rowKey = null} = {}) {
        const span = document.createElement('span');
        span.className = INLINE_CLASS;
        if (rowKey !== null) span.dataset.dbpmRowKey = rowKey;
        span.textContent = '…';

        const durationCell = findDurationCell(row);
        if (durationCell) durationCell.before(span);
        else row.appendChild(span);

        return span;
    }

    async function injectQueueBpms() {
        const queueContainer = document.querySelector('.player-queuelist');
        if (!queueContainer) return;

        injectBpmsIntoRows(queueContainer, row => resolveRowTrackId(row, {allowSearchFallback: true}), {
            eagerSpan: true,
        })
    }

    // Watch the entire document for newly added rows.
    // Deezer's virtualised list only keeps visible rows in the DOM; as the user
    // scrolls, old rows are removed and new ones are added. We use this observer
    // to inject BPM tags into those new rows on the fly.
    function startPlaylistObserver() {
        if (playlistObserver) return;
        playlistObserver = new MutationObserver((mutations) => {
            // Only act when actual row elements were added to the DOM.
            // We ignore mutations caused by our own span insertions (INLINE_CLASS).
            const hasNewRows = mutations.some(m =>
                [...m.addedNodes].some(n =>
                    n.nodeType === 1 &&
                    !n.classList?.contains(INLINE_CLASS) &&
                    (n.getAttribute?.('role') === 'row' || n.querySelector?.('[role="row"][aria-rowindex]'))
                )
            );
            if (!hasNewRows) return;

            // Inject into the queue list if it's open, independently of the page state.
            injectQueueBpms();

            // Self-healing: if the page changed (e.g. the user navigated to a different
            // album), trigger a full reload of track IDs before injecting.
            // This is the primary navigation detection path — it doesn't rely on URL
            // change events, which can be missed in SPAs.
            if (currentPageUrl !== location.pathname) {
                injectPlaylistBpms();
            } else {
                injectPlaceholders();
            }
        });
        playlistObserver.observe(document.documentElement, {childList: true, subtree: true});
    }

    function stopPlaylistObserver() {
        if (playlistObserver) {
            playlistObserver.disconnect();
            playlistObserver = null;
        }
    }

    // ── Change detection (player + URL) ──────────────────────────────────────
    // Deezer is a SPA that uses the History API (pushState) for navigation.
    // There is no built-in event for pushState changes, so we infer them from
    // <title> mutations (the title always changes when the track or page changes)
    // and from the popstate event (browser back/forward navigation).

    let lastUrl = location.href;
    let urlChangeTimer = null;

    function onUrlChange() {
        if (location.href === lastUrl) return; // spurious call — nothing actually changed
        lastUrl = location.href;
        currentTrackId = null;
        updatePlayerBadge();
        // Playlist cleanup is intentionally NOT done here. The MutationObserver and
        // the safety net interval both check currentPageUrl !== location.pathname and
        // call injectPlaylistBpms() (which runs removePlaylistBpms() first) when the
        // page changes. Removing BPMs here caused them to disappear when clicking play,
        // because Deezer updates the URL as part of starting playback.
    }

    // Debounce URL change handling by 150 ms to avoid acting on intermediate states
    // during navigation (e.g. title changes before the new page is fully rendered).
    function scheduleUrlChange() {
        clearTimeout(urlChangeTimer);
        urlChangeTimer = setTimeout(onUrlChange, 150);
    }

    function setupMiniplayerObserver(miniplayerEl) {
        let lastPlayerTitle = null;
        new MutationObserver(() => {
            const anchor = miniplayerEl.querySelector('[data-testid="item_title"] a[href*="/album/"]');
            const title = anchor?.textContent ?? null;
            if (title === lastPlayerTitle) return;
            logDebugInfo("[MINIPLAYER] title changed", lastPlayerTitle, '->', title);
            lastPlayerTitle = title;
            currentTrackId = null;
            updatePlayerBadge();
        }).observe(miniplayerEl, {childList: true, subtree: true, characterData: true});
    }

    // Make sure the mini player is loaded before setting up the mutation observer
    const miniplayerEl = document.querySelector('[data-testid="miniplayer_container"]');
    if (miniplayerEl) {
        setupMiniplayerObserver(miniplayerEl);
    } else {
        const waitForMiniplayer = new MutationObserver(() => {
            const el = document.querySelector('[data-testid="miniplayer_container"]');
            if (!el) return;
            waitForMiniplayer.disconnect();
            setupMiniplayerObserver(el);
            updatePlayerBadge();
        });
        waitForMiniplayer.observe(document.body, {childList: true, subtree: true});
    }

    // Watch the <title> element only for URL/navigation changes (not for badge updates).
    const titleEl = document.querySelector('title');
    if (titleEl) {
        new MutationObserver(scheduleUrlChange).observe(titleEl, {childList: true});
    }

    // Also handle browser back/forward navigation (popstate).
    window.addEventListener('popstate', scheduleUrlChange);

    // Flush cache immediately when the page is hidden (tab switch, navigation, extension reload)
    // to avoid losing entries that are still pending in the debounce timer.
    window.addEventListener('pagehide', () => {
        clearTimeout(saveDebounce);
        persistCaches();
    });

    // Safety net: Deezer's virtualised list sometimes recycles existing row elements
    // (updating them in-place) instead of removing and re-adding them. In that case
    // the MutationObserver never fires for new rows, and URL changes go undetected.
    // This interval catches those cases within 2.5 seconds.
    // It also re-checks existing rows after a column-header sort, where Deezer
    // may recycle rows with new track content without triggering the observer.
    setInterval(() => {
        if (!playlistModeEnabled || isLoadingTrackIds) return;
        if (currentPageUrl !== location.pathname) {
            injectPlaylistBpms();
        } else if (isTrackPage) {
            injectPlaceholders(); // re-check rows in case they were sorted in-place
        }
    }, 2500);

    // ── Toggle – capture-phase listener so Deezer can't intercept it ─────────
    // Deezer's UI framework (Chakra UI) stops click events from bubbling in some
    // contexts, which silently swallows our button clicks. Listening in the capture
    // phase (the event travels down before bubbling up) ensures we always see it.
    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.dbpm-list-btn')) {
            e.stopPropagation();
            setPlaylistMode(!playlistModeEnabled);
        }
    }, true /* capture */);

    // ── Init ──────────────────────────────────────────────────────────────────

    // Load the persisted BPM cache first so any track already known doesn't need
    // a network request. Then restore playlist mode if it was active last session
    // (delayed 900 ms to give Deezer time to render the playlist before we inject).
    checkCacheClear().then(loadPersistedCache).then(() => {
        if (localStorage.getItem(STORAGE_KEY) === '1') {
            setTimeout(() => setPlaylistMode(true), 900);
        } else {
            getBadge(); // create the badge even if playlist mode is off
        }
    });
})();

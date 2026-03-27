(function () {
  'use strict';

  // DOM identifiers used to find/mark our own elements.
  // Keeping them as constants prevents typos and makes them easy to change.
  const BADGE_ID        = 'deezer-bpm-badge';   // id of the floating badge div
  const INLINE_CLASS    = 'dbpm-inline';         // class on each per-row BPM span
  const HEADER_CLASS    = 'dbpm-header';         // class on the injected BPM column header
  const INJECTED_ATTR   = 'data-dbpm-injected';  // attribute we set on rows we already processed
  const STORAGE_KEY     = 'deezerBpmPlaylistMode'; // localStorage key for playlist mode preference

  // ── Persistent BPM cache ─────────────────────────────────────────────────
  // We cache BPM values so we never fetch the same track twice, even across
  // page reloads. The in-memory Map is populated from extension storage at
  // startup and written back after every new fetch.

  const bpmCache = new Map(); // trackId (string) → number|null
  const inFlight = new Map(); // trackId (string) → Promise<number|null>
                              // Tracks requests that are currently in-flight so
                              // two callers asking for the same track share one fetch.

  // browser.storage is the Firefox API name; chrome.storage is Chrome's.
  // We pick whichever is available so the same code works in both browsers.
  const storageApi = (typeof browser !== 'undefined' && browser.storage)
    ? browser.storage
    : chrome.storage;

  const CACHE_STORAGE_KEY = 'deezerBpmCache';
  const MAX_CACHE_SIZE    = 5000; // cap to avoid filling up extension storage

  // ── Debug logging ─────────────────────────────────────────────────────────
  // Set localStorage key 'deezerBpmDebug' to '1' in the browser console to
  // enable verbose logging. Persists across reloads until manually removed.
  //   enable:  localStorage.setItem('deezerBpmDebug', '1')
  //   disable: localStorage.removeItem('deezerBpmDebug')
  const logDebugInfo = localStorage.getItem('deezerBpmDebug') === '1'
      ? console.log.bind(console, '[Deezer BPM]')
      : () => {};

  // Read the persisted cache from extension storage into the in-memory Map.
  // Called once at startup, before any fetches happen.
  async function loadPersistedCache() {
    try {
      const result = await storageApi.local.get(CACHE_STORAGE_KEY);
      if (localStorage.getItem('deezerBpmCacheClear') === '1') {
        storageApi.local.remove(CACHE_STORAGE_KEY);
        logDebugInfo('Cache cleared');
        localStorage.removeItem('deezerBpmCacheClear');
      }
      const saved  = result[CACHE_STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        for (const [id, bpm] of Object.entries(saved)) bpmCache.set(id, bpm);
      }
    } catch (e) {
      console.warn('[Deezer BPM] Could not load cache:', e);
    }
  }

  // Write the in-memory cache back to extension storage.
  // We debounce by 2 s so that a burst of fetches (e.g. loading a full playlist)
  // only triggers one write instead of hundreds.
  let saveDebounce = null;
  function scheduleSaveCache() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => {
      // Keep only the most recent MAX_CACHE_SIZE entries to stay within storage limits.
      const entries = [...bpmCache.entries()].slice(-MAX_CACHE_SIZE);
      storageApi.local.set({ [CACHE_STORAGE_KEY]: Object.fromEntries(entries) })
        .catch(e => console.warn('[Deezer BPM] Could not persist cache:', e));
    }, 2000);
  }

  // ── Fetch queue (max 3 concurrent requests) ───────────────────────────────
  // When playlist mode is on we could fire dozens of API requests at once,
  // which would likely get rate-limited. This queue keeps at most 3 requests
  // running simultaneously and queues the rest.

  const queue = {
    running: 0,
    max: 3,
    pending: [],
    // Enqueue a function; returns a Promise that resolves with its return value.
    add(fn) {
      return new Promise((resolve, reject) => {
        this.pending.push({ fn, resolve, reject });
        this._run();
      });
    },
    // Start the next pending task if we're below the concurrency limit.
    async _run() {
      if (this.running >= this.max || !this.pending.length) return;
      this.running++;
      const { fn, resolve, reject } = this.pending.shift();
      try   { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { this.running--; this._run(); } // when one finishes, start the next
    },
  };

  // Fetch the BPM for a single track, using the in-memory cache and the queue.
  async function fetchBpmCached(trackId) {
    const id = String(trackId); // normalise to string so cache keys are consistent
    if (bpmCache.has(id)) return bpmCache.get(id); // already known — return immediately
    if (inFlight.has(id)) return inFlight.get(id); // request already in-flight — share it

    // No cache hit — create a new queued fetch.
    const promise = queue.add(async () => {
      try {
        const resp = await fetch(`https://api.deezer.com/track/${id}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        logDebugInfo('Fetched track from API:', data);
        // Deezer reports 0 for tracks with no BPM data; treat that as "unknown".
        const bpm  = (typeof data.bpm === 'number' && data.bpm > 0) ? Math.round(data.bpm) : null;
        bpmCache.set(id, bpm);
        scheduleSaveCache();
        return bpm;
      } finally {
        // Always remove from inFlight when done, whether it succeeded or threw.
        inFlight.delete(id);
      }
    });

    inFlight.set(id, promise);
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
  }).observe(document.body, { childList: true });

  // ── Player – track detection ──────────────────────────────────────────────
  // We need to know which track is currently playing so we can fetch its BPM.
  // Deezer doesn't expose a simple event for this, so we infer it from the URL
  // or from DOM elements in the player bar.

  let currentTrackId   = null; // track ID shown on the badge right now
  let playerController = null; // AbortController for the in-flight album fetch

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
    const anchor     = container.querySelector('[data-testid="item_title"] a[href*="/album/"]');
    if (!anchor) return null;

    const trackTitle = normalizeTrackKeyPart(anchor.textContent.trim());
    logDebugInfo('player track title:', trackTitle);
    const albumMatch = anchor.getAttribute('href').match(/\/album\/(\d+)/);
    if (!albumMatch) return null;
    const albumId = albumMatch[1];

    // Abort any previous in-flight fetch so we don't act on stale results.
    if (playerController) playerController.abort();
    playerController = new AbortController();

    try {
      const resp = await fetch(
        `https://api.deezer.com/album/${albumId}/tracks?limit=200`,
        { signal: playerController.signal }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      logDebugInfo('album tracks:', data);
      const match = (data.data || []).find(
        t => normalizeTrackKeyPart(t.title) === trackTitle
      );
      logDebugInfo('album track match:', match);
      return match ? String(match.id) : null;
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[Deezer BPM] album fetch error:', e);
      return null;
    }
  }

  // Refresh the floating badge for the currently playing track.
  // Called whenever the title or URL changes.
  async function updatePlayerBadge() {
    setBadgeValue('…');
    const trackId = await detectTrackIdFromPlayer().catch(() => null);
    if (!trackId) { setBadgeValue('–'); currentTrackId = null; return; }
    if (trackId === currentTrackId) return; // nothing changed, skip
    currentTrackId = trackId;
    setBadgeValue('…');
    try {
      const bpm = await fetchBpmCached(trackId);
      logDebugInfo('Fetched track BPM:', bpm);
      setBadgeValue(bpm ?? 'N/A', bpm != null);
    } catch (err) {
      if (err.name !== 'AbortError') { console.warn('[Deezer BPM]', err); setBadgeValue('–'); }
    }
  }

  // ── Playlist mode ─────────────────────────────────────────────────────────
  // When enabled, a BPM tag is injected next to the duration of every visible
  // row in a playlist or album view. Deezer uses a virtualised list so only a
  // handful of rows exist in the DOM at any time; we use a MutationObserver to
  // inject tags into newly rendered rows as the user scrolls.

  let playlistModeEnabled = true;
  let playlistObserver    = null;
  let currentTrackIds     = null; // ordered array of track IDs for the current page
  let currentTrackMap     = null; // Map: "title\0artistId" → trackId (for sorted views)
  let currentPageUrl      = null; // pathname for which currentTrackIds was fetched
  let isLoadingTrackIds   = false; // prevents concurrent loads of the same page
  let isPrivatePlaylist   = false; // true when the API returned OAuthException (private playlist)
  const queueTrackCache   = new Map(); // "title\0artistName" → trackId, avoids re-searching queue rows

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

  // ── Deezer API – fetch ordered track IDs for current playlist/album ───────
  // We need the track IDs in the same order as they appear on the page so we
  // can map each row's aria-rowindex (1-based position) to a track ID.
  // We also build lookup maps so we can re-identify tracks after the user sorts
  // the list by a column header.

  function normalizeTrackKeyPart(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[’']/g, "'")
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function makeTrackKey(title, artistId, albumValue) {
    const parts = [normalizeTrackKeyPart(title), normalizeTrackKeyPart(artistId)];
    if (albumValue != null) parts.push(normalizeTrackKeyPart(albumValue));
    return parts.join('\0');
  }

  // Look up a track ID from currentTrackMap using the DOM elements of a row.
  // Returns the ID string on a hit, or null on a miss.
  function lookupTrackInMap(row) {
    if (!currentTrackMap) return null;
    const titleEl  = row.querySelector('[data-testid="title"]');
    const artistEl = row.querySelector('[data-testid="artist"]');
    if (!titleEl || !artistEl) return null;
    const title    = titleEl.textContent.trim();
    const artistId = (artistEl.getAttribute('href') || '').match(/\/artist\/(\d+)/)?.[1];
    if (!artistId) return null;
    const albumEl = row.querySelector('[data-testid="album"]');
    if (albumEl) {
      const albumId = (albumEl.getAttribute('href') || '').match(/\/album\/(\d+)/)?.[1];
      if (albumId) {
        const id = currentTrackMap.byId.get(makeTrackKey(title, artistId, albumId));
        if (id) return id;
      }
      const albumTitle = albumEl.textContent?.trim();
      if (albumTitle) {
        const id = currentTrackMap.byTitle.get(makeTrackKey(title, artistId, albumTitle));
        if (id) return id;
      }
    }
    return currentTrackMap.byArtistOnly.get(
        `${normalizeTrackKeyPart(title)}\0${normalizeTrackKeyPart(artistId)}`
    ) ?? null;
  }


  // Fetches all pages of a paginated Deezer API list endpoint and returns an
  // array of track IDs and lookup maps.
  async function fetchAllTrackIds(url) {
    const ids = [];
    const mapByArtistAlbumId = new Map();
    const mapByArtistAlbumTitle = new Map();
    const mapByArtistOnly = new Map(); // normalized "title\0artistId" → trackId
    let next = url;
    while (next) {
      const resp = await fetch(next);
      if (!resp.ok) break;
      const data = await resp.json();
      if (data.error) {
        logDebugInfo('Fetch error:', data.error);
        if (data.error.type === 'OAuthException') throw Object.assign(new Error(data.error.message), { type: 'OAuthException' })
        break;
      }
      for (const t of (data.data || [])) {
        const id = String(t.id);
        ids.push(id);

        if (t.title != null && t.artist?.id != null) {
          mapByArtistOnly.set(makeTrackKey(t.title, t.artist.id), id);
          if (t.album?.id != null) {
            mapByArtistAlbumId.set(makeTrackKey(t.title, t.artist.id, t.album.id), id);
          }
          if (t.album?.title != null) {
            mapByArtistAlbumTitle.set(makeTrackKey(t.title, t.artist.id, t.album.title), id);
          }
        }
      }
      next = data.next || null;
    }
    return { ids, mapByArtistAlbumId, mapByArtistAlbumTitle, mapByArtistOnly };
  }

  // Inspect the current URL and fetch the track list for the playlist or album.
  // Returns null if the current page is neither a playlist nor an album.
  async function loadTrackIdsForCurrentPage() {
    const path = location.pathname;
    const playlistMatch = path.match(/\/playlist\/(\d+)/);
    const albumMatch = path.match(/\/album\/(\d+)/);

    let apiUrl  = null;
    let logLabel = null;
    if (playlistMatch) { apiUrl = `https://api.deezer.com/playlist/${playlistMatch[1]}/tracks?limit=200`; logLabel = 'playlist'; }
    else if (albumMatch) { apiUrl = `https://api.deezer.com/album/${albumMatch[1]}/tracks?limit=200`;    logLabel = 'album'; }
    if (!apiUrl) return null;

    try {
      const { ids, mapByArtistAlbumId, mapByArtistAlbumTitle, mapByArtistOnly } = await fetchAllTrackIds(apiUrl);
      currentTrackMap = { byId: mapByArtistAlbumId, byTitle: mapByArtistAlbumTitle, byArtistOnly: mapByArtistOnly };
      logDebugInfo(`${logLabel} track IDs loaded:`, ids.length);
      return ids;
    } catch (e) {
      if (e.type === 'OAuthException') {
        logDebugInfo('Private playlist detected, falling back to DOM search');
        isPrivatePlaylist = true;
        return [];
      }
      throw e;
    }
  }

  // Resolve the track ID for a row. Tries the most specific keys first, then
  // falls back to less specific matches, and finally to row order.
  function resolveTrackId(row, rowIndex) {
    return lookupTrackInMap(row) ?? currentTrackIds?.[rowIndex] ?? null;
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
    // Find the leaf element showing the track duration.
    let el = [...row.querySelectorAll('*')].find(
      e => !e.children.length && /^\d{1,2}:\d{2}$/.test(e.textContent.trim())
    );
    if (!el) return null;

    // Walk up to the column-level ancestor (first parent with 3+ children).
    while (el.parentElement && el.parentElement !== row) {
      if (el.parentElement.children.length >= 3) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Inject BPM placeholders into all currently visible rows that haven't been
  // processed yet. The actual BPM value is filled in asynchronously once fetched.
  // Also handles in-place row recycling (e.g. after a column-header sort) by
  // detecting when a row's track has changed and refreshing its BPM span.
  function injectPlaceholders() {
    // Guard: don't inject stale data if the page has already changed.
    if (!currentTrackIds || currentPageUrl !== location.pathname) return;

    // Inject the BPM column header if not already present.
    injectColumnHeader();

    for (const row of document.querySelectorAll('[role="row"][aria-rowindex]')) {
      // Skip rows inside the play-queue modal — handled separately by injectQueueBpms().
      if (row.closest('.player-queuelist')) continue;

      // Skip rows that don't have a title (e.g. "Add to queue").'
      if (!row.querySelector('[data-testid="title"]')) continue;

      // aria-rowindex is 1-based; map it to our 0-based currentTrackIds array.
      const rowIndex = parseInt(row.getAttribute('aria-rowindex'), 10) - 1;
      const trackId  = resolveTrackId(row, rowIndex);
      if (!trackId) {
        // Private playlist: the API gave us nothing, resolve via DOM search instead.
        if (isPrivatePlaylist && !row.getAttribute(INJECTED_ATTR)) {
          row.setAttribute(INJECTED_ATTR, 'pending');
          resolveQueueRowTrackId(row).then(resolvedId => {
            if (!resolvedId || !row.isConnected) { row.removeAttribute(INJECTED_ATTR); return; }
            if (row.getAttribute(INJECTED_ATTR) !== 'pending') return; // already handled
            row.setAttribute(INJECTED_ATTR, '1');
            injectBpmSpanIntoRow(row, resolvedId);
          });
        }
        continue;
      }

      // If the row was already injected, check whether the track is still the
      // same. After a column-header sort Deezer may recycle DOM rows in-place
      // (updating their content without removing them), so aria-rowindex stays
      // the same but points to a different track. Detect this by comparing the
      // track ID we stored on the span against the newly resolved one.
      if (row.getAttribute(INJECTED_ATTR)) {
        const existing = row.querySelector(`.${INLINE_CLASS}`);
        if (existing?.dataset.dbpmTrack === trackId) continue; // same track — nothing to do
        // Track changed: remove the stale span and fall through to re-inject.
        existing?.remove();
        row.removeAttribute(INJECTED_ATTR);
      }

      // Mark the row so we don't process it again when the observer fires.
      row.setAttribute(INJECTED_ATTR, '1');

      injectBpmSpanIntoRow(row, trackId);
    }
  }

  // Entry point for injecting BPMs into the current page.
  // Handles the case where the page URL changed since the last call (navigated
  // to a different playlist/album) by fetching a fresh track list first.
  async function injectPlaylistBpms() {
    if (isLoadingTrackIds) return; // a load is already in progress — don't start another

    if (currentPageUrl !== location.pathname) {
      // The user navigated to a new page. Clean up any tags from the previous page
      // before loading the new track list.
      removePlaylistBpms();

      const targetUrl   = location.pathname;
      isLoadingTrackIds = true;
      currentPageUrl    = targetUrl; // set early so other callers see the new URL
      currentTrackIds   = null;
      currentTrackMap   = null;
      isPrivatePlaylist = false;
      try {
        currentTrackIds = await loadTrackIdsForCurrentPage();
      } finally {
        isLoadingTrackIds = false;
      }

      // If the URL changed *again* while we were awaiting the API response,
      // our data is already stale. Reset and schedule a fresh attempt.
      if (location.pathname !== targetUrl) {
        currentPageUrl  = null;
        currentTrackIds = null;
        currentTrackMap = null;
        setTimeout(injectPlaylistBpms, 100);
        return;
      }
    }

    if (!currentTrackIds || (currentTrackIds.length === 0 && isPrivatePlaylist)) return; // not a playlist/album page

    injectPlaceholders();
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
    const titleEl  = row.querySelector('[data-testid="title"]');
    const artistEl = row.querySelector('[data-testid="artist"]');
    return titleEl && artistEl
        ? `${normalizeTrackKeyPart(titleEl.textContent.trim())}\0${normalizeTrackKeyPart(artistEl.textContent.trim())}`
        : null;
  }

  // Resolve a track ID for a queue row purely from its DOM content.
  // Tries the currentTrackMap first (free, no network), then falls back to a
  // Deezer API search using the title and artist name visible in the row.
  async function resolveQueueRowTrackId(row) {
    const titleEl  = row.querySelector('[data-testid="title"]');
    const artistEl = row.querySelector('[data-testid="artist"]');
    if (!titleEl || !artistEl) return null;

    const title      = titleEl.textContent.trim();
    const artistName = artistEl.textContent.trim();
    const rowKey = getRowKey(row);

    if (queueTrackCache.has(rowKey)) return queueTrackCache.get(rowKey);

    const mapHit = lookupTrackInMap(row);
    if (mapHit) { queueTrackCache.set(rowKey, mapHit); return mapHit; }

    // No map hit — search the Deezer API by title + artist name.
    const q = `track:"${title}" artist:"${artistName}"`;
    try {
      const resp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const id = data.data?.[0]?.id;
      const resolved = id != null ? String(id) : null;
      if (resolved) queueTrackCache.set(rowKey, resolved); // cache for future scroll recycling
      return resolved;
    } catch {
      return null;
    }
  }

  function renderBpmValue(span, trackId) {
    return bpm => {
      if (!span.isConnected || span.dataset.dbpmTrack !== trackId) return;
      span.textContent = bpm != null ? String(bpm) : 'N/A';
      if (bpm != null) span.classList.add(`${INLINE_CLASS}--loaded`)
      else span.classList.add(`${INLINE_CLASS}--unknown`);
    };
  }

  // Create and insert a BPM span into `row` for the given `trackId`.
  // `rowKey` is an optional title+artist key stored on the span for
  // staleness detection when rows are recycled during virtual scrolling.
  // `errorText` is the text shown in the span if the BPM fetch fails.
  function injectBpmSpanIntoRow(row, trackId, { rowKey = null, errorText = 'N/A' } = {}) {
    const span = document.createElement('span');
    span.className = INLINE_CLASS;
    span.dataset.dbpmTrack = trackId;
    if (rowKey != null) span.dataset.dbpmRowKey = rowKey;
    span.textContent = '…';

    const durationCell = findDurationCell(row);
    if (durationCell) durationCell.before(span);
    else row.appendChild(span);

    fetchBpmCached(trackId).then(renderBpmValue(span, trackId)).catch(err => {
      console.warn('[Deezer BPM] fetch error for track', trackId, err);
      if (span.isConnected) span.textContent = errorText;
    });
  }

  async function injectQueueBpms() {
    const queueContainer = document.querySelector('.player-queuelist');
    if (!queueContainer) return;

    for (const row of queueContainer.querySelectorAll('[role="row"][aria-rowindex]')) {
      const injectedAttr = row.getAttribute(INJECTED_ATTR);

      if (injectedAttr === 'pending') continue;

      if (injectedAttr === '1') {
        const existing = row.querySelector(`.${INLINE_CLASS}`);
        if (existing) {
          // Check if the row was recycled in-place: compare the stored title+artist
          // key on the span against what is currently in the DOM.
          const currentKey = getRowKey(row);
          if (existing.dataset.dbpmRowKey === currentKey) continue; // same content — nothing to do
          // Content changed: row was recycled. Remove stale span and re-inject.
          existing.remove();
        }
        row.removeAttribute(INJECTED_ATTR);
      }

      // Claim the row immediately before any await to prevent concurrent injection.
      row.setAttribute(INJECTED_ATTR, 'pending');

      const trackId = await resolveQueueRowTrackId(row);
      if (!trackId || !row.isConnected) {
        row.removeAttribute(INJECTED_ATTR);
        continue;
      }

      row.setAttribute(INJECTED_ATTR, '1');

      // Compute the row key again (post-await) to store on the span for staleness checks.
      const rowKey = getRowKey(row) ?? trackId;

      injectBpmSpanIntoRow(row, trackId, { rowKey, errorText: 'N/A' });
    }
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
      if (!currentTrackIds || currentPageUrl !== location.pathname) {
        injectPlaylistBpms();
      } else {
        injectPlaceholders();
      }
    });
    playlistObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopPlaylistObserver() {
    if (playlistObserver) { playlistObserver.disconnect(); playlistObserver = null; }
  }

  // ── Change detection (player + URL) ──────────────────────────────────────
  // Deezer is a SPA that uses the History API (pushState) for navigation.
  // There is no built-in event for pushState changes, so we infer them from
  // <title> mutations (the title always changes when the track or page changes)
  // and from the popstate event (browser back/forward navigation).

  let lastUrl   = location.href;
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

  // Watch the <title> element. Deezer updates it whenever the playing track or
  // the current page changes, making it a reliable proxy for both events.
  const miniplayerEl = document.querySelector('[data-testid="miniplayer_container"]');
  if (miniplayerEl) {
    let lastPlayerTitle = null;
    new MutationObserver(() => {
      const anchor = miniplayerEl.querySelector('[data-testid="item_title"] a[href*="/album/"]');
      const title   = anchor?.textContent ?? null;
      // Only act when the album link actually changes — this filters out unrelated
      // subtree mutations (e.g. playback progress, volume, etc.).
      if (title === lastPlayerTitle) return;
      logDebugInfo("title changed", lastPlayerTitle, title)
      lastPlayerTitle = title;
      currentTrackId = null;
      updatePlayerBadge();
    }).observe(miniplayerEl, { childList: true, subtree: true, characterData: true });
  }

  // Watch the <title> element only for URL/navigation changes (not for badge updates).
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(scheduleUrlChange).observe(titleEl, { childList: true });
  }

  // Also handle browser back/forward navigation (popstate).
  window.addEventListener('popstate', scheduleUrlChange);

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
    } else if (currentTrackIds) {
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
  loadPersistedCache().then(() => {
    if (localStorage.getItem(STORAGE_KEY) === '1') {
      setTimeout(() => setPlaylistMode(true), 900);
    } else {
      getBadge(); // create the badge even if playlist mode is off
    }
    updatePlayerBadge();
  });
})();

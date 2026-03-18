(function () {
  'use strict';

  const BADGE_ID      = 'deezer-bpm-badge';
  const INLINE_CLASS  = 'dbpm-inline';
  const INJECTED_ATTR = 'data-dbpm-injected';
  const STORAGE_KEY   = 'deezerBpmPlaylistMode';

  // ── Shared BPM cache ──────────────────────────────────────────────────────

  const bpmCache = new Map(); // trackId (string) → number|null

  // ── Fetch queue (max 3 concurrent requests) ───────────────────────────────

  const queue = {
    running: 0,
    max: 3,
    pending: [],
    add(fn) {
      return new Promise((resolve, reject) => {
        this.pending.push({ fn, resolve, reject });
        this._run();
      });
    },
    async _run() {
      if (this.running >= this.max || !this.pending.length) return;
      this.running++;
      const { fn, resolve, reject } = this.pending.shift();
      try   { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { this.running--; this._run(); }
    },
  };

  async function fetchBpmCached(trackId) {
    if (bpmCache.has(trackId)) return bpmCache.get(trackId);
    return queue.add(async () => {
      const resp = await fetch(`https://api.deezer.com/track/${trackId}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const bpm  = (typeof data.bpm === 'number' && data.bpm > 0) ? Math.round(data.bpm) : null;
      bpmCache.set(trackId, bpm);
      return bpm;
    });
  }

  // ── Badge ─────────────────────────────────────────────────────────────────

  function getBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.innerHTML =
        '<span class="dbpm-label">BPM</span>' +
        '<span class="dbpm-value">–</span>' +
        '<button class="dbpm-list-btn" title="Show BPM in playlist">≡</button>';
      badge.querySelector('.dbpm-list-btn').addEventListener('click', () => {
        setPlaylistMode(!playlistModeEnabled);
      });
      document.body.appendChild(badge);
    }
    return badge;
  }

  function setBadgeValue(text, active) {
    const badge = getBadge();
    badge.querySelector('.dbpm-value').textContent = text;
    badge.classList.toggle('dbpm-active', !!active);
  }

  // ── Player – track detection ──────────────────────────────────────────────

  let currentTrackId   = null;
  let playerController = null;

  function detectTrackId() {
    const urlMatch = location.pathname.match(/\/track\/(\d+)/);
    if (urlMatch) return urlMatch[1];

    const playerSelectors = [
      '[data-testid="player_track_title"] a',
      '[class*="PlayerTrackTitle"] a',
      '[class*="player-track-title"] a',
      '.track-title a',
    ];
    for (const sel of playerSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const m = (el.getAttribute('href') || '').match(/\/track\/(\d+)/);
        if (m) return m[1];
      }
    }
    return null;
  }

  async function searchTrackByTitle() {
    const raw = document.title.replace(/[-–|]?\s*Deezer\s*$/i, '').trim();
    if (!raw) return null;
    if (playerController) playerController.abort();
    playerController = new AbortController();
    const resp = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent(raw)}&limit=1`,
      { signal: playerController.signal }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data?.[0]?.id ?? null;
  }

  async function updatePlayerBadge() {
    let trackId = detectTrackId();
    if (!trackId) {
      setBadgeValue('…');
      trackId = await searchTrackByTitle().catch(() => null);
    }
    if (!trackId) { setBadgeValue('–'); currentTrackId = null; return; }
    if (trackId === currentTrackId) return;
    currentTrackId = trackId;
    setBadgeValue('…');
    try {
      const bpm = await fetchBpmCached(trackId);
      setBadgeValue(bpm ?? 'N/A', bpm != null);
    } catch (err) {
      if (err.name !== 'AbortError') { console.warn('[Deezer BPM]', err); setBadgeValue('–'); }
    }
  }

  // ── Playlist mode ─────────────────────────────────────────────────────────

  let playlistModeEnabled = false;
  let playlistObserver    = null;
  let currentTrackIds     = null; // ordered array of track IDs for current page
  let currentPageUrl      = null; // URL for which currentTrackIds was fetched

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

  /**
   * Fetches all pages of a Deezer API tracklist URL, returns array of track ID strings.
   */
  async function fetchAllTrackIds(url) {
    const ids = [];
    let next = url;
    while (next) {
      const resp = await fetch(next);
      if (!resp.ok) break;
      const data = await resp.json();
      for (const t of (data.data || [])) ids.push(String(t.id));
      next = data.next || null;
    }
    return ids;
  }

  async function loadTrackIdsForCurrentPage() {
    const path = location.pathname;

    const playlistMatch = path.match(/\/playlist\/(\d+)/);
    if (playlistMatch) {
      return fetchAllTrackIds(
        `https://api.deezer.com/playlist/${playlistMatch[1]}/tracks?limit=200`
      );
    }

    const albumMatch = path.match(/\/album\/(\d+)/);
    if (albumMatch) {
      return fetchAllTrackIds(
        `https://api.deezer.com/album/${albumMatch[1]}/tracks?limit=200`
      );
    }

    return null;
  }

  // ── Playlist injection ────────────────────────────────────────────────────

  async function injectPlaylistBpms() {
    stopPlaylistObserver();

    // Re-fetch track list if the page has changed
    if (currentPageUrl !== location.pathname) {
      currentPageUrl  = location.pathname;
      currentTrackIds = null;
      currentTrackIds = await loadTrackIdsForCurrentPage();
      console.log('[Deezer BPM] Track IDs loaded:', currentTrackIds?.length ?? 0);
    }

    if (!currentTrackIds || currentTrackIds.length === 0) {
      console.log('[Deezer BPM] No track list found for this page (not a playlist/album?)');
      if (playlistModeEnabled) startPlaylistObserver();
      return;
    }

    // Deezer virtual list: visible rows have role="row" and aria-rowindex (1-based)
    const rows = document.querySelectorAll('[role="row"][aria-rowindex]');
    console.log(`[Deezer BPM] Visible rows: ${rows.length}`);

    for (const row of rows) {
      if (row.getAttribute(INJECTED_ATTR)) continue;

      const rowIndex = parseInt(row.getAttribute('aria-rowindex'), 10) - 1; // → 0-based
      const trackId  = currentTrackIds[rowIndex];
      if (!trackId) continue;

      row.setAttribute(INJECTED_ATTR, '1');

      const span = document.createElement('span');
      span.className = INLINE_CLASS;
      span.textContent = '…';
      row.appendChild(span);

      fetchBpmCached(trackId).then(bpm => {
        if (!span.isConnected) return;
        span.textContent = bpm != null ? String(bpm) : '?';
        if (bpm != null) span.classList.add(`${INLINE_CLASS}--loaded`);
      }).catch(err => {
        console.warn('[Deezer BPM] fetch error for track', trackId, err);
        if (span.isConnected) span.textContent = '?';
      });
    }

    if (playlistModeEnabled) startPlaylistObserver();
  }

  function removePlaylistBpms() {
    document.querySelectorAll(`.${INLINE_CLASS}`).forEach(el => el.remove());
    document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => el.removeAttribute(INJECTED_ATTR));
  }

  function startPlaylistObserver() {
    if (playlistObserver) return;
    let debounce = null;
    playlistObserver = new MutationObserver((mutations) => {
      // Only react to externally added nodes (not our own spans)
      const external = mutations.some(m =>
        [...m.addedNodes].some(n => n.nodeType === 1 && !n.classList?.contains(INLINE_CLASS))
      );
      if (!external) return;
      clearTimeout(debounce);
      debounce = setTimeout(injectPlaylistBpms, 400);
    });
    playlistObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopPlaylistObserver() {
    if (playlistObserver) { playlistObserver.disconnect(); playlistObserver = null; }
  }

  // ── Change detection (player + URL) ──────────────────────────────────────

  let lastTitle = document.title;
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        currentTrackId = null;
        updatePlayerBadge();
      }
    }).observe(titleEl, { childList: true });
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentTrackId  = null;
      currentTrackIds = null; // force re-fetch for new page
      updatePlayerBadge();
      if (playlistModeEnabled) {
        removePlaylistBpms();
        setTimeout(injectPlaylistBpms, 600);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Init ──────────────────────────────────────────────────────────────────

  if (localStorage.getItem(STORAGE_KEY) === '1') {
    setTimeout(() => setPlaylistMode(true), 900);
  } else {
    getBadge();
  }

  updatePlayerBadge();
})();

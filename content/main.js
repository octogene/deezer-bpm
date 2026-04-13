(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        PLAYLIST_MODE_KEY,
    } = window.DeezerBpm.constants;

    const {
        checkCacheClear,
        loadPersistedCache,
        flushPendingCacheSave,
    } = window.DeezerBpm.cache;

    const {
        resolveRowTrackId,
    } = window.DeezerBpm.resolver;

    const {
        getBadge,
        syncPlaylistModeButton,
        resetCurrentTrackId,
        schedulePlayerBadgeUpdate,
        initBadge,
    } = window.DeezerBpm.badge;

    const {
        injectPlaceholders,
        injectQueueBpms,
        removePlaylistBpms,
        initPlaylistFilter,
        scheduleApplyFilter,
    } = window.DeezerBpm.playlist;

    const {
        startPlaylistObserver,
        stopPlaylistObserver,
        setupMiniplayerObserver,
        setupTitleObserver,
        setupPopstateObserver,
        setupPagehideObserver,
        startPlaylistRescan,
        setupToggleListener,
    } = window.DeezerBpm.observers;

    let playlistModeEnabled = true;
    let currentPageUrl = null;
    let isLoadingTrackIds = false;
    let isTrackPage = false;
    let playlistRefreshTimer = null;
    let playlistRefreshRunning = false;
    let playlistRefreshQueued = false;

    async function injectPlaylistBpms() {
        if (isLoadingTrackIds) return;

        if (currentPageUrl !== location.pathname) {
            removePlaylistBpms();

            const targetUrl = location.pathname;
            isLoadingTrackIds = true;
            currentPageUrl = targetUrl;
            isTrackPage = false;

            try {
                isTrackPage = detectPageType();
            } finally {
                isLoadingTrackIds = false;
            }

            if (location.pathname !== targetUrl) {
                currentPageUrl = null;
                schedulePlaylistRefresh(100);
                return;
            }
        }

        if (!isTrackPage) return;

        refreshPlaylistPlaceholders();
    }

    function setPlaylistMode(enabled) {
        playlistModeEnabled = enabled;
        localStorage.setItem(PLAYLIST_MODE_KEY, enabled ? '1' : '0');
        syncPlaylistModeButton(enabled);

        if (enabled) {
            schedulePlaylistRefresh(0);
            startPlaylistObserver({
                onQueueMutation: refreshQueueBpms,
                onPlaylistMutation: handleObservedPlaylistMutation,
            });
        } else {
            removePlaylistBpms();
            stopPlaylistObserver();
        }
    }

    function detectPageType() {
        return /\/(playlist|album)\/\d+/.test(location.pathname)
            || /\/search\/[^/]+(\/track)?$/.test(location.pathname)
            || /\/profile\/\d+\/(loved|history)/.test(location.pathname);
    }

    function refreshPlaylistPlaceholders() {
        injectPlaceholders({
            isTrackPage,
            currentPageUrl,
            resolveRowTrackId,
        });
    }

    function refreshQueueBpms() {
        injectQueueBpms(resolveRowTrackId);
    }

    function schedulePlaylistRefresh(delay = 0) {
        if (playlistRefreshRunning) {
            playlistRefreshQueued = true;
            return;
        }

        clearTimeout(playlistRefreshTimer);
        playlistRefreshTimer = setTimeout(() => {
            playlistRefreshTimer = null;
            runPlaylistRefresh();
        }, delay);
    }

    async function runPlaylistRefresh() {
        if (!playlistModeEnabled) return;

        if (playlistRefreshRunning) {
            playlistRefreshQueued = true;
            return;
        }

        playlistRefreshRunning = true;

        try {
            await injectPlaylistBpms();
            refreshQueueBpms();
            scheduleApplyFilter();
        } finally {
            playlistRefreshRunning = false;

            if (playlistRefreshQueued) {
                playlistRefreshQueued = false;
                schedulePlaylistRefresh(0);
            }
        }
    }

    function handleObservedPlaylistMutation() {
        if (currentPageUrl !== location.pathname) {
            schedulePlaylistRefresh(0);
            return;
        }

        if (isTrackPage) {
            refreshPlaylistPlaceholders();
        }

        scheduleApplyFilter();
    }

    function handleUrlChange() {
        schedulePlayerBadgeUpdate();
        schedulePlaylistRefresh(150);
    }

    function handleMiniplayerTitleChange() {
        resetCurrentTrackId();
    }

    function handleMiniplayerReady() {
        schedulePlayerBadgeUpdate(0);
    }

    function handlePlaylistRescan() {
        if (!playlistModeEnabled || isLoadingTrackIds) return;
        schedulePlaylistRefresh(0);
    }

    setupMiniplayerObserver({
        onTitleChange: handleMiniplayerTitleChange,
        onReady: handleMiniplayerReady,
    });

    setupTitleObserver(handleUrlChange);
    setupPopstateObserver(handleUrlChange);
    setupPagehideObserver(() => {
        flushPendingCacheSave();
    });

    startPlaylistRescan(handlePlaylistRescan);

    setupToggleListener(() => {
        setPlaylistMode(!playlistModeEnabled);
    });

    checkCacheClear().then(loadPersistedCache).then(() => {
        playlistModeEnabled = localStorage.getItem(PLAYLIST_MODE_KEY) === '1';
        initBadge({ playlistModeEnabled });
        initPlaylistFilter();

        if (playlistModeEnabled) {
            setTimeout(() => setPlaylistMode(true), 900);
        } else {
            getBadge();
        }
    });
})();
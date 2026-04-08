(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        STORAGE_KEY,
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
                setTimeout(injectPlaylistBpms, 100);
                return;
            }
        }

        if (!isTrackPage) return;

        refreshPlaylistPlaceholders();
    }

    function setPlaylistMode(enabled) {
        playlistModeEnabled = enabled;
        localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
        syncPlaylistModeButton(enabled);

        if (enabled) {
            injectPlaylistBpms();
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

    function handleObservedPlaylistMutation() {
        if (currentPageUrl !== location.pathname) {
            injectPlaylistBpms();
        } else {
            refreshPlaylistPlaceholders();
        }
    }

    function handleUrlChange() {
        schedulePlayerBadgeUpdate();
    }

    function handleMiniplayerTitleChange() {
        resetCurrentTrackId();
    }

    function handleMiniplayerReady() {
        schedulePlayerBadgeUpdate(0);
    }

    function handlePlaylistRescan() {
        if (!playlistModeEnabled || isLoadingTrackIds) return;

        if (currentPageUrl !== location.pathname) {
            injectPlaylistBpms();
        } else if (isTrackPage) {
            refreshPlaylistPlaceholders();
        }
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
        playlistModeEnabled = localStorage.getItem(STORAGE_KEY) === '1';
        initBadge({ playlistModeEnabled });

        if (playlistModeEnabled) {
            setTimeout(() => setPlaylistMode(true), 900);
        } else {
            getBadge();
        }
    });
})();
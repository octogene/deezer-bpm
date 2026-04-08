(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const constants = {
        // DOM identifiers
        BADGE_ID: 'deezer-bpm-badge',
        INLINE_CLASS: 'dbpm-inline',
        HEADER_CLASS: 'dbpm-header',
        INJECTED_ATTR: 'data-dbpm-injected',
        ROW_KEY_ATTR: 'data-dbpm-key',

        // Local storage keys
        STORAGE_KEY: 'deezerBpmPlaylistMode',
        CLEAR_CACHE_STORAGE_KEY: 'deezerBpmCacheClear',

        // Extension storage keys
        BPM_CACHE_STORAGE_KEY: 'deezerBpmCache',
        COVER_CACHE_STORAGE_KEY: 'deezerCoverIdCache',
        COVER_TRACK_CACHE_STORAGE_KEY: 'deezerCoverTrackCache',

        // Special values
        COVER_PLACEHOLDER_ID: 'd41d8cd98f00b204e9800998ecf8427e',
        UNRESOLVABLE: Symbol('unresolvable'),

        // Limits
        MAX_CACHE_SIZE: 10000,
        TRACK_QUEUE_CONCURRENCY: 5,
        ALBUM_QUEUE_CONCURRENCY: 3,

        // Timings
        PLAYLIST_RESCAN_INTERVAL_MS: 2500,
        CACHE_SAVE_DEBOUNCE_MS: 2000,
        BADGE_UPDATE_DELAY_MS: 150,
        URL_CHANGE_DELAY_MS: 150,
        MINIPLAYER_UPDATE_DELAY_MS: 150,
        INITIAL_PLAYLIST_INIT_DELAY_MS: 900,
        ROW_COVER_WAIT_MS: 150,
        ROW_COVER_POLL_INTERVAL_MS: 16,
        PAGE_RETRY_DELAY_MS: 100,

        // Debug
        DEBUG_STORAGE_KEY: 'deezerBpmDebug',
        LOG_PREFIX: '[Deezer BPM]',
        DEBUG_BADGE_STYLE: 'color: white; background: #7B2FBE; border-radius: 3px; font-weight: bold',
        ERROR_BADGE_STYLE: 'color: white; background: red; border-radius: 3px; font-weight: bold',
    };

    window.DeezerBpm.constants = constants;
})();
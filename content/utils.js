(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        COVER_PLACEHOLDER_ID,
        DEBUG_STORAGE_KEY,
        LOG_PREFIX,
        DEBUG_BADGE_STYLE,
        ERROR_BADGE_STYLE,
    } = window.DeezerBpm.constants;

    const DEBUG = localStorage.getItem(DEBUG_STORAGE_KEY) === '1';

    function normalizeTrackKeyPart(value) {
        return String(value)
            .trim()
            .replace(/^\d+\.\s+/, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[’']/g, "'")
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    function makeCoverTrackKey(coverId, title) {
        return `${coverId}\0${normalizeTrackKeyPart(title)}`;
    }

    function makeAlbumTrackKey(albumId, title) {
        return `album:${albumId}\0${normalizeTrackKeyPart(title)}`;
    }

    function extractCoverId(element, coverTestId = 'cover') {
        const coverImg = element.querySelector(`[data-testid="${coverTestId}"] img`);
        const coverMatch = coverImg?.getAttribute('src')?.match(/\/images\/cover\/([a-f0-9]+)\//);
        const coverId = coverMatch ? coverMatch[1] : null;
        return coverId !== COVER_PLACEHOLDER_ID ? coverId : null;
    }

    function logDebugInfo(...args) {
        if (!DEBUG) return;
        console.log(`%c${LOG_PREFIX}`, DEBUG_BADGE_STYLE, ...args);
    }

    function logDebugError(...args) {
        if (!DEBUG) return;
        console.error(`%c${LOG_PREFIX}`, ERROR_BADGE_STYLE, ...args);
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    window.DeezerBpm.utils = {
        normalizeTrackKeyPart,
        makeCoverTrackKey,
        makeAlbumTrackKey,
        extractCoverId,
        logDebugInfo,
        logDebugError,
        delay,
        DEBUG,
    };
})();
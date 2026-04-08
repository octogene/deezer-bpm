(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        BADGE_ID,
        BADGE_UPDATE_DELAY_MS,
    } = window.DeezerBpm.constants;

    const {
        logDebugInfo,
        logDebugError,
    } = window.DeezerBpm.utils;

    const {
        fetchBpmCached,
    } = window.DeezerBpm.api;

    const {
        detectTrackIdFromPlayer,
    } = window.DeezerBpm.resolver;

    let currentTrackId = null;
    let badgeUpdateTimer = null;
    let badgeUpdateRunning = false;
    let badgeUpdateQueued = false;
    let badgeObserverStarted = false;

    function getBadge() {
        let badge = document.getElementById(BADGE_ID);

        if (!badge) {
            badge = document.createElement('div');
            badge.id = BADGE_ID;
            badge.innerHTML =
                '<span class="dbpm-label">BPM</span>' +
                '<span class="dbpm-value">–</span>' +
                '<button class="dbpm-list-btn" title="Show BPM in playlist">≡</button>';

            document.body.appendChild(badge);
        }

        return badge;
    }

    function setBadgeValue(text, active) {
        const badge = getBadge();
        badge.querySelector('.dbpm-value').textContent = text;
        badge.classList.toggle('dbpm-active', !!active);
    }

    function syncPlaylistModeButton(enabled) {
        const badge = getBadge();
        badge
            .querySelector('.dbpm-list-btn')
            .classList.toggle('dbpm-list-btn--on', !!enabled);
    }

    function resetCurrentTrackId() {
        currentTrackId = null;
    }

    function schedulePlayerBadgeUpdate(delay = BADGE_UPDATE_DELAY_MS) {
        clearTimeout(badgeUpdateTimer);
        badgeUpdateTimer = setTimeout(() => {
            badgeUpdateTimer = null;
            runPlayerBadgeUpdate();
        }, delay);
    }

    async function runPlayerBadgeUpdate() {
        if (badgeUpdateRunning) {
            badgeUpdateQueued = true;
            logDebugInfo('[BADGE] Update already running; queueing a follow-up pass');
            return;
        }

        badgeUpdateRunning = true;

        try {
            const trackId = await detectTrackIdFromPlayer().catch(reason => {
                logDebugError('[BADGE] Failed to detect track ID from player:', reason);
                return null;
            });

            if (!trackId) {
                setBadgeValue('–');
                currentTrackId = null;
                return;
            }

            if (trackId === currentTrackId) {
                logDebugInfo('[BADGE] Same track; skipping update for', trackId);
                return;
            }

            currentTrackId = trackId;
            setBadgeValue('…');

            const bpm = await fetchBpmCached(trackId);
            logDebugInfo('[BADGE] Fetched track BPM:', bpm);
            setBadgeValue(bpm ?? 'N/A', bpm !== null);
        } catch (error) {
            logDebugError('[BADGE] Failed to update', error);
            setBadgeValue('✕');
        } finally {
            badgeUpdateRunning = false;

            if (badgeUpdateQueued) {
                badgeUpdateQueued = false;
                schedulePlayerBadgeUpdate(0);
            }
        }
    }

    function ensureBadgeObserver() {
        if (badgeObserverStarted) return;
        badgeObserverStarted = true;

        new MutationObserver(() => {
            if (!document.getElementById(BADGE_ID)) {
                getBadge();
            }
        }).observe(document.body, { childList: true });
    }

    function initBadge({ playlistModeEnabled = false } = {}) {
        getBadge();
        syncPlaylistModeButton(playlistModeEnabled);
        ensureBadgeObserver();
    }

    window.DeezerBpm.badge = {
        getBadge,
        setBadgeValue,
        syncPlaylistModeButton,
        resetCurrentTrackId,
        schedulePlayerBadgeUpdate,
        runPlayerBadgeUpdate,
        ensureBadgeObserver,
        initBadge,
    };
})();
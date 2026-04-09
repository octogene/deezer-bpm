(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        INLINE_CLASS,
        HEADER_CLASS,
        INJECTED_ATTR,
        ROW_KEY_ATTR,
        UNRESOLVABLE,
    } = window.DeezerBpm.constants;

    const {
        makeCoverTrackKey,
        logDebugInfo,
        logDebugError,
    } = window.DeezerBpm.utils;

    const {
        bpmCache,
        trackResolutionCache,
    } = window.DeezerBpm.cache;

    const {
        fetchBpmCached,
    } = window.DeezerBpm.api;

    function findDurationCell(row) {
        let element = row.querySelector('[data-testid="duration"]');
        if (!element) return null;

        while (element.parentElement && element.parentElement !== row) {
            if (element.parentElement.children.length >= 2) return element;
            element = element.parentElement;
        }

        return null;
    }

    function getTrackListContainer() {
        return document.querySelector('.catalog-content')
            ?? document.querySelector('#page_content');
    }

    function getRowKey(row) {
        const titleEl = row.querySelector('[data-testid="title"]');
        const coverImg = row.querySelector('[data-testid="cover"] img');
        const title = titleEl?.textContent.trim() ?? '';
        const coverMatch = coverImg?.getAttribute('src')?.match(/\/images\/cover\/([a-f0-9]+)\//);
        const coverId = coverMatch?.[1] ?? '';
        return makeCoverTrackKey(coverId, title);
    }

    function renderBpmValue(span, trackId) {
        return bpm => {
            if (!span.isConnected || span.dataset.dbpmTrack !== trackId) return;
            span.textContent = bpm !== null ? String(bpm) : 'N/A';
            span.classList.toggle(`${INLINE_CLASS}--loaded`, bpm !== null);
            span.classList.toggle(`${INLINE_CLASS}--unknown`, bpm === null);
        };
    }

    function createBpmSpan(row, { rowKey = null } = {}) {
        const span = document.createElement('span');
        span.className = INLINE_CLASS;
        if (rowKey !== null) span.dataset.dbpmRowKey = rowKey;
        span.textContent = '…';

        const durationCell = findDurationCell(row);
        if (durationCell) {
            durationCell.before(span);
        } else {
            row.appendChild(span);
        }

        return span;
    }

    function injectBpmsIntoRows(container, resolveTrackId, {
        rowFilter = null,
        eagerSpan = false,
    } = {}) {
        for (const row of container.querySelectorAll('[role="row"][aria-rowindex]')) {
            const injectedAttr = row.getAttribute(INJECTED_ATTR);

            if (injectedAttr === 'pending') continue;

            if (injectedAttr === '1') {
                const currentKey = getRowKey(row);

                if (row.getAttribute(ROW_KEY_ATTR) === currentKey) continue;
                if (rowFilter && !rowFilter(row)) continue;

                const existing = row.querySelector(`.${INLINE_CLASS}`);
                if (existing) {
                    const newTrackId = trackResolutionCache.get(currentKey);
                    if (newTrackId) {
                        const bpm = bpmCache.get(newTrackId);
                        if (bpm !== undefined) {
                            existing.dataset.dbpmRowKey = currentKey;
                            existing.dataset.dbpmTrack = newTrackId;
                            row.setAttribute(ROW_KEY_ATTR, currentKey);
                            renderBpmValue(existing, newTrackId)(bpm);
                            continue;
                        }
                    }

                    existing.remove();
                }

                row.removeAttribute(INJECTED_ATTR);
                row.removeAttribute(ROW_KEY_ATTR);
            }

            if (rowFilter && !rowFilter(row)) continue;

            row.setAttribute(INJECTED_ATTR, 'pending');

            const pendingRowKey = getRowKey(row);
            const span = eagerSpan ? createBpmSpan(row) : null;

            resolveTrackId(row).then(trackId => {
                if (!row.isConnected) {
                    row.removeAttribute(INJECTED_ATTR);
                    row.removeAttribute(ROW_KEY_ATTR);
                    span?.remove();
                    return;
                }

                if (trackId === null) {
                    row.setAttribute(INJECTED_ATTR, '1');
                    if (span) span.textContent = '–';
                    return;
                }

                if (row.getAttribute(INJECTED_ATTR) !== 'pending') {
                    span?.remove();
                    return;
                }

                row.setAttribute(INJECTED_ATTR, '1');
                row.setAttribute(ROW_KEY_ATTR, pendingRowKey);

                if (trackId === UNRESOLVABLE) {
                    if (span) {
                        span.dataset.dbpmRowKey = pendingRowKey;
                        span.textContent = '✕';
                    }
                    return;
                }

                const bpmSpan = span ?? createBpmSpan(row, { rowKey: pendingRowKey });
                if (span) span.dataset.dbpmRowKey = pendingRowKey;
                bpmSpan.dataset.dbpmTrack = trackId;

                fetchBpmCached(trackId)
                    .then(renderBpmValue(bpmSpan, trackId))
                    .catch(error => {
                        console.warn('[Deezer BPM] fetch error for track', trackId, error);
                        if (bpmSpan.isConnected) bpmSpan.textContent = 'N/A';
                    });
            });
        }
    }

    function injectColumnHeader(container) {
        if (container.querySelector(`.${HEADER_CLASS}`)) return;

        const headers = [...container.querySelectorAll('[role="columnheader"]')];
        if (!headers.length) return;

        let durationHeader = null;
        const durationCell = [...container.querySelectorAll('[role="row"][aria-rowindex]')]
            .reduce((found, row) => found ?? findDurationCell(row), null);

        if (durationCell) {
            const colIndex = [...durationCell.parentElement.children].indexOf(durationCell);
            logDebugInfo('Found duration cell column index', colIndex);
            if (colIndex >= 0 && colIndex < headers.length) {
                durationHeader = headers[colIndex];
            }
        } else {
            logDebugError('Could not find duration cell in sample row', headers);
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

    function injectPlaceholders({ isTrackPage, currentPageUrl, resolveRowTrackId }) {
        if (!isTrackPage || currentPageUrl !== location.pathname) return;

        const catalog = getTrackListContainer();
        if (!catalog) return;

        injectColumnHeader(catalog);

        injectBpmsIntoRows(catalog, row => resolveRowTrackId(row), {
            eagerSpan: true,
            rowFilter: row =>
                !row.closest('.player-queuelist') &&
                !!row.querySelector('[data-testid="title"]') &&
                !row.querySelector('button[aria-label="Add track"]') &&
                !row.querySelector('[data-testid="show"]'),
        });
    }

    function injectQueueBpms(resolveRowTrackId) {
        const queueContainer = document.querySelector('.player-queuelist');
        if (!queueContainer) return;

        injectBpmsIntoRows(
            queueContainer,
            row => resolveRowTrackId(row, { allowSearchFallback: true }),
            { eagerSpan: true }
        );
    }

    function removePlaylistBpms() {
        const catalog = getTrackListContainer();
        if (!catalog) return;

        catalog.querySelectorAll(`.${INLINE_CLASS}, .${HEADER_CLASS}`).forEach(element => element.remove());
        catalog.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(element => {
            element.removeAttribute(INJECTED_ATTR);
            element.removeAttribute(ROW_KEY_ATTR);
        });
    }

    window.DeezerBpm.playlist = {
        findDurationCell,
        getTrackListContainer,
        getRowKey,
        renderBpmValue,
        createBpmSpan,
        injectBpmsIntoRows,
        injectColumnHeader,
        injectPlaceholders,
        injectQueueBpms,
        removePlaylistBpms,
    };
})();
(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  const {
    INLINE_CLASS,
    HEADER_CLASS,
    INJECTED_ATTR,
    ROW_KEY_ATTR,
    FILTER_MATCH_CLASS,
    UNRESOLVABLE,
  } = window.DeezerBpm.constants;

  const {
    makeCoverTrackKey,
    logDebugInfo,
    logDebugError,
    extractCoverId,
    parseBpmFilter,
  } = window.DeezerBpm.utils;

  const { syncFilterButton } = window.DeezerBpm.badge;

  const { bpmCache, trackResolutionCache } = window.DeezerBpm.cache;

  const { fetchBpmCached } = window.DeezerBpm.api;

  let activeBpmFilterPredicate = null;
  let filterApplyScheduled = false;

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
    return (
      document.querySelector(".catalog-content") ??
      document.querySelector("#page_content")
    );
  }

  function getRowKey(row) {
    const titleEl = row.querySelector('[data-testid="title"]');
    const title = titleEl?.textContent.trim() ?? "";
    const coverId = extractCoverId(row);
    return makeCoverTrackKey(coverId, title);
  }

  function getRowFilterMatch(bpm) {
    if (!activeBpmFilterPredicate || bpm === undefined || bpm === null) {
      return null;
    }

    const bpmNum = Number(bpm);
    return !isNaN(bpmNum) && activeBpmFilterPredicate(bpmNum);
  }

  function updateRowFilterState(row, bpm) {
    if (!row) return;

    const matches = getRowFilterMatch(bpm);
    row.classList.toggle(FILTER_MATCH_CLASS, !!matches);

    if (matches !== null) {
      toggleRowCheckbox(row, matches);
    }
  }

  function renderBpmValue(span, trackId, row = null) {
    return (bpm) => {
      if (!span.isConnected || span.dataset.dbpmTrack !== trackId) return;

      span.textContent = bpm !== null ? String(bpm) : "N/A";
      span.classList.toggle(`${INLINE_CLASS}--loaded`, bpm !== null);
      span.classList.toggle(`${INLINE_CLASS}--unknown`, bpm === null);

      updateRowFilterState(row, bpm);
    };
  }

  function createBpmSpan(row) {
    const span = document.createElement("span");
    span.className = INLINE_CLASS;
    span.textContent = "…";

    const durationCell = findDurationCell(row);
    if (durationCell) {
      durationCell.before(span);
    } else {
      row.appendChild(span);
    }

    return span;
  }

  function resetInjectedRow(row, span = null) {
    row.removeAttribute(INJECTED_ATTR);
    row.removeAttribute(ROW_KEY_ATTR);
    span?.remove();
  }

  function reuseCachedRowBpm(row, rowKey) {
    const span = row.querySelector(`.${INLINE_CLASS}`);
    if (!span) return false;

    const trackId = trackResolutionCache.get(rowKey);
    if (!trackId) return false;

    const bpm = bpmCache.get(trackId);
    if (bpm === undefined) return false;

    span.dataset.dbpmTrack = trackId;
    row.setAttribute(ROW_KEY_ATTR, rowKey);
    renderBpmValue(span, trackId, row)(bpm);
    return true;
  }

  function injectBpmsIntoRows(
    container,
    resolveTrackId,
    { rowFilter = null } = {},
  ) {
    for (const row of container.querySelectorAll(
      '[role="row"][aria-rowindex]',
    )) {
      if (rowFilter && !rowFilter(row)) continue;

      const injectedAttr = row.getAttribute(INJECTED_ATTR);
      if (injectedAttr === "pending") continue;

      const rowKey = getRowKey(row);

      if (injectedAttr === "1") {
        if (row.getAttribute(ROW_KEY_ATTR) === rowKey) continue;
        if (reuseCachedRowBpm(row, rowKey)) continue;

        row.querySelector(`.${INLINE_CLASS}`)?.remove();
        row.removeAttribute(INJECTED_ATTR);
        row.removeAttribute(ROW_KEY_ATTR);
      }

      row.setAttribute(INJECTED_ATTR, "pending");

      const span = createBpmSpan(row);

      resolveTrackId(row).then((trackId) => {
        if (!row.isConnected) {
          resetInjectedRow(row, span);
          return;
        }

        if (row.getAttribute(INJECTED_ATTR) !== "pending") {
          span.remove();
          return;
        }

        row.setAttribute(INJECTED_ATTR, "1");

        if (trackId === null) {
          span.textContent = "–";
          return;
        }

        row.setAttribute(ROW_KEY_ATTR, rowKey);

        if (trackId === UNRESOLVABLE) {
          span.textContent = "✕";
          row.classList.remove(FILTER_MATCH_CLASS);
          return;
        }

        span.dataset.dbpmTrack = trackId;

        fetchBpmCached(trackId)
          .then(renderBpmValue(span, trackId, row))
          .catch((error) => {
            console.warn("[Deezer BPM] fetch error for track", trackId, error);
            if (!span.isConnected) return;

            span.textContent = "N/A";
            row.classList.remove(FILTER_MATCH_CLASS);
          });
      });
    }
  }

  function injectColumnHeader(container) {
    if (container.querySelector(`.${HEADER_CLASS}`)) return;

    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    if (!headers.length) return;

    let durationHeader = null;
    const durationCell = [
      ...container.querySelectorAll('[role="row"][aria-rowindex]'),
    ].reduce((found, row) => found ?? findDurationCell(row), null);

    if (durationCell) {
      const colIndex = [...durationCell.parentElement.children].indexOf(
        durationCell,
      );
      logDebugInfo("Found duration cell column index", colIndex);
      if (colIndex >= 0 && colIndex < headers.length) {
        durationHeader = headers[colIndex];
      }
    } else {
      logDebugError("Could not find duration cell in sample row", headers);
    }

    if (!durationHeader) return;

    const bpmHeader = document.createElement("div");
    bpmHeader.className = HEADER_CLASS;
    bpmHeader.setAttribute("role", "columnheader");

    const btn = document.createElement("button");
    btn.className = durationHeader.querySelector("button")?.className ?? "";
    btn.type = "button";
    btn.disabled = true;
    btn.setAttribute("aria-label", "BPM");
    btn.textContent = "BPM";

    bpmHeader.appendChild(btn);
    durationHeader.before(bpmHeader);
  }

  function injectPlaceholders({
    isTrackPage,
    currentPageUrl,
    resolveRowTrackId,
  }) {
    if (!isTrackPage || currentPageUrl !== location.pathname) return;

    const catalog = getTrackListContainer();
    if (!catalog) return;

    injectColumnHeader(catalog);

    injectBpmsIntoRows(catalog, (row) => resolveRowTrackId(row), {
      rowFilter: (row) =>
        !row.closest(".player-queuelist") &&
        !!row.querySelector('[data-testid="title"]') &&
        !row.querySelector('button[aria-label="Add track"]') &&
        !row.querySelector('[data-testid="show"]'),
    });
  }

  function injectQueueBpms(resolveRowTrackId) {
    const queueContainer = document.querySelector(".player-queuelist");
    if (!queueContainer) return;

    injectBpmsIntoRows(queueContainer, (row) =>
      resolveRowTrackId(row, { allowSearchFallback: true }),
    );
  }

  function removePlaylistBpms() {
    const catalog = getTrackListContainer();
    if (!catalog) return;

    catalog
      .querySelectorAll(`.${INLINE_CLASS}, .${HEADER_CLASS}`)
      .forEach((element) => element.remove());

    catalog.querySelectorAll(`[${INJECTED_ATTR}]`).forEach((element) => {
      element.removeAttribute(INJECTED_ATTR);
      element.removeAttribute(ROW_KEY_ATTR);
      element.classList.remove(FILTER_MATCH_CLASS);
    });
  }

  function applyFilterToVisibleRows() {
    const catalog = getTrackListContainer();
    const rows = catalog
      ? [...catalog.querySelectorAll('[role="row"][aria-rowindex]')]
      : [];
    const queueRows = [
      ...document.querySelectorAll(
        '.player-queuelist [role="row"][aria-rowindex]',
      ),
    ];

    [...rows, ...queueRows].forEach((row) => {
      const trackId = row.querySelector(`.${INLINE_CLASS}`)?.dataset.dbpmTrack;
      updateRowFilterState(
        row,
        !trackId || trackId === UNRESOLVABLE
          ? undefined
          : bpmCache.get(trackId),
      );
    });
  }

  function scheduleApplyFilter() {
    if (filterApplyScheduled) return;

    filterApplyScheduled = true;
    queueMicrotask(() => {
      filterApplyScheduled = false;
      applyFilterToVisibleRows();
    });
  }

  function toggleRowCheckbox(row, shouldSelect) {
    const button = row.querySelector('[data-testid="select_button"]');
    const checkbox = button?.querySelector('input[type="checkbox"]');
    if (!button || !checkbox) return;

    const isChecked =
      button.getAttribute("aria-checked") === "true" ||
      checkbox.closest('[aria-checked="true"]') !== null ||
      checkbox.checked;

    if (shouldSelect !== isChecked) {
      const snapshots = [];
      let el = button.parentElement;
      while (el) {
        if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
          snapshots.push({ el, top: el.scrollTop, left: el.scrollLeft });
        }
        el = el.parentElement;
      }

      const restore = () => {
        for (const s of snapshots) {
          s.el.scrollTop = s.top;
          s.el.scrollLeft = s.left;
        }
      };

      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );

      restore();
      Promise.resolve().then(restore);
      setTimeout(restore, 0);
    }
  }

  function initPlaylistFilter() {
    window.addEventListener("dbpm:filter-changed", (e) => {
      const filterStr = e.detail.filter;
      logDebugInfo("[PLAYLIST] Filter changed event received:", filterStr);
      activeBpmFilterPredicate = parseBpmFilter(filterStr);
      syncFilterButton(!!activeBpmFilterPredicate);
      scheduleApplyFilter();
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
    applyFilterToVisibleRows,
    scheduleApplyFilter,
    initPlaylistFilter,
  };
})();

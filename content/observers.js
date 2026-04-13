(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  const {
    PLAYLIST_RESCAN_INTERVAL_MS,
    INLINE_CLASS,
    HEADER_CLASS,
    BADGE_ID,
  } = window.DeezerBpm.constants;

  const { logDebugInfo } = window.DeezerBpm.utils;

  const { getTrackListContainer, applyFilterToVisibleRows } =
      window.DeezerBpm.playlist;

  let playlistObserver = null;
  let playlistContainerObserver = null;
  let observedCatalog = null;
  let observedQueueContainer = null;
  let lastUrl = location.href;
  let urlChangeTimer = null;
  let playlistRescanIntervalId = null;
  let miniplayerReadyObserver = null;
  let filterApplyScheduled = false;

  function scheduleApplyFilter() {
    if (filterApplyScheduled) return;
    filterApplyScheduled = true;

    queueMicrotask(() => {
      filterApplyScheduled = false;
      applyFilterToVisibleRows();
    });
  }

  function isDbpmNode(node) {
    if (!(node instanceof Element)) return false;

    return (
        node.id === BADGE_ID ||
        node.classList.contains(INLINE_CLASS) ||
        node.classList.contains(HEADER_CLASS) ||
        node.closest(`#${BADGE_ID}`) !== null ||
        node.closest(`.${INLINE_CLASS}`) !== null ||
        node.closest(`.${HEADER_CLASS}`) !== null
    );
  }

  function hasRelevantPlaylistMutation(mutations) {
    return mutations.some((mutation) => {
      if (mutation.type !== "childList") return true;

      const addedRelevant = [...mutation.addedNodes].some(
          (node) => !isDbpmNode(node),
      );
      if (addedRelevant) return true;

      const removedRelevant = [...mutation.removedNodes].some(
          (node) => !isDbpmNode(node),
      );
      return removedRelevant;
    });
  }

  function refreshObservedContainers() {
    if (!playlistObserver) return;

    const catalog = getTrackListContainer();
    const queueContainer = document.querySelector(".player-queuelist");

    if (
        catalog === observedCatalog &&
        queueContainer === observedQueueContainer
    )
      return;

    playlistObserver.disconnect();

    if (catalog) {
      playlistObserver.observe(catalog, { childList: true, subtree: true });
    }

    if (queueContainer) {
      playlistObserver.observe(queueContainer, {
        childList: true,
        subtree: true,
      });
    }

    observedCatalog = catalog;
    observedQueueContainer = queueContainer;
  }

  function startPlaylistObserver({ onQueueMutation, onPlaylistMutation }) {
    if (!playlistObserver) {
      playlistObserver = new MutationObserver((mutations) => {
        if (!hasRelevantPlaylistMutation(mutations)) return;

        onQueueMutation();

        if (onPlaylistMutation) {
          onPlaylistMutation();
        }

        scheduleApplyFilter();
      });
    }

    if (!playlistContainerObserver) {
      playlistContainerObserver = new MutationObserver(() => {
        refreshObservedContainers();
      });
      playlistContainerObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    refreshObservedContainers();
  }

  function stopPlaylistObserver() {
    if (playlistObserver) {
      playlistObserver.disconnect();
      playlistObserver = null;
    }

    if (playlistContainerObserver) {
      playlistContainerObserver.disconnect();
      playlistContainerObserver = null;
    }

    observedCatalog = null;
    observedQueueContainer = null;
  }

  function onUrlChange(callback) {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    callback();
  }

  function scheduleUrlChange(callback, delay = 150) {
    clearTimeout(urlChangeTimer);
    urlChangeTimer = setTimeout(() => onUrlChange(callback), delay);
  }

  function setupMiniplayerObserver({ onTitleChange, onReady }) {
    const attachObserver = (miniplayerEl) => {
      let lastPlayerTitle = null;
      let miniplayerTimer = null;

      new MutationObserver(() => {
        const anchor = miniplayerEl.querySelector(
            '[data-testid="item_title"] a[href*="/album/"]',
        );
        const title = anchor?.textContent ?? null;
        if (title === lastPlayerTitle) return;

        logDebugInfo(
            "[MINIPLAYER] title changed",
            lastPlayerTitle,
            "->",
            title,
        );
        lastPlayerTitle = title;

        onTitleChange?.();

        clearTimeout(miniplayerTimer);
        miniplayerTimer = setTimeout(() => {
          onReady?.();
        }, 150);
      }).observe(miniplayerEl, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };

    const miniplayerEl = document.querySelector(
        '[data-testid="miniplayer_container"]',
    );
    if (miniplayerEl) {
      attachObserver(miniplayerEl);
      return;
    }

    miniplayerReadyObserver = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="miniplayer_container"]');
      if (!el) return;

      miniplayerReadyObserver.disconnect();
      miniplayerReadyObserver = null;

      attachObserver(el);
      onReady?.();
    });

    miniplayerReadyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function setupTitleObserver(callback) {
    const titleEl = document.querySelector("title");
    if (!titleEl) return;

    new MutationObserver(() => {
      scheduleUrlChange(callback);
    }).observe(titleEl, { childList: true });
  }

  function setupPopstateObserver(callback) {
    window.addEventListener("popstate", () => {
      scheduleUrlChange(callback);
    });
  }

  function setupPagehideObserver(callback) {
    window.addEventListener("pagehide", () => {
      callback();
    });
  }

  function startPlaylistRescan(callback) {
    if (playlistRescanIntervalId !== null) return;

    playlistRescanIntervalId = window.setInterval(() => {
      callback();
    }, PLAYLIST_RESCAN_INTERVAL_MS);
  }

  function stopPlaylistRescan() {
    if (playlistRescanIntervalId === null) return;

    clearInterval(playlistRescanIntervalId);
    playlistRescanIntervalId = null;
  }

  function setupToggleListener(callback) {
    document.addEventListener(
        "mousedown",
        (event) => {
          if (event.target.closest(".dbpm-list-btn")) {
            event.stopPropagation();
            callback();
          }
        },
        true,
    );
  }

  window.DeezerBpm.observers = {
    startPlaylistObserver,
    stopPlaylistObserver,
    refreshObservedContainers,
    scheduleUrlChange,
    setupMiniplayerObserver,
    setupTitleObserver,
    setupPopstateObserver,
    setupPagehideObserver,
    startPlaylistRescan,
    stopPlaylistRescan,
    setupToggleListener,
  };
})();
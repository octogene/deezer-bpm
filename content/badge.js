(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  const {
    BADGE_ID,
    BADGE_UPDATE_DELAY_MS,
    FILTER_WIDGET_CLASS,
    FILTER_WIDGET_OPEN_CLASS,
    FILTER_BTN_CLASS,
    FILTER_BTN_ON_CLASS,
    FILTER_INPUT_CLASS,
    FILTER_APPLY_CLASS,
  } = window.DeezerBpm.constants;

  const { logDebugInfo, logDebugError } = window.DeezerBpm.utils;

  const { fetchBpmCached } = window.DeezerBpm.api;

  const { detectTrackIdFromPlayer } = window.DeezerBpm.resolver;

  let currentTrackId = null;
  let badgeUpdateTimer = null;
  let badgeUpdateRunning = false;
  let badgeUpdateQueued = false;
  let badgeObserverStarted = false;

  function createBadgeContent(badge) {
    const svgNs = "http://www.w3.org/2000/svg";

    const filterWidget = document.createElement("div");
    filterWidget.className = FILTER_WIDGET_CLASS;

    const filterButton = document.createElement("button");
    filterButton.className = FILTER_BTN_CLASS;
    filterButton.title = "Select tracks by BPM filter";

    const filterIcon = document.createElementNS(svgNs, "svg");
    filterIcon.setAttribute("viewBox", "0 0 24 24");
    filterIcon.setAttribute("width", "14");
    filterIcon.setAttribute("height", "14");
    filterIcon.setAttribute("focusable", "false");
    filterIcon.setAttribute("class", "chakra-icon");
    filterIcon.setAttribute("aria-hidden", "true");

    const filterPath = document.createElementNS(svgNs, "path");
    filterPath.setAttribute(
      "d",
      "M10.947 5.35c3.725 0 5.614 1.89 5.614 5.614 0 1.513-.326 2.745-.967 3.661l-.392.477-.398.374c-.925.731-2.223 1.102-3.857 1.102-3.725 0-5.614-1.889-5.614-5.614 0-3.725 1.889-5.613 5.614-5.613Zm0-1.332C6.486 4.018 4 6.503 4 10.964s2.486 6.947 6.947 6.947c1.955 0 3.53-.478 4.684-1.39l3.243 3.462L20 18.927l-3.315-3.537c.79-1.127 1.209-2.61 1.209-4.426 0-4.46-2.486-6.946-6.947-6.946Z",
    );
    filterIcon.appendChild(filterPath);
    filterButton.appendChild(filterIcon);

    const filterInput = document.createElement("input");
    filterInput.className = FILTER_INPUT_CLASS;
    filterInput.type = "text";
    filterInput.placeholder = ">100";

    const filterApply = document.createElement("button");
    filterApply.className = FILTER_APPLY_CLASS;
    filterApply.title = "Apply filter";
    filterApply.textContent = "✓";

    filterWidget.appendChild(filterButton);
    filterWidget.appendChild(filterInput);
    filterWidget.appendChild(filterApply);

    const disc = document.createElement("div");
    disc.className = "dbpm-disc";

    const label = document.createElement("span");
    label.className = "dbpm-label";
    label.textContent = "BPM";

    const value = document.createElement("span");
    value.className = "dbpm-value";
    value.textContent = "–";

    const listButton = document.createElement("button");
    listButton.className = "dbpm-list-btn";
    listButton.title = "Show BPM in playlist";
    listButton.textContent = "≡";

    disc.appendChild(label);
    disc.appendChild(value);
    disc.appendChild(listButton);

    badge.appendChild(filterWidget);
    badge.appendChild(disc);
  }

  function getBadge() {
    let badge = document.getElementById(BADGE_ID);

    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      createBadgeContent(badge);

      document.body.appendChild(badge);
      attachBadgeEvents(badge);
    }

    return badge;
  }

  function setBadgeValue(text, active) {
    const badge = getBadge();
    badge.querySelector(".dbpm-value").textContent = text;
    badge
      .querySelector(".dbpm-disc")
      .classList.toggle("dbpm-disc--active", !!active);
  }

  function syncPlaylistModeButton(enabled) {
    const badge = getBadge();
    badge
      .querySelector(".dbpm-list-btn")
      .classList.toggle("dbpm-list-btn--on", !!enabled);
  }

  function syncFilterButton(active) {
    const badge = getBadge();
    badge
      .querySelector("." + FILTER_BTN_CLASS)
      .classList.toggle(FILTER_BTN_ON_CLASS, !!active);
  }

  function attachBadgeEvents(badge) {
    badge.addEventListener("click", (e) => {
      if (e.target.closest("." + FILTER_BTN_CLASS)) {
        e.preventDefault();
        e.stopPropagation();
        const widget = badge.querySelector("." + FILTER_WIDGET_CLASS);
        const isOpen = widget.classList.toggle(FILTER_WIDGET_OPEN_CLASS);

        if (isOpen) {
          setTimeout(
            () => widget.querySelector("." + FILTER_INPUT_CLASS).focus(),
            100,
          );
        } else {
          // Reset filter if input is closed
          applyFilterWithValue("");
        }
        return;
      }

      if (e.target.closest("." + FILTER_APPLY_CLASS)) {
        e.preventDefault();
        e.stopPropagation();
        applyFilterFromInput();
      }
    });

    badge.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" &&
        e.target.classList.contains(FILTER_INPUT_CLASS)
      ) {
        e.preventDefault();
        e.stopPropagation();
        applyFilterFromInput();
      }
    });
  }

  function applyFilterFromInput() {
    const badge = getBadge();
    const input = badge.querySelector("." + FILTER_INPUT_CLASS);
    applyFilterWithValue(input.value.trim());
  }

  function applyFilterWithValue(value) {
    logDebugInfo("[BADGE] Applying filter with value:", value);

    window.dispatchEvent(
      new CustomEvent("dbpm:filter-changed", {
        detail: { filter: value },
      }),
    );
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
      logDebugInfo("[BADGE] Update already running; queueing a follow-up pass");
      return;
    }

    badgeUpdateRunning = true;

    try {
      const trackId = await detectTrackIdFromPlayer().catch((reason) => {
        logDebugError("[BADGE] Failed to detect track ID from player:", reason);
        return null;
      });

      if (!trackId) {
        setBadgeValue("–");
        currentTrackId = null;
        return;
      }

      if (trackId === currentTrackId) {
        logDebugInfo("[BADGE] Same track; skipping update for", trackId);
        return;
      }

      currentTrackId = trackId;
      setBadgeValue("…");

      const bpm = await fetchBpmCached(trackId);
      logDebugInfo("[BADGE] Fetched track BPM:", bpm);
      setBadgeValue(bpm ?? "N/A", bpm !== null);
    } catch (error) {
      logDebugError("[BADGE] Failed to update", error);
      setBadgeValue("✕");
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
    syncFilterButton,
    resetCurrentTrackId,
    schedulePlayerBadgeUpdate,
    runPlayerBadgeUpdate,
    ensureBadgeObserver,
    initBadge,
  };
})();

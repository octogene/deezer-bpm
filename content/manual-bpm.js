(function () {
  "use strict";

  window.DeezerBpm = window.DeezerBpm || {};

  // Shared by both the content script and the popup (see popup/popup.html),
  // which run in separate JS contexts with no other way to share code.

  function isValidTrackId(id) {
    return /^\d+$/.test(String(id).trim());
  }

  function isValidManualBpm(bpm) {
    return Number.isInteger(bpm) && bpm > 0 && bpm < 1000;
  }

  // Validates a raw {id: bpm} storage object (as read from storage.local or
  // an import payload) into a Map<string, number> of accepted overrides.
  function parseManualOverrides(rawValue) {
    const result = new Map();
    if (rawValue && typeof rawValue === "object") {
      for (const [id, bpmRaw] of Object.entries(rawValue)) {
        const bpm = Number(bpmRaw);
        if (isValidTrackId(id) && isValidManualBpm(bpm)) {
          result.set(String(id).trim(), bpm);
        }
      }
    }
    return result;
  }

  window.DeezerBpm.manualBpm = {
    isValidTrackId,
    isValidManualBpm,
    parseManualOverrides,
  };
})();

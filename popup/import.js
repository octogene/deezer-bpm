(function () {
  "use strict";

  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;

  const { MANUAL_BPM_STORAGE_KEY, DEBUG_STORAGE_KEY } =
    window.DeezerBpm.constants;
  const { parseManualOverrides } = window.DeezerBpm.manualBpm;
  const { validateAndBuild } = window.DeezerBpm.csv;

  const DEBUG = localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  const log = (...args) => {
    if (DEBUG) console.log("[Deezer BPM][import]", ...args);
  };

  let els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els = {
      chooseBtn: document.getElementById("choose-btn"),
      fileInput: document.getElementById("file-input"),
      replaceAll: document.getElementById("replace-all"),
      status: document.getElementById("status"),
    };

    els.chooseBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", () => {
      const file = els.fileInput.files[0];
      if (file) onImport(file);
      // Reset so selecting the same file again re-triggers "change".
      els.fileInput.value = "";
    });
  }

  async function readOverrides() {
    const result = await storage.local.get(MANUAL_BPM_STORAGE_KEY);
    const raw = result[MANUAL_BPM_STORAGE_KEY];
    return Object.fromEntries(parseManualOverrides(raw));
  }

  async function onImport(file) {
    els.chooseBtn.disabled = true;
    setStatus("Reading file…", "info");
    log("Import started:", {
      name: file?.name,
      size: file?.size,
      type: file?.type,
    });

    try {
      const text = await file.text();
      log("File read. length:", text.length);

      const result = validateAndBuild(text);
      log("Validation result:", result);

      if (result.error) {
        log("Import rejected:", result.error);
        setStatus(result.error, "err");
        return;
      }

      const replaceAll = els.replaceAll.checked;
      const existing = replaceAll ? {} : await readOverrides();
      const merged = { ...existing, ...result.valid };
      log("Writing overrides:", {
        replaceAll,
        existing: Object.keys(existing).length,
        imported: result.imported,
        merged: Object.keys(merged).length,
      });

      await storage.local.set({ [MANUAL_BPM_STORAGE_KEY]: merged });
      log("storage.local.set succeeded");

      const parts = [
        `Imported ${result.imported} manual BPM${
          result.imported === 1 ? "" : "s"
        }`,
      ];
      if (result.skipped) {
        parts.push(
          `${result.skipped} row${result.skipped === 1 ? "" : "s"} skipped`,
        );
      }
      setStatus(`${parts.join(", ")}. You can close this window.`, "ok");
    } catch (error) {
      // Log the whole error object -- its .message is sometimes empty (e.g.
      // storage quota / serialization errors).
      console.error("[Deezer BPM][import] Import failed:", error);
      setStatus(`Import failed: ${error?.message || error}`, "err");
    } finally {
      els.chooseBtn.disabled = false;
    }
  }

  function setStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = kind || "info";
  }
})();

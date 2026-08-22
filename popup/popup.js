(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;
  const windows =
    typeof browser !== "undefined" ? browser.windows : chrome.windows;

  const { MANUAL_BPM_STORAGE_KEY } = window.DeezerBpm.constants;
  const { parseManualOverrides } = window.DeezerBpm.manualBpm;
  const { buildCsv } = window.DeezerBpm.csv;

  let els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els = {
      count: document.getElementById("count"),
      exportBtn: document.getElementById("export-btn"),
      importBtn: document.getElementById("import-btn"),
      status: document.getElementById("status"),
    };

    els.exportBtn.addEventListener("click", onExport);
    els.importBtn.addEventListener("click", openImportWindow);

    refreshCount();
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  async function readOverrides() {
    const result = await storage.local.get(MANUAL_BPM_STORAGE_KEY);
    const raw = result[MANUAL_BPM_STORAGE_KEY];
    return Object.fromEntries(parseManualOverrides(raw));
  }

  async function refreshCount() {
    try {
      const overrides = await readOverrides();
      const n = Object.keys(overrides).length;
      els.count.textContent =
        n === 1 ? "1 manual BPM saved" : `${n} manual BPMs saved`;
      els.exportBtn.disabled = n === 0;
    } catch {
      els.count.textContent = "Could not read saved BPMs.";
    }
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  async function onExport() {
    els.exportBtn.disabled = true;

    try {
      const overrides = await readOverrides();
      const ids = Object.keys(overrides);
      const csv = buildCsv(ids, overrides, runtime.getManifest().version);

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `deezer-manual-bpm-${dateStamp()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus(
        `Exported ${ids.length} manual BPM${ids.length === 1 ? "" : "s"}.`,
        "ok",
      );
    } catch (error) {
      setStatus(`Export failed: ${error.message}`, "err");
    } finally {
      els.exportBtn.disabled = false;
      refreshCount();
    }
  }

  function dateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  // Firefox closes an action popup as soon as an <input type="file"> opens the
  // native file picker (the popup loses focus before -- sometimes during --
  // the "change" event), so the picker can't live in this popup. Instead it
  // gets its own real window, which Firefox does not auto-close on blur.
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1658694
  async function openImportWindow() {
    await windows.create({
      url: runtime.getURL("popup/import.html"),
      type: "popup",
      width: 360,
      height: 340,
    });
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  function setStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = kind || "info";
  }
})();

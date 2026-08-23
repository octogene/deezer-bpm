(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;
  const windows =
    typeof browser !== "undefined" ? browser.windows : chrome.windows;

  const { MANUAL_BPM_STORAGE_KEY, SYNC_SETTINGS_KEY } =
    window.DeezerBpm.constants;
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
      syncCode: document.getElementById("sync-code"),
      generateBtn: document.getElementById("generate-btn"),
      copyBtn: document.getElementById("copy-btn"),
      syncEnabled: document.getElementById("sync-enabled"),
      autoSync: document.getElementById("auto-sync"),
      mergeBtn: document.getElementById("merge-btn"),
      lwwBtn: document.getElementById("lww-btn"),
      syncInfo: document.getElementById("sync-info"),
    };

    els.exportBtn.addEventListener("click", onExport);
    els.importBtn.addEventListener("click", openImportWindow);

    els.generateBtn.addEventListener("click", onGenerateCode);
    els.copyBtn.addEventListener("click", onCopyCode);
    els.syncCode.addEventListener("change", () =>
      saveSyncSettings({ code: normalizeCode(els.syncCode.value) }),
    );
    els.syncEnabled.addEventListener("change", () =>
      saveSyncSettings({ syncEnabled: els.syncEnabled.checked }),
    );
    els.autoSync.addEventListener("change", () =>
      saveSyncSettings({ autoSync: els.autoSync.checked }),
    );
    els.mergeBtn.addEventListener("click", () => onSync("merge"));
    els.lwwBtn.addEventListener("click", () => onSync("lww"));

    refreshCount();
    loadSyncSettings();
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

  // ── Sync ──────────────────────────────────────────────────────────────────

  // Uppercase and strip whitespace; keep the alphabet + dashes the Worker allows.
  function normalizeCode(raw) {
    return String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "");
  }

  async function onGenerateCode() {
    const result = await runtime.sendMessage({ type: "open-sync-activation" });
    if (!result?.ok) {
      setStatus(
        `Could not open code creation: ${result?.error || "unknown error"}`,
        "err",
      );
      return;
    }
    setStatus("Create the code in the new tab, then paste it here.", "info");
  }

  async function onCopyCode() {
    const code = els.syncCode.value.trim();
    if (!code) {
      setStatus("Nothing to copy — generate a code first.", "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setStatus("Sync code copied to clipboard.", "ok");
    } catch {
      // Clipboard API can be unavailable; fall back to selecting the field.
      els.syncCode.focus();
      els.syncCode.select();
      setStatus("Press Ctrl+C to copy the selected code.", "info");
    }
  }

  async function readSyncSettings() {
    const result = await storage.local.get(SYNC_SETTINGS_KEY);
    const s = result[SYNC_SETTINGS_KEY];
    return {
      code: "",
      syncEnabled: true,
      autoSync: false,
      lastSyncAt: 0,
      lastStatus: "",
      ...(s && typeof s === "object" ? s : {}),
    };
  }

  async function loadSyncSettings() {
    try {
      const settings = await readSyncSettings();
      els.syncCode.value = settings.code || "";
      els.syncEnabled.checked = settings.syncEnabled !== false;
      els.autoSync.checked = !!settings.autoSync;
      renderSyncInfo(settings);
      updateSyncButtons();
    } catch {
      els.syncInfo.textContent = "Could not read sync settings.";
    }
  }

  async function saveSyncSettings(patch) {
    const current = await readSyncSettings();
    const codeChanged =
      Object.hasOwn(patch, "code") && patch.code !== current.code;
    const next = {
      ...current,
      ...patch,
      ...(codeChanged
        ? {
            lastSyncAt: 0,
            lastStatus: "",
            syncStateCode: "",
            syncRevision: 0,
            syncBaseline: {},
            syncConflicts: {},
          }
        : {}),
    };
    await storage.local.set({ [SYNC_SETTINGS_KEY]: next });
    renderSyncInfo(next);
    updateSyncButtons();
  }

  function updateSyncButtons() {
    const hasCode = !!els.syncCode.value.trim();
    const enabled = els.syncEnabled.checked;
    els.autoSync.disabled = !enabled;
    els.mergeBtn.disabled = !enabled || !hasCode;
    els.lwwBtn.disabled = !enabled || !hasCode;
  }

  function renderSyncInfo(settings) {
    if (settings.syncEnabled === false) {
      els.syncInfo.textContent = "Sync is disabled.";
      return;
    }
    if (!settings.code) {
      els.syncInfo.textContent = "Not syncing yet — create or paste a code.";
      return;
    }
    const bad = (settings.lastStatus || "").startsWith("error");
    // Check for a failure before the lastSyncAt gate below -- it's only ever
    // set on a successful sync, so a sync that fails before its first
    // success would otherwise be reported as "Not synced yet.", hiding the
    // error entirely.
    if (bad && !settings.lastSyncAt) {
      els.syncInfo.textContent = `Sync failed: ${settings.lastStatus.slice(7)}`;
      return;
    }
    if (!settings.lastSyncAt) {
      els.syncInfo.textContent = settings.autoSync
        ? "Auto-sync on. Not synced yet."
        : "Not synced yet.";
      return;
    }
    const when = new Date(settings.lastSyncAt).toLocaleString();
    const conflict = (settings.lastStatus || "").startsWith("conflict");
    if (bad) {
      els.syncInfo.textContent = `Last sync failed (${when}): ${settings.lastStatus.slice(7)}`;
    } else if (conflict) {
      const conflictCount = Number(settings.lastStatus.slice(10)) || 0;
      els.syncInfo.textContent =
        `Last synced ${when}; ${conflictCount} unresolved ` +
        `conflict${conflictCount === 1 ? "" : "s"}.`;
    } else {
      els.syncInfo.textContent = `Last synced ${when}${
        settings.autoSync ? " · auto-sync on" : ""
      }.`;
    }
  }

  async function onSync(mode) {
    // Persist whatever is in the field first, in case the user pasted a code
    // and clicked without blurring it.
    const code = normalizeCode(els.syncCode.value);
    els.syncCode.value = code;
    if (!code) {
      setStatus("Enter or generate a sync code first.", "err");
      return;
    }
    await saveSyncSettings({ code });

    els.mergeBtn.disabled = true;
    els.lwwBtn.disabled = true;
    setStatus(
      mode === "lww" ? "Syncing with local changes…" : "Syncing…",
      "info",
    );

    try {
      const res = await runtime.sendMessage({ type: "sync", mode });
      if (res && res.ok) {
        if (res.capacityExceeded) {
          // Downloads still succeeded; only the upload was refused.
          setStatus(
            "This sync code is full, so new tracks were not uploaded. " +
              "Remove some manual BPMs, or create a new code.",
            "err",
          );
        } else if (res.conflicts) {
          setStatus(
            `Merged with ${res.conflicts} conflicting track${
              res.conflicts === 1 ? "" : "s"
            } kept local. Use local changes to upload them.`,
            "info",
          );
        } else {
          setStatus(
            `Synced ${res.count} manual BPM${res.count === 1 ? "" : "s"}.`,
            "ok",
          );
        }
      } else {
        setStatus(`Sync failed: ${res?.error || "unknown error"}`, "err");
      }
    } catch (error) {
      setStatus(`Sync failed: ${error?.message || error}`, "err");
    } finally {
      updateSyncButtons();
      refreshCount();
      loadSyncSettings();
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  function setStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = kind || "info";
  }
})();

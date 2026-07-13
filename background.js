(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const tabs = typeof browser !== "undefined" ? browser.tabs : chrome.tabs;
  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;
  const alarms =
    typeof browser !== "undefined" ? browser.alarms : chrome.alarms;

  // ── Config ───────────────────────────────────────────────────────────────
  // Must match content/constants.js. Duplicated because the background service
  // worker does not load the content-script constants module.
  const MANUAL_BPM_STORAGE_KEY = "deezerBpmManualOverrides";
  const SYNC_SETTINGS_KEY = "deezerBpmSync";

  // The deployed Cloudflare Worker (see worker/README.md). This URL must also be
  // listed in manifest.json `host_permissions`. Replace with your own after
  // `wrangler deploy`; the same literal is duplicated in popup/popup.js.
  const SYNC_ENDPOINT = "https://deezer-bpm-sync.example.workers.dev";

  const SYNC_ALARM_NAME = "deezerBpmAutoSync";
  const SYNC_INTERVAL_MIN = 15;

  // Schema for the synced CSV — kept identical to the popup export format.
  const CSV_FORMAT_VERSION = 1;
  const CSV_HEADER = "track_id,bpm";

  const DEBUG = true;
  const log = (...args) => {
    if (DEBUG) console.log("[Deezer BPM][bg]", ...args);
  };

  // ── What's-new tab on update (unchanged) ───────────────────────────────────
  runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    reconfigureAlarm();

    if (reason !== "update") return;

    const current = runtime.getManifest().version;

    // Only open the page if the major or minor version changed
    const prev = (previousVersion ?? "").split(".");
    const curr = current.split(".");
    if (prev[0] === curr[0] && prev[1] === curr[1]) return;

    tabs.create({ url: runtime.getURL("docs/whatsnew/index.html") });
  });

  // ── Validation (matches popup/content) ──────────────────────────────────────
  function isValidId(id) {
    return /^\d+$/.test(String(id).trim());
  }

  function isValidBpm(bpm) {
    return Number.isFinite(bpm) && bpm > 0 && bpm < 1000;
  }

  // ── Storage helpers ─────────────────────────────────────────────────────────
  async function readOverrides() {
    const result = await storage.local.get(MANUAL_BPM_STORAGE_KEY);
    const raw = result[MANUAL_BPM_STORAGE_KEY];
    const out = {};
    if (raw && typeof raw === "object") {
      for (const [id, bpmRaw] of Object.entries(raw)) {
        const bpm = Number(bpmRaw);
        if (isValidId(id) && isValidBpm(bpm)) out[id] = Math.trunc(bpm);
      }
    }
    return out;
  }

  function writeOverrides(map) {
    // Writing this key triggers the content script's storage.onChanged listener
    // (content/main.js), so a pull reflects on the page with no reload.
    return storage.local.set({ [MANUAL_BPM_STORAGE_KEY]: map });
  }

  async function readSettings() {
    const result = await storage.local.get(SYNC_SETTINGS_KEY);
    const s = result[SYNC_SETTINGS_KEY];
    return {
      code: "",
      autoSync: false,
      lastSyncAt: 0,
      lastStatus: "",
      syncedRemoteUpdatedAt: 0,
      ...(s && typeof s === "object" ? s : {}),
    };
  }

  async function patchSettings(patch) {
    const current = await readSettings();
    const next = { ...current, ...patch };
    await storage.local.set({ [SYNC_SETTINGS_KEY]: next });
    return next;
  }

  // ── CSV codec (minimal — we only ever parse files we wrote) ──────────────────
  function buildCsv(map) {
    const version = runtime.getManifest().version;
    const lines = [
      `# Deezer BPM manual overrides; format=${CSV_FORMAT_VERSION}; extension=${version}`,
      CSV_HEADER,
    ];
    for (const [id, bpm] of Object.entries(map)) lines.push(`${id},${bpm}`);
    return lines.join("\r\n") + "\r\n";
  }

  function parseCsv(text) {
    const out = {};
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (!line || line.startsWith("#")) continue;
      if (line.toLowerCase().startsWith("track_id")) continue; // header row
      const [idRaw, bpmRaw] = line.split(",");
      const id = (idRaw ?? "").trim();
      const bpm = Number((bpmRaw ?? "").trim());
      if (isValidId(id) && isValidBpm(bpm)) out[id] = Math.trunc(bpm);
    }
    return out;
  }

  // ── Network ──────────────────────────────────────────────────────────────────
  // Returns { map, remoteUpdatedAt } or null (no remote file yet).
  async function pullRemote(code) {
    const res = await fetch(`${SYNC_ENDPOINT}/csv`, {
      method: "GET",
      headers: { "X-Sync-Code": code },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pull failed (HTTP ${res.status})`);
    const text = await res.text();
    const remoteUpdatedAt = Number(res.headers.get("X-Updated-At")) || 0;
    return { map: parseCsv(text), remoteUpdatedAt };
  }

  // Uploads the map and returns the new remoteUpdatedAt (server clock).
  async function pushRemote(code, map) {
    const res = await fetch(`${SYNC_ENDPOINT}/csv`, {
      method: "PUT",
      headers: { "X-Sync-Code": code, "Content-Type": "text/csv" },
      body: buildCsv(map),
    });
    if (!res.ok) throw new Error(`push failed (HTTP ${res.status})`);
    const data = await res.json().catch(() => ({}));
    return Number(data.updatedAt) || Date.now();
  }

  function sameMap(a, b) {
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) if (a[k] !== b[k]) return false;
    return true;
  }

  // ── Sync engine ──────────────────────────────────────────────────────────────
  async function syncNow(mode) {
    const settings = await readSettings();
    const code = (settings.code || "").trim();
    if (!code) return { ok: false, error: "No sync code set." };

    try {
      const local = await readOverrides();
      const remote = await pullRemote(code);
      const remoteMap = remote ? remote.map : {};

      let direction;
      let finalLocal = local;
      let remoteUpdatedAt = remote ? remote.remoteUpdatedAt : 0;

      if (mode === "lww") {
        if (!remote) {
          // Nothing remote yet — seed it from local.
          remoteUpdatedAt = await pushRemote(code, local);
          direction = "push";
        } else if (
          remote.remoteUpdatedAt > (settings.syncedRemoteUpdatedAt || 0)
        ) {
          // Remote changed since our last sync → remote wins (wholesale).
          finalLocal = remoteMap;
          if (!sameMap(finalLocal, local)) await writeOverrides(finalLocal);
          direction = "pull";
        } else {
          // Remote unchanged since last sync → local wins (wholesale).
          remoteUpdatedAt = await pushRemote(code, local);
          direction = "push";
        }
      } else {
        // merge (default, and always used by auto-sync): union, local wins on
        // key conflict. Never deletes → deletions don't propagate.
        const merged = { ...remoteMap, ...local };
        finalLocal = merged;
        if (!sameMap(merged, local)) await writeOverrides(merged);
        if (!remote || !sameMap(merged, remoteMap)) {
          remoteUpdatedAt = await pushRemote(code, merged);
        }
        direction = "merge";
      }

      const lastSyncAt = Date.now();
      await patchSettings({
        lastSyncAt,
        lastStatus: "ok",
        syncedRemoteUpdatedAt: remoteUpdatedAt,
      });

      log("sync ok", {
        mode,
        direction,
        count: Object.keys(finalLocal).length,
      });
      return {
        ok: true,
        mode,
        direction,
        count: Object.keys(finalLocal).length,
        lastSyncAt,
      };
    } catch (error) {
      const message = error?.message || String(error);
      await patchSettings({ lastStatus: `error: ${message}` });
      console.warn("[Deezer BPM][bg] sync failed:", error);
      return { ok: false, error: message };
    }
  }

  // ── Messaging (popup → background) ────────────────────────────────────────────
  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "sync") return false;
    syncNow(msg.mode === "lww" ? "lww" : "merge").then(sendResponse);
    return true; // keep the channel open for the async response
  });

  // ── Auto-sync alarm ────────────────────────────────────────────────────────
  async function reconfigureAlarm() {
    try {
      const { code, autoSync } = await readSettings();
      if (autoSync && code) {
        alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MIN });
        log("auto-sync alarm armed");
      } else {
        alarms.clear(SYNC_ALARM_NAME);
        log("auto-sync alarm cleared");
      }
    } catch (error) {
      console.warn("[Deezer BPM][bg] alarm setup failed:", error);
    }
  }

  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) syncNow("merge");
  });

  // Re-arm when the popup changes the sync settings (code / auto-sync toggle).
  storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SYNC_SETTINGS_KEY]) reconfigureAlarm();
  });

  // Set up on service-worker startup too (onInstalled won't fire on every wake).
  reconfigureAlarm();
})();

(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const tabs = typeof browser !== "undefined" ? browser.tabs : chrome.tabs;
  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;
  const alarms =
    typeof browser !== "undefined" ? browser.alarms : chrome.alarms;

  // These values must match content/constants.js. The background service worker
  // does not load content-script modules.
  const MANUAL_BPM_STORAGE_KEY = "deezerBpmManualOverrides";
  const SYNC_SETTINGS_KEY = "deezerBpmSync";

  // Replace this after deploying the Worker; the host must also be present in
  // manifest.json `host_permissions`.
  const SYNC_ENDPOINT = "https://deezer-bpm-sync.ooctogene.workers.dev";
  const SYNC_ALARM_NAME = "deezerBpmAutoSync";
  const SYNC_INTERVAL_MIN = 15;
  // Randomized per cycle (not just once) so that clients which happen to
  // enable auto-sync around the same time -- e.g. two of one person's own
  // devices, or many users after an update rollout -- drift apart instead of
  // hammering the Worker in lockstep every SYNC_INTERVAL_MIN.
  const SYNC_JITTER_MIN = 3;
  const MAX_SYNC_PAGES = 20;
  // Must match MAX_CHANGES in worker/wrangler.toml -- the server rejects a
  // single request carrying more changes than this.
  const SYNC_MAX_CHANGES_PER_REQUEST = 500;

  function nextSyncDelayMinutes() {
    const jitter = (Math.random() * 2 - 1) * SYNC_JITTER_MIN;
    return Math.max(1, SYNC_INTERVAL_MIN + jitter);
  }

  const DEBUG = true;
  const log = (...args) => {
    if (DEBUG) console.log("[Deezer BPM][bg]", ...args);
  };

  let operationQueue = Promise.resolve();

  runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    reconfigureAlarm();

    if (reason !== "update") return;

    const current = runtime.getManifest().version;
    const prev = (previousVersion ?? "").split(".");
    const curr = current.split(".");
    if (prev[0] === curr[0] && prev[1] === curr[1]) return;

    tabs.create({ url: runtime.getURL("docs/whatsnew/index.html") });
  });

  function isValidId(id) {
    return /^\d+$/.test(String(id).trim());
  }

  function isValidBpm(bpm) {
    return Number.isInteger(bpm) && bpm > 0 && bpm < 1000;
  }

  function normalizeOverrides(raw) {
    const result = {};
    if (!raw || typeof raw !== "object") return result;

    for (const [id, bpmRaw] of Object.entries(raw)) {
      const bpm = Number(bpmRaw);
      if (isValidId(id) && isValidBpm(bpm)) {
        result[String(id).trim()] = bpm;
      }
    }
    return result;
  }

  function normalizeConflictValue(value) {
    if (value === null) return null;
    const bpm = Number(value);
    return isValidBpm(bpm) ? bpm : undefined;
  }

  function normalizeConflicts(raw) {
    const result = {};
    if (!raw || typeof raw !== "object") return result;

    for (const [id, conflict] of Object.entries(raw)) {
      if (!isValidId(id) || !conflict || typeof conflict !== "object") continue;
      const local = normalizeConflictValue(conflict.local);
      const remote = normalizeConflictValue(conflict.remote);
      if (local !== undefined && remote !== undefined && local !== remote) {
        result[id] = { local, remote };
      }
    }
    return result;
  }

  async function readOverrides() {
    const result = await storage.local.get(MANUAL_BPM_STORAGE_KEY);
    return normalizeOverrides(result[MANUAL_BPM_STORAGE_KEY]);
  }

  async function readSettings() {
    const result = await storage.local.get(SYNC_SETTINGS_KEY);
    const stored = result[SYNC_SETTINGS_KEY];
    const settings =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? stored
        : {};

    return {
      code: "",
      syncEnabled: true,
      autoSync: false,
      lastSyncAt: 0,
      lastStatus: "",
      lastCapacityExceeded: false,
      syncStateCode: "",
      ...settings,
      syncRevision:
        Number.isInteger(settings.syncRevision) && settings.syncRevision >= 0
          ? settings.syncRevision
          : 0,
      syncBaseline: normalizeOverrides(settings.syncBaseline),
      syncConflicts: normalizeConflicts(settings.syncConflicts),
    };
  }

  async function patchSettingsForCode(code, patch) {
    const current = await readSettings();
    if ((current.code || "").trim() !== code) return current;

    const next = { ...current, ...patch };
    await storage.local.set({ [SYNC_SETTINGS_KEY]: next });
    return next;
  }

  function mapValue(map, id) {
    return Object.hasOwn(map, id) ? map[id] : null;
  }

  function setMapValue(map, id, value) {
    if (value === null) {
      delete map[id];
    } else {
      map[id] = value;
    }
  }

  function changedIds(a, b) {
    const result = new Set();
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (mapValue(a, id) !== mapValue(b, id)) result.add(id);
    }
    return result;
  }

  function buildClientChanges(baseline, local, conflicts, force) {
    const changes = [];
    const sentIds = new Set();

    for (const id of changedIds(baseline, local)) {
      const localValue = mapValue(local, id);
      const blocked = conflicts[id];
      if (
        !force &&
        blocked &&
        blocked.local === localValue &&
        blocked.remote === mapValue(baseline, id)
      ) {
        continue;
      }

      changes.push({ trackId: id, bpm: localValue });
      sentIds.add(id);
    }

    return { changes, sentIds };
  }

  // Carries the Worker's machine-readable error code so callers can react to a
  // specific failure instead of matching on message text.
  class SyncError extends Error {
    constructor(message, code, retryAfter) {
      super(message);
      this.name = "SyncError";
      this.code = code || "";
      this.retryAfter = retryAfter || 0;
    }
  }

  // Splits changes into chunks no larger than the server's MAX_CHANGES
  // (worker/wrangler.toml) so a bulk import or a from-scratch resync doesn't
  // get rejected outright by the "too many changes" limit.
  function chunkChanges(changes) {
    if (changes.length <= SYNC_MAX_CHANGES_PER_REQUEST) return [changes];

    const chunks = [];
    for (let i = 0; i < changes.length; i += SYNC_MAX_CHANGES_PER_REQUEST) {
      chunks.push(changes.slice(i, i + SYNC_MAX_CHANGES_PER_REQUEST));
    }
    return chunks;
  }

  // Uploads a single chunk of changes (which may itself still be paginated on
  // the way down) and returns the revision it produced.
  async function requestSyncChunk(code, baseRevision, changes, force) {
    let cursor = null;
    let throughRevision = null;
    let capacityExceeded = false;
    const serverChanges = [];

    for (let page = 0; page < MAX_SYNC_PAGES; page++) {
      const response = await fetch(`${SYNC_ENDPOINT}/sync`, {
        method: "POST",
        headers: {
          "X-Sync-Code": code,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baseRevision,
          force: cursor ? false : force,
          changes: cursor ? [] : changes,
          ...(cursor ? { cursor, throughRevision } : {}),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("Retry-After")) || 0;
        const messages = {
          sync_space_not_found:
            "This sync code is not active. Create a new code.",
          rate_limited: retryAfter
            ? `Too many sync requests. Try again in ${retryAfter} seconds.`
            : "Too many sync requests. Try again later.",
          safety_budget_exhausted:
            "Daily sync safety limit reached. Try again tomorrow.",
          revision_ahead: "Local sync state is ahead of the server.",
        };
        throw new SyncError(
          messages[data.code] ||
            data.error ||
            `sync failed (HTTP ${response.status})`,
          data.code,
          retryAfter,
        );
      }

      if (
        !Number.isInteger(data.revision) ||
        data.revision < baseRevision ||
        data.throughRevision !== data.revision ||
        !Array.isArray(data.changes) ||
        (data.nextCursor !== null &&
          data.nextCursor !== undefined &&
          typeof data.nextCursor !== "string")
      ) {
        throw new Error("sync server returned an invalid response");
      }

      if (throughRevision === null) {
        throughRevision = data.throughRevision;
        // Only the first page can carry a write, so this flag is only
        // meaningful there.
        capacityExceeded = data.capacityExceeded === true;
      } else if (data.throughRevision !== throughRevision) {
        throw new Error("sync server changed revision during pagination");
      }

      serverChanges.push(...data.changes);
      if (!data.nextCursor) {
        return {
          revision: throughRevision,
          changes: serverChanges,
          capacityExceeded,
        };
      }
      cursor = data.nextCursor;
    }

    throw new Error("sync response exceeded the pagination limit");
  }

  // Uploads all outgoing changes as one or more chunked requests, advancing
  // baseRevision between chunks, and stitches the resulting deltas back into
  // one contiguous result -- each chunk's delta only covers its own slice of
  // revisions, so concatenating them in order reconstructs the full delta
  // from the original baseRevision through the final one.
  async function requestSync(code, baseRevision, changes, force) {
    let revision = baseRevision;
    let capacityExceeded = false;
    const serverChanges = [];

    for (const chunk of chunkChanges(changes)) {
      const result = await requestSyncChunk(code, revision, chunk, force);
      revision = result.revision;
      capacityExceeded = capacityExceeded || result.capacityExceeded;
      serverChanges.push(...result.changes);
    }

    return { revision, changes: serverChanges, capacityExceeded };
  }

  // Returns the rebuilt server baseline plus the set of track IDs the delta
  // actually carried. A track we uploaded but that is absent from the delta was
  // not applied by the server — see reconcileSync.
  function applyServerChanges(baseline, changes) {
    const result = { ...baseline };
    const appliedIds = new Set();

    for (const change of changes) {
      const id = String(change?.trackId ?? "").trim();
      const bpm = change?.bpm === null ? null : Number(change?.bpm);
      if (!isValidId(id) || (bpm !== null && !isValidBpm(bpm))) {
        throw new Error("sync server returned an invalid track change");
      }
      setMapValue(result, id, bpm);
      appliedIds.add(id);
    }

    return { serverBaseline: result, appliedIds };
  }

  function reconcileSync({
    baseline,
    requestLocal,
    latestLocal,
    serverBaseline,
    appliedIds,
    previousConflicts,
    sentIds,
    force,
  }) {
    const finalLocal = {};
    const conflicts = {};
    const ids = new Set([
      ...Object.keys(baseline),
      ...Object.keys(requestLocal),
      ...Object.keys(latestLocal),
      ...Object.keys(serverBaseline),
      ...Object.keys(previousConflicts),
    ]);

    for (const id of ids) {
      const baseValue = mapValue(baseline, id);
      const requestValue = mapValue(requestLocal, id);
      const latestValue = mapValue(latestLocal, id);
      const serverValue = mapValue(serverBaseline, id);
      const previousConflict = previousConflicts[id];
      const editedDuringSync = latestValue !== requestValue;

      const newConflict =
        !force &&
        sentIds.has(id) &&
        requestValue !== baseValue &&
        serverValue !== baseValue &&
        requestValue !== serverValue;

      const blockedConflict =
        !force &&
        previousConflict &&
        requestValue === previousConflict.local &&
        baseValue === previousConflict.remote;

      // A track the server accepted always comes back in the delta, because
      // applying it advances the revision past our baseline. So an uploaded
      // track that is missing from the delta was rejected — the space is at its
      // row cap, or it lost a race. Keep the local value and let the next sync
      // retry it, instead of resetting to the baseline and silently discarding
      // the user's edit.
      const notApplied = sentIds.has(id) && !appliedIds.has(id);

      let resolvedValue = serverValue;
      if (newConflict || blockedConflict) {
        resolvedValue = requestValue;
        conflicts[id] = {
          local: requestValue,
          remote: serverValue,
        };
      } else if (notApplied) {
        resolvedValue = requestValue;
      }

      if (editedDuringSync) {
        resolvedValue = latestValue;
        delete conflicts[id];
      }

      setMapValue(finalLocal, id, resolvedValue);
    }

    return { finalLocal, conflicts };
  }

  // One synchronization attempt against a given local baseline/revision.
  async function attemptSync(mode, code, state) {
    const force = mode === "lww";
    const { baseline, baseRevision, previousConflicts } = state;

    const requestLocal = await readOverrides();
    const { changes, sentIds } = buildClientChanges(
      baseline,
      requestLocal,
      previousConflicts,
      force,
    );
    const response = await requestSync(code, baseRevision, changes, force);
    const { serverBaseline, appliedIds } = applyServerChanges(
      baseline,
      response.changes,
    );

    const latestSettings = await readSettings();
    if ((latestSettings.code || "").trim() !== code) {
      throw new Error("sync code changed while synchronization was running");
    }

    const latestLocal = await readOverrides();
    const { finalLocal, conflicts } = reconcileSync({
      baseline,
      requestLocal,
      latestLocal,
      serverBaseline,
      appliedIds,
      previousConflicts,
      sentIds,
      force,
    });

    const lastSyncAt = Date.now();
    const conflictCount = Object.keys(conflicts).length;
    // Conflict count and capacity are read back from their own fields
    // (syncConflicts, lastCapacityExceeded) rather than packed into
    // lastStatus text, so the popup never has to parse them back out of a
    // string that can combine multiple pieces of state.
    const nextSettings = {
      ...latestSettings,
      syncStateCode: code,
      syncRevision: response.revision,
      syncBaseline: serverBaseline,
      syncConflicts: conflicts,
      lastSyncAt,
      lastStatus: "ok",
      lastCapacityExceeded: response.capacityExceeded === true,
    };

    await storage.local.set({
      [MANUAL_BPM_STORAGE_KEY]: finalLocal,
      [SYNC_SETTINGS_KEY]: nextSettings,
    });

    log("sync ok", {
      mode,
      revision: response.revision,
      sent: changes.length,
      received: response.changes.length,
      conflicts: conflictCount,
      capacityExceeded: response.capacityExceeded,
    });
    return {
      ok: true,
      mode,
      direction: "merge",
      count: Object.keys(finalLocal).length,
      conflicts: conflictCount,
      capacityExceeded: response.capacityExceeded === true,
      lastSyncAt,
    };
  }

  async function runSync(mode) {
    const initialSettings = await readSettings();
    if (initialSettings.syncEnabled === false) {
      return { ok: false, error: "Sync is disabled." };
    }
    const code = (initialSettings.code || "").trim();
    if (!code) return { ok: false, error: "No sync code set." };

    const stateMatchesCode = initialSettings.syncStateCode === code;
    const state = {
      baseline: stateMatchesCode ? initialSettings.syncBaseline : {},
      baseRevision: stateMatchesCode ? initialSettings.syncRevision : 0,
      previousConflicts: stateMatchesCode ? initialSettings.syncConflicts : {},
    };

    try {
      return await attemptSync(mode, code, state);
    } catch (error) {
      // The server has no record of a revision we think we already hold — the
      // space was restored from a backup, or recreated. Without this, the client
      // stays wedged forever: it never lowers its own revision on its own.
      // Re-running from revision 0 rebuilds the baseline from the server and
      // keeps local values that are missing remotely.
      if (error?.code === "revision_ahead") {
        log("server revision is behind local state; resyncing from scratch");
        try {
          return await attemptSync(mode, code, {
            baseline: {},
            baseRevision: 0,
            previousConflicts: {},
          });
        } catch (retryError) {
          return await failSync(code, retryError);
        }
      }
      return await failSync(code, error);
    }
  }

  async function failSync(code, error) {
    const message = error?.message || String(error);
    await patchSettingsForCode(code, { lastStatus: `error: ${message}` });
    console.warn("[Deezer BPM][bg] sync failed:", error);
    return { ok: false, error: message, code: error?.code || "" };
  }

  function enqueueOperation(callback) {
    const operation = operationQueue.then(callback);
    operationQueue = operation.catch(() => {});
    return operation;
  }

  function syncNow(mode) {
    return enqueueOperation(() => runSync(mode));
  }

  async function setManualOverride(trackId, bpm) {
    const id = String(trackId ?? "").trim();
    if (!isValidId(id) || (bpm !== null && !isValidBpm(bpm))) {
      return { ok: false, error: "Invalid manual BPM update." };
    }

    const overrides = await readOverrides();
    setMapValue(overrides, id, bpm);
    await storage.local.set({ [MANUAL_BPM_STORAGE_KEY]: overrides });
    return { ok: true };
  }

  async function importManualOverrides(rawOverrides, replaceAll) {
    const imported = normalizeOverrides(rawOverrides);
    const inputCount =
      rawOverrides && typeof rawOverrides === "object"
        ? Object.keys(rawOverrides).length
        : 0;
    if (Object.keys(imported).length !== inputCount) {
      return { ok: false, error: "Invalid manual BPM import." };
    }

    const existing = replaceAll ? {} : await readOverrides();
    const merged = { ...existing, ...imported };
    await storage.local.set({ [MANUAL_BPM_STORAGE_KEY]: merged });
    return { ok: true, count: Object.keys(merged).length };
  }

  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;

    let operation;
    if (msg.type === "sync") {
      operation = syncNow(msg.mode === "lww" ? "lww" : "merge");
    } else if (msg.type === "open-sync-activation") {
      operation = tabs
        .create({ url: `${SYNC_ENDPOINT}/activate` })
        .then(() => ({ ok: true }));
    } else if (msg.type === "set-manual-override") {
      operation = enqueueOperation(() =>
        setManualOverride(msg.trackId, msg.bpm),
      );
    } else if (msg.type === "import-manual-overrides") {
      operation = enqueueOperation(() =>
        importManualOverrides(msg.overrides, !!msg.replaceAll),
      );
    } else {
      return false;
    }

    operation
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      );
    return true;
  });

  async function reconfigureAlarm() {
    try {
      const { code, syncEnabled, autoSync } = await readSettings();
      const shouldRun = syncEnabled !== false && autoSync && !!code;
      // The service worker re-runs this on every cold start (MV3 tears it down
      // after ~30s idle), which can be far more often than SYNC_INTERVAL_MIN.
      // Only touch the alarm when it needs to change, so an already-armed
      // one-shot keeps its jittered delay instead of being reset to "now".
      const existing = await alarms.get(SYNC_ALARM_NAME);

      if (shouldRun) {
        if (!existing) {
          alarms.create(SYNC_ALARM_NAME, {
            delayInMinutes: nextSyncDelayMinutes(),
          });
          log("auto-sync alarm armed");
        }
      } else if (existing) {
        alarms.clear(SYNC_ALARM_NAME);
        log("auto-sync alarm cleared");
      }
    } catch (error) {
      console.warn("[Deezer BPM][bg] alarm setup failed:", error);
    }
  }

  alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM_NAME) return;
    // One-shot alarms self-remove once fired, so re-arm the next cycle here
    // (with a fresh random delay) instead of using a fixed periodInMinutes.
    syncNow("merge").finally(() => reconfigureAlarm());
  });

  storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SYNC_SETTINGS_KEY]) reconfigureAlarm();
  });

  // The merge/conflict helpers above are pure functions and hold the trickiest
  // logic in the extension, so tests/merge.test.mjs drives them directly. This
  // is the background context's own global scope — nothing on a web page can
  // reach it.
  globalThis.DeezerBpmSyncInternals = {
    buildClientChanges,
    applyServerChanges,
    reconcileSync,
    normalizeOverrides,
    normalizeConflicts,
    changedIds,
    chunkChanges,
  };

  reconfigureAlarm();
})();

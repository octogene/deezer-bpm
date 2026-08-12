(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const storage =
    typeof browser !== "undefined" ? browser.storage : chrome.storage;

  const { MANUAL_BPM_STORAGE_KEY, DEBUG_STORAGE_KEY } =
    window.DeezerBpm.constants;
  const { isValidTrackId, isValidManualBpm, parseManualOverrides } =
    window.DeezerBpm.manualBpm;

  // Schema version written into (and validated from) the export file.
  const CSV_FORMAT_VERSION = 1;
  const CSV_HEADER = "track_id,bpm";

  const DEBUG = localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  const log = (...args) => {
    if (DEBUG) console.log("[Deezer BPM][popup]", ...args);
  };

  let els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els = {
      count: document.getElementById("count"),
      exportBtn: document.getElementById("export-btn"),
      importBtn: document.getElementById("import-btn"),
      fileInput: document.getElementById("file-input"),
      replaceAll: document.getElementById("replace-all"),
      status: document.getElementById("status"),
    };

    els.exportBtn.addEventListener("click", onExport);
    els.importBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", () => {
      const file = els.fileInput.files[0];
      if (file) onImport(file);
      // Reset so selecting the same file again re-triggers "change".
      els.fileInput.value = "";
    });

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
      const csv = buildCsv(ids, overrides);

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

  // The file is intentionally just track_id + bpm: that is the complete,
  // lossless representation of a manual override, needs no network, and
  // round-trips exactly. Both fields are digits only, so no CSV escaping is
  // required.
  function buildCsv(ids, overrides) {
    const version = runtime.getManifest().version;
    const lines = [
      `# Deezer BPM manual overrides; format=${CSV_FORMAT_VERSION}; extension=${version}`,
      CSV_HEADER,
    ];

    for (const id of ids) lines.push(`${id},${overrides[id]}`);

    return lines.join("\r\n") + "\r\n";
  }

  function dateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  async function onImport(file) {
    setStatus("Reading file…", "info");
    log("Import started:", {
      name: file?.name,
      size: file?.size,
      type: file?.type,
    });

    try {
      const text = await file.text();
      log("File read. length:", text.length);
      log("First 200 chars:", JSON.stringify(text.slice(0, 200)));

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
      setStatus(`${parts.join(", ")}.`, "ok");
      refreshCount();
    } catch (error) {
      // Log the whole error object — its .message is sometimes empty (e.g.
      // storage quota / serialization errors).
      console.error("[Deezer BPM][popup] Import failed:", error);
      setStatus(`Import failed: ${error?.message || error}`, "err");
    }
  }

  function validateAndBuild(text) {
    const { delimiter, rows } = detectDelimiterAndParse(text);
    log("Delimiter:", JSON.stringify(delimiter), "| rows parsed:", rows.length);

    const headerIdx = findHeaderIndex(rows);
    if (headerIdx === -1) {
      return { error: "The file is empty." };
    }

    const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
    const idIdx = header.indexOf("track_id");
    const bpmIdx = header.indexOf("bpm");
    log("Header row:", header, "| track_id idx:", idIdx, "| bpm idx:", bpmIdx);

    if (idIdx === -1 || bpmIdx === -1) {
      return {
        error:
          "Invalid file: the CSV must have a header row with 'track_id' and " +
          "'bpm' columns.",
      };
    }

    const fileFormat = readFileFormat(rows, headerIdx);
    log("Detected format:", fileFormat);
    if (fileFormat !== null && fileFormat > CSV_FORMAT_VERSION) {
      return {
        error:
          `This file uses format v${fileFormat}, but this version of the ` +
          `extension only understands up to v${CSV_FORMAT_VERSION}. ` +
          `Please update the extension.`,
      };
    }

    const valid = {};
    let skipped = 0;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = rows[i];
      if (isBlankRow(cells)) continue;

      const id = (cells[idIdx] ?? "").trim();
      const bpm = Number((cells[bpmIdx] ?? "").trim());

      if (isValidTrackId(id) && isValidManualBpm(bpm)) {
        valid[id] = bpm;
      } else {
        skipped++;
        // Log the first few offenders so a whole-file rejection is explainable.
        if (skipped <= 10) {
          log(`Skipped row ${i}:`, cells, "| id:", id, "| bpm:", bpm);
        }
      }
    }

    const imported = Object.keys(valid).length;
    if (imported === 0) {
      return {
        error: `No valid rows found (${skipped} skipped). Nothing was imported.`,
      };
    }

    return { valid, imported, skipped };
  }

  function isBlankRow(row) {
    return row.length === 1 && (row[0] ?? "").trim() === "";
  }

  // Finds the first row that isn't blank or a comment (a row whose first cell
  // starts with "#", once quotes have already been stripped by parseCsv).
  // Comment lines are only recognised before the header, so a data cell that
  // happens to start with "#" is never mistaken for one.
  function findHeaderIndex(rows) {
    for (let i = 0; i < rows.length; i++) {
      if (isBlankRow(rows[i])) continue;
      if ((rows[i][0] ?? "").trim().startsWith("#")) continue;
      return i;
    }
    return -1;
  }

  // Reads "format=<n>" from a "#..."-prefixed comment row found before the
  // header, once parseCsv has already stripped any quoting -- unlike a raw-text
  // regex, this can't be fooled by a spreadsheet app quoting the comment line.
  function readFileFormat(rows, headerIdx) {
    for (let i = 0; i < headerIdx; i++) {
      const cell = (rows[i][0] ?? "").trim();
      if (!cell.startsWith("#")) continue;
      const match = cell.match(/format\s*=\s*(\d+)/i);
      if (match) return Number(match[1]);
    }
    return null;
  }

  // Tries each candidate delimiter (comma first, since it's the extension's
  // own export format) by fully parsing the file with the real, quote-aware
  // parseCsv and checking whether the resulting header contains the required
  // columns. This reuses parseCsv's quote handling instead of sniffing the
  // delimiter from raw, possibly-quoted text, which a spreadsheet app's
  // re-save (locales default to ";", and may quote a comment line containing
  // literal ";" characters) could otherwise mis-detect.
  function detectDelimiterAndParse(text) {
    for (const delimiter of [",", ";", "\t"]) {
      const rows = parseCsv(text, delimiter);
      const headerIdx = findHeaderIndex(rows);
      if (headerIdx === -1) continue;

      const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
      if (header.includes("track_id") && header.includes("bpm")) {
        return { delimiter, rows };
      }
    }

    // No candidate produced a valid header -- fall back to comma so the
    // existing "missing track_id/bpm header" error still surfaces.
    return { delimiter: ",", rows: parseCsv(text, ",") };
  }

  // RFC-4180-style CSV parser: handles quoted fields, escaped quotes (""), a
  // leading UTF-8 BOM, and CRLF / LF / CR line endings. Delimiter is supplied by
  // detectDelimiterAndParse so "," and ";" (and tab) files both parse.
  function parseCsv(text, delimiter) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;

    const endRow = () => {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    };

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }

      if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        endRow();
      } else if (c === "\r") {
        endRow();
        if (text[i + 1] === "\n") i++;
      } else {
        field += c;
      }
    }

    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  function setStatus(message, kind) {
    els.status.textContent = message;
    els.status.className = kind || "info";
  }
})();

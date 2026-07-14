//! Cloudflare Worker (Rust / workers-rs) that syncs the Deezer BPM
//! manual-overrides CSV for a single user, keyed by a hash of their sync code.
//! No accounts, no signing — the extension does a plain fetch() with the code
//! in the `X-Sync-Code` header. See ../README.md.
//!
//! HTTP contract (identical to the previous JS worker):
//!   GET  /csv  -> stored CSV + `X-Updated-At` header, or 404
//!   PUT  /csv  -> validates + stores the CSV, returns `{ "updatedAt": <ms> }`

use sha2::{Digest, Sha256};
use worker::*;

/// Manual-override CSVs are tiny; cap the body so a leaked/guessed code can't be
/// used to store arbitrary blobs.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// Upper bound on data rows — a guard on top of the byte cap.
const MAX_ROWS: usize = 100_000;

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    // CORS preflight. Extension fetches from a granted host permission bypass
    // CORS anyway; these headers just make the Worker usable from devtools/curl.
    if req.method() == Method::Options {
        return with_cors(Response::empty()?.with_status(204));
    }

    if req.path() != "/csv" {
        return with_cors(json_error("not found", 404)?);
    }

    // The sync code travels in a header (never the URL) so it can't leak via logs.
    let code = req.headers().get("X-Sync-Code")?.unwrap_or_default();
    if !valid_code(&code) {
        return with_cors(json_error("invalid sync code", 400)?);
    }
    let key = object_key(&code);

    let bucket = env.bucket("BUCKET")?;

    match req.method() {
        Method::Get => {
            match bucket.get(&key).execute().await? {
                Some(object) => match object.body() {
                    Some(body) => {
                        let bytes = body.bytes().await?;
                        let mut resp = Response::from_bytes(bytes)?;
                        let headers = resp.headers_mut();
                        headers.set("Content-Type", "text/csv; charset=utf-8")?;
                        // R2's own upload time is the authoritative "last written"
                        // clock, used by the extension as the LWW watermark.
                        headers
                            .set("X-Updated-At", &object.uploaded().as_millis().to_string())?;
                        with_cors(resp)
                    }
                    // Object exists but carries no body (e.g. precondition) — treat
                    // as absent.
                    None => with_cors(json_error("not found", 404)?),
                },
                None => with_cors(json_error("not found", 404)?),
            }
        }

        Method::Put => {
            if content_length(&req) > MAX_BODY_BYTES {
                return with_cors(json_error("payload too large", 413)?);
            }
            let text = req.text().await?;
            // Re-check after reading: Content-Length can be absent or lie.
            if text.len() > MAX_BODY_BYTES {
                return with_cors(json_error("payload too large", 413)?);
            }
            // Only well-formed override files may land in R2.
            if let Err(msg) = validate_csv(&text) {
                return with_cors(json_error(&format!("invalid CSV: {msg}"), 400)?);
            }

            // put().execute() yields Option<Object>; on the rare None fall back
            // to the current time so the client always gets a usable watermark.
            let updated = match bucket.put(&key, text).execute().await? {
                Some(object) => object.uploaded().as_millis(),
                None => Date::now().as_millis(),
            };
            let mut resp = Response::ok(format!("{{\"updatedAt\":{updated}}}"))?;
            resp.headers_mut()
                .set("Content-Type", "application/json")?;
            with_cors(resp)
        }

        _ => with_cors(json_error("method not allowed", 405)?),
    }
}

/// The sync code is generated client-side (Crockford-ish base32 + dashes).
/// Accept a generous but bounded shape so a junk code can't create a junk object.
fn valid_code(code: &str) -> bool {
    let len = code.len();
    (16..=128).contains(&len)
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// object key = hex(SHA-256(code)). The raw code is never used as an R2 key.
fn object_key(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn content_length(req: &Request) -> usize {
    req.headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Validates that `text` matches the extension's export format: an optional
/// leading comment, a `track_id,bpm` header, then rows of `<digits>,<1..=999>`.
/// Mirrors the `isValidId` / `isValidBpm` rules in background.js / popup.js.
/// Zero data rows is valid (the user may have cleared all overrides).
fn validate_csv(text: &str) -> std::result::Result<(), String> {
    let mut header_seen = false;
    let mut rows = 0usize;

    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if !header_seen {
            let normalized: String = line
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            if normalized != "track_id,bpm" {
                return Err(format!("missing or invalid header (line {})", i + 1));
            }
            header_seen = true;
            continue;
        }

        let mut parts = line.split(',');
        let id = parts.next().unwrap_or("").trim();
        let bpm = parts.next().unwrap_or("").trim();
        if parts.next().is_some() {
            return Err(format!("too many columns (line {})", i + 1));
        }
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("invalid track_id (line {})", i + 1));
        }
        match bpm.parse::<u32>() {
            Ok(v) if (1..=999).contains(&v) => {}
            _ => return Err(format!("invalid bpm (line {})", i + 1)),
        }

        rows += 1;
        if rows > MAX_ROWS {
            return Err(format!("too many rows (max {MAX_ROWS})"));
        }
    }

    if !header_seen {
        return Err("missing header row".to_string());
    }
    Ok(())
}

/// Attaches the shared CORS headers to any response.
fn with_cors(mut resp: Response) -> Result<Response> {
    let headers = resp.headers_mut();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "X-Sync-Code, Content-Type")?;
    headers.set("Access-Control-Expose-Headers", "X-Updated-At")?;
    headers.set("Access-Control-Max-Age", "86400")?;
    Ok(resp)
}

fn json_error(message: &str, status: u16) -> Result<Response> {
    // message is worker-authored (no user input interpolated verbatim beyond our
    // own validation text), so a plain JSON string is fine.
    let mut resp = Response::ok(format!("{{\"error\":{}}}", json_string(message)))?
        .with_status(status);
    resp.headers_mut()
        .set("Content-Type", "application/json")?;
    Ok(resp)
}

/// Minimal JSON string escaper (quotes + backslashes + control chars) so error
/// messages containing our own text serialize safely without a serde dep.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
